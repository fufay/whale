// 截图引擎：uitest screenCap 整屏截图 + WMS 窗口边界 + 纯 JS PNG 裁剪。
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { hdcRun, shell, shellArgs } from './hdc.js';
import { decodePng, cropPng } from './png.js';

let sizeCache = null;

/** 解析 hidumper WindowManagerService 输出为窗口数组 + 焦点 WinId。 */
export function parseWindows(text) {
  const rows = [];
  let focus = null;
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(
      /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+\[\s*(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s*\]/,
    );
    if (m) {
      rows.push({
        name: m[1],
        displayId: +m[2],
        pid: +m[3],
        winId: +m[4],
        type: +m[5],
        mode: +m[6],
        flag: +m[7],
        zord: +m[8],
        orientation: +m[9],
        x: +m[10],
        y: +m[11],
        w: +m[12],
        h: +m[13],
      });
    }
    const f = line.match(/^Focus window:\s*(\d+)/);
    if (f) focus = +f[1];
  }
  return { rows, focus };
}

/** 列出全部窗口（含 z 序与焦点）。 */
export function listWindows() {
  const out = shellArgs('hidumper', '-s', 'WindowManagerService', '-a', '-a');
  const { rows, focus } = parseWindows(out);
  return { windows: rows, focus };
}

/** 屏幕分辨率（取自 WMS 全屏面板窗口，零截图成本）。 */
export function screenSize() {
  if (!sizeCache) {
    const { windows } = listWindows();
    const panel =
      windows.find((w) => w.name === 'SCBScenePanel1') ||
      windows.find((w) => w.w > 0 && w.h > 0);
    sizeCache = { width: panel.w, height: panel.h, displayId: panel.displayId };
  }
  return { ...sizeCache };
}

/**
 * 截图。mode：
 *  - 无 window/region：整屏
 *  - window：按窗口名子串或 WinId 定位窗口边界裁剪
 *  - region：[x, y, w, h] 直接裁剪
 * 返回 { path, width, height, bytes, mode }。
 */
export function capture({ displayId, window, region, outPath, saveDir } = {}) {
  const dir = isAbsolute(outPath || '') ? dirname(outPath) : saveDir;
  mkdirSync(dir, { recursive: true });
  const remote = `/data/local/tmp/dsp_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`;
  const args = ['uitest', 'screenCap', '-p', remote];
  if (displayId != null) args.push('-d', String(displayId));
  const out = shellArgs(...args);
  if (!/No Error|saved/i.test(out)) throw new Error('screenCap 失败: ' + out.trim());
  const local = outPath
    ? isAbsolute(outPath)
      ? outPath
      : join(saveDir, outPath)
    : join(dir, `capture_${Date.now()}.png`);
  hdcRun(['file', 'recv', remote, local]);
  shell('rm -f ' + remote);
  let buf = readFileSync(local);
  let mode = 'full';
  if (window != null) {
    const { windows } = listWindows();
    const winId = /^\d+$/.test(String(window)) ? Number(window) : null;
    const w =
      winId != null
        ? windows.find((x) => x.winId === winId)
        : windows.find((x) => x.name.includes(String(window)));
    if (!w) throw new Error('未找到窗口: ' + window);
    buf = cropPng(buf, w.x, w.y, w.w, w.h);
    writeFileSync(local, buf);
    mode = `window:${w.name}`;
  } else if (Array.isArray(region) && region.length === 4) {
    const [rx, ry, rw, rh] = region.map(Number);
    buf = cropPng(buf, rx, ry, rw, rh);
    writeFileSync(local, buf);
    mode = 'region';
  }
  const meta = decodePng(buf);
  return { path: local, width: meta.width, height: meta.height, bytes: buf.length, mode };
}
