// dsh-screen-pilot — DSH 插件入口（Host 半身）。
// 能力：整屏/窗口/区域截图；UI 树导出与检索；鼠标点击/滑动、键盘按键/文本注入。
// 全部经 hdc 桥调用设备侧 uitest / hidumper，shell 域即可用（无需 root）。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { registerTools } from './tools.js';

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
      }, 'screen-pilot: tools');
    }
  } catch (e) {
    // 绝不让插件初始化失败拖垮 profile 启动
    console.warn('[dsh-screen-pilot] 工具注册失败（不影响 DSHM 启动）:', e?.message || String(e));
  }
}
