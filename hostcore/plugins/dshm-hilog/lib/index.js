// lib/index.js —— dsh-hilog 插件入口（cordis）。
//
// 把「抓鸿蒙 hilog」做成 3 个 agent 工具（纯 host 侧，无 Web UI）：
//   · hilog_level   读 / 设 / 还原设备全局日志级别（设置默认即还原，见 §5.1）
//   · hilog_dump    非阻塞取当前缓冲区（-x），客户端截断 + 可选落盘
//   · hilog_capture 实时抓 N 秒（**流式**读取对抗 512KB 滚动），结束自动还原级别
//
// 硬约束（开发需求文档.md §5，全部在这里落地）：
//   · 执行一律走 `ctx.shell` 接缝（**绝不**用 node:child_process —— 本机 process.execPath
//     是 appspawn，会被运行时拒绝）；
//   · 命令与参数分离构造（见 lib/hilog.js 的 quoteArg），不把用户输入裸拼进命令行；
//   · hdcCmd 可配置 + 双通道自动探测（bridge / via-host），返回值注明走的哪条；
//   · 只挑 Connected 目标；级别改动 try/finally 还原；输出默认截断 + 落盘。
//
// 分工：本文件只做 cordis 接线（Config 模式 + apply）；
//       工具定义/渲染/ctx.shell 适配在 lib/tools.js，业务逻辑在 lib/ops.js，
//       纯解析在 lib/hilog.js，通道探测在 lib/hdc.js。
// 参考实现：本机 dsh-proxyagent 的插件骨架（`export const name/inject/Config/apply`、
// `ctx.inject(['shell'])` 可选注入、`ctx.tools.register({...})`），已在本机验证可挂载。

import z from '@deepseek-ai/schemastery';
import { DEFAULT_VIA_HOST, HOST_KEEPALIVE } from './hdc.js';
import { registerTools, shellAdapters, saveLog, renderResult } from './tools.js';

export { registerTools, shellAdapters, saveLog, renderResult };

export const name = 'dsh-hilog';
export const inject = ['tools'];

/** 设置命名空间 = cordis.patch.yml 里的 entry id（不是包名）。 */
const NS = 'dsh-hilog';

export const Config = z.object({
  hdcCmd: z.string().default('hdc').volatile()
    .description('bridge 通道的命令（默认 `hdc`：本机是自动过桥转发器 = 无线调试/TCP 目标）。'),
  hdcCmdViaHost: z.string().default(DEFAULT_VIA_HOST).volatile()
    .description('via-host 通道的命令（借宿主 hdc server 127.0.0.1:18710）—— 抓 USB 手机/平板的唯一通路；文件不存在时该通道自动跳过。'),
  channel: z.string().default('auto').volatile()
    .description('通道策略：auto（默认，先 bridge 后 via-host）/ bridge / via-host。'),
  device: z.string().default('').volatile()
    .description('缺省目标（hdc list targets 的 key）。默认空 = 自动挑唯一的 Connected 目标。'),
  level: z.string().default('I').volatile()
    .description('hilog_capture 默认抓取的最低级别（D/I/W/E/F）。默认 I：能覆盖 hilog.info，又不至于把 D 级噪声全倒出来。'),
  seconds: z.number().default(15).volatile().description('hilog_capture 默认抓取秒数。'),
  maxSeconds: z.number().default(120).volatile().description('hilog_capture 允许的最大秒数（防止一条工具调用把会话挂住）。'),
  maxLines: z.number().default(200).volatile().description('hilog_dump 默认返回条数（上限之外只落盘）。'),
  maxBytes: z.number().default(32768).volatile().description('单次返回的日志正文字节上限（默认 32KB，谁先到算谁）。'),
  maxCaptureLines: z.number().default(2000).volatile().description('hilog_capture 默认最多收集多少条新日志（抓够可提前收手）。'),
  pollMs: z.number().default(200).volatile().description('流式读取的轮询间隔（毫秒）。'),
  timeoutMs: z.number().default(30000).volatile().description('单条 hdc 命令的超时（毫秒）。'),
  listTimeoutMs: z.number().default(45000).volatile().description('`list targets -v` 的超时（桥首次启动可能要几秒）。'),
  stdoutMaxBytes: z.number().default(8388608).volatile().description('单条命令的输出缓冲上限（8MB；超出会 lossy 并有 spillPath）。'),
  outputDir: z.string().default('').volatile()
    .description('落盘目录。默认空 = <会话工作区>/Build/dsh-hilog/logs。'),
  dumpSave: z.boolean().default(false).volatile().description('hilog_dump 是否默认落盘（false：默认只回截断摘要）。'),
  captureSave: z.boolean().default(true).volatile().description('hilog_capture 是否默认落盘（true：抓到的日志是瞬时的，不落盘就没了）。'),
  sinceNow: z.boolean().default(true).volatile().description('hilog_capture 是否只保留"本次调用开始之后"的日志（阻塞读会先吐缓冲区历史）。'),
  sandboxMode: z.string().default('danger-full-access').volatile()
    .description('交给 ctx.shell 的沙箱模式。hdc 要读写 /data/... 与桥缓存 ⇒ 默认 danger-full-access（与 dsh-proxyagent 同款理由）。'),
});

export function plainConfig(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(plainConfig);
  if (typeof value.get === 'function') return plainConfig(value.get());
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainConfig(v)]));
}

export function apply(ctx, config) {
  let readConfig = () => {
    try { return plainConfig(Config(ctx.fiber?.config ?? config)); } catch { return plainConfig(config); }
  };

  // 可选：把「设置」页里改过的值读回来（拿不到就用 profile 里的 config）
  ctx.inject(['settings'], (sctx) => {
    try {
      if (!sctx || !sctx.settings) return;
      const live = () => {
        try {
          if (typeof sctx.settings.describe === 'function') {
            const row = (sctx.settings.describe() || []).find?.((r) => r && r.ns === NS);
            if (row && row.value && typeof row.value === 'object') return plainConfig(row.value);
          } else if (typeof sctx.settings.get === 'function') {
            const v = sctx.settings.get(NS);
            if (v && typeof v === 'object') return plainConfig(v);
          }
        } catch { /* ignore */ }
        return null;
      };
      readConfig = () => live() ?? plainConfig(Config(ctx.fiber?.config ?? config));
    } catch (e) {
      ctx.logger?.debug?.('dsh-hilog: 读设置失败（忽略）', e);
    }
  });

  // 执行通道：DSH 的 shell 接缝（可选注入 —— 缺了也照常加载，工具会回明确错误）
  let shellRef = null;
  ctx.inject(['shell'], (sctx) => {
    try {
      shellRef = (sctx && sctx.shell) || null;
      if (shellRef) ctx.logger?.info?.('dsh-hilog: 已接入 ctx.shell（hdc 命令走 DSH 执行器）');
    } catch (e) {
      ctx.logger?.debug?.('dsh-hilog: 取 shell 接缝失败', e);
    }
  });

  registerTools(ctx, { getConfig: () => readConfig(), getShell: () => shellRef, logger: ctx.logger });
  ctx.logger?.info?.(`dsh-hilog: ready（通道 auto → bridge:${readConfig().hdcCmd || 'hdc'} / via-host:${(readConfig().hdcCmdViaHost || '').slice(0, 40)}…；USB 需宿主 server：${HOST_KEEPALIVE}）`);
}

export default { name, inject, Config, apply, plainConfig, registerTools, shellAdapters, saveLog, renderResult };
