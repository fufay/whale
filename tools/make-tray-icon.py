#!/usr/bin/env python3
"""从 Whale 角色头像生成**单色品牌剪影**资源（托盘图标 + 顶栏标识）。

## 产物

| 输出 | 用途 |
|---|---|
| `Common/assets/tray/tray_{white,black}.svg` | **实心版**（亮度阈值 120）——托盘图标（推荐），方形 72×72、内容**按宽度满版** |
| `Common/assets/tray/tray_line_{white,black}.svg` | 线稿版（阈值 80，细线，小尺寸偏弱） |
| `Common/assets/tray/preview_{solid,line}_on_{dark,light}.png` | 深/浅底效果预览（72px） |
| `--place` 时另写 | `entry/src/main/resources/rawfile/tray_{white,black}.svg`（托盘 rawfile）<br>`entry/src/main/resources/base/media/whale_mark.svg`（顶栏 `Image`，**480×390 = 内容真实比例**） |

## 流程

1. 纯标准库解码 PNG（本机没有 PIL/Pillow）；
2. 按**亮度阈值**单色化（白底/脸部/头饰的亮部成为镂空）；
3. 画布做**覆盖率抗锯齿**（每目标像素对源像素块取覆盖率）；
4. 用 **potrace 的 JS 端口**把灰度图曲线矢量化（本机没有 potrace/autotrace/ImageMagick）；
5. 归一化成 SVG：托盘 72×72 方槽（`image.createImageSource` 解 SVG 要求 root 带
   width/height，72 = 24vp@3x，与原 PNG 托盘图标同尺寸）；顶栏 480×390（内容真实比例）。
6. 黑/白两版：同一条 path，仅 `fill` 不同（托盘由系统按状态栏明暗二选一）。

## ⚠ 两个必须守住的口径（都是真机反馈改出来的）

1. **不能把内容裁成正方形**：鲸鱼娘的**鱼鳍耳朵**长在头像左右边缘（原图 x 直达 0 与 718），
   方形裁切会把耳朵切掉（2026-10-17 用户指出）。⇒ 托盘在方形槽位里**按宽度满版、垂直居中**
   （上下留白是方槽固有代价）；顶栏标识直接用内容的真实宽高比。
2. **托盘要"装满"**：第一版按长边 × 0.92 缩进，真机上比系统图标明显小 ⇒ 现在按宽度
   × `FILL_RATIO`（0.98）铺满，仅留 1% 安全边。

## 依赖（一次性）

potrace 的 **JS 端口**（纯 JS，无原生依赖）：

```sh
mkdir -p /tmp/potrace && cd /tmp/potrace && npm i potrace      # 本机用 brew 的 node@24
POTRACE_MODULE=/tmp/potrace/node_modules/potrace python3 tools/make-tray-icon.py --place
```

用法：
    python3 tools/make-tray-icon.py            # 只出 assets（预览 + SVG）
    python3 tools/make-tray-icon.py --place    # 另写进 App 资源（rawfile + media）
"""
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 源图优先用**仓库内**的原件（docs/brand/whale-icon-source.png，随库分发 ⇒ 新克隆可重放）；
# 开发机上用户提供的原件在 Common/assets/icon.png，作为回退。
_SRC_IN_REPO = os.path.join(ROOT, 'docs', 'brand', 'whale-icon-source.png')
_SRC_DEV = os.path.normpath(os.path.join(ROOT, '..', 'assets', 'icon.png'))
SRC = _SRC_IN_REPO if os.path.isfile(_SRC_IN_REPO) else _SRC_DEV
OUT_ASSETS = os.path.normpath(os.path.join(ROOT, '..', 'assets', 'tray'))
RAWFILE = os.path.join(ROOT, 'entry', 'src', 'main', 'resources', 'rawfile')
MEDIA = os.path.join(ROOT, 'entry', 'src', 'main', 'resources', 'base', 'media')

CANVAS = 480        # 矢量化画布宽（越大曲线越平滑；最终由 viewBox 缩放）
FILL_RATIO = 0.98   # 内容宽度占画布比例（托盘按宽度满版）
MARK_H = 390        # 顶栏标识画布高：480×390 = 头像内容真实比例 718:584（含鱼鳍耳朵）
TRAY_SIZE = 72      # 托盘：24vp@3x，与原 PNG 一致
SOLID_THRESHOLD = 120
LINE_THRESHOLD = 80
SS = 4              # 预览缩小用的超采样倍数


