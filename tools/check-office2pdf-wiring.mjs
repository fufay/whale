#!/usr/bin/env node
/**
 * 门禁：Office 预览走 HAP 内置 office2pdf 的**接线**是否完整。
 *
 * 为什么需要它（2026-10-29 的教训，全是实测踩出来的）：
 *   这条链路有 6 个**互相独立**的接点，任一断开都会静默退化成"该格式文件暂时无法预览"，
 *   而且从页面上完全看不出断在哪：
 *     ① profile 必须 `disabled: true` 掉**上游** `office-kit`（rc.2 起它注册同名 `officeKit`
 *        服务，且底层 LibreOfficeKit 在 openharmony-arm64 上不可达）；
 *     ② profile 必须启用我们自己的 `dshm-office2pdf`（注册同名服务，顶替上游实现）；
 *     ③ profile 必须**停用** `dshm-office-system-preview`（它以 priority:"extension" 认领
 *        doc/docx/ppt/pptx，会盖过官方 builtin 实现 ⇒ 官方 OfficeBody 永不运行）；
 *     ④ 插件宿主半边的方法参数名必须**逐字**是 `workspaceFileScope` —— Gateway 的
 *        source-mode 按参数名查 wire 映射（`workspaceFileScope` → `workspaceFileScopeId`），
 *        换个名字就报 `args fields do not match the descriptor`；
 *     ⑤ 插件**不能**导出 `apply` —— cordis 见 apply 就不实例化 default 类 ⇒ 服务注册不上；
 *     ⑥ C++ 外壳必须由 **CMake** 构建（`add_library`）+ `DT_NEEDED libnode.so.137`，
 *        且 HAP 的 `libs/` 里要有 Rust 的 `liboffice2pdf_capi.so` 与 CMake 的
 *        `liboffice2pdf_ext.so`；另外 ArkTS 侧要有系统字体桥把 Noto CJK 放进应用目录。
 *
 * 全部是**仓库内静态判据**（读文件 + 正则），不需要核心树/设备 ⇒ 可进 CI。
 *
 * 退出码：0 = 接线完整；1 = 有断点（逐条打印）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const passes = [];

/** 断言一条判据。 */
function check(label, condition, detail) {
  if (condition) {
    passes.push(label);
  } else {
    failures.push(detail === undefined ? label : `${label}：${detail}`);
  }
}

function read(relPath) {
  const full = join(ROOT, relPath);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
}

/* ── ① profile：上游 office-to-pdf 被停用 ───────────────────────────────── */
{
  const profile = read('hostcore/profile/ondevice/cordis.patch.yml');
  check('① profile 停用上游 office-to-pdf',
    /- id:\s*office-kit\s*\n\s*disabled:\s*true/.test(profile),
    'profile 里应出现 `- id: office-kit` + `disabled: true`（rc.2 起上游包改名）');
  check('① profile 启用 dshm-office2pdf',
    /- id:\s*dshm-office2pdf\s*\n\s*name:\s*'@deepseek-ai\/dshm-office2pdf'/.test(profile),
    'profile 里应插入 dshm-office2pdf 行');
  check('③ profile 停用 dshm-office-system-preview（让出 doc/docx/ppt/pptx 认领）',
    /- id:\s*dshm-office-system-preview\s*\n\s*name:\s*'@deepseek-ai\/dshm-office-system-preview'\s*\n\s*disabled:\s*true/.test(profile),
    'dshm-office-system-preview 应 disabled: true（否则它盖过官方 builtin 认领）');
}

/* ── ②/⑤ 插件宿主半边 ──────────────────────────────────────────────────── */
{
  const host = read('hostcore/plugins/dshm-office2pdf/lib/index.js');
  check('② 宿主插件注册同名服务 officeToPdf',
    host.includes('super(ctx, SERVICE_KEY)') && host.includes("const SERVICE_KEY = 'officeKit'"),
    '应以 super(ctx, "officeKit") 注册服务（rc.2 契约）');
  check('④ render 参数名逐字为 workspaceFileScope',
    /async render\(\s*workspaceFileScope\s*,\s*path\s*,\s*priority\s*,\s*signal\s*\)/.test(host),
    'Gateway source-mode 按参数名查 wire 映射，必须叫 workspaceFileScope');
  check('④ getGeneration 暴露为 generation',
    /method:\s*'getGeneration'\s*,\s*exportName:\s*'generation'/.test(host),
    'Remote 标记里的 exportName 应为 generation');
  check('⑤ 宿主半边不导出 apply（否则 cordis 不实例化 default 类）',
    !/export\s+function\s+apply\b/.test(host),
    'index.js 不能有 `export function apply`');
  check('② 宿主半边 export default 类',
    /export default Office2PdfService/.test(host),
    '应 export default 服务类，cordis 才会实例化');
  check('② 返回结构与官方契约一致（8 个字段）',
    ['absolutePath', 'version', 'offset', 'eof', 'bytes', 'data', 'missingFonts', 'generation']
      .every((field) => new RegExp(`\\b${field}\\s*:`).test(host)),
    'render() 返回值应含 absolutePath/version/offset/eof/bytes/data/missingFonts/generation');
}

