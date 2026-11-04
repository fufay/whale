// 截图引擎：整屏快通道（snapshot_display → JPEG）+ 裁剪通道（uitest screenCap → PNG → 纯 JS 裁剪）。
//
// 性能要点（真机 3120x2080 实测）：
//  · 整屏：snapshot_display 出 JPEG ~400ms、~0.35MB（uitest screenCap 出 PNG ~600ms、~2MB），
//    失败自动回退 PNG，语义不变。
//  · 整屏不再为了拿尺寸 decodePng 整图（原实现 ~180ms/次纯浪费），改直读 IHDR/SOF。
//  · 窗口模式下 hidumper 与 screenCap 合并进同一次 hdc shell 往返；远端临时文件不单独 rm，
//    由 hdc.js 的清理队列在下一次调用顺带删除。
//  · 设备侧 uitest 是单例服务：所有 uitest 命令经 hdc.js 的串行队列发出，撞车时重试一次。
import { mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { fileRecv, isUitestContention, queueCleanup, shell, uitestShell } from './hdc.js';
import { cropPng, readImageSize } from './png.js';

let sizeCache = null;
let remoteSeq = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** uitest 指令撞车（设备侧单例服务）时重试一次。 */
async function withUitestRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    if (!isUitestContention(e)) throw e;
    await sleep(200);
    return fn();
  }
}

/** 设备侧临时文件路径（唯一、不覆盖并发调用）。 */
function remotePath(ext) {
  remoteSeq = (remoteSeq + 1) % 1e6;
  return `/data/local/tmp/dsp_${process.pid}_${Date.now()}_${remoteSeq}.${ext}`;
}

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
export async function listWindows() {
  const out = await shell('hidumper -s WindowManagerService -a -a');
  const { rows, focus } = parseWindows(out);
  return { windows: rows, focus };
}

/** 屏幕分辨率（取自 WMS 全屏面板窗口，零截图成本；进程内缓存）。 */
export async function screenSize() {
  if (!sizeCache) {
    const { windows } = await listWindows();
    const panel =
      windows.find((w) => w.name === 'SCBScenePanel1') ||
      windows.find((w) => w.w > 0 && w.h > 0);
    if (!panel) throw new Error('无法从 WindowManagerService 取屏幕尺寸');
    sizeCache = { width: panel.w, height: panel.h, displayId: panel.displayId };
  }
  return { ...sizeCache };
}

function pickFullFormat(outPath, format) {
  const f = String(format || '').toLowerCase();
  if (f === 'png' || f === 'jpeg' || f === 'jpg') return f === 'jpg' ? 'jpeg' : f;
  const ext = outPath ? extname(String(outPath)).toLowerCase() : '';
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  return 'jpeg'; // 默认快格式
}

function extFor(fmt) {
  return fmt === 'png' ? '.png' : '.jpeg';
}

/** 把路径扩展名规范成目标格式对应的扩展名（read_image 会按扩展名声明 mediaType）。 */
function ensureExt(p, fmt) {
  const want = extFor(fmt);
  const cur = extname(p).toLowerCase();
  if (cur === want || (fmt === 'jpeg' && cur === '.jpg')) return p;
  return (cur ? p.slice(0, p.length - cur.length) : p) + want;
}

function resolveLocal(outPath, saveDir, dir, fmt) {
  const p = outPath
    ? isAbsolute(outPath)
      ? outPath
      : join(saveDir, outPath)
    : join(dir, `capture_${Date.now()}`);
  return ensureExt(p, fmt);
}

/** 整屏 JPEG 快通道。失败抛错，由调用方回退 PNG。 */
async function captureJpeg(displayId, local) {
  const remote = remotePath('jpeg');
  try {
    const out = await shell(`snapshot_display -i ${Number(displayId) || 0} -f ${remote}`);
    if (!/success/i.test(out)) throw new Error('snapshot_display 未成功: ' + String(out).trim().slice(0, 300));
    await fileRecv(remote, local);
  } finally {
    queueCleanup(remote);
  }
  const buf = readFileSync(local);
  const meta = readImageSize(buf);
  if (meta.format !== 'jpeg') throw new Error('快通道返回的不是 JPEG');
  return { path: local, width: meta.width, height: meta.height, bytes: buf.length, mode: 'full', format: 'jpeg' };
}

