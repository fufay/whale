// dsh-screen-pilot — DSH 插件入口（Host 半身）。
// 能力：整屏/窗口/区域截图；UI 树导出与检索；鼠标点击/滑动、键盘按键/文本注入。
// 设备侧命令默认走「长连会话」（PTY 常驻 hdc shell，~40ms/条）；长连不可用时自动降级为逐次调用。
// 全部经 hdc 桥调用设备侧 uitest / hidumper，shell 域即可用（无需 root）。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { registerTools } from './tools.js';
import { setShell, setSessionOptions, disposeSession } from './hdc.js';

export const name = 'screen-pilot';
/*
 * 【alpha.2 兼容（2026-10-28，docs/126 Phase 3）】原为 `inject = []` + apply 里
 * `ctx.get('tools')` 的"软取服务"写法。alpha.2 的 @deepseek-ai/dsh-tools 服务
 * 依赖 systemPrompt，激活顺序晚于本插件 ⇒ apply 时 `ctx.get('tools')` 为空，
 * 真机日志：`[dsh-screen-pilot] tools 服务不可用：跳过模型工具注册（插件仍正常加载）`
 * ⇒ 截图/UI 树/键鼠 9 个模型工具全部没注册。
 * 改成硬依赖（与 dshm-hilog 同一写法）：cordis 会把本插件推迟到 tools 服务就绪后激活。
 */
export const inject = ['tools'];

function defaultSaveDir() {
  const base = process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh');
  return join(base, 'attachments', 'screen-pilot');
}

export function apply(ctx, config = {}) {
  const saveDir = config.saveDir || defaultSaveDir();
  try {
    mkdirSync(saveDir, { recursive: true });
  } catch (e) {
    // 目录不可写也不致命：截图时还会再建一次
  }
  // hdc 执行走 DSH 的 ctx.shell 接缝：Host 侧一次性调用；长连由 ctx.shell 起 python relay 提供。
  // 软注入：缺了插件照常加载，工具执行时会返回明确错误 / 自动降级逐次调用。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['shell'], (sctx) => {
        try {
          setShell(sctx && sctx.shell);
          if (sctx && sctx.shell) console.log('[dsh-screen-pilot] 已接入 ctx.shell（hdc 命令走 DSH 执行器）');
        } catch (e) {
          console.warn('[dsh-screen-pilot] 取 shell 接缝失败:', e?.message || String(e));
        }
      });
    } else if (typeof ctx.get === 'function') {
      const s = ctx.get('shell');
      if (s) setShell(s);
    }
  } catch (e) {
    console.warn('[dsh-screen-pilot] 接入 shell/subprocess 失败（工具会返回明确错误或降级）:', e?.message || String(e));
  }
  // 设计 §8 的会话配置项接线（默认值在 session.js）。
  try {
    setSessionOptions({
      idleTimeoutMs: config.idleTimeoutMs,
      commandTimeoutMs: config.commandTimeoutMs,
      openTimeoutMs: config.openTimeoutMs,
      sessionLog: config.sessionLog,
    });
  } catch (e) {
    console.warn('[dsh-screen-pilot] 会话参数接线失败（用默认值）:', e?.message || String(e));
  }
  try {
    const tools = ctx.get('tools');
    if (!tools || typeof tools.register !== 'function') {
      console.warn('[dsh-screen-pilot] tools 服务不可用：跳过模型工具注册（插件仍正常加载）');
      return;
    }
    const disposers = registerTools(tools, { saveDir });
    console.log(`[dsh-screen-pilot] 已注册 ${disposers.length} 个模型工具（保存目录 ${saveDir}）`);
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        for (const d of disposers) {
          try { d(); } catch { /* ignore */ }
        }
        // 插件卸载/关闭：关掉长连会话，避免残留 hdc shell 进程（返回 Promise 供 effect 等待）。
        return disposeSession().catch(() => {});
      }, 'screen-pilot: tools');
    }
  } catch (e) {
    // 绝不让插件初始化失败拖垮 profile 启动
    console.warn('[dsh-screen-pilot] 工具注册失败（不影响 DSHM 启动）:', e?.message || String(e));
  }
}