# ── PNG 读 / 写（纯标准库）─────────────────────────────────────────────
def read_png(path):
    raw = open(path, 'rb').read()
    pos, w, h, ctype, idat = 8, 0, 0, 0, bytearray()
    while pos < len(raw):
        length = struct.unpack('>I', raw[pos:pos + 4])[0]
        kind = raw[pos + 4:pos + 8]
        data = raw[pos + 8:pos + 8 + length]
        if kind == b'IHDR':
            w, h, depth, ctype, _comp, _filt, interlace = struct.unpack('>IIBBBBB', data)
            if depth != 8 or interlace != 0 or ctype not in (0, 2, 4, 6):
                raise SystemExit(f'只支持 8bit 非隔行 PNG（本图 depth={depth} ctype={ctype} interlace={interlace}）')
        elif kind == b'IDAT':
            idat += data
        elif kind == b'IEND':
            break
        pos += 12 + length
    ch = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    buf = zlib.decompress(bytes(idat))
    stride = w * ch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ft = buf[p]
        p += 1
        line = bytearray(buf[p:p + stride])
        p += stride
        if ft == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, ch, out


def write_png_rgba(path, w, h, px):
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += px[y * stride:(y + 1) * stride]

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)

    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n'
                           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
                           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
                           + chunk(b'IEND', b''))


# ── 掩膜 / 覆盖率 ─────────────────────────────────────────────────────
def luminance_of(px, ch, i):
    if ch == 4 and px[i + 3] < 16:
        return 255
    r, g, b = px[i], px[i + 1], px[i + 2]
    return (r * 299 + g * 587 + b * 114) // 1000


def content_box(px, w, h, ch):
    """内容包围盒（阈值 200，稳定）。**含左右鱼鳍耳朵**（原图 x 直达 0 与 718）。"""
    x0, y0, x1, y1 = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            if luminance_of(px, ch, (y * w + x) * ch) < 200:
                x0, y0 = min(x0, x), min(y0, y)
                x1, y1 = max(x1, x + 1), max(y1, y + 1)
    return x0, y0, x1, y1


def coverage(threshold, W, H):
    """按**宽度**满版（不裁左右，保住耳朵）→ W×H 画布的覆盖度图。"""
    w, h, ch, px = read_png(SRC)
    x0, y0, x1, y1 = content_box(px, w, h, ch)
    cw, chh = x1 - x0, y1 - y0
    scale = cw / (W * FILL_RATIO)          # 源像素 / 目标像素
    offx = (W - cw / scale) / 2
    offy = (H - chh / scale) / 2
    cov = [0.0] * (W * H)
    for ty in range(H):
        sy = y0 + (ty - offy) * scale
        y_lo, y_hi = max(y0, int(sy) - 1), min(y1, int(sy) + 2)
        for tx in range(W):
            sx = x0 + (tx - offx) * scale
            x_lo, x_hi = max(x0, int(sx) - 1), min(x1, int(sx) + 2)
            hit = total = 0
            for yy in range(y_lo, y_hi):
                base = yy * w
                for xx in range(x_lo, x_hi):
                    if luminance_of(px, ch, (base + xx) * ch) < threshold:
                        hit += 1
                    total += 1
            cov[ty * W + tx] = hit / total if total else 0.0
    return cov


def write_trace_input(cov, W, H, path):
    px = bytearray(W * H * 4)
    for i, c in enumerate(cov):
        v = int(255 * (1 - c))
        px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v
        px[i * 4 + 3] = 255
    write_png_rgba(path, W, H, px)


# ── potrace（JS 端口）─────────────────────────────────────────────────
def trace_svg(png_path, work_dir):
    if not os.environ.get('POTRACE_MODULE'):
        raise SystemExit('缺少 POTRACE_MODULE：先 `npm i potrace`，再把 POTRACE_MODULE 指向其目录（见文件头）')
    out = os.path.join(work_dir, 'traced.svg')
    script = os.path.join(work_dir, 'trace.cjs')
    open(script, 'w', encoding='utf-8').write(
        "const potrace = require(process.env.POTRACE_MODULE);\n"
        "const fs = require('fs');\n"
        "potrace.trace(process.argv[2], {threshold:128, blackOnWhite:true, background:'transparent',"
        " optTolerance:0.2, turdSize:2}, (e, svg) => { if (e) { console.error(e); process.exit(1); }"
        " fs.writeFileSync(process.argv[3], svg); });\n")
    subprocess.run(['node', script, png_path, out], check=True, env=dict(os.environ))
    return open(out, encoding='utf-8').read()


