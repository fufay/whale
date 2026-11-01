#!/usr/bin/env node
/*
 * 为「Whale」项目生成 APP 图标（分层图标 foreground/background + 品牌展示图）。
 *
 * 【与上游 tools/make-icon.py 的关系】
 *   make-icon.py 是 DSHM 的图标生成器：主体是 **dsh 官方鲸鱼 SVG path**（扫描线 even-odd 填充）
 *   + 右下角 HM/OS 角标，且**不产出**启动画面资源（startIcon/logo_dark 保持原版）。
 *   本脚本是 Whale 的**独立**生成器：主体换成用户提供的角色插画位图
 *   （`assets/whale.png`，691×691 白底），因此不能用 SVG path 那套逻辑，改为位图缩放 + 合成。
 *   两个脚本互不影响；本脚本同样**不触碰** startIcon.png / logo_dark.png（启动画面保持原版）。
 *
 * 【产物（6 个）】
 *   | 路径 | 尺寸 | 说明 |
 *   |---|---|---|
 *   | AppScope/resources/base/media/foreground.png        | 1024 | 分层图标前景（透明画布 + 居中白底插画） |
 *   | AppScope/resources/base/media/background.png        | 1024 | 分层图标背景（纯白，与上游一致） |
 *   | entry/src/main/resources/base/media/foreground.png  | 1024 | 同 AppScope（必须一致，否则不同入口图标不同） |
 *   | entry/src/main/resources/base/media/background.png  | 1024 | 同上 |
 *   | docs/brand/whale-icon.png                            | 512  | 白底合成展示图（README/物料用） |
 *   | docs/brand/whale-mark.png                            | 256  | 纯标记（透明底） |
 *
 * 【几何口径】鸿蒙分层图标的前景内容应落在画布中央的安全区（系统会对前景层做缩放/视差，
 *   贴边内容会被裁）。这里取 **内容占 76%（780/1024）**：插画自身四周已有白边，
 *   实际角色主体约占画布 62–66%，落在官方建议的 60–70% 区间内。
 *   前景层用**透明画布**承载中央白底插画；背景层纯白 ⇒ 白对白无缝，视差移动不露边。
 *
 * 【为什么前景不放整幅铺满】系统视差会平移/放大前景层，铺满会让"图形"与"背景"失去分层语义；
 *   中央留白是分层图标的规范形态（上游 DSHM 的 foreground 亦为透明底 + 居中图形）。
 *
 * 用法（本机 sharp 在 DSHM 核心树里，需 NODE_PATH）：
 *   NODE_PATH=<core>/node_modules node tools/make-whale-icon.mjs [源图路径]
 * 前置：源图存在（默认 Common/assets/whale.png，可用参数覆盖）。
 */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = require('sharp');
} catch (error) {
  console.error('✗ 无法加载 sharp。请用 NODE_PATH 指向含 sharp 的 node_modules，例如：');
  console.error('  NODE_PATH=/data/storage/el2/base/haps/entry/files/dsh/cores/<ver>/node_modules node tools/make-whale-icon.mjs');
  console.error('  原始错误:', error instanceof Error ? error.message : error);
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC_DEFAULT = resolve(ROOT, '..', 'assets', 'whale.png');

const SRC = resolve(process.argv[2] ?? SRC_DEFAULT);
const CANVAS = 1024;             // 分层图标画布
const ART = 780;                 // 插画在画布上的边长（安全区：76%）
const PAD = Math.round((CANVAS - ART) / 2);
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

const OUT = {
  fgApp: join(ROOT, 'AppScope', 'resources', 'base', 'media', 'foreground.png'),
  bgApp: join(ROOT, 'AppScope', 'resources', 'base', 'media', 'background.png'),
  fgEntry: join(ROOT, 'entry', 'src', 'main', 'resources', 'base', 'media', 'foreground.png'),
  bgEntry: join(ROOT, 'entry', 'src', 'main', 'resources', 'base', 'media', 'background.png'),
  icon: join(ROOT, 'docs', 'brand', 'whale-icon.png'),
  mark: join(ROOT, 'docs', 'brand', 'whale-mark.png'),
};

function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true });
}

/** 断言：产物存在、尺寸正确、字节数合理（0 字节或异常小即失败）。 */
async function verify(file, size, { minBytes = 200 } = {}) {
  if (!existsSync(file)) throw new Error(`产物缺失: ${file}`);
  const meta = await sharp(file).metadata();
  if (meta.width !== size || meta.height !== size) {
    throw new Error(`尺寸不符: ${file} = ${meta.width}x${meta.height}，期望 ${size}x${size}`);
  }
  const stat = (await import('node:fs')).statSync(file);
  if (stat.size < minBytes) throw new Error(`产物过小（可能为空图）: ${file} = ${stat.size} B`);
  return `${size}x${size} ${stat.size} B`;
}

