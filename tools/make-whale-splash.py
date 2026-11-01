#!/usr/bin/env python3
"""
为「Whale」生成**启动画面标识**（把上游的黑鲸 logo_dark 换成鲸鱼娘插画）。

【为什么要另写一个脚本（不复用 tools/make-whale-icon.mjs）】
  make-whale-icon.mjs 依赖 `sharp`——本机（whale 侧沙箱）**没有可用的 sharp**：
  核心树 `node_modules/` 里没有 sharp（它是宿主侧依赖，被裁剪规则移除了），
  brew 的全局 node_modules 也没有。而 DSHM 那一侧的 sharp 在本应用 uid 之外，读不到。
  ⇒ 本脚本改为**纯标准库**实现（zlib + struct）：解 PNG → 去白边 → 双线性缩放 →
  合成到纯色底 → 写 PNG。零依赖、可复现、跑在设备内嵌 python 3.12 上。

【产物（2 个，均为 512×512 PNG）】
  · entry/src/main/resources/base/media/logo_dark.png
      应用内**启动页**那张（WebApp.ets 启动页 `Image($r('app.media.logo_dark'))`，92×92 显示）。
      底色填 **#F3F7FB**（启动页 Column 的背景色，逐字同值）⇒ 与背景无缝，不出现白方块。
  · entry/src/main/resources/base/media/startIcon.png
      系统冷启动闪屏用的图标。底色填**纯白**（系统闪屏底色通常是白），避免与系统底色打架。

【几何口径】
  去白边后按**长边**缩放到画布的 88%（两侧各留 6% 呼吸位）；`ImageFit.Contain` 显示时
  图形不会被裁，且和分层应用图标（whale-icon 系列）的视觉重量一致。

【与 make-whale-icon.mjs 的分工】
  那个脚本管**应用图标**（AppScope/entry 的 foreground+background 分层图标 + 品牌展示图），
  且刻意不动启动画面；本脚本**只**管启动画面这两张。两者互不覆盖。

用法：
  python3 tools/make-whale-splash.py [源图] [--check]
  默认源图 = ../assets/whale.png（即 Common/assets/whale.png）
  --check 只计算不写盘（打印将要生成的几何与体积）
"""
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = os.path.normpath(os.path.join(ROOT, '..', 'assets', 'whale.png'))
MEDIA = os.path.join(ROOT, 'entry', 'src', 'main', 'resources', 'base', 'media')
# 原图备份落在 dist/（构建产物区，.gitignore 已忽略）——不要污染受版本管理的 media/
BACKUP = os.path.join(ROOT, 'dist', 'media-backup')

CANVAS = 512          # 输出边长
FILL_RATIO = 0.88     # 去白边后的长边占画布比例
SPLASH_BG = (0xF3, 0xF7, 0xFB)   # 启动页底色（WebApp.ets 逐字同值）
SYSTEM_BG = (0xFF, 0xFF, 0xFF)   # 系统闪屏底色
WHITE_TRIM = 250      # 去白边阈值：三通道都 >= 该值视为背景


