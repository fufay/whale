'use strict';
/**
 * DSHM 进程内插件安装器（D26 运行时安装通道，2026-09-21）。
 *
 * 【解决什么】端侧没有 pnpm/npm/git（E86 硬边界：上游 `dsh plugin add` =
 * spawnSync("pnpm")，第一步就 ENOENT），也没有独立 node 可执行文件跑它们
 * （Node 以 libnode.so 形式嵌入，D6 E15）⇒ web/CLI 的所有安装路径在端侧
 * 都是死路。本模块把「安装」拉回进程内：
 *   spec 解析 → HTTPS 拉 tarball → 纯 JS gunzip + ustar 解包 →
 *   profile node_modules 落位 → package.json merge → 用户插件行追加（E91）
 *
 * 【触发方式】不由本模块决定：hostcore/app/main.js 轮询
 * `$DSH_HOME/install-queue/*.req`（spec 文本文件），调 installSpec(spec)，
 * 结果写回同目录 `<id>.done` / `<id>.fail`（JSON）。写 .req 的一侧可以是
 * ArkUI 设置页（SettingsPlugins 的安装区块）或模型（skill：ohos-plugin-install）。
 *
 * 【spec 支持范围】与上游 dsh-plugin-manager 的 install-spec 三形态对齐：
 *   1. npm 包名（`<name>` / `<name>@<version>` / `@scope/name`）
 *   2. git URL（https://github.com/o/r(.git) / git@github.com:o/r.git）
 *   3. hosted repo URL（github.com/o/r，#branch 可选）
 * 其它 git host 不支持（如实报错，不猜）。
 *
 * 【GitHub 仓库不一定装得上（2026-09-30 用户报"插件入口给 github 地址装不上"）】
 * GitHub 源形态有两类失败，**都不是网络问题**（实测 codeload 直连可用，设备侧
 * `wget` 也能把 32MB 的 tar.gz 完整拉下来）：
 *   ① **monorepo**：根目录只有子目录，每个子包各有一份 package.json（如
 *      `Small-tailqwq/dsh-deep-whale/{maid-atelier,orca-link,skin-manager}/`）。
 *      这类必须由 spec 指明子目录——`&path:/<子目录>`、`?path=<子目录>`、
 *      `#path:/<子目录>` 三种写法都认（最后一种是各仓库自带 INSTALL.md 的写法）；
 *      没指明就如实报错，并告诉用户该往地址后面补什么。
 *   ② **源码树缺构建产物**：根目录有 package.json，但 `main`/`exports` 指向的文件
 *      是由 `npm run build` 生成的、**只随 npm 发布物**存在（如 `dsh-market/dsh-market`
 *      的 `lib/`，`files` 里列着 `lib` 而仓库里没有）。端侧没有 pnpm/tsc（见上），
 *      源码树装下来也起不来 ⇒ 落位校验必然失败。处置见 `repositoryMatchesRequest`
 *      ＋ installSpecInner 里的 githubFallback 一段（改用 registry 上的同名 npm 包）。
 * 判据写在这里，免得下一个人重新发明。
 *
 * 【为什么纯 JS 解 tar 而不 spawn busybox tar】busybox 副本虽有 tar 能力，
 * 但 spawn 在端侧始终带平台级不确定性（执行位/权限策略），而 tgz =
 * gzip(ustar)，node:zlib.gunzipSync + 512 字节头解析是零依赖的确定性路径。
 * 沙箱禁止 symlink（真机探针 13900012）：tar 里的 symlink 条目如实跳过并
 * 在结果里列出，不让安装静默残缺。
 *
 * 【依赖递归的边界】只递归 dependencies（devDependencies/peerDependencies
 * 不装，optionalDependencies 尽力装失败不阻断），深度 ≤3，同名单轮去重、
 * 已存在（node_modules 里有 package.json）跳过。版本选择用简化 semver
 * （^ ~ 精确 * latest >=），足够覆盖 dsh 插件生态的常规写法。
 *
 * 【依赖冲突 ⇒ 嵌套落位（2026-10-23 事故：两个插件争同一包的大版本）】
 *
 * 旧实现是**纯扁平落位**：所有包（含依赖的依赖）都落到
 * `profiles/<p>/node_modules/<name>`，同名只留一份；一旦后来安装的包要求
 * **不同版本**，就把根上那份**换掉**（日志原话：`已装版本漂移（js-yaml：磁盘
 * 5.5.0 ≠ 目标 4.3.2），清除旧目录并重新落位`）。真机后果：
 *   · `dsh-config-manager@0.1.81` 声明 `js-yaml ^5.4.1`（v5 的 `NOT_RESOLVED` API）；
 *   · `dshmarket@1.69.0` 声明 `js-yaml ^4.3.2`；
 *   · 装后者把根 `js-yaml` 换成 4.3.2 ⇒ **先装的那个下次启动 import 直接
 *     `SyntaxError: … does not provide an export named 'NOT_RESOLVED'`**，
 *     而市场把"在 bundles 里但没热挂载"显示成"重启后生效" ⇒ 提示永不消失。
 *   · 同一机制在 2026-10-21、10-23 各实测一次（js-yaml v4/v5 来回翻；argparse 同样）。
 *
 * 新语义（对齐 npm/pnpm 的 dedupe + 嵌套，而不是"只留一份"）：
 *   1. 顶层插件恒落 `node_modules/<name>`（用户请求谁就更新谁）；
 *   2. 依赖落位前先看**根上同名包**：
 *        · 根上没有 ⇒ 照旧落根（保持扁平，避免整棵树变深）；
 *        · 根上有且**满足本依赖声明的 range** ⇒ 复用（真 dedupe，不下载）；
 *        · 根上有但**不满足** ⇒ 落到消费者包自己的
 *          `<consumer>/node_modules/<name>`（**不碰根**，别的插件照旧解析根上那份）；
 *   3. `seen` 按**落位路径**去重（同一个包名可以合法地存在多份）；
 *   4. 安装后自检：遍历 profile 里每个顶层插件声明的必装依赖，按 Node 解析
 *      规则核对"解析到的版本是否满足 range"，不满足的写进 `.done` 的
 *      `depWarnings`（市场 UI/宿主日志都能看到**哪个包被哪个依赖拖坏**）。
 *
 * 为什么不升级成完整包管理器（lockfile / peer / 多版本图）：端侧要的只是
 * "别把别人的依赖换掉"，嵌套两层就能表达；完整求解器在 300MB 级 HAP 的
 * 进程内安装通道里没有收益，反而制造新的失败面。
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
// 与启动期预检（composeUserRows/sanitizeDependencies）同判据的入口检查——
// 两边判据不一致就是"装完即被拒拼/隔离"的配方（真机实证见 installSpecInner 落位校验注释）。
const { packageDirLoadable, ensureMarketRows } = require('./dshm-user-rows.js');
// 【卸载写坏 overlay 的配套组件（2026-10-24）】严格解析 / 原子写 / 备份清理。
// 单独成模块的理由（不许 require('js-yaml') 等运行时依赖）见 dshm-yaml-check.js 头注释。
const yamlCheck = require('./dshm-yaml-check.js');

/** 默认 registry：npmmirror（大陆 CDN，完整 npm 镜像）；可在 <homeDir>/installer.json 覆盖。 */
const DEFAULT_REGISTRY = 'https://registry.npmmirror.com';
/** 依赖递归最大深度（顶层为 0）。 */
const MAX_DEPTH = 3;
/** 单包下载超时（ms）。 */
const FETCH_TIMEOUT_MS = 30000;
/**
 * monorepo 自动下探的最大层数（相对仓库根、不含根自身）。
 * 2 层是实测覆盖：`dsh-deep-whale/{maid-atelier,orca-link,skin-manager}/` 都在第 1 层；
 * 再深（packages/foo/bar）属于"要用户明说"的那一类，不猜。
 */
const MONOREPO_SCAN_DEPTH = 2;

// ── 皮肤市场「展示名 → 真实安装 spec」映射 ───────────────────────────────
// 真机实证 2026-09-24：dsh-skin-market 的目录里用 `@dsh-external/dsh-client-ui-skin-*`
// 当展示名，但真实发布到 npm 的包名是作者自己的 scope（如 @smalltailqwq/…），也有的是
// 独立 GitHub 仓库（如 Ewnscat-ya/dsh-client-ui-skin-denia）。展示名在 registry 上
// 查无此包 → 市场的"下载并检查安装包"（pnpm view）就 exit 1，其实与 dsh 版本无关。
// 这里把已知展示名映射到真实安装 spec（npm 真实包名 / github: 源），view 与 install
// 都在 resolveSpec 前先做改写，让市场里的皮肤能真正装上。未知 spec 原样透传。
const SKIN_ALIAS_MAP = {
  '@dsh-external/dsh-client-ui-skin-orca-link': '@smalltailqwq/dsh-client-ui-skin-orca-link',
  '@dsh-external/dsh-client-ui-skin-maid-atelier': '@smalltailqwq/dsh-client-ui-skin-maid-atelier',
  '@dsh-external/dsh-client-ui-skin-dusia': 'github:Ewnscat-ya/dsh-client-ui-skin-denia',
  '@dsh-external/dsh-client-ui-skin-denia': 'github:Ewnscat-ya/dsh-client-ui-skin-denia',
};

/** 把展示名改写为真实安装 spec；无匹配则原样返回。 */
function dshmSkinAlias(spec) {
  const s = (spec || '').trim();
  return typeof s === 'string' ? (Object.prototype.hasOwnProperty.call(SKIN_ALIAS_MAP, s) ? SKIN_ALIAS_MAP[s] : s) : s;
}

// ── HTTP（node:https，手动跟随重定向）──────────────────────────────────

function httpGet(urlStr, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, {
      headers: { 'user-agent': 'dshm-installer/1 (+dsh-host)' },
      timeout: FETCH_TIMEOUT_MS,
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('重定向次数过多：' + urlStr));
          return;
        }
        let next = '';
        try {
          next = new URL(res.headers.location, urlStr).toString();
        } catch (e) {
          reject(new Error('重定向地址非法：' + res.headers.location));
          return;
        }
        httpGet(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error('HTTP ' + code + '：' + urlStr));
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => {
      req.destroy(new Error('请求超时（' + FETCH_TIMEOUT_MS + 'ms）：' + urlStr));
    });
    req.on('error', reject);
  });
}