def path_data(traced):
    m = re.search(r'(<path\b[^>]*/\s*>)', traced, re.S)
    if not m:
        raise SystemExit('potrace 输出里没有 <path>')
    return re.search(r'd="([^"]*)"', m.group(1)).group(1)


def svg_with(d, w, h, fill, vb_w, vb_h):
    """单 path 单色 SVG（root 带 width/height：ArkWeb `image.createImageSource` 解 SVG 的要求）。"""
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" '
            'version="1.1">\n\t<g fill="%s" stroke="none">\n\t\t<path fill-rule="evenodd" d="%s"/>\n'
            '\t</g>\n</svg>\n') % (w, h, vb_w, vb_h, fill, d)


# ── 预览（72px，深/浅底）─────────────────────────────────────────────
def write_previews(cov, W, H, name):
    grid = [0.0] * (TRAY_SIZE * SS * TRAY_SIZE * SS)
    for y in range(TRAY_SIZE * SS):
        sy = int(y * H / (TRAY_SIZE * SS))
        for x in range(TRAY_SIZE * SS):
            grid[y * TRAY_SIZE * SS + x] = cov[sy * W + int(x * W / (TRAY_SIZE * SS))]
    for tag, bg, fg in (('dark', (28, 28, 30), (255, 255, 255)), ('light', (243, 243, 245), (0, 0, 0))):
        side = TRAY_SIZE + 28
        px = bytearray(side * side * 4)
        for i in range(side * side):
            px[i * 4], px[i * 4 + 1], px[i * 4 + 2], px[i * 4 + 3] = bg[0], bg[1], bg[2], 255
        for y in range(TRAY_SIZE):
            for x in range(TRAY_SIZE):
                a = sum(grid[(y * SS + dy) * TRAY_SIZE * SS + (x * SS + dx)]
                        for dy in range(SS) for dx in range(SS)) / (SS * SS)
                j = ((y + 14) * side + (x + 14)) * 4
                px[j] = int(fg[0] * a + bg[0] * (1 - a))
                px[j + 1] = int(fg[1] * a + bg[1] * (1 - a))
                px[j + 2] = int(fg[2] * a + bg[2] * (1 - a))
        write_png_rgba(os.path.join(OUT_ASSETS, f'preview_{name}_on_{tag}.png'), side, side, px)


def main():
    place = '--place' in sys.argv
    if not os.path.isfile(SRC):
        raise SystemExit(f'找不到源图：{SRC}')
    os.makedirs(OUT_ASSETS, exist_ok=True)
    mark_svg = None
    with tempfile.TemporaryDirectory(prefix='whale-tray-') as tmp:
        for name, threshold in (('solid', SOLID_THRESHOLD), ('line', LINE_THRESHOLD)):
            print(f'→ {name}（阈值 {threshold}）')
            cov = coverage(threshold, CANVAS, CANVAS)
            write_previews(cov, CANVAS, CANVAS, name)
            trace_in = os.path.join(tmp, f'in_{name}.png')
            write_trace_input(cov, CANVAS, CANVAS, trace_in)
            d = path_data(trace_svg(trace_in, tmp))
            for suffix, fill in (('_black.svg', '#000000'), ('_white.svg', '#FFFFFF')):
                dst = os.path.join(OUT_ASSETS, (f'tray{suffix}' if name == 'solid' else f'tray_line{suffix}'))
                svg = svg_with(d, TRAY_SIZE, TRAY_SIZE, fill, CANVAS, CANVAS)
                ET.fromstring(svg)
                open(dst, 'w', encoding='utf-8').write(svg)
                print('  ✔', os.path.relpath(dst, ROOT))
            if name == 'solid':
                # 顶栏标识：内容真实比例 480×390（含鱼鳍耳朵），单色供 Image.fillColor 重着色
                cov_mark = coverage(threshold, CANVAS, MARK_H)
                trace_in_mark = os.path.join(tmp, 'in_mark.png')
                write_trace_input(cov_mark, CANVAS, MARK_H, trace_in_mark)
                mark_svg = svg_with(path_data(trace_svg(trace_in_mark, tmp)), CANVAS, MARK_H,
                                    '#000000', CANVAS, MARK_H)
                ET.fromstring(mark_svg)

    if place:
        for name in ('tray_white.svg', 'tray_black.svg'):
            shutil.copy(os.path.join(OUT_ASSETS, name), os.path.join(RAWFILE, name))
        if mark_svg is not None:
            open(os.path.join(MEDIA, 'whale_mark.svg'), 'w', encoding='utf-8').write(mark_svg)
        print('✔ 已写入 App 资源（rawfile 托盘 + media 顶栏标识）')


if __name__ == '__main__':
    main()
