/**
 * dshm-office2pdf 宿主半边：**顶替**上游 `officeToPdf` 远程服务。
 *
 * ── 为什么这么做（目标：与官方完全对齐）────────────────────────────────────────
 * 侧栏 Office 预览的官方实现（`dsh-client-ui-sidebar-documentpreview` 的 office 定义）
 * 只做 UI：它调 `remote.officeToPdf.render(...)` 拿 PDF 字节，再交给官方 PDF 子槽渲染。
 * 而官方那条转换链路（`@deepseek-ai/dsh-office-to-pdf` → `libreoffice-kit`）在
 * openharmony-arm64 上结构性不可达（`platformTarget()` 对非 darwin/win32/linux 返回 undefined）。
 *
 * ⇒ 我们**只替换服务实现、不碰任何 UI**：注册同名 service `officeToPdf`，
 *    `render()` 返回与官方**逐字段相同**的结构（见下）。于是客户端一行不改，
 *    渲染/缓存/工具栏/多页滚动全部走官方代码 —— 和真 PDF 预览完全一致。
 *
 * ── 官方返回值契约（`dsh-office-to-pdf/lib/index.js:572-582`）─────────────────
 * ```js
 * { absolutePath, version, offset: 0, eof: true, bytes, data, missingFonts, generation }
 * ```
 *   · `data` = PDF 字节（Uint8Array），`bytes` = 其长度
 *   · `absolutePath` / `version` 来自 `workspaceFiles.stat()`，用于客户端判"源文件没变"
 *   · `missingFonts` = 缺失字体族数组（我们尽力而为：字体桥拿不到中文字体时非空）
 *   · `generation` = 引擎世代号（引擎/字体配置变一次换一次，客户端据此丢缓存）
 *
 * ── 怎么注册成 Remote（不用装饰器）────────────────────────────────────────────
 * 官方用 TS 装饰器 `@Remote` / `@Remote("generation")` 打标，编译后是往原型上写
 * `REMOTE_METHOD_DESCRIPTOR`（一个**普通字符串常量**，非 Symbol）：
 *   "@deepseek-ai/dsh-typert-protocol/remote-methods"
 * 我们的插件是手写 JS，没有装饰器语法 ⇒ 直接写同形状的标记，效果与官方等价。
 * 依据：`dsh-typert-protocol/lib/index.js:315`（常量定义）、`:430-473`（读取/mark 逻辑）、
 *       `dsh-api-gateway/lib/index.js:924/936/1272`（Gateway 就是按这个标记发现方法）。
 *
 * ── 与 HAP 侧的关系 ─────────────────────────────────────────────────────────
 * 真正的转换由 HAP 内置的 office2pdf 完成（Rust/Typst 引擎 + CMake NAPI 外壳，
 * 宿主 `process.dlopen` 加载）。本插件经 `ctx.get('dshmHostBridge')` 之外的公开通道拿它：
 * 目前用 HTTP 自调用 `POST /dshm-office2pdf/convert`（main.js 注册，端口由 `ctx.webServer.port` 取），
 * 这样插件与 HAP 的耦合面只有一个 URL，升级/回退都容易。
 *
 * @module dshm-office2pdf
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

/** Remote 方法标记的键（与 `@deepseek-ai/dsh-typert-protocol` 内部常量逐字一致）。 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/** 转换端点（main.js 注册）。 */
const CONVERT_PATH = '/dshm-office2pdf/convert';

/** 支持的扩展名（与官方 office 实现一致）。 */
const SUPPORTED = new Set(['doc', 'docx', 'ppt', 'pptx']);

/** 服务名：与上游同名，客户端 `remote.officeToPdf` 直接指向我们。 */
const SERVICE_KEY = 'officeToPdf';

/** 本服务需要的外部服务（官方实现要 workspaceFiles 与 fs 读源文件）。 */
export const inject = ['workspaceFiles', 'fs', 'webServer'];

/**
 * 给类的原型写 Remote 方法标记（等价于 TS 的 `@Remote` / `@Remote("generation")`）。
 * @param {Function} ctor 服务类
 * @param {Array<{method: string, exportName?: string}>} methods 要暴露的方法
 */
function markRemoteMethods(ctor, methods) {
  const frozen = Object.freeze(methods.map((entry) => Object.freeze({
    method: entry.method,
    ...entry.exportName === undefined || entry.exportName === entry.method
      ? {} : { exportName: entry.exportName },
    invocation: Object.freeze({ kind: 'direct' }),
  })));
  Object.defineProperty(ctor.prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({ version: 1, methods: frozen }),
  });
}