/** 整屏 PNG 通道（快通道不可用时的回退，也是 format=png 的正式路径）。 */
async function capturePngFull(displayId, local) {
  const remote = remotePath('png');
  try {
    const args = ['uitest', 'screenCap', '-p', remote];
    if (displayId != null) args.push('-d', String(displayId));
    const out = await withUitestRetry(async () => {
      const o = await uitestShell(args.join(' '));
      if (!/No Error|saved/i.test(o)) throw new Error('screenCap 失败: ' + String(o).trim());
      return o;
    });
    await fileRecv(remote, local);
  } finally {
    queueCleanup(remote);
  }
  const buf = readFileSync(local);
  const meta = readImageSize(buf);
  return { path: local, width: meta.width, height: meta.height, bytes: buf.length, mode: 'full', format: meta.format };
}

/**
 * 截图。mode：
 *  - 无 window/region：整屏（默认 JPEG 快通道，format=png 或 outPath 为 .png 时走 PNG）
 *  - window：按窗口名子串或 WinId 定位窗口边界裁剪（PNG）
 *  - region：[x, y, w, h] 直接裁剪（PNG）
 * 返回 { path, width, height, bytes, mode, format }。
 */
export async function capture({ displayId, window: win, region, outPath, saveDir, format } = {}) {
  const dir = isAbsolute(outPath || '') ? dirname(outPath) : saveDir;
  mkdirSync(dir, { recursive: true });
  const crop = win != null || (Array.isArray(region) && region.length === 4);

  if (!crop) {
    const fmt = pickFullFormat(outPath, format);
    const local = resolveLocal(outPath, saveDir, dir, fmt);
    if (fmt === 'jpeg') {
      try {
        return await captureJpeg(displayId, local);
      } catch {
        // 回退 PNG；路径扩展名同步改掉，避免「jpeg 名字 + png 内容」被 read_image 拒绝。
        const pngLocal = ensureExt(local, 'png');
        return capturePngFull(displayId, pngLocal);
      }
    }
    return capturePngFull(displayId, local);
  }

  // ── 裁剪通道：一次 hdc 往返内完成「截图 +（窗口模式）窗口表」──
  const local = resolveLocal(outPath, saveDir, dir, 'png');
  const remote = remotePath('png');
  const marker = `SPM${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const capArgs = ['uitest', 'screenCap', '-p', remote];
  if (displayId != null) capArgs.push('-d', String(displayId));
  const cmd =
    `${capArgs.join(' ')} 2>&1; echo "${marker}=$?"` +
    (win != null ? '; hidumper -s WindowManagerService -a -a' : '');
  try {
    const w = await withUitestRetry(async () => {
      const out = await uitestShell(cmd);
      const mIdx = out.indexOf(marker);
      if (mIdx < 0) throw new Error('screenCap 失败（无返回标记）: ' + String(out).trim().slice(0, 300));
      const capOut = out.slice(0, mIdx);
      if (!/No Error|saved/i.test(capOut)) throw new Error('screenCap 失败: ' + capOut.trim().slice(0, 300));
      if (win == null) return null;
      const windowsText = out.slice(out.indexOf('\n', mIdx) + 1);
      const { rows: windows } = parseWindows(windowsText);
      const winId = /^\d+$/.test(String(win)) ? Number(win) : null;
      const hit = winId != null
        ? windows.find((x) => x.winId === winId)
        : windows.find((x) => String(x.name).includes(String(win)));
      if (!hit) throw new Error('未找到窗口: ' + win);
      return hit;
    });
    await fileRecv(remote, local);
    const src = readFileSync(local);
    const box = w
      ? { x: w.x, y: w.y, w: w.w, h: w.h }
      : { x: Number(region[0]), y: Number(region[1]), w: Number(region[2]), h: Number(region[3]) };
    const cropped = cropPng(src, box.x, box.y, box.w, box.h);
    await writeFile(local, cropped);
    const meta = readImageSize(cropped);
    return {
      path: local,
      width: meta.width,
      height: meta.height,
      bytes: cropped.length,
      mode: w ? `window:${w.name}` : 'region',
      format: 'png',
    };
  } finally {
    queueCleanup(remote);
  }
}
