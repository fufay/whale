// 纯 JS PNG 解码 / 裁剪 / 编码（仅 node:zlib，无外部依赖）+ 图片尺寸直读（PNG/JPEG）。
// 支持 8-bit：colorType 2 (RGB)、4 (gray+alpha)、6 (RGBA)；不支持调色板(3)。
//
// 性能要点（真机 3120x2080 RGBA 实测）：
//  · 只为拿尺寸时用 readImageSize()（读 IHDR/SOF，~0.03ms），不要 decodePng()（~180ms）。
//  · decodePng 原地反滤波（不逐行 Buffer.from + prev 拷贝）：整图 ~110ms（原 ~180ms）。
//  · 裁剪时只反滤波到需要的行/列（maxRows/maxCols）：region 裁剪 ~50ms（原 ~200ms）。
import zlib from 'node:zlib';

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

const PNG_SIG = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1');

/** 遍历 PNG chunk，返回 { width, height, bitDepth, colorType, idat }。 */
function parsePng(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a png');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('latin1');
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  return { width, height, bitDepth, colorType, idat };
}

/** 直读 PNG 尺寸（IHDR 固定是第一个 chunk，读 16 字节即可）。 */
export function readPngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a png');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
}

/** 直读 JPEG 尺寸（扫描 SOF0/1/2 段）。不是 JPEG 返回 null。 */
export function readJpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) { p += 1; continue; }
    const marker = buf[p + 1];
    // 无长度字段的标记
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    const len = buf.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > buf.length) break;
    // SOF0/1/2/3/5/6/7/9/10/11/13/14/15（排除 DHT/JPG/DAC）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(p + 7), height: buf.readUInt16BE(p + 5), format: 'jpeg' };
    }
    p += 2 + len;
  }
  return null;
}

/** 按文件签名识别格式并直读尺寸，返回 { width, height, format }。 */
export function readImageSize(buf) {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIG)) return readPngSize(buf);
  const jpeg = readJpegSize(buf);
  if (jpeg) return jpeg;
  throw new Error('不是受支持的 PNG/JPEG 图片');
}

/**
 * 解码 PNG 为「原地反滤波后的原始字节」。
 * 注意：返回的 raw 仍保留每行行首的 filter 字节，行 y 的像素起点 = y * rowLen + 1。
 * 默认整图解码；传 maxRows/maxCols 可只反滤波左上角需要的部分（其余行保持压缩流原样）。
 */
export function decodePng(buf, { maxRows = Infinity, maxCols = Infinity } = {}) {
  const { width, height, bitDepth, colorType, idat } = parsePng(buf);
  if (bitDepth !== 8) throw new Error('only 8-bit png supported');
  if (colorType === 3) throw new Error('palette png not supported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rowLen = stride + 1;
  if (raw.length < height * rowLen) throw new Error('truncated png data');
  const rows = Math.min(Number.isFinite(maxRows) ? Math.max(0, maxRows) : height, height);
  const cols = Math.min(Number.isFinite(maxCols) ? Math.max(0, maxCols) : width, width);
  const bytes = cols * channels;
  let prev = -1; // 上一行行首在 raw 中的偏移
  for (let y = 0; y < rows; y++) {
    const p = y * rowLen;
    const f = raw[p];
    const off = p + 1;
    if (f === 1) {
      for (let i = channels; i < bytes; i++) raw[off + i] = (raw[off + i] + raw[off + i - channels]) & 0xff;
    } else if (f === 2) {
      const q = prev + 1;
      for (let i = 0; i < bytes; i++) raw[off + i] = (raw[off + i] + raw[q + i]) & 0xff;
    } else if (f === 3) {
      const q = prev + 1;
      for (let i = 0; i < bytes; i++) {
        const a = i >= channels ? raw[off + i - channels] : 0;
        raw[off + i] = (raw[off + i] + ((a + raw[q + i]) >> 1)) & 0xff;
      }
    } else if (f === 4) {
      const q = prev + 1;
      for (let i = 0; i < bytes; i++) {
        const a = i >= channels ? raw[off + i - channels] : 0;
        const b = raw[q + i];
        const c = i >= channels ? raw[q + i - channels] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        raw[off + i] = (raw[off + i] + pr) & 0xff;
      }
    }
    prev = p;
  }
  return { width, height, channels, colorType, stride, rowLen, raw, rowsDecoded: rows };
}

/** 从 PNG buffer 裁剪区域 (x, y, w, h)，返回新 PNG buffer。越界部分自动截断。 */
export function cropPng(buf, x, y, w, h) {
  const meta = readPngSize(buf);
  const cx = Math.max(0, Math.floor(x));
  const cy = Math.max(0, Math.floor(y));
  const cw = Math.min(Math.floor(w), meta.width - cx);
  const ch = Math.min(Math.floor(h), meta.height - cy);
  if (cw <= 0 || ch <= 0) throw new Error('crop region empty');
  // 只反滤波到需要的行列（裁剪区域之外的像素不参与编码）。
  const img = decodePng(buf, { maxRows: cy + ch, maxCols: cx + cw });
  const { channels, stride, rowLen, raw } = img;
  const partLen = cw * channels;
  const rows = new Array(ch);
  for (let ry = 0; ry < ch; ry++) {
    const src = (cy + ry) * rowLen + 1 + cx * channels;
    const row = Buffer.allocUnsafe(1 + partLen);
    row[0] = 0; // filter type 0
    raw.copy(row, 1, src, src + partLen);
    rows[ry] = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cw, 0);
  ihdr.writeUInt32BE(ch, 4);
  ihdr[8] = 8;
  ihdr[9] = img.colorType;
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