/** 四角必须透明（前景层透明画布的判据）；中心区域必须非透明（图形在位）。 */
async function verifyForeground(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => data[(y * info.width + x) * info.channels + 3];
  const corners = [at(0, 0), at(info.width - 1, 0), at(0, info.height - 1), at(info.width - 1, info.height - 1)];
  if (corners.some((a) => a !== 0)) throw new Error(`前景四角必须透明，实际 alpha=${corners.join(',')} (${file})`);
  const c = at(Math.floor(info.width / 2), Math.floor(info.height / 2));
  if (c === 0) throw new Error(`前景中心透明——图形缺失或未居中 (${file})`);
  return `四角透明 ✓ 中心 alpha=${c}`;
}

async function main() {
  if (!existsSync(SRC)) {
    console.error(`✗ 源图不存在: ${SRC}`);
    process.exit(1);
  }
  const srcMeta = await sharp(SRC).metadata();
  console.log(`源图: ${SRC} (${srcMeta.width}x${srcMeta.height}, ${srcMeta.format})`);

  // 1) 插画缩放到安全区。源为白底位图 ⇒ fit:contain + 白底填充，保证正方形且白边一致。
  const art = await sharp(SRC)
    .resize(ART, ART, { fit: 'contain', background: WHITE })
    .png()
    .toBuffer();

  // 2) 分层图标：前景 = 透明画布 + 居中插画；背景 = 纯白
  const foreground = await sharp({
    create: { width: CANVAS, height: CANVAS, channels: 4, background: TRANSPARENT },
  })
    .composite([{ input: art, top: PAD, left: PAD }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  const background = await sharp({
    create: { width: CANVAS, height: CANVAS, channels: 4, background: WHITE },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

  for (const [file, buf] of [[OUT.fgApp, foreground], [OUT.fgEntry, foreground],
    [OUT.bgApp, background], [OUT.bgEntry, background]]) {
    ensureDir(file);
    await sharp(buf).toFile(file);
  }

  // 3) 品牌展示图：白底合成（512）/ 纯标记透明底（256）
  ensureDir(OUT.icon);
  ensureDir(OUT.mark);
  await sharp({ create: { width: 512, height: 512, channels: 4, background: WHITE } })
    .composite([{ input: await sharp(SRC).resize(390, 390, { fit: 'contain', background: WHITE }).png().toBuffer(), top: 61, left: 61 }])
    .flatten({ background: WHITE })
    .png({ compressionLevel: 9 })
    .toFile(OUT.icon);
  await sharp(SRC).resize(256, 256, { fit: 'contain', background: TRANSPARENT }).png().toFile(OUT.mark);

  // 4) 自检
  const checks = [];
  checks.push(['AppScope foreground', await verify(OUT.fgApp, CANVAS), await verifyForeground(OUT.fgApp)]);
  checks.push(['entry   foreground', await verify(OUT.fgEntry, CANVAS), await verifyForeground(OUT.fgEntry)]);
  checks.push(['AppScope background', await verify(OUT.bgApp, CANVAS), '纯白 ✓']);
  checks.push(['entry   background', await verify(OUT.bgEntry, CANVAS), '纯白 ✓']);
  checks.push(['docs icon(512)', await verify(OUT.icon, 512), '白底合成 ✓']);
  checks.push(['docs mark(256)', await verify(OUT.mark, 256), '透明底 ✓']);

  // 5) 两处必须逐字节一致（否则不同入口图标不同）
  const { readFileSync } = await import('node:fs');
  const sameFg = Buffer.compare(readFileSync(OUT.fgApp), readFileSync(OUT.fgEntry)) === 0;
  const sameBg = Buffer.compare(readFileSync(OUT.bgApp), readFileSync(OUT.bgEntry)) === 0;
  if (!sameFg || !sameBg) throw new Error('AppScope 与 entry 的图标不一致（必须逐字节相同）');

  for (const [name, size, extra] of checks) console.log(`  ✓ ${name}: ${size} | ${extra}`);
  console.log('  ✓ AppScope 与 entry 逐字节一致');
  console.log('完成：6 个产物已写出（startIcon/logo_dark 未触碰，保持原版）。');
}

main().catch((error) => {
  console.error('✗ 生成失败:', error instanceof Error ? error.message : error);
  process.exit(1);
});