async function fetchBuffer(urlStr) {
  const res = await httpGet(urlStr, 5);
  const chunks = [];
  for await (const c of res) {
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function fetchJson(urlStr) {
  const buf = await fetchBuffer(urlStr);
  return JSON.parse(buf.toString('utf8'));
}

// ── tar.gz 解包：**单份实现**在 hostcore/app/tar-gz.cjs ──────────────────
//
// 【2026-10-07 合并】本文件原有一份私有的 ustar 解包（只支持 ustar + GNU
// longname，PAX 头直接跳过）。工具链解包（CPython stdlib 25MB tar.gz）在手机 /
// 平板档必须走进程内解包（本档不能 spawn，见 docs/104），于是把 walker 抽成共享
// 模块，两边**不存在第二份解析逻辑**。本文件保留同名同步入口 `extractTar`。
const tarGz = require('./tar-gz.cjs');

/**
 * 解 npm tarball（ustar / GNU / PAX）到 destDir，返回 { written, skipped }。
 * 【与旧实现的三条语义逐字对齐】① 剥 `package/` 根前缀；② 路径含 `..` 段或为绝对
 * 路径 ⇒ **抛出**（tar-slip 防护，不静默跳过）；③ symlink/hardlink 不建链
 * （沙箱禁 link，真机探针 13900012）⇒ 如实跳过并报告。
 * 【唯一的行为变化】PAX `path=` 现在会被采纳 ⇒ 超长路径（≥100 字符）**落到正确位置**，
 * 而不是落在被截断的 ustar 名字上（旧实现忽略 PAX 头）。这是修正，不是回退。
 */
function extractTar(tarBuf, destDir) {
  return tarGz.extractTar(tarBuf, destDir, { stripPrefixes: ['package'] });
}

// ── 简化 semver（^ ~ 精确 * latest >= <）───────────────────────────────

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (m === null) {
    return null;
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/** 在 versions 键列表里选满足 range 的最高稳定版（跳过 prerelease）。 */
function pickVersion(range, versions, latest) {
  const clean = (range || '').trim();
  if (clean.length === 0 || clean === '*' || clean === 'latest' || clean === 'x') {
    return latest || versions[versions.length - 1] || null;
  }
  let m = /^([\^~]?)(\d+)(?:\.(\d+)?)?(?:\.(\d+)?)?$/.exec(clean);
  if (m !== null) {
    const kind = m[1];
    const maj = Number(m[2]);
    const min = m[3] !== undefined ? Number(m[3]) : null;
    const pat = m[4] !== undefined ? Number(m[4]) : null;
    let best = null;
    for (const v of versions) {
      const pv = parseVersion(v);
      if (pv === null) {
        continue;
      }
      if (kind === '^') {
        const upper = maj === 0 ? (min === 0 ? [0, 0, pat === null ? 0 : pat + 1] : [0, min === null ? 1 : min + 1, 0]) : [maj + 1, 0, 0];
        if (cmpVersion(pv, [maj, min === null ? 0 : min, pat === null ? 0 : pat]) >= 0 && cmpVersion(pv, upper) < 0) {
          if (best === null || cmpVersion(pv, best) > 0) {
            best = pv;
          }
        }
      } else if (kind === '~') {
        const upper = [maj, (min === null ? 0 : min) + 1, 0];
        if (cmpVersion(pv, [maj, min === null ? 0 : min, pat === null ? 0 : pat]) >= 0 && cmpVersion(pv, upper) < 0) {
          if (best === null || cmpVersion(pv, best) > 0) {
            best = pv;
          }
        }
      } else {
        // 精确或省略通配：1 / 1.2 / 1.2.3
        if (pv[0] === maj && (min === null || pv[1] === min) && (pat === null || pv[2] === pat)) {
          if (best === null || cmpVersion(pv, best) > 0) {
            best = pv;
          }
        }
      }
    }
    return best === null ? null : best.join('.');
  }
  m = /^>=(\d+\.\d+\.\d+)$/.exec(clean);
  if (m !== null) {
    const floor = parseVersion(m[1]);
    let best = null;
    for (const v of versions) {
      const pv = parseVersion(v);
      if (pv !== null && cmpVersion(pv, floor) >= 0 && (best === null || cmpVersion(pv, best) > 0)) {
        best = pv;
      }
    }
    return best === null ? null : best.join('.');
  }
  // 无法解析的范围：交回 latest（naive，但对 dsh 插件生态的常规写法覆盖足够）
  return latest || null;
}

// ── spec 解析（npm 包名 / GitHub 三形态）───────────────────────────────

/**
 * 解析 GitHub 形态的安装 spec，含 **monorepo 子目录**（`&path:`）。
 *
 * 【为什么要有 subpath（2026-09-25 报告 5 §2.1）】皮肤市场里有 36/302 个皮肤是
 * 「一个仓库放多个皮肤、每个皮肤各占一个子目录」（如
 * `Small-tailqwq/dsh-deep-whale` 下的 `maid-atelier/`、`orca-link/`）。市场给这类
 * 皮肤发的 spec 形如：
 *     github:Small-tailqwq/dsh-deep-whale#<commit>&path:/maid-atelier
 * 旧实现**先按 `#` 切分**，于是 `&path:/maid-atelier` 被当成 ref 的一部分 ⇒
 * codeload URL 变成 `…/tar.gz/<commit>&path:/maid-atelier` ⇒ **HTTP 404**（真机原文）。
 *
 * 【修正切分顺序】必须先切 `&path:`、再切 `#`，且**两种先后顺序都要兼容**
 * （市场数据里两种都出现过）。所以不靠"按位置切"，而是各自用正则从整串里**摘出来**：
 *   · `&path:<值>` 或 `?path=<值>`：取到第一个分隔符（`#`/`&`/`?`/空白）为止；
 *   · `#<ref>`：取 `#` 之后到下一个 `&`/`?` 为止。
 * 摘完之后剩下的才是 owner/repo 主体。
 *
 * @returns `{kind, owner, repo, ref, subpath}`；subpath 为空串表示"整仓库即包"。
 */
function parseGitHub(spec) {
  let s = (spec || '').trim();
  let branch = '';
  let subpath = '';
  /*
   * 先摘 path（三种拼法都认）。
   * `[^#&?\s]*` 而不是 `.*`：值到下一个分隔符为止——这样 `#commit&path:/x` 与
   * `&path:/x#commit` 两种顺序都能正确切出。
   *
   * 【`#path:` 也必须认（2026-09-30）】上游仓库自带的 INSTALL.md 写的是
   * `github:o/r#path:/sub`（pnpm github 简写的子目录形态，如
   * `Small-tailqwq/dsh-deep-whale` 的 INSTALL.md）。旧正则只认 `&path:` / `?path=`，
   * 于是 `#path:/sub` 整段被当成 **ref** ⇒ codeload URL 变成 `…/tar.gz/path:/sub`
   * ⇒ **HTTP 404**：用户照着仓库文档抄也装不上，且报错与"仓库不存在"无从区分。
   * 之所以敢收 `#path:`：git ref 名不含 `:`（`refs` 的禁字符集），
   * 故 `#path[:=]` 不会误吞真分支/真 tag 名。
   */
  const pathMatch = /[&?#]path[:=]([^#&?\s]*)/.exec(s);
  if (pathMatch !== null) {
    subpath = pathMatch[1].trim();
    s = s.slice(0, pathMatch.index) + s.slice(pathMatch.index + pathMatch[0].length);
  }
  // 再摘 ref（`#` 之后到下一个分隔符为止）。
  const hashAt = s.indexOf('#');
  if (hashAt >= 0) {
    const rest = s.slice(hashAt + 1);
    const stop = rest.search(/[&?\s]/);
    branch = (stop >= 0 ? rest.slice(0, stop) : rest).trim();
    s = s.slice(0, hashAt) + (stop >= 0 ? rest.slice(stop) : '');
  }
  s = s.trim();
  // 归一化 subpath：去掉前导 `/` 与 `./`，去掉尾部 `/`（后续按 join 用）。
  subpath = subpath.replace(/^\.?\//, '').replace(/\/+$/, '');
  // npm 的 github: 简写（github:owner/repo、github:owner/repo.git）——skin-market
  // 等插件市场传的就是这种。剥掉 github: 前缀后再按 owner/repo 走。
  if (/^github:/.test(s) && !/^github:\//.test(s)) {
    s = s.slice('github:'.length);
  }
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#]+?)(?:\.git)?\/?$/.exec(s);
  if (m === null) {
    m = /^git@github\.com:([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/.exec(s);
  }
  if (m === null) {
    // owner/repo 简写：非 @ 开头且恰好一段斜杠（@开头是 npm scope）
    m = /^([^@\s/]+)\/([^@\s/]+)$/.exec(s);
  }
  if (m === null) {
    return null;
  }
  return {
    kind: 'github',
    owner: m[1],
    repo: m[2],
    ref: branch.length > 0 ? branch : 'HEAD',
    subpath,
  };
}

function parseNpm(spec) {
  const s = (spec || '').trim();
  if (s.includes('://') || s.includes('@') && s.indexOf('@') === 0 && !/^@[^/\s]+\/[^@\s]+(@[^@\s]+)?$/.test(s)) {
    return null;
  }
  const m = /^((?:@[^/\s]+\/)?[^@\s/]+)(?:@([^@\s]+))?$/.exec(s);
  if (m === null) {
    return null;
  }
  return { kind: 'npm', name: m[1], range: m[2] || '' };
}

/** spec → { kind, tarballUrl, name?, version? }。npm 先查 registry，GitHub 直拼 codeload。 */
async function resolveSpec(spec, registry) {
  spec = dshmSkinAlias(spec); // 皮肤市场展示名 → 真实安装 spec
  const gh = parseGitHub(spec);
  if (gh !== null && spec.includes('/')) {
    return {
      kind: 'github',
      name: gh.owner + '--' + gh.repo, // GitHub 包名在落位时读 tarball 内 package.json 修正
      version: gh.ref,
      tarballUrl: 'https://codeload.github.com/' + gh.owner + '/' + gh.repo + '/tar.gz/' + gh.ref,
      // monorepo 子目录（`&path:`）：调用方据此在解包后进入该子目录取包（报告 5 §2.1）。
      subpath: gh.subpath,
    };
  }
  const np = parseNpm(spec);
  if (np === null) {
    throw new Error('无法识别的插件标识：' + spec + '（支持 npm 包名或 GitHub 仓库地址）');
  }
  // npm 元数据查询：优先给到的 registry（默认 npmmirror），查不到则回退官方 npmjs。
  // 皮肤/插件市场传的 `@dsh-external/dsh-client-ui-skin-*` 等 scoped 包部分只在官方
  // registry 发布、npmmirror 未同步（真机实证 2026-09-24：$\@scope 在 npmmirror 404）。
  // 让 npm 分录用双 registry 探测，安装源与 pnpm 默认一致（npmjs）。
  let meta = null;
  const fallbackRegistries = [registry].concat(registry.indexOf('registry.npmjs.org') === -1 ? ['https://registry.npmjs.org'] : []);
  for (const reg of fallbackRegistries) {
    try {
      const cand = await fetchJson(reg.replace(/\/+$/, '') + '/' + encodeURIComponent(np.name));
      if (cand && cand.versions && typeof cand.versions === 'object') {
        meta = cand;
        break;
      }
    } catch (e) {
      // 该 registry 404/网络失败：试下一个
    }
  }
  if (meta === null) {
    throw new Error('registry 元数据异常：' + np.name);
  }
  const all = Object.keys(meta.versions);
  const stable = all.filter((v) => !v.includes('-'));
  const distTags = meta['dist-tags'] || {};
  const version = pickVersion(np.range, stable.sort(cmpVersionByKey), distTags.latest);
  if (version === null) {
    throw new Error('registry 上找不到满足「' + np.range + '」的版本：' + np.name);
  }
  const vMeta = meta.versions[version];
  if (!vMeta || !vMeta.dist || !vMeta.dist.tarball) {
    throw new Error('版本缺 tarball 地址：' + np.name + '@' + version);
  }
  return { kind: 'npm', name: np.name, version, tarballUrl: vMeta.dist.tarball };
}

function cmpVersionByKey(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null) {
    return 1;
  }
  if (pb === null) {
    return -1;
  }
  return cmpVersion(pa, pb);
}

// ── profile 落位（node_modules / package.json / 用户行）───────────────

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function ensureProfileDirs(profileDir) {
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
}

/**
 * 【monorepo 自动下探（2026-09-30）】在一个解包出来的仓库树里找"子包目录"。
 *
 * 返回**相对 baseDir 的 POSIX 路径**数组（如 `['maid-atelier','orca-link']`），已排序。
 * 判据刻意保守——**只认"目录里有 package.json"**，且遇到第一个包就停止往下：
 *   · 顶层（depth 0）不算候选：调用方只在"根目录读不到 package.json"时才来问；
 *   · `node_modules/` 与 `.` 开头的目录跳过（`.github/`、`.agents/` 里没有包，
 *     但 `node_modules` 里可能有几百份 package.json，扫进去毫无意义）；
 *   · 一个目录本身是包就不再往下找它的子目录（嵌套 workspace 属于"要用户明说"）。
 *
 * 【为什么必须"恰好一个才用"】`Small-tailqwq/dsh-deep-whale` 的 maid-atelier /
 * orca-link / skin-manager **三个子包都声明了 `dsh.bundle`**，任何"挑那个像插件的"
 * 启发式在这类仓库上都没有区分度 ⇒ 多候选时如实列给用户，不猜。
 */
function findPackageRoots(baseDir, maxDepth) {
  const out = [];
  const walk = (dir, rel, depth) => {
    if (depth > maxDepth) {
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    if (depth > 0 && entries.some((e) => e.isFile() && e.name === 'package.json')) {
      out.push(rel);
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) {
        continue;
      }
      walk(path.join(dir, e.name), rel.length > 0 ? rel + '/' + e.name : e.name, depth + 1);
    }
  };
  walk(baseDir, '', 0);
  return out.sort();
}

/**
 * 【同一性守卫（2026-09-30）】"回退到 npm 同名包"必须是**同一个仓库**，否则退回就是
 * 装了个无关的包——比失败更糟（用户以为装上了）。
 *
 * 判据：请求 spec 能解析出 `owner/repo`，且包 manifest 的 `repository` 指向同一个
 * `owner/repo`（大小写不敏感）。`repository` 缺失、是别的 host、或指向别的仓库
 * ⇒ 守卫失败，**不回退**、照原样报错。
 *
 * @param pkgMeta 包 manifest 的解析结果
 * @param spec 用户请求的原始 spec
 */
function repositoryMatchesRequest(pkgMeta, spec) {
  const gh = parseGitHub(spec);
  if (gh === null) {
    return false;
  }
  if (pkgMeta === null || typeof pkgMeta !== 'object' || Array.isArray(pkgMeta)) {
    return false;
  }
  let url = '';
  const repo = pkgMeta.repository;
  if (typeof repo === 'string') {
    url = repo;
  } else if (repo !== null && typeof repo === 'object' && typeof repo.url === 'string') {
    url = repo.url;
  }
  if (url.trim().length === 0) {
    return false;
  }
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (m === null) {
    return false;
  }
  return m[1].toLowerCase() === gh.owner.toLowerCase()
    && m[2].toLowerCase() === gh.repo.toLowerCase();
}

/**
 * 【幂等分支按仓库找已落位的包（2026-09-30）】GitHub spec 推不出真实包名：占位名是
 * `owner--repo`（如 `dsh-market--dsh-market`），而落位用的是 tarball/manifest 里的
 * `name`（如 `dshmarket`）。于是"用 GitHub 地址装第二次"时 `existsSync(占位名)` 落空，
 * 结果被说成 `包已存在（幂等，无需重装）`——名字还是错的（真机实证：dsh-market 回退
 * 装成 dshmarket 后，再贴一次 GitHub 地址就走到这条）。
 *
 * 判据：`node_modules/<name>/package.json` 的 `repository` 指向请求的 owner/repo
 * （与回退守卫 `repositoryMatchesRequest` 同一把尺子）。只在幂等分支调用——那里本来
 * 就没有别的办法知道包名，扫一遍目录是可接受的代价。
 *
 * @returns 找到的包名，找不到返回 `''`
 */
function findInstalledByRepository(profileDir, spec) {
  const nm = path.join(profileDir, 'node_modules');
  let entries = [];
  try {
    entries = fs.readdirSync(nm, { withFileTypes: true });
  } catch (e) {
    return '';
  }
  const scoped = [];
  for (const e of entries) {
    if (!e.isDirectory()) {
      continue;
    }
    if (e.name.startsWith('@')) {
      let inner = [];
      try {
        inner = fs.readdirSync(path.join(nm, e.name), { withFileTypes: true });
      } catch (err) {
        inner = [];
      }
      for (const i of inner) {
        if (i.isDirectory()) {
          scoped.push(e.name + '/' + i.name);
        }
      }
    } else {
      scoped.push(e.name);
    }
  }
  scoped.sort();
  for (const name of scoped) {
    const meta = readJsonSafe(path.join(nm, name, 'package.json'));
    if (meta !== null && repositoryMatchesRequest(meta, spec)) {
      return name;
    }
  }
  return '';
}

/** 读已落位包的 manifest 版本；读不到/无 version 字段 ⇒ `''`（调用方据此不判漂移）。 */
function readInstalledVersion(destDir) {
  const meta = readJsonSafe(path.join(destDir, 'package.json'));
  return meta && typeof meta.version === 'string' ? meta.version : '';
}

/**
 * 【P1-2（2026-09-28）】磁盘版本 vs 本次解析出的目标版本，是否漂移。
 *
 * 这条判据守的是"清单声明 ≠ 磁盘实际"的静默不一致：profile/package.json 写
 * `dshmarket: 1.66.2`、node_modules 里还是 1.65.1（真机现场）。旧实现只判"入口
 * 可加载"就幂等跳过，于是 `pnpm add <pkg>@<目标>` 永远"成功"却永不收敛；0.2.0
 * 的兼容检查按**磁盘**版本判定 ⇒ 该插件被静默跳过，市场 UI 与实际运行版本长期不符。
 *
 * 判据刻意保守，宁可不判也不误判（误判 = 每次安装都无谓重下整棵依赖树）：
 *   · 两侧都要有可读版本号——任一侧为空（半残包、manifest 无 version）不判漂移，
 *     交回"入口可加载即幂等"的旧语义，由残留自愈那条路径处理；
 *   · 只对 npm 形态比对：GitHub 形态的 `resolved.version` 是 **ref**（`HEAD` /
 *     `dev` / `<commit>`），与 manifest 里的 semver 不同维度，比了就必然误报；
 *   · 必须是"同一个 name"下的比较——调用方用 `resolved.name` 取磁盘版本，同名才进来。
 */
function versionDrifted(resolved, haveVersion) {
  if (!resolved || resolved.kind !== 'npm') {
    return false;
  }
  const want = typeof resolved.version === 'string' ? resolved.version.trim() : '';
  const have = typeof haveVersion === 'string' ? haveVersion.trim() : '';
  if (want.length === 0 || have.length === 0) {
    return false;
  }
  return want !== have;
}

// ── 依赖 range 判定（冲突嵌套 + 安装后自检的共用判据）──────────────────

/**
 * 版本是否满足依赖声明的 range。冲突嵌套落位与"安装后依赖自检"共用这一份判据，
 * 两处若各写一份，迟早会出现"装的时候认为满足、体检的时候认为不满足"。
 *
 * 三点刻意保守的语义（本模块只对 npm semver 形态负责）：
 *   · 版本读不出来 ⇒ false（调用方据此报"不可判定/缺失"，不假装满足）；
 *   · range 解析不了的 token（`github:…` / `file:…` / `workspace:*` / `latest` /
 *     dist-tag）**不参与判定**，整条 range 视为"未判定"⇒ 返回 true，宁可少报；
 *   · 支持 `^ ~ >= <= > < =`、空格连接的"与"、`||` 的"或"、`1`/`1.2`/`1.x` 前缀、
 *     以及 `1.2.3 - 1.5.0` 连字符范围（整段视为不判定）。不支持的东西一律不误报。
 */
function versionSatisfies(version, range) {
  const have = parseVersion(String(version === undefined || version === null ? '' : version).trim());
  if (have === null) {
    return false;
  }
  const raw = String(range === undefined || range === null ? '' : range).trim();
  if (raw.length === 0) {
    return true;
  }
  for (const branch of raw.split('||')) {
    if (satisfiesRangeBranch(have, branch.trim())) {
      return true;
    }
  }
  return false;
}

/** `||` 的一段：空白分隔的多个比较符 = 逻辑与；超范围语法（连字符）不判定。 */
function satisfiesRangeBranch(have, branch) {
  if (branch.length === 0 || branch === '*' || branch === 'x' || branch === 'X' || branch === 'latest') {
    return true;
  }
  if (/\s-\s/.test(branch)) {
    return true; // `1.2.3 - 1.5.0`：不实现连字符范围，按"未判定"放行（不误报）
  }
  const tokens = branch.split(/\s+/).filter((t) => t.length > 0);
  for (const token of tokens) {
    if (satisfiesComparator(have, token) === false) {
      return false;
    }
  }
  return true;
}

/**
 * 单个比较符判定。返回 true / false / null（null = 这个 token 不是 semver 比较符，
 * 不参与判定，例如 `https://…`、`file:../x`、`next`）。
 */
function satisfiesComparator(have, token) {
  const m = /^v?(\^|~|>=|<=|>|<|=)?v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/.exec(token);
  if (m === null) {
    return null;
  }
  const op = m[1] === undefined ? '' : m[1];
  const maj = Number(m[2]);
  const isWild = (s) => s === undefined || s === 'x' || s === 'X' || s === '*';
  const min = isWild(m[3]) ? null : Number(m[3]);
  const pat = isWild(m[4]) ? null : Number(m[4]);
  const at = (a, b, c) => [a, b, c];
  const low = at(maj, min === null ? 0 : min, pat === null ? 0 : pat);
  if (op === '^') {
    // ^1.2.3 → [1.2.3, 2.0.0)；^0.2.3 → [0.2.3, 0.3.0)；^0.0.3 → [0.0.3, 0.0.4)
    let upper;
    if (maj > 0) {
      upper = at(maj + 1, 0, 0);
    } else if (min === null) {
      upper = at(1, 0, 0);
    } else if (min > 0) {
      upper = at(0, min + 1, 0);
    } else if (pat === null) {
      upper = at(0, 1, 0);
    } else {
      upper = at(0, 0, pat + 1);
    }
    return cmpVersion(have, low) >= 0 && cmpVersion(have, upper) < 0;
  }
  if (op === '~') {
    // ~1.2.3 / ~1.2 → [1.2.0, 1.3.0)；~1 → [1.0.0, 2.0.0)
    const upper = min === null ? at(maj + 1, 0, 0) : at(maj, min + 1, 0);
    return cmpVersion(have, low) >= 0 && cmpVersion(have, upper) < 0;
  }
  if (op === '>=') {
    return cmpVersion(have, low) >= 0;
  }
  if (op === '>') {
    if (pat !== null) {
      return cmpVersion(have, low) > 0;
    }
    return min === null ? cmpVersion(have, at(maj + 1, 0, 0)) >= 0 : cmpVersion(have, at(maj, min + 1, 0)) >= 0;
  }
  if (op === '<=') {
    if (pat !== null) {
      return cmpVersion(have, low) <= 0;
    }
    return min === null ? cmpVersion(have, at(maj + 1, 0, 0)) < 0 : cmpVersion(have, at(maj, min + 1, 0)) < 0;
  }
  if (op === '<') {
    return cmpVersion(have, low) < 0;
  }
  // 无操作符 / `=`：精确，或"段前缀"（1 / 1.2 / 1.x / 1.2.x）
  if (pat !== null) {
    return cmpVersion(have, low) === 0;
  }
  if (min !== null) {
    return have[0] === maj && have[1] === min;
  }
  return have[0] === maj;
}

/** 相对 profile 的 POSIX 路径标签（取证日志用；越界时回退绝对路径）。 */
function relLabel(profileDir, absPath) {
  const rel = path.relative(profileDir, absPath);
  if (rel.length === 0) {
    return '.';
  }
  if (rel.startsWith('..')) {
    return absPath;
  }
  return rel.split(path.sep).join('/');
}

/**
 * 【安装后依赖自检（2026-10-23 事故的配套保险）】遍历 profile 的**顶层插件**
 * （`package.json` dependencies 的每个键），按 Node 的模块解析顺序核对它们声明的
 * **必装依赖**是否装到位、版本是否满足 range。返回告警数组（空 = 通过）。
 *
 * 为什么需要它：扁平/嵌套混合落位之后，"某个插件解析到了错版本的依赖"本身不会
 * 抛错——它只在**下次 import** 时才炸（真机原话：`SyntaxError: … does not provide
 * an export named 'NOT_RESOLVED'`），而市场把"在 bundles 里但没热挂载"显示成
 * "重启后生效"，提示永不消失。把体检结果写进 `.done` 的 `depWarnings`（宿主日志
 * 也打一遍），就能一句话指出"**哪个插件、哪个依赖、要什么版本、实际解析到哪**"。
 *
 * 三条防误报边界：
 *   · 只查 `dependencies`（optional 装不上属预期，peer 本来就不装）；
 *   · range 解析不了的（git/file/workspace/tag）跳过判定——安装器只对 npm semver 负责；
 *   · 包目录不存在 / manifest 读不出版本的，不算告警（那是"没装上/半残"另一类问题，
 *     由落位校验与启动期自愈负责）。
 */
function collectDependencyWarnings(profileDir) {
  const out = [];
  const profilePkg = readJsonSafe(path.join(profileDir, 'package.json'));
  const topDeps = profilePkg !== null && typeof profilePkg === 'object'
    && profilePkg.dependencies !== null && typeof profilePkg.dependencies === 'object'
    && !Array.isArray(profilePkg.dependencies)
    ? profilePkg.dependencies : {};
  const rootModules = path.join(profileDir, 'node_modules');
  for (const pluginName of Object.keys(topDeps).sort()) {
    const pluginDir = path.join(rootModules, pluginName);
    const pluginPkg = readJsonSafe(path.join(pluginDir, 'package.json'));
    if (pluginPkg === null || typeof pluginPkg !== 'object' || Array.isArray(pluginPkg)) {
      continue;
    }
    const declared = pluginPkg.dependencies !== null && typeof pluginPkg.dependencies === 'object'
      && !Array.isArray(pluginPkg.dependencies)
      ? pluginPkg.dependencies : {};
    for (const depName of Object.keys(declared).sort()) {
      const range = String(declared[depName] === undefined ? '' : declared[depName]).trim();
      if (range.length === 0) {
        continue;
      }
      const hit = resolveDeclaredDependency(pluginDir, depName);
      if (hit === null) {
        out.push({ pkg: pluginName, dep: depName, range, found: '', from: '' });
        continue;
      }
      const foundVersion = readInstalledVersion(hit.pkgDir);
      if (foundVersion.length === 0) {
        continue;
      }
      if (!versionSatisfies(foundVersion, range)) {
        out.push({
          pkg: pluginName,
          dep: depName,
          range,
          found: foundVersion,
          from: relLabel(profileDir, hit.pkgDir),
        });
      }
    }
  }
  return out;
}

/** 按 Node 的模块解析顺序（逐层向上找 `node_modules/<dep>`）定位依赖包目录。 */
function resolveDeclaredDependency(pkgDir, depName) {
  let dir = pkgDir;
  for (let i = 0; i < 8; i++) {
    const cand = path.join(dir, 'node_modules', depName);
    if (fs.existsSync(path.join(cand, 'package.json'))) {
      return { pkgDir: cand };
    }
    const up = path.dirname(dir);
    if (up === dir) {
      break;
    }
    dir = up;
  }
  return null;
}

/**
 * merge profile package.json 的 dependencies（只增不改，保留其余字段）。
 *
 * 【2026-09-26 开发端落实 P1】依赖值优先写**请求 spec**，而不是一律 `^version`。
 *
 * 为什么：`dsh-skin-market` 的 `installedSpecMatches()` 会把 profile 里登记的依赖值
 * 与"用户审核过的来源"逐字比对。真机实测（0.1.7-rc.1）：端侧记 `^1.2.0`，而市场
 * 审的是 `github:owner/repo#<commit>` → `does not match the reviewed source/version`
 * → 安装被判"没装上"。
 *
 * 取值规则（与真 pnpm 语义对齐，同时满足市场的比对）：
 *   · 请求是 git/GitHub 形态（github:owner/repo[#ref]、git+https://…、owner/repo）
 *     ⇒ 原样记录该 spec——这正是市场审核比对的字符串；
 *   · 请求是 npm 形态且带显式范围（name@^1.2.3）⇒ 记录该范围；
 *   · 请求是纯包名（pnpm add foo）⇒ 记 `^<解析到的版本>`（pnpm 默认 save-prefix）。
 *
 * @param items 每项 `{ name, version, spec? }`；`spec` 存在时按上面的规则取用。
 */
function mergeDependencies(profileDir, installed) {
  const pkgPath = path.join(profileDir, 'package.json');
  const existed = fs.existsSync(pkgPath);
  const pkg = readJsonSafe(pkgPath) || {};
  /*
   * 【2026-10-24 A3】写坏 profile/package.json = 下次 boot fatal。三条纪律：
   *   ① 现有文件存在但读不出（坏 JSON）⇒ 先**留档**（`.bak-invalid-<ts>`）再写，
   *      绝不静默覆盖用户数据（旧实现会直接写成 `{}`，等于把依赖/配置全抹掉）；
   *   ② 写前校验序列化结果（`JSON.parse(JSON.stringify(...))`）；
   *   ③ 原子写（同目录 tmp + rename），避免写一半崩出半截文件。
   * 备份失败时**抛错**而不是覆盖——宁可安装失败，不可毁数据。
   */
  if (existed && readJsonSafe(pkgPath) === null) {
    yamlCheck.backupFileSync(pkgPath, 'invalid');
  }
  pkg.dependencies = pkg.dependencies || {};
  for (const item of installed) {
    pkg.dependencies[item.name] = dependencyValueFor(item);
  }
  const text = JSON.stringify(pkg, null, 2) + '\n';
  try {
    JSON.parse(text);
  } catch (e) {
    throw new Error('package.json 序列化失败：' + (e && e.message ? e.message : e));
  }
  yamlCheck.writeFileAtomicSync(pkgPath, text);
}

/** 由请求 spec 推出要写进 dependencies 的值（见 mergeDependencies 注释的规则）。 */
function dependencyValueFor(item) {
  const raw = typeof item.spec === 'string' ? item.spec.trim() : '';
  const version = typeof item.version === 'string' ? item.version : '';
  if (raw.length === 0) {
    return '^' + version;
  }
  // git / GitHub 形态：原样记录（市场就是按这个字符串做来源比对）。
  if (parseGitHub(raw) !== null) {
    return raw;
  }
  if (/^(git\+|git:|https?:\/\/.*\.git)/i.test(raw)) {
    return raw;
  }
  // npm 形态：name@range ⇒ 记录 range；纯包名 ⇒ ^version。
  const at = raw.lastIndexOf('@');
  if (at > 0) {
    const range = raw.slice(at + 1);
    if (range.length > 0) {
      return range;
    }
  }
  return '^' + version;
}

/**
 * 顶层包装完之后该「登记到哪里」—— 由它的 `package.json.dsh` 形态决定。
 *
 * 【为什么需要这个判定】用户行是 `- id: <X>`，而 cordis 的 patch 语义是
 * **"按 id 更新已有条目"**（id 不存在时只告警跳过）。所以一行 `- id: <包名>` 只有在
 * "某个 bundle 的 patch 里恰好插入了**同名** entry"时才有意义，否则就是**孤儿行**。
 *
 * 【2026-09-25 真机证据（报告：billion-context 装了但不生效）】
 * 旧门控把 `dsh.bundle` 当成"真插件 ⇒ 值得写行"的**正**判据，方向正好相反：
 *   · `billion-context` 的 `dsh.bundle.patch = ./dsh.bundle.patch.yml`，
 *     该 patch 里 insert 的 entry id 是 **`bili-native`**（不是包名）；
 *   · 官方皮肤 `dsh-client-ui-skin-denia` 的 patch insert 的 id 是 **`ui-skin-denia`**。
 * ⇒ 对这两个包写 `- id: <包名>` **必然匹配不到任何条目**。后果有两层：
 *   ① 行是死的（挂载不了）；② 插件市场的 toggle 报 `no loader entry matched`，
 *   看起来像"插件坏了"。
 *
 * 【上游的权威口径】`dsh-plugin-manager` 的 `reconcile()`（`lib/index.js:241-250`）：
 * 对每个新装的 dependency，**声明了 `dsh.bundle` 的就 push 进 `dsh.profile.bundles`**
 * （并加载它的 patch）；**没声明的就 warn "installed as a plain dependency, not a
 * profile layer" 后跳过**。注意上游**根本没有"用户行"这个概念**——那是本项目的自有
 * 机制（因为我们的 `cordis.patch.yml` 每次启动被种子覆盖，需要一个旁路文件承载用户
 * 自己的 patch 行）。⇒ 装 bundle 型包时，**正确落点是 `dsh.profile.bundles`**。
 *
 * 【二分类】
 *   · `bundle` —— 声明了 `dsh.bundle`/`dsh.bundles` ⇒ **登记进 `dsh.profile.bundles`**，
 *                 **不写用户行**（它的 entry 由它自己的 patch 插入）。
 *   · `plain`  —— 其余（含纯库与无 `dsh` 字段者）⇒ **什么都不登记**（与上游 reconcile
 *                 一致："plain dependency, not a profile layer"）。
 *                 报告 3 那条"纯库不写行"的意图被**包含**而非推翻。
 *
 * 【为什么不再有"普通插件写用户行"这一支】报告建议里提到"普通插件 → 才写行"，但我在
 * 真实生态里**找不到这样的实例**：官方与社区插件（dshmarket / modlens /
 * dsh-better-sidebar / 各皮肤 / billion-context）**全部**声明 `dsh.bundle`。
 * 而"非 bundle 包"要能被 `- id: <包名>` 挂载，前提是**别处**已有同名 entry —— 那是
 * 无法从包自身推出的外部条件。故不实现该支（**宁可少写，不可写孤儿行**）。
 * 若将来真出现此类插件，判据应是"**该 id 在现有条目里真的存在**"，而不是"它有 dsh 字段"。
 *
 * @param pkg 顶层包的 `package.json` 解析结果
 * @returns {{kind: 'bundle'|'plain'}}
 */
function topPackageDisposition(pkg) {
  const dsh = pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg) ? pkg.dsh : null;
  if (dsh !== null && typeof dsh === 'object' && !Array.isArray(dsh)
    && (dsh.bundle !== undefined || dsh.bundles !== undefined)) {
    return { kind: 'bundle' };
  }
  return { kind: 'plain' };
}

/**
 * 把包名登记进 profile 的 `dsh.profile.bundles`（幂等）。与上游 `reconcile()` 同落点。
 * @returns 是否真的写入（已存在返回 false）
 */
function appendProfileBundle(profileDir, name) {
  const pkgPath = path.join(profileDir, 'package.json');
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    return false;
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return false;
  }
  pkg.dsh = pkg.dsh !== null && typeof pkg.dsh === 'object' && !Array.isArray(pkg.dsh) ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile !== null && typeof pkg.dsh.profile === 'object' && !Array.isArray(pkg.dsh.profile)
    ? pkg.dsh.profile : {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  if (bundles.includes(name)) {
    return false;
  }
  bundles.push(name);
  pkg.dsh.profile.bundles = bundles;
  // 【2026-10-24 A3】同 mergeDependencies：写前校验 + 原子写（读不出来时上面已 return false，
  // 不覆盖坏文件——那种情况交给启动期检查（B）/ 卸载器重建，而不是"顺手抹掉"）。
  const text = JSON.stringify(pkg, null, 2) + '\n';
  try {
    JSON.parse(text);
  } catch (e) {
    throw new Error('package.json 序列化失败：' + (e && e.message ? e.message : e));
  }
  yamlCheck.writeFileAtomicSync(pkgPath, text);
  return true;
}

/*
 * 【2026-09-25 删除 appendUserRow + yamlRowValue —— 删除本身就是这次的结论】
 *
 * 这两个函数原先负责"把包名写进 `.dshm-plugin-rows.yml` 作为 `- id: <包名>`"。
 * 报告（billion-context 装了但不生效 + 市场 toggle 报 no loader entry matched）让我
 * 把这条机制查到了底，结论是：**安装器写用户行这件事本身就是错的**。
 *
 * 证据链（三条，互相独立）：
 *   ① 用户行是 `- id: <X>`，而 cordis 的 patch 语义是**"按 id 更新已有条目"**
 *      （id 不存在时只告警跳过）⇒ 该行只在"确实存在 id 为 X 的条目"时才有意义。
 *   ② **没有 bundle 用自己做条目 id**。我在核心树里把 8 个声明 `dsh.bundle` 的包
 *      逐个查过：patch 插入的 entry id **恰好等于自己包名的，一个都没有**。
 *      生态里同样如此——`billion-context` 的 entry 是 `bili-native`、
 *      `dsh-client-ui-skin-denia` 的 entry 是 `ui-skin-denia`。
 *      ⇒ 给包写 `- id: <包名>` **必然是孤儿行**。
 *   ③ 上游 `dsh-plugin-manager` 的 `reconcile()`（`lib/index.js:241-250`）对
 *      "新装的依赖"只有两种处置：**声明 `dsh.bundle` ⇒ push 进 `dsh.profile.bundles`**；
 *      否则 warn "installed as a plain dependency, not a profile layer" 后跳过。
 *      **上游根本没有"用户行"这个概念**——那是本项目的自有机制（因为我们的
 *      `cordis.patch.yml` 每次启动被种子覆盖，需要一个旁路文件承载用户自己的 patch 行）。
 *
 * 所以正确落点是 `dsh.profile.bundles`（见 `appendProfileBundle`），而不是用户行。
 *
 * 【`.dshm-plugin-rows.yml` 仍然有用】它由**端侧「插件」页**维护（`CorePane.ets` /
 * `Index.ets` 里写 `- id` + `disabled`），语义是"**用户对已有条目**的启停覆盖"——
 * 即 id 来自**别处已存在的条目**，不是安装器凭空写的包名。两条路径的差别就在这一点上：
 * 前者引用已存在的条目，后者引用不存在的条目。
 *
 * 【若将来真要支持"普通插件写行"】判据必须是"**该 id 在现有条目里真的存在**"
 * （可在 boot 后拿 loader 的条目清单核对），**不能**退回到"它有 dsh 字段就写"——
 * 那正是这次修掉的错误。判据写在这里，免得下一个人重新发明。
 */

/** 读 <homeDir>/installer.json 的 registry 配置（缺省 npmmirror）。 */
function readRegistry(homeDir) {
  const cfg = readJsonSafe(path.join(homeDir, 'installer.json'));
  if (cfg && typeof cfg.registry === 'string' && cfg.registry.startsWith('https://')) {
    return cfg.registry;
  }
  return DEFAULT_REGISTRY;
}

// ── 安装主体 ───────────────────────────────────────────────────────────

/**
 * 安装一个插件 spec 到 profile。返回结果对象（不抛错：失败也走返回值，
 * 调用方（main.js 队列段）按 ok 字段写 .done/.fail）。
 * opts: { homeDir, profile, log? }
 */
async function installSpec(spec, opts) {
  try {
    return await installSpecInner(spec, opts);
  } catch (e) {
    // 契约：本函数不抛错，失败也走返回值（main.js 队列段按 ok 字段写 .done/.fail）
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function installSpecInner(spec, opts) {
  const homeDir = opts.homeDir;
  const profile = opts.profile || 'ondevice';
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (!homeDir || typeof spec !== 'string' || spec.trim().length === 0) {
    return { ok: false, error: '参数缺失（homeDir/spec）' };
  }
  const profileDir = (typeof opts.profileDir === 'string' && opts.profileDir.length > 0)
    ? opts.profileDir
    : path.join(homeDir, 'profiles', profile);
  const registry = readRegistry(homeDir);
  ensureProfileDirs(profileDir);
  const tmpRoot = path.join(homeDir, '.installer-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });

  const installed = [];
  const seen = new Set();
  let topName = '';
  let topVersion = '';
  // 【P1-2（2026-09-28）】被"版本漂移重装"顶掉的旧版本号：resolved.name → 磁盘上原版本。
  // 结果里带 beforeVersion → afterVersion，让"清单声明 ≠ 磁盘实际"这种静默不一致
  // 在 .done JSON 里可见（真机表现：市场 UI 显示 1.66.2、实际跑 1.65.1）。
  const beforeVersions = new Map();
  let topBeforeVersion = '';
  // 【登记门控（2026-09-25 报告）】顶层包的 manifest 本体，供循环后判定"登记到哪"。
  // 判据与落点见 topPackageDisposition 的注释（声明 dsh.bundle ⇒ 进 dsh.profile.bundles；
  // 否则什么都不登记）。旧写法用一个 `topHasBundle` 布尔并去写**用户行**，方向是反的。
  let topPkgForRow = null;
  let note = '重启应用后生效（bundle 型插件已登记，启动时随 profile 挂载）';
  /* 【GitHub 回退的记账】见落位校验失败那段：回退到 npm 同名包后，把"改用了谁"记下来
   * 进 note（.done JSON 自证），并把 npm 名留给幂等分支用作 id——GitHub spec 推出来的
   * 占位名是 `owner--repo`，与 tarball 内真名（如 `dshmarket`）不同，不记就会在"第二次
   * 安装"时找不到已落位目录、把结果说成"包已存在（幂等，无需重装）"（名字还是错的）。 */
  let githubFallbackNote = '';
  // 【冲突嵌套（2026-10-23）】job 多带三个字段：`parentDir`（声明该依赖的包目录，
  // 冲突时嵌套落位到哪里）、`depName`（父包 manifest 里声明的包名）、`range`
  // （父包声明的版本范围）。三者都只对 depth>0 的依赖 job 有意义。
  const rootModulesDir = path.join(profileDir, 'node_modules');
  const queue = [{ spec: spec.trim(), depth: 0, parentDir: '', depName: '', range: '' }];
  while (queue.length > 0) {
    const job = queue.shift();
    let resolved = null;
    try {
      resolved = await resolveSpec(job.spec, registry);
    } catch (e) {
      if (job.depth === 0) {
        throw e; // 顶层失败 = 整体失败
      }
      log('依赖解析失败（跳过）：' + job.spec + '：' + (e && e.message));
      continue; // 子依赖失败：如实记录、不阻断
    }
    const isDep = job.depth > 0;
    // ── 落位目标：顶层恒落根；依赖先看根上同名包是否够用 ──────────────────
    const depName = isDep ? (job.depName || resolved.name) : resolved.name;
    let dest = path.join(rootModulesDir, resolved.name);
    if (isDep) {
      const rootDest = path.join(rootModulesDir, depName);
      const rootExists = fs.existsSync(path.join(rootDest, 'package.json'));
      const rootVersion = rootExists ? readInstalledVersion(rootDest) : '';
      const rootLoadable = rootExists
        ? packageDirLoadable(rootDest, relLabel(profileDir, rootDest))
        : '不存在';
      // 根上那份"够不够用"：版本可读 ⇒ 按声明的 range 判；版本读不出（manifest 无
      // version）⇒ 只按完整性判（旧语义）——不因"读不到版本"就凭空嵌套一份。
      const rootUsable = rootExists && (rootVersion.length === 0
        ? rootLoadable.length === 0
        : versionSatisfies(rootVersion, job.range));
      if (rootUsable && rootLoadable.length === 0) {
        seen.add(rootDest);
        continue; // 根上已有满足 range 的完整副本 ⇒ 扁平复用（真 dedupe：不下载、不动盘）
      }
      if (rootUsable) {
        // 版本满足但包残缺（半残残留）⇒ 重新落根自愈：不能把坏包当依赖交出去
        // （它会在下次 import 时才炸，见 collectDependencyWarnings 的注释）。
        log('根上依赖不完整（' + depName + '），清除残留并重新落根…');
        dest = rootDest;
      } else if (rootExists && job.parentDir.length > 0) {
        // 【本函数的核心修法】根上有同名包但**不满足**本依赖的 range ⇒ 不覆盖根，
        // 嵌套到**消费者包自己的** node_modules：先装的插件继续解析根上那份，
        // 后装的插件解析自己嵌套的那份，互不改写（js-yaml v4/v5 事故的根因）。
        dest = path.join(job.parentDir, 'node_modules', depName);
        log('依赖版本冲突（' + depName + '：根上 ' + rootVersion + ' 不满足「' + job.range
          + '」，改落嵌套 ' + relLabel(profileDir, dest) + '）');
      } else {
        dest = rootDest; // 根上没有该包 ⇒ 保持扁平落根（避免整棵依赖树变深）
      }
    }
    const destLabel = relLabel(profileDir, dest);
    if (seen.has(dest)) {
      continue;
    }
    if (fs.existsSync(path.join(dest, 'package.json'))) {
      // 【残留自愈（2026-09-24）】市场安装失败"没有新装任何包"的根因：上次安装
      // 留下半残 node_modules/<name>（package.json 在但入口缺失，装完即含不入 UI）。
      // 既有逻辑见目录在就直接 seen+跳过 ⇒ topName 空、installed=[] ⇒ 返回"没有
      // 新装任何包"。这里改为：已存在但**可加载**才跳过（幂等）；存在但判坏（半残
      // 残留）→ 视为未装，走下方重新下载落位（清掉旧目录，装新的）。
      // 【P1-2（2026-09-28）】但"可加载"只证明入口在、**不证明版本对**。真机现场：
      // profile/package.json 声明 dshmarket@1.66.2、磁盘还是 1.65.1（等长改写之外
      // 的另一类静默不一致）。旧写法永远走幂等分支 continue ⇒ 之后任何
      // `pnpm add <pkg>@1.66.2` 都"成功"却永不收敛；而 0.2.0 的兼容检查按**磁盘**
      // 版本判定 ⇒ 该插件被静默跳过、市场 UI 与实际运行版本长期不符。故补一维判据：
      // 磁盘 manifest 的 version 与本次解析出的目标版本不一致 ⇒ 视为未装、重落位。
      // 【2026-10-23 扩到嵌套落位】判据按 job 种类分两种：顶层看"目标版本漂移"
      // （用户请求了具体版本，必须收敛）；依赖看"现有版本是否仍满足 range"
      // （不为了追 latest 反复重下——那会把装插件变成静默升级整棵依赖树）。
      const haveVersion = readInstalledVersion(dest);
      const loadableReason = packageDirLoadable(dest, destLabel);
      const versionOk = isDep
        ? versionSatisfies(haveVersion, job.range)
        : !versionDrifted(resolved, haveVersion);
      if (loadableReason.length === 0 && versionOk) {
        seen.add(dest);
        continue; // 已装、完整、且版本对（真幂等）
      }
      if (!versionOk) {
        log('已装版本漂移（' + (isDep ? destLabel : resolved.name) + '：磁盘 ' + haveVersion
          + (isDep ? ' 不满足「' + job.range + '」' : ' ≠ 目标 ' + resolved.version)
          + '），清除旧目录并重新落位…');
      } else {
        log('已装目录不完整（' + destLabel + '），清除残留并重新安装…');
      }
      beforeVersions.set(isDep ? destLabel : resolved.name, haveVersion);
      fs.rmSync(dest, { recursive: true, force: true });
    }
    log('下载 ' + resolved.name + '@' + resolved.version + ' …');
    const tgz = await fetchBuffer(resolved.tarballUrl);
    const tar = zlib.gunzipSync(tgz);
    const tmp = path.join(tmpRoot, resolved.name.replace(/[\/@:]/g, '_') + '-' + Date.now());
    fs.rmSync(tmp, { recursive: true, force: true });
    const ext = extractTar(tar, tmp);
    // npm tarball 根是 package/；GitHub codeload 根是 <repo>-<ref>/
    let realRoot = tmp;
    const entries = fs.readdirSync(tmp);
    let soleDir = '';
    if (entries.length === 1) {
      const only = path.join(tmp, entries[0]);
      let isDir = false;
      try { isDir = fs.statSync(only).isDirectory(); } catch (e) { isDir = false; }
      if (isDir) {
        soleDir = only;
      }
      if (fs.existsSync(path.join(only, 'package.json'))) {
        realRoot = only;
      }
    }
    /*
     * 【monorepo 子目录包（报告 5 §2.1）】GitHub 侧还有一层：一个仓库里放多个包，
     * 每个包各占一个子目录（`…/dsh-deep-whale` 下的 `maid-atelier/`、`orca-link/`）。
     * 这类 tarball 的**根目录没有 package.json**（它属于整个 monorepo），真正的包在
     * `<仓库根>/<subpath>/`。
     *
     * 【必须用 soleDir 而不是 realRoot 作基准】codeload 的 tarball 恒有一层
     * `<repo>-<ref>/` 外壳，而该外壳**没有 package.json** ⇒ 上面那段不会把 realRoot
     * 推进去。若直接用 `realRoot + subpath` 就会拼到 `tmp/maid-atelier`（不存在）。
     * 真机实测（本机复现）：报 "试过 …\.installer-tmp\Small-tailqwq--dsh-deep-whale-…\maid-atelier"，
     * 而实际路径多一层 `dsh-deep-whale-HEAD/`。故基准取"唯一顶层目录"（若存在），
     * 否则退回 realRoot（兼容 npm tarball 那种直接是包根的形态）。
     *
     * 判据分两步，避免把"根目录确实缺 package.json 的坏包"误当成子目录包：
     *   ① 只有 spec 明确给了 `&path:` 时才进子目录；
     *   ② 进到那一层后仍要能读到 package.json，否则如实报错（附上试过的路径）。
     */
    const subpath = typeof resolved.subpath === 'string' ? resolved.subpath : '';
    if (subpath.length > 0) {
      const base = soleDir.length > 0 ? soleDir : realRoot;
      const sub = path.join(base, ...subpath.split('/').filter((seg) => seg.length > 0 && seg !== '.'));
      if (fs.existsSync(path.join(sub, 'package.json'))) {
        realRoot = sub;
        log(`已进入 monorepo 子目录：${subpath}`);
      } else {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw new Error(`spec 声明了子目录但该处没有 package.json：${subpath}`
          + `（tarball 根=${tmp}，试过 ${sub}）`);
      }
    }
    /*
     * 【monorepo 自动下探（2026-09-30 用户报"给 github 地址装不上"）】没给 `&path:`
     * 且根目录读不到 package.json 时，先自己找一层，别直接报"没有可识别的
     * package.json"——那句话对用户毫无可操作性（他不知道该往地址后面补什么）。
     *
     * 只认两种结果：**恰好一个包 ⇒ 用它**（等价于自动补 `&path:`）；**多个包 ⇒ 报错
     * 并把候选列出来**。为什么不挑"那个声明了 dsh.bundle 的"：实测
     * `Small-tailqwq/dsh-deep-whale` 的三个子包**全部**声明 dsh.bundle，该启发式在这里
     * 无区分度，瞎猜等于装错包。
     *
     * 基准用 soleDir（codeload 的 `<repo>-<ref>/` 外壳），理由同上面那段注释。
     * 只在 GitHub 形态下探：npm tarball 的包根是约定的 `package/`，缺 manifest 就是坏包。
     */
    if (resolved.kind === 'github' && subpath.length === 0) {
      const probe = readJsonSafe(path.join(realRoot, 'package.json'));
      if (probe === null || typeof probe.name !== 'string') {
        const scanBase = soleDir.length > 0 ? soleDir : realRoot;
        const roots = findPackageRoots(scanBase, MONOREPO_SCAN_DEPTH);
        if (roots.length === 1) {
          realRoot = path.join(scanBase, ...roots[0].split('/'));
          log(`仓库根目录没有 package.json，自动进入唯一的子包目录：${roots[0]}`);
        } else if (roots.length > 1) {
          fs.rmSync(tmp, { recursive: true, force: true });
          throw new Error('该仓库根目录没有 package.json（可能是 monorepo），'
            + '找到多个子包，请在地址后指定其中一个（&path:/<子目录>）：'
            + roots.map((r) => '&path:/' + r).join(' 或 '));
        }
        // roots.length === 0：交给下面原有的"没有可识别的 package.json"报错，文案更准。
      }
    }
    const pkgMeta = readJsonSafe(path.join(realRoot, 'package.json'));
    if (pkgMeta === null || typeof pkgMeta.name !== 'string') {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error('tarball 里没有可识别的 package.json：' + job.spec
        + '（该仓库根目录没有 package.json，且未找到子包目录；'
        + '若它是 monorepo，请在地址后加 &path:/<子目录>）');
    }
    // GitHub spec 的包名以 tarball 内声明为准（修正占位名）
    const finalName = pkgMeta.name;
    // 【嵌套落位（2026-10-23）】目标目录跟着上面的落位决策走：顶层 = profile 根；
    // 依赖 = 根上那份或消费者目录下的 node_modules（GitHub 形态依赖按真名修正末段）。
    const finalDest = path.join(path.dirname(dest), finalName);
    if (seen.has(finalDest)) {
      fs.rmSync(tmp, { recursive: true, force: true });
      continue;
    }
    fs.rmSync(finalDest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(finalDest), { recursive: true });
    fs.renameSync(realRoot, finalDest);
    // 【落位后校验（2026-09-24）】半残包是端侧反复出现的形态：package.json 在、
    // main 入口缺失（真机 4 轮安装全部如此；本机同代码装同一 registry 的同一版本
    // 却完整——端侧特有，成因未定，取证字段已并入 error）。半残包一旦落位，整条
    // 启用链全灭：用户行预检拒拼（启停失效）→ 半残包隔离改名 → bundles 悬空引用
    // → setBundleEnabled 恒报 cannot resolve profile bundle（用户侧即"装上了但
    // 启用报异常"）。落位即校验，与启动期 `packageDirLoadable` 同判据；不完整直接
    // 回滚删除并整体报失败——宁可不装，不留半残。tgz 字节数与解包文件数进 error
    // （.fail JSON 持久化），下次复现可直接定位是下载截断还是解包丢文件。
    // 【2026-10-23】判据从"profile 根上的包名"改成"**这个落位目录**"：嵌套依赖
    // 不在根上，按根判会解析到别的版本（假通过），必须按 dest 自身校验。
    const loadableReason = packageDirLoadable(finalDest, relLabel(profileDir, finalDest));
    if (loadableReason.length > 0) {
      fs.rmSync(finalDest, { recursive: true, force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
      /*
       * 【GitHub 源码树缺构建产物 ⇒ 回退 registry 上的同名包（2026-09-30）】
       *
       * 现场：用户在插件入口填 `https://github.com/dsh-market/dsh-market`，装完必失败——
       * `package.json` 的 `main` 指向 `lib/index.js`、`files` 里也列着 `lib`，但 `lib/`
       * 是 `npm run build`（tsc + tsdown）生成的，**只随 npm 发布物存在**，GitHub
       * 源码 tarball 里没有（实测：codeload 4,445,445B / 279 条目，`lib/` 0 条；
       * npm tarball 177 条目里 47 个 `lib/*.js`）。端侧没有 pnpm/tsc（见文件头），
       * 源码树装下来必然起不来 ⇒ 落位校验必然拒绝。
       *
       * 处置：改用 registry 上**同名**的 npm 包。四条纪律：
       *   ① **必须同一性守卫** —— 包 manifest 的 `repository` 要指向请求的
       *      owner/repo（`repositoryMatchesRequest`）。否则"回退"就是装了个无关的
       *      包，比失败更糟（用户以为装上了）。守卫失败照旧报错。
       *   ② **只回退一次** —— 回退后的 job 带 `noFallback`，npm 形态再失败直接报错，
       *      不递归互回退（否则可能来回弹）。
       *   ③ **只在未给 `&path:` 时回退** —— 用户明确指了子目录，说明他要的就是源码树
       *      里那个包，替他换成 npm 包是违背意图的。
       *   ④ 版本取 registry 上的最新（`resolveSpec` 走 `latest`），与上游
       *      `dsh plugin add <name>` 行为一致；profile 里记的依赖值仍是**用户原始
       *      GitHub spec**（见 mergeDependencies 注释：市场按这个字符串做来源比对）。
       */
      if (resolved.kind === 'github' && subpath.length === 0 && job.noFallback !== true
        && repositoryMatchesRequest(pkgMeta, job.spec)) {
        let npmResolved = null;
        try {
          npmResolved = await resolveSpec(pkgMeta.name, registry);
        } catch (e) {
          npmResolved = null;
        }
        if (npmResolved !== null && npmResolved.kind === 'npm' && npmResolved.name === pkgMeta.name) {
          log('GitHub 源码树缺构建产物（' + loadableReason + '），改用 registry 上的同名包 '
            + npmResolved.name + '@' + npmResolved.version + ' …');
          githubFallbackNote = '（GitHub 仓库的源码树不含构建产物，已改用 npm 上的同名包 '
            + npmResolved.name + '@' + npmResolved.version + '）';
          queue.unshift({
            spec: npmResolved.name + '@' + npmResolved.version,
            depth: job.depth,
            noFallback: true,
          });
          continue;
        }
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      throw new Error('落位校验失败（已回滚，不留半残包）：' + loadableReason
        + '；tgz=' + tgz.length + 'B，解包写入 ' + ext.written + ' 文件'
        + (ext.skipped.length > 0 ? '，跳过 ' + ext.skipped.length + ' 个 link 条目' : ''));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    seen.add(finalDest);
    const installedItem = {
      name: finalName,
      version: String(pkgMeta.version || resolved.version),
      files: ext.written,
      skippedLinks: ext.skipped.length,
    };
    if (isDep) {
      // 【冲突嵌套的取证字段】依赖装在谁的 `node_modules` 下（顶层包不带这个字段，
      // 保持 .done JSON / 市场 UI 的既有形状不变）。
      installedItem.parent = relLabel(profileDir, path.dirname(finalDest));
    }
    installed.push(installedItem);
    if (topName.length === 0) {
      topName = finalName;
      topVersion = String(pkgMeta.version || resolved.version);
      // 【P1-2】顶层包若是"被版本漂移顶掉"的那个，把旧版本记下来（首次安装时 map 里没有 ⇒ 空串）。
      topBeforeVersion = beforeVersions.has(finalName) ? beforeVersions.get(finalName) : '';
      // 【为什么要留下 manifest 本体】登记落点（bundles 还是 plain）由**顶层包的
      // manifest** 决定，而判定发生在循环之后 ⇒ 这里把解析结果存下来，
      // 不要在循环末再读一次文件（那会多一次 I/O，也容易读到别的东西）。
      topPkgForRow = pkgMeta;
    }
    if (job.depth < MAX_DEPTH) {
      const deps = Object.assign({}, pkgMeta.dependencies || {}, pkgMeta.optionalDependencies || {});
      for (const depKey of Object.keys(deps)) {
        queue.push({
          spec: depKey + '@' + deps[depKey],
          depth: job.depth + 1,
          // 【冲突嵌套（2026-10-23）】把"是谁声明的"带下去：冲突时就嵌套到这个目录；
          // 声明名与 range 也带上（根上已有同名包时据此判"够不够用"）。
          parentDir: finalDest,
          depName: depKey,
          range: String(deps[depKey] === undefined ? '' : deps[depKey]),
        });
      }
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  /*
   * 【安装后依赖自检（2026-10-23 事故的配套保险）】见 collectDependencyWarnings 的注释。
   *
   * 为什么做成闭包、在**每个成功分支**分别调用：体检的输入是 profile 的
   * `package.json.dependencies`（顶层插件清单），而三个成功分支都是在"登记完
   * profile 依赖之后"才 return 的——提前算会把**刚装好的顶层插件**漏掉（它还没
   * 进 dependencies）。代价是每次安装多读几十个 manifest，端侧可忽略。
   *
   * 永远不因体检本身失败而让安装失败：它是**诊断**，不是落位的一部分。
   */
  const dependencySelfCheck = () => {
    let warnings = [];
    try {
      warnings = collectDependencyWarnings(profileDir);
    } catch (e) {
      log('依赖体检失败（忽略）：' + (e && e.message ? e.message : e));
    }
    if (warnings.length > 0) {
      log('依赖体检：' + warnings.length + ' 处告警（相关插件下次 import 会失败）：');
      for (const w of warnings) {
        log('  · ' + w.pkg + ' 需要 ' + w.dep + '@' + w.range + '，实际 '
          + (w.found.length > 0 ? w.found + '（解析到 ' + w.from + '）' : '未安装'));
      }
    }
    return warnings;
  };
  if (installed.length === 0) {
    // 之前 "没有新装任何包" 被 web/市场侧判成失败（ok:false + .fail），但真 pnpm add
    // 幂等：包早已装好 → 应视为成功（ok:true）。且【关键是】已有目录不一定登记进了
    // profile（用户插件行/package.json dependencies）——市场安装报"成功但 profile 无
    // 变化"正是这种：node_modules 在、行没写。所以幂等分支也要把顶层包的行 + 依赖补上。
    let topIdRaw = '';
    const gh = parseGitHub(spec.trim());
    const np = parseNpm(spec.trim());
    if (np !== null) {
      topIdRaw = np.name;
    } else if (gh !== null) {
      topIdRaw = gh.owner + '--' + gh.repo; // 与 resolveSpec 的 GitHub 占位名一致（落位后会按 tarball 内名修正，此处仅尽力）
    }
    // 【GitHub 形态补一步】占位名匹配不到时，按 manifest 的 repository 反查真实包名
    // （见 findInstalledByRepository 注释：回退装成 npm 名之后，再贴 GitHub 地址就是
    // 走到这里）。找到就用它——否则下面的幂等返回会把名字说错。
    if (gh !== null && !fs.existsSync(path.join(profileDir, 'node_modules', topIdRaw, 'package.json'))) {
      const byRepo = findInstalledByRepository(profileDir, spec.trim());
      if (byRepo.length > 0) {
        topIdRaw = byRepo;
      }
    }
    if (topIdRaw.length > 0
      && fs.existsSync(path.join(profileDir, 'node_modules', topIdRaw, 'package.json'))) {
      let ver = '';
      const metaPkg = readJsonSafe(path.join(profileDir, 'node_modules', topIdRaw, 'package.json'));
      if (metaPkg && typeof metaPkg.version === 'string') {
        ver = metaPkg.version;
      }
      // 【登记门控（2026-09-25 报告）】幂等分支同样按"登记到哪"的判定走：从**已落位
      // manifest 现读一次**（不能复用 topPkgForRow——那条路径没被走到）。
      const disp2 = topPackageDisposition(metaPkg);
      mergeDependencies(profileDir, [{ name: topIdRaw, version: ver, spec: spec.trim() }]);
      if (disp2.kind === 'bundle') {
        const added2 = appendProfileBundle(profileDir, topIdRaw);
        log(added2
          ? 'bundle 型包已补登记进 dsh.profile.bundles：' + topIdRaw
          : 'bundle 型包已在 dsh.profile.bundles 中：' + topIdRaw);
      }
      return {
        ok: true,
        name: topIdRaw,
        version: ver,
        installed: [],
        // 【安装后依赖自检】幂等分支同样体检：老 profile 里"被别人的安装换掉依赖"
        // 的插件，重装一次就能在 .done/宿主日志里看到原因，不用再猜"重启后生效"。
        depWarnings: dependencySelfCheck(),
        note: disp2.kind === 'bundle'
          ? '包已存在，已确认登记进 profile（重启应用后挂载生效）'
          : '包已存在（幂等；plain dependency 不登记为 profile 层）',
      };
    }
    return {
      ok: true,
      name: topIdRaw,
      installed: [],
      depWarnings: dependencySelfCheck(),
      note: '包已存在（幂等，无需重装）',
    };
  }
  // 只写顶层包一行（对齐真 pnpm add 行为）：上游 installBundle 靠 dependencies
  // 的 diff 确定"装了哪一个包"（dsh-plugin-manager index.js:921-924，新增 key
  // 数 ≠1 即 ManagementFailure("ambiguous-install")）。2026-09-23 真机实测：
  // dshmarket（带依赖树的 bundle）整棵写入 → diff 出 N 个 → web UI 报"无法从
  // 依赖变更中确定装了哪一个包"。真 pnpm add 也只写 spec 一行（依赖树进
  // lock/node_modules）；端侧 dependencies 字段的唯一读者就是该 diff——cordis
  // 挂载认 node_modules 落位 + patch 行，不认它。子包明细仍完整保留在返回值
  // installed 数组（.done JSON → UI 安装详情）。
  mergeDependencies(profileDir, [{ name: topName, version: topVersion, spec: spec.trim() }]);
  // 【登记门控（2026-09-25 报告：billion-context 装了不生效）】见 topPackageDisposition
  // 的完整证据：声明 dsh.bundle 的包落点是 **dsh.profile.bundles**（与上游 reconcile 一致），
  // **不写用户行**（它的 entry 由它自己的 patch 插入，行名对不上 ⇒ 孤儿行 + 市场 toggle 报错）。
  const disp = topPackageDisposition(topPkgForRow);
  if (disp.kind === 'bundle') {
    const added = appendProfileBundle(profileDir, topName);
    log(added
      ? 'bundle 型包已登记进 dsh.profile.bundles：' + topName + '（重启应用后挂载生效）'
      : 'bundle 型包已在 dsh.profile.bundles 中：' + topName);
  } else {
    log('顶层包未声明 dsh.bundle（plain dependency），只落 node_modules、不登记为 profile 层：' + topName);
  }
  return {
    ok: true,
    name: topName,
    version: topVersion,
    // 【P1-2】漂移重装时把旧版本带出来：`beforeVersion` 仅在"因版本不一致被顶掉"时存在，
    // 让 .done JSON 自证"这次为什么重装"（否则只有 installed 非空，看不出是漂移还是首次装）。
    beforeVersion: topBeforeVersion || (beforeVersions.has(topName) ? beforeVersions.get(topName) : ''),
    afterVersion: topVersion,
    installed: installed,
    // 【安装后依赖自检】空数组 = 所有顶层插件的必装依赖都解析得到且版本满足 range；
    // 非空 = `[{pkg, dep, range, found, from}]`，直接指出"哪个包、要什么、实际解析到哪"。
    depWarnings: dependencySelfCheck(),
    registry: registry,
    note: note + githubFallbackNote,
  };
}

// ── 卸载 ──────────────────────────────────────────────────────────────
/**
 * 卸载一个插件 spec（web 插件页「卸载」通过 pnpm rm → 假壳少 .rem 请求 →
 * 本函数）。与 installSpec 同契约：{ ok, name, ... }，失败走返回值不抛。
 *
 * 删除量：node_modules/<name>、package.json 的 dependencies/peerDependencies
 * /dsh.profile.bundles 里的对应条目、.dshm-plugin-rows.yml 的 `- id: <name>` 块、
 * cordis.patch.yml 里对应的 name / - id: 行。幂等：本不存在也返回 ok。
 */
async function removeSpec(spec, opts) {
  try {
    return await removeSpecInner(spec, opts);
  } catch (e) {
    // 契约同 installSpec：不抛错，失败走返回值
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/*
 * 【已删除的旧实现（2026-10-24 A2）】`removeRowBlockById` / `removeRowBlockByIdSuffix`
 * 曾是"按文本行过滤"的整块删除尝试：只匹配顶层 `- id:`、遇空行即截断、不认 `name:`-only
 * 行。它们表达的历史判据（剥引号比较、`&path:` 后缀的词边界规则）已全部并入
 * `removeRowBlocks`——**不要再写第三份**。旧函数连同注释一并删除，是因为"同一个语义
 * 有两份实现"正是这次事故的起因（第 3 步删整块、第 4 步只删行）。
 */

/*
 * ── 卸载不再写坏 overlay：removeRowBlocks（2026-10-24 事故根治的核心）──────────
 *
 * 【为什么需要它】旧实现是**按文本行过滤**：`removeSpecInner` 第 4 步
 *   `patch.split('\n').filter((l) => !isTargetLine(l))`
 * 只删 `- id:` / `name:` 两行，把 `config:` / `disabled:` 等子键留在原地 ⇒ 下次启动
 * `duplicated mapping key` ⇒ BOOT_40 fatal（10-08 / 10-09 / 10-24 三次同形事故）。
 * 同一文件的第 3 步（`removeRowBlockById`）反而是"删整块"的正确语义——第 4 步是漏网的。
 *
 * 【本函数的契约】
 *   · 命中身份行（`- id:` / `- name:` / 直接子键 `name:`）后**回溯到 row 起点**，
 *     删除整条 row（含缩进子键、嵌套子行、块内空行与注释）；
 *   · 未命中的内容**逐字节不变**，不重排、不重新序列化（保留注释/格式/缩进风格）；
 *   · 保留原行尾风格（`\n` / `\r\n` 混排也按行原样保留）；
 *   · `- insert:` 容器若**因本次删除**变空，连同容器行一起回收（否则 insert 变 null）；
 *   · 无命中 ⇒ 返回原文（调用方可据 `removed === 0` 决定不写盘，保 mtime）。
 *
 * 【身份匹配的两类位置（关键：不能把 config: 里的 name/id 当身份）】
 *   1) row 起点：`- id: X` / `- name: X`；
 *   2) 直接子键：`  name: X`，且缩进 = 父 row 起点 + 2、父 row 起点必须是 `- id:`
 *      （`- insert:` 容器下的 `name:` 是容器属性，不是身份）。
 *   更深缩进（`config:` 内部、`insert:` 的 config 内部）一律不匹配。
 *
 * @param {string} text  文件全文
 * @param {{ids?: string[], suffixes?: string[]}} identity 候选 id/name（裸值）与 &path: 后缀
 * @returns {{text: string, removed: number}} removed = 被删掉的 row 条数（同一 row 多次命中只算 1）
 */
function removeRowBlocks(text, identity) {
  const src = typeof text === 'string' ? text : '';
  const identityObj = identity !== null && typeof identity === 'object' ? identity : {};
  const ids = Array.isArray(identityObj.ids)
    ? identityObj.ids.map((v) => stripYamlQuotes(v)).filter((v) => v.length > 0) : [];
  const suffixes = Array.isArray(identityObj.suffixes)
    ? identityObj.suffixes.map((v) => stripYamlQuotes(v)).filter((v) => v.length > 0) : [];
  if (ids.length === 0 && suffixes.length === 0) {
    return { text: src, removed: 0 };
  }
  const lines = splitLinesKeepEol(src);
  const bodies = lines.map((raw) => raw.replace(/\r?\n$/, ''));
  const indents = bodies.map((body) => leadingSpaces(body));
  /** 行是否为空行（整行只有空白）。 */
  const blankAt = (i) => bodies[i].trim().length === 0;
  /** 行是否 list item 起点（`- `）。 */
  const rowAt = (i) => /^\s*-\s+/.test(bodies[i]);
  /** 行是否 `- insert:` 容器（可带行内注释）。 */
  const insertAt = (i) => /^\s*-\s+insert:\s*(?:#.*)?$/.test(bodies[i]);

  // ── 1) 找身份行 → 回溯 row 起点 ────────────────────────────────────────
  const starts = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (blankAt(i)) {
      continue;
    }
    const rowHit = /^(\s*)-\s+(id|name):\s*(.*)$/.exec(bodies[i]);
    if (rowHit !== null) {
      const value = yamlScalarOf(rowHit[3]);
      if (value.length > 0 && identityMatches(value, ids, suffixes)) {
        starts.add(i);
      }
      continue;
    }
    const childHit = /^(\s*)name:\s*(.*)$/.exec(bodies[i]);
    if (childHit === null) {
      continue;
    }
    // 只认"直接子键"：先回溯最近的 `- ` 行；父行必须是 `- id:`，缩进差恰好 2。
    let p = i - 1;
    while (p >= 0 && (blankAt(p) || !rowAt(p))) {
      p -= 1;
    }
    if (p < 0) {
      continue;
    }
    const parentIsId = /^\s*-\s+id:/.test(bodies[p]);
    const childIndent = childHit[1].length;
    if (!parentIsId || childIndent !== indents[p] + 2) {
      continue;
    }
    const value = yamlScalarOf(childHit[2]);
    if (value.length > 0 && identityMatches(value, ids, suffixes)) {
      starts.add(p);
    }
  }
  if (starts.size === 0) {
    return { text: src, removed: 0 };
  }

  // ── 2) 每个 row 起点 → 块范围（含块内空行/注释，止于缩进 ≤ rowIndent 的非空行）──
  const doomed = new Array(lines.length).fill(false);
  for (const start of starts) {
    const rowIndent = indents[start];
    let end = start + 1;
    while (end < lines.length) {
      if (blankAt(end)) {
        // 空行是否属于本块：看它后面第一个非空行是否更深（同一 row 的分隔行）。
        let j = end + 1;
        while (j < lines.length && blankAt(j)) {
          j += 1;
        }
        if (j < lines.length && indents[j] > rowIndent) {
          end = j; // 空行属于块，继续从更深行开始判定
          continue;
        }
        break; // 空行即块边界（不删空行，保持与相邻 row 的间隔）
      }
      if (indents[end] > rowIndent) {
        end += 1;
        continue;
      }
      break;
    }
    for (let k = start; k < end; k++) {
      doomed[k] = true;
    }
  }

  // ── 3) `- insert:` 容器回收：只清理"因本次删除才变空"的容器 ──────────────
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < lines.length; i++) {
      if (doomed[i] || !insertAt(i)) {
        continue;
      }
      const cIndent = indents[i];
      let originalChildren = 0;
      let remaining = 0;
      let j = i + 1;
      while (j < lines.length) {
        if (blankAt(j)) {
          j += 1;
          continue;
        }
        if (indents[j] <= cIndent) {
          break;
        }
        originalChildren += 1;
        if (!doomed[j]) {
          remaining += 1;
        }
        j += 1;
      }
      if (originalChildren > 0 && remaining === 0) {
        doomed[i] = true; // 容器刚变空 ⇒ 一并回收（保留其后的空行，不影响别的 row）
        changed = true;
      }
    }
  }

  return { text: lines.filter((_, idx) => !doomed[idx]).join(''), removed: starts.size };
}

/** 剥掉成对的 YAML 引号（只用于比较，不改原文）。 */
function stripYamlQuotes(value) {
  const s = String(value === undefined || value === null ? '' : value).trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * 解析 id/name 行冒号后的标量：支持 'x' / "x" / 裸值 + 行内注释。
 * 只服务包名/id（不含空格的常规值），不实现完整 YAML 标量语义。
 */
function yamlScalarOf(rest) {
  const s = String(rest === undefined || rest === null ? '' : rest).trim();
  if (s.length === 0) {
    return '';
  }
  const quoted = /^('([^']*)'|"([^"]*)")\s*(?:#.*)?$/.exec(s);
  if (quoted !== null) {
    return quoted[2] !== undefined ? quoted[2] : quoted[3];
  }
  const hash = s.indexOf(' #');
  return (hash >= 0 ? s.slice(0, hash) : s).trim();
}

/** 身份匹配：ids 完全相等；suffixes 沿用旧 removeRowBlockByIdSuffix 的词边界规则（语义不回退，见 A1 门禁 §7）。 */
function identityMatches(value, ids, suffixes) {
  const v = stripYamlQuotes(value);
  if (v.length === 0) {
    return false;
  }
  for (const id of ids) {
    if (v === id) {
      return true;
    }
  }
  for (const suffix of suffixes) {
    if (v === suffix) {
      return true;
    }
    if (suffix.length > 0 && v.endsWith(suffix)) {
      const sep = v.charAt(v.length - suffix.length - 1);
      if (sep === '-' || sep === '/' || sep === '@') {
        return true;
      }
    }
  }
  return false;
}

/** 拆行并**保留每行原行尾**（`\n` / `\r\n`）；删除整行时风格天然保留。 */
function splitLinesKeepEol(text) {
  if (text.length === 0) {
    return [];
  }
  return text.split(/(?<=\n)/);
}

/** 前导空格数（tab 计 1；这些文件约定 2 空格缩进，不做完整 YAML 缩进语义）。 */
function leadingSpaces(body) {
  let n = 0;
  while (n < body.length && (body.charAt(n) === ' ' || body.charAt(n) === '\t')) {
    n += 1;
  }
  return n;
}

/** 从 spec 文本剥离范围/版本，还原成纯包名（@scope/name 或 name）。 */
function barePackageName(spec) {
  let s = String(spec || '').trim();
  const slash = s.indexOf('/');
  if (s.startsWith('@') && slash !== -1) {
    const verAt = s.indexOf('@', slash + 1);
    if (verAt !== -1) {
      s = s.slice(0, verAt);
    }
    return s;
  }
  const at = s.indexOf('@');
  if (at > 0) {
    s = s.slice(0, at);
  }
  return s;
}

async function removeSpecInner(spec, opts) {
  const homeDir = opts.homeDir;
  const profile = opts.profile || 'ondevice';
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (!homeDir || typeof spec !== 'string' || spec.trim().length === 0) {
    return { ok: false, error: '参数缺失（homeDir/spec）' };
  }
  const name = barePackageName(spec);
  if (!name) {
    return { ok: false, error: '无法识别包名：' + spec };
  }
  const profileDir = (typeof opts.profileDir === 'string' && opts.profileDir.length > 0)
    ? opts.profileDir
    : path.join(homeDir, 'profiles', profile);

  /*
   * 【`&path:` 皮肤卸载后用户行残留】——报告 7 §2 / 报告 8 §1
   *
   * 现象：卸载后包与依赖都删干净了（依赖: 0），`.dshm-plugin-rows.yml` 仍留着
   * `- id: '@dsh-external/dsh-client-ui-skin-maid-atelier'`。
   *
   * 【根因有两层，都要治】
   *   ① **名字来源不同**：安装时写进行的名字来自**子目录 manifest 的 `package.json.name`**
   *      （`&path:` 皮肤的真实包名），而卸载只拿 spec 解析出的一个名字
   *      （GitHub 占位名 `owner--repo`、或市场展示名）⇒ 不是同一个字符串。
   *   ② **引号**（真正的拦路虎：composeUserRows 会把它回写成带引号形式）：`composeUserRows` 会把
   *      `@scope/name` 回写成带引号的 `- id: '@scope/name'` 并落盘，而比较用的是裸名
   *      ⇒ 永远匹配不上。**只修 ① 不修 ② 仍然删不掉**——这正是报告 7 修过、报告 8
   *      又复现的原因。
   *
   * 【修法】候选名集合（多路匹配）+ removeRowBlocks 剥引号比较：
   *   ① spec 解析出的名字（覆盖 npm 与无 subpath 的 GitHub 包）；
   *   ② **已装 manifest 的 `name`**：从 profile `dependencies` 里找出"值就是这个 spec"
   *      的条目名——这是最可靠的一路，因为安装时写进 dependencies 的正是它；
   *   ③ `&path:` 的子目录名兜底（manifest 已丢但行还在时）。
   */
  const candidates = new Set();
  // ① spec 解析出的名字：**只在它看起来像包名时才收**。GitHub 形态的 spec 整串是
  //    `github:owner/repo#ref&path:/x`，那个串不是包名，收进候选只会让日志噪声
  //    （实测：候选里出现整条 spec）。npm 形态（`name` / `@scope/name`）才收。
  if (parseGitHub(name) === null) {
    candidates.add(name);
  }
  // ② 从 profile dependencies 反查真实 name
  try {
    const pkgPath0 = path.join(profileDir, 'package.json');
    const pkg0 = readJsonSafe(pkgPath0);
    const deps0 = pkg0 && typeof pkg0 === 'object' && pkg0.dependencies && typeof pkg0.dependencies === 'object'
      ? pkg0.dependencies : {};
    const specTrim = spec.trim();
    for (const depName of Object.keys(deps0)) {
      const depSpec = String(deps0[depName]);
      // 依赖值就是安装时写的请求 spec（见 mergeDependencies 的 dependencyValueFor）：
      // 与本 spec 相同、或去掉 #ref 后主干相同，即认定是同一个包。
      const sameSpec = depSpec === specTrim
        || depSpec.split('#')[0] === specTrim.split('#')[0];
      if (sameSpec) {
        candidates.add(depName);
      }
    }
  } catch (e) {
    // 读不到就只靠 ①/③
  }
  /*
   * ③ `&path:` 子目录名 —— **按后缀匹配**，不是精确相等。
   *
   * 【为什么后缀】`&path:` 皮肤在 profile 里登记的真实包名是**子目录 manifest 的 name**，
   * 而它是带 scope 的完整名（如 `@dsh-external/dsh-client-ui-skin-maid-atelier`），
   * 光凭子目录名 `maid-atelier` **推不出** scope 前缀（那来自仓库里的 manifest，
   * 此刻可能已被删掉、依赖也已清空——报告实测的正是这种"包与依赖都不在了"的残局）。
   * 但它一定是"以子目录名结尾"的（`…-maid-atelier` / `…/maid-atelier` / `maid-atelier`）。
   * 故对**行 id** 用后缀匹配：能删掉孤儿行，又不会误伤别的包
   * （子目录名本身足够独特；且精确匹配仍走 ①/②）。
   */
  let suffixCandidates = [];
  try {
    const gh = parseGitHub(spec.trim());
    if (gh !== null && typeof gh.subpath === 'string' && gh.subpath.length > 0) {
      const seg = gh.subpath.split('/').filter((s) => s.length > 0 && s !== '.');
      if (seg.length > 0) {
        const base = seg[seg.length - 1];
        candidates.add(base);
        suffixCandidates.push(base);
      }
    }
  } catch (e) {
    // 解析失败不影响其余路径
  }
  /*
   * ④ GitHub 形态的兜底：`github:owner/repo[-#ref]`（无 `&path:`）在 profile 里登记的
   * 真实包名无从预知（是仓库里 manifest 的 name），候选 ② 只能靠 dependencies 反查；
   * 若那一步没命中（例如依赖已被手工清掉），至少还能按 `owner--repo` 占位名清一次。
   * 【为什么必须有这条】报告实测过"包与依赖都删了"的情形——依赖已不在 package.json，
   * ② 就查不到；此时若 names 为空，四次清理**一个都不执行**，卸载变成 no-op。
   */
  try {
    const gh0 = parseGitHub(spec.trim());
    if (gh0 !== null) {
      candidates.add(gh0.owner + '--' + gh0.repo);
    }
  } catch (e) {
    // 忽略
  }
  const names = Array.from(candidates);
  if (names.length === 0) {
    // 极端情况：连占位名都构造不出（spec 形态前所未见）。如实返回，不假装清干净。
    return { ok: false, error: '无法从 spec 推出任何候选包名：' + spec };
  }
  log('卸载候选项（spec 名 / 已装 manifest 名 / 子目录名 / GitHub 占位名）：' + names.join('、'));
  const removed = [];

  for (const name of names) {
    // 1) node_modules/<name>
    const nmDest = path.join(profileDir, 'node_modules', name);
    if (fs.existsSync(nmDest)) {
      fs.rmSync(nmDest, { recursive: true, force: true });
      removed.push('node_modules/' + name);
      log('已删除包目录：' + name);
    }
  }

  // 2) profile/package.json：dependencies / peerDependencies / dsh.profile.bundles
  const pkgPath = path.join(profileDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = readJsonSafe(pkgPath);
      let changed = false;
      if (pkg && typeof pkg === 'object' && !Array.isArray(pkg)) {
        for (const field of ['dependencies', 'peerDependencies']) {
          const deps = pkg[field];
          if (deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
            for (const n of names) {
              if (Object.prototype.hasOwnProperty.call(deps, n)) {
                delete deps[n];
                changed = true;
              }
            }
          }
        }
        const bundles = pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)
          ? pkg.dsh.profile.bundles : null;
        if (bundles !== null) {
          const kept = bundles.filter((b) => !names.includes(b));
          if (kept.length !== bundles.length) {
            pkg.dsh.profile.bundles = kept;
            changed = true;
          }
        }
      }
      if (changed) {
        const serialized = JSON.stringify(pkg ?? {}, null, 2) + '\n';
        try {
          JSON.parse(serialized); // 写前校验：序列化结果必须可解析（防御性，成本可忽略）
        } catch (e) {
          return { ok: false, error: 'package.json 序列化失败，未写入：' + (e && e.message ? e.message : e) };
        }
        yamlCheck.writeFileAtomicSync(pkgPath, serialized);
        removed.push('package.json 依赖');
      }
    } catch (e) {
      // 写坏 package.json 同样会让 boot fatal ⇒ 必须上报，不再"忽略"
      return { ok: false, error: '更新 package.json 失败：' + (e && e.message ? e.message : e) };
    }
  }

  /*
   * 【卸载写盘的三条纪律（2026-10-24，规格 §A3）】
   *   ① 只在真的删到内容时才写（`removed === 0` ⇒ 不写，mtime 不动）；
   *   ② 写前备份、写用原子 rename；写后**严格解析**，失败立刻回滚并返回 ok:false——
   *      "文件写坏了但回执 ok:true"是这次事故最坏的放大器，禁止再出现；
   *   ③ 解析器与 boot 同源（dshm-yaml-check.js），不引入新的运行时依赖。
   */
  const yamlOpts = {
    coreDir: typeof opts.coreDir === 'string' ? opts.coreDir : '',
    homeDir,
    profileDir,
  };

  // 3) 用户插件行 .dshm-plugin-rows.yml —— 整块删除（含 config:/disabled: 子键）
  const rowsPath = path.join(profileDir, '.dshm-plugin-rows.yml');
  if (fs.existsSync(rowsPath)) {
    try {
      const before = fs.readFileSync(rowsPath, 'utf8');
      const { text, removed: n } = removeRowBlocks(before, { ids: names, suffixes: suffixCandidates });
      if (n > 0 && text !== before) {
        const backup = yamlCheck.backupFileSync(rowsPath, 'uninstall');
        yamlCheck.writeFileAtomicSync(rowsPath, text);
        const chk = yamlCheck.strictParseYaml(text, yamlOpts);
        if (!chk.ok) {
          fs.copyFileSync(backup, rowsPath); // 回滚：用户行文件同样会让 boot fatal
          return { ok: false, error: '卸载后 .dshm-plugin-rows.yml 解析失败，已回滚：' + chk.reason };
        }
        yamlCheck.pruneBackupsSync(rowsPath, 'uninstall', 10);
        removed.push('.dshm-plugin-rows.yml');
        log('已整块删除用户插件行（' + n + ' 条）');
      }
    } catch (e) {
      return { ok: false, error: '更新用户插件行失败：' + (e && e.message ? e.message : e) };
    }
  }

  // 4) cordis.patch.yml —— 同样的整块删除 + 写后校验（这次事故的直接源头）
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  if (fs.existsSync(patchPath)) {
    try {
      const before = fs.readFileSync(patchPath, 'utf8');
      const { text, removed: n } = removeRowBlocks(before, { ids: names, suffixes: suffixCandidates });
      if (n > 0 && text !== before) {
        const backup = yamlCheck.backupFileSync(patchPath, 'uninstall');
        yamlCheck.writeFileAtomicSync(patchPath, text);
        const chk = yamlCheck.strictParseYaml(text, yamlOpts);
        if (!chk.ok) {
          fs.copyFileSync(backup, patchPath); // 回滚到写前（宁可卸载失败，不留坏 profile）
          return { ok: false, error: '卸载后 cordis.patch.yml 解析失败，已回滚：' + chk.reason };
        }
        yamlCheck.pruneBackupsSync(patchPath, 'uninstall', 10);
        removed.push('cordis.patch.yml');
        log('已整块删除 patch 行（' + n + ' 条）');
      }
    } catch (e) {
      return { ok: false, error: '更新 cordis.patch.yml 失败：' + (e && e.message ? e.message : e) };
    }
  }

  // 5) 市场行 .dshm-market-rows.yml —— 用现成语义做"包不在 ⇒ 清托管行"（否则 boot 后
  //    市场页仍会显示一个装不出来的插件；在 5) 之前那四步只清 profile 自己的文件）。
  try {
    ensureMarketRows(profileDir, profile, { log });
  } catch (e) {
    log('清理市场行失败（忽略）：' + (e && e.message ? e.message : e));
  }

  return {
    ok: true,
    name,
    removed,
    note: removed.length > 0 ? '已卸载（重启应用后正式生效）' : '该插件本不存在（幂等）',
  };
}

module.exports = {
  installSpec,
  removeSpec,
  extractTar,
  resolveSpec,
  readRegistry,
  DEFAULT_REGISTRY,
  dshmSkinAlias,
  readInstalledVersion,
  versionDrifted,
  // 【为什么导出这两个纯函数】它们的判据是"猜测"性质的（下探哪个目录、回退到哪个包），
  // 靠集成测试只能覆盖到手上恰好有的那几个仓库。导出后可在门禁里用临时目录把边界
  // （多候选、node_modules 干扰、不同仓库、repository 缺失）逐条钉住，零网络。
  findPackageRoots,
  repositoryMatchesRequest,
  // 【冲突嵌套（2026-10-23）】导出判据与体检函数：门禁里用临时目录/临时 profile
  // 把"range 判定 → 嵌套落位 → depWarnings"逐条钉住（零网络也能验一半）。
  versionSatisfies,
  collectDependencyWarnings,
  // 【卸载整块删除（2026-10-24）】纯函数，供零网络门禁 check-dshm-uninstall.cjs 直接
  // 逐条钉住 14 条边界 + 历史事故 fixture；接线在 removeSpecInner 第 3/4 步（A2）。
  removeRowBlocks,
  // 【A3 写盘加固】导出供零网络门禁在临时 profile 上验"原子写/写前校验/坏文件留档"。
  mergeDependencies,
  appendProfileBundle,
};