def read_png(path):
    """解码 8bit RGB/RGBA 非隔行 PNG → (w, h, channels, bytearray)。"""
    raw = open(path, 'rb').read()
    if raw[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit(f'不是 PNG：{path}')
    pos, w, h, depth, ctype, idat = 8, 0, 0, 0, 0, bytearray()
    while pos < len(raw):
        ln = struct.unpack('>I', raw[pos:pos + 4])[0]
        typ = raw[pos + 4:pos + 8]
        data = raw[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, depth, ctype, _comp, _filt, interlace = struct.unpack('>IIBBBBB', data)
            if depth != 8 or ctype not in (2, 6) or interlace != 0:
                raise SystemExit(f'只支持 8bit RGB/RGBA 非隔行 PNG（本图 depth={depth} type={ctype} interlace={interlace}）')
        elif typ == b'IDAT':
            idat += data
        elif typ == b'IEND':
            break
        pos += 12 + ln
    ch = 4 if ctype == 6 else 3
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


def write_png(path, w, h, rgb):
    """写 RGB8 PNG（filter 0）。"""
    stride = w * 3
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgb[y * stride:(y + 1) * stride]

    def chunk(typ, data):
        return (struct.pack('>I', len(data)) + typ + data
                + struct.pack('>I', zlib.crc32(typ + data) & 0xFFFFFFFF))

    out = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    open(path, 'wb').write(out)


def content_bbox(w, h, ch, px):
    """去白边：返回非白像素的包围盒 (x0, y0, x1, y1)（含端点，右开）。"""
    x0, y0, x1, y1 = w, h, 0, 0
    for y in range(h):
        row = y * w * ch
        for x in range(w):
            i = row + x * ch
            if ch == 4 and px[i + 3] < 8:
                continue
            if px[i] >= WHITE_TRIM and px[i + 1] >= WHITE_TRIM and px[i + 2] >= WHITE_TRIM:
                continue
            if x < x0:
                x0 = x
            if x + 1 > x1:
                x1 = x + 1
            if y < y0:
                y0 = y
            if y + 1 > y1:
                y1 = y + 1
    if x1 <= x0 or y1 <= y0:
        raise SystemExit('去白边后内容为空（源图可能不是白底插画）')
    return x0, y0, x1, y1


def compose(src, bg):
    """源图 → 512×512 纯色底合成图（返回 rgb bytearray）。"""
    w, h, ch, px = read_png(src)
    x0, y0, x1, y1 = content_bbox(w, h, ch, px)
    cw, chh = x1 - x0, y1 - y0
    side = max(cw, chh)
    scale = (CANVAS * FILL_RATIO) / side
    tw, th = max(1, int(round(cw * scale))), max(1, int(round(chh * scale)))
    ox, oy = (CANVAS - tw) // 2, (CANVAS - th) // 2
    canvas = bytearray(bytes(bg) * (CANVAS * CANVAS))
    for ty in range(th):
        sy = y0 + (ty + 0.5) / scale - 0.5
        y_a = max(y0, min(y1 - 1, int(sy)))
        y_b = min(y1 - 1, y_a + 1)
        fy = max(0.0, min(1.0, sy - y_a))
        for tx in range(tw):
            sx = x0 + (tx + 0.5) / scale - 0.5
            x_a = max(x0, min(x1 - 1, int(sx)))
            x_b = min(x1 - 1, x_a + 1)
            fx = max(0.0, min(1.0, sx - x_a))
            acc = [0.0, 0.0, 0.0, 0.0]
            for (sxx, wx) in ((x_a, 1 - fx), (x_b, fx)):
                for (syy, wy) in ((y_a, 1 - fy), (y_b, fy)):
                    k = wx * wy
                    if k <= 0:
                        continue
                    i = (syy * w + sxx) * ch
                    a = px[i + 3] / 255.0 if ch == 4 else 1.0
                    acc[0] += px[i] * k * a
                    acc[1] += px[i + 1] * k * a
                    acc[2] += px[i + 2] * k * a
                    acc[3] += k * a
            if acc[3] <= 0.0001:
                continue
            r, g, b = acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]
            a = min(1.0, acc[3])
            di = ((oy + ty) * CANVAS + (ox + tx)) * 3
            canvas[di] = int(round(r * a + bg[0] * (1 - a)))
            canvas[di + 1] = int(round(g * a + bg[1] * (1 - a)))
            canvas[di + 2] = int(round(b * a + bg[2] * (1 - a)))
    return canvas, (cw, chh), (tw, th), (ox, oy)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    check = '--check' in sys.argv
    src = args[0] if args else DEFAULT_SRC
    if not os.path.isfile(src):
        raise SystemExit(f'找不到源图：{src}')

    print(f'源图：{src}')
    targets = [('logo_dark.png', SPLASH_BG, '应用内启动页（底 #F3F7FB，与启动页背景同值）'),
               ('startIcon.png', SYSTEM_BG, '系统冷启动闪屏（底 白）')]
    for name, bg, why in targets:
        dst = os.path.join(MEDIA, name)
        canvas, crop, size, off = compose(src, bg)
        print(f'  {name}: 去白边后 {crop[0]}×{crop[1]} → 缩放 {size[0]}×{size[1]} @ ({off[0]},{off[1]})，画布 {CANVAS}×{CANVAS}，{why}')
        if check:
            continue
        if os.path.isfile(dst):
            os.makedirs(BACKUP, exist_ok=True)
            bak = os.path.join(BACKUP, name)
            if not os.path.isfile(bak):
                with open(dst, 'rb') as s, open(bak, 'wb') as d:
                    d.write(s.read())
        write_png(dst, CANVAS, CANVAS, canvas)
        print(f'    已写入 {dst}（{os.path.getsize(dst):,} B；原图备份 dist/media-backup/{name}）')
    print('完成。' + ('（--check 模式，未写盘）' if check else ''))


if __name__ == '__main__':
    main()