/* ── ② 插件客户端半边：不得认领预览（认领会让官方 UI 被顶掉）─────────────── */
{
  const client = read('hostcore/plugins/dshm-office2pdf/lib/client.js');
  check('② 客户端半边不注册 documentPreviews（不认领后缀）',
    !client.includes('documentPreviews.register'),
    'client.js 若认领后缀会顶掉官方 OfficeBody / PDF 渲染器');
}

/* ── ⑥ HAP 侧：C++ 外壳 + CMake target + libs 产物 ───────────────────────── */
{
  const cpp = read('entry/src/main/cpp/office2pdf_ext.cpp');
  check('⑥ C++ 外壳存在且用 Node 口径注册（NAPI_MODULE）',
    cpp.includes('NAPI_MODULE(office2pdf_ext, Init)'),
    'office2pdf_ext.cpp 应含 NAPI_MODULE(office2pdf_ext, Init)');
  // 只看**真正的 #include 行**：注释里讨论 `napi/native_api.h`（ArkTS 直调的历史结论）是允许的
  const includeLines = cpp.split('\n').filter((line) => /^\s*#include\b/.test(line));
  check('⑥ C++ 外壳 include <node_api.h>（不是 napi/native_api.h）',
    includeLines.some((line) => line.includes('<node_api.h>'))
    && !includeLines.some((line) => line.includes('napi/native_api.h')),
    'NAPI_MODULE 宏只在 node_api.h 里；OHOS 的 native_api.h 没有它');
  check('⑥ C++ 外壳运行时 dlopen Rust 库',
    cpp.includes('dlopen(kLibName') && cpp.includes('office2pdf_convert'),
    '外壳应 dlopen liboffice2pdf_capi.so 并 dlsym office2pdf_convert');

  const cmake = read('entry/src/main/cpp/CMakeLists.txt');
  check('⑥ CMake 构建 office2pdf_ext 并链 libnode',
    /add_library\(office2pdf_ext SHARED office2pdf_ext\.cpp\)/.test(cmake)
    && /target_link_libraries\(office2pdf_ext PRIVATE \$\{O2P_LIBNODE\} dl\)/.test(cmake),
    '手工拷 .so 不会被 ArkTS 实例化（见 CMakeLists 头注）⇒ 必须由 CMake 构建');

  const libsDir = join(ROOT, 'entry/libs/arm64-v8a');
  const libs = existsSync(libsDir) ? readdirSync(libsDir) : [];
  check('⑥ entry/libs 有 liboffice2pdf_capi.so（Rust 引擎，跑 tools/office2pdf/build-capi.sh 生成）',
    libs.includes('liboffice2pdf_capi.so'),
    '缺它 ⇒ 转换端点会回 503（`office2pdf 桥不可用`）');
  check('⑥ entry/libs 有 libnode.so.137（外壳 NAPI 符号来源）',
    libs.some((name) => name.startsWith('libnode.so')),
    '缺它 ⇒ office2pdf_ext 编不出来（CMake 会跳过并警告）');
}

/* ── ⑥ main.js：桥 + 端点 + 路径白名单 ──────────────────────────────────── */
{
  const main = read('hostcore/app/main.js');
  check('⑥ main.js 有 getOffice2pdfBridge（process.dlopen 加载外壳）',
    main.includes('function getOffice2pdfBridge()') && main.includes('process.dlopen(mod, addon)'),
    '桥是 Host 侧唯一加载点');
  check('⑥ main.js 注册 /dshm-office2pdf/convert 端点',
    main.includes("path: '/dshm-office2pdf/convert'"),
    '插件/客户端靠它拿 PDF 字节');
  check('⑥ 端点路径白名单含用户存储（工作区在 /storage/Users/currentUser 下）',
    main.includes("const USER_STORAGE = '/storage/Users/currentUser'")
    && /function o2pPathAllowed/.test(main),
    '只放行沙箱会让工作区文档 403（`路径越界`）');
  check('⑥ 端点响应带 cache-control: no-transform（避开全局 gzip）',
    main.includes("'cache-control': 'no-transform'"),
    '100 MB 级 PDF 边压边发会打满 CPU');
}

/* ── ⑥ ArkTS 字体桥：Noto CJK 从系统取，不随包带字体 ─────────────────────── */
{
  const font = read('entry/src/main/ets/runtime/Office2pdfFont.ets');
  check('⑥ 字体桥存在且直连 Noto CJK 两个 ttc',
    font.includes('/system/fonts/NotoSerifCJK-Regular.ttc')
    && font.includes('/system/fonts/NotoSansCJK-Regular.ttc'),
    'office2pdf 的宋体链/雅黑链只认 Noto CJK；用错字体会中文行叠行');
  check('⑥ EntryAbility 调用字体桥',
    read('entry/src/main/ets/entryability/EntryAbility.ets').includes('setupOffice2pdfFont'),
    '字体桥需在 loadContent 回调里跑（那时 UIContext 才可用）');
}

/* ── 报告 ───────────────────────────────────────────────────────────────── */
for (const label of passes) console.log('ok   ' + label);
if (failures.length > 0) {
  console.error('');
  for (const failure of failures) console.error('FAIL ' + failure);
  console.error(`\n结果：${passes.length} 通过 / ${failures.length} 失败 —— Office 预览接线有断点（见上）。`);
  process.exit(1);
}
console.log(`\n结果：${passes.length} 项全部通过 —— Office 预览走 HAP 内置 office2pdf 的接线完整。`);