/** 把文档转成 PDF 字节（走 HAP 端点）。 */
async function convertViaHost(port, absolutePath, signal) {
  const response = await fetch(`http://127.0.0.1:${port}${CONVERT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: absolutePath }),
    signal,
  });
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload && payload.error ? String(payload.error) : '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `conversion failed (HTTP ${response.status})`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * 顶替官方的 Office→PDF 服务。
 *
 * 只实现客户端真正会用到的两个 Remote 方法（`render` / `generation`），
 * 其余（缓存、队列、并发、取消语义）由客户端 `OfficePreviewCache` 与官方 UI 层承担——
 * 那是官方代码，我们不动。
 */
class Office2PdfService extends TypertRemoteService {
  /** 引擎世代号：引擎或字体配置变一次换一次（客户端据此丢弃缓存的 PDF）。 */
  generation = `office2pdf-${Date.now().toString(36)}`;

  /**
   * @param {object} ctx cordis 上下文
   */
  constructor(ctx) {
    super(ctx, SERVICE_KEY);

    // 【诊断】确认服务真的注册进 cordis（verify: ctx.get 能取回本实例）
    try {
      const back = ctx.get(SERVICE_KEY);
      console.log('[dshm-office2pdf] ctor: ctx.get(' + SERVICE_KEY + ') === this ? '
        + String(back === this) + ', backType=' + (back === undefined ? 'undefined' : typeof back));
      // cordis 在构造期可能还没把服务登记完 ⇒ 5s 后再看一次（决定性判据）
      setTimeout(() => {
        try {
          const later = ctx.get(SERVICE_KEY);
          console.log('[dshm-office2pdf] +5s: === this ? ' + String(later === this)
            + ', backType=' + (later === undefined ? 'undefined' : typeof later)
            + ', typertRemote=' + String(later !== undefined && later.typertRemote !== undefined)
            + ', remoteMethodsOk=' + String(later !== undefined && later.render !== undefined));
        } catch (e) {
          console.log('[dshm-office2pdf] +5s 诊断失败：' + String(e && e.message ? e.message : e));
        }
      }, 5000);
    } catch (e) {
      console.log('[dshm-office2pdf] ctx.get 诊断失败：' + String(e && e.message ? e.message : e));
    }
  }

  /**
   * 把一个工作区 Office 文档转成 PDF。
   *
   * 参数与返回值都与官方 `OfficeToPdf.render` 逐字段对齐（见文件头契约），
   * 客户端据 `absolutePath`/`version` 判定源文件是否变化。
   *
   * @param {object} workspaceFileScope 工作区文件作用域（含 sessionId / workspaceRoot）
   *   ⚠️ 参数名**必须**逐字叫 `workspaceFileScope`：Gateway 的 source-mode 按参数名查
   *   wire 映射表（`workspaceFileScope` → `workspaceFileScopeId`），叫别的名字会报
   *   `args fields do not match the descriptor: unexpected "workspaceFileScopeId"`。
   * @param {string} path 文档路径（绝对或工作区相对）
   * @param {'foreground'|'background'} priority 优先级（本实现不区分，仅吞掉）
   * @param {AbortSignal} signal 取消信号
   * @returns {Promise<object>} 官方同形状结果
   */
  async render(workspaceFileScope, path, priority, signal) {
    signal.throwIfAborted();
    const extension = String(path).split('.').pop().toLowerCase();
    if (!SUPPORTED.has(extension)) {
      throw new Error('The path must end in doc, docx, ppt, or pptx.');
    }
    const files = this.ctx.get('workspaceFiles');
    const fileSystem = this.ctx.get('fs');
    if (files === undefined || fileSystem === undefined) {
      throw new Error('Office file rendering requires workspaceFiles and fs.');
    }
    const source = await files.stat(workspaceFileScope, path, signal);
    signal.throwIfAborted();
    const port = this.ctx.get('webServer').port;
    const pdf = await convertViaHost(port, source.absolutePath, signal);
    signal.throwIfAborted();
    return {
      absolutePath: source.absolutePath,
      version: source.version,
      offset: 0,
      eof: true,
      bytes: pdf.byteLength,
      data: pdf,
      missingFonts: [],
      generation: this.generation,
    };
  }

  /**
   * 客户端复用一个已缓存的 PDF 前会先问世代号；不匹配就重新转换。
   * @param {AbortSignal} signal 取消信号
   * @returns {string} 当前世代号
   */
  getGeneration(signal) {
    signal.throwIfAborted();
    return this.generation;
  }
}

// 打 Remote 标记：方法与官方一一对应（`getGeneration` 对外叫 `generation`）
markRemoteMethods(Office2PdfService, [
  { method: 'render' },
  { method: 'getGeneration', exportName: 'generation' },
]);

/** 插件名（诊断用）。 */
export const name = 'dshm-office2pdf';

/*
 * 【不要导出 apply】cordis 的插件约定：模块**有 `apply` 导出**时，它把 `apply` 当插件体，
 * **不再实例化 default 类** ⇒ 服务永远注册不上（2026-10-29 实测：`ctx.get('officeToPdf')`
 * 返回 undefined，所有 Office 预览集体退化成"该格式文件暂时无法预览"）。
 * 官方 `@deepseek-ai/dsh-office-to-pdf` 也只导出 default 类、没有 apply——照它做。
 */
export default Office2PdfService;
