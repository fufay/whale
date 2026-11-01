// 纯 JS PNG 解码 / 裁剪 / 编码（仅 node:zlib，无外部依赖）。
// 支持 8-bit：colorType 2 (RGB)、4 (gray+alpha)、6 (RGBA)；不支持调色板(3)。
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

/** 解码 PNG 为原始像素（每行 stride = width*channels，无滤波残留）。 */
export function decodePng(buf) {
  if (buf.slice(0, 8).toString('latin1') !== '\x89PNG\r\n\x1a\n') {
    throw new Error('not a png');
  }
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
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
  if (bitDepth !== 8) throw new Error('only 8-bit png supported');
  if (colorType === 3) throw new Error('palette png not supported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    if (f === 1) {
      for (let i = channels; i < stride; i++) line[i] = (line[i] + line[i - channels]) & 0xff;
    } else if (f === 2) {
      for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff;
    } else if (f === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? line[i - channels] : 0;
        line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff;
      }
    } else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? line[i - channels] : 0;
        const b = prev[i];
        const c = i >= channels ? prev[i - channels] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pr) & 0xff;
      }
    }
    line.copy(out, y * stride);
    line.copy(prev);
  }
  return { width, height, channels, colorType, data: out, stride };
}

/** 从 PNG buffer 裁剪区域 (x, y, w, h)，返回新 PNG buffer。越界部分自动截断。 */
export function cropPng(buf, x, y, w, h) {
  const img = decodePng(buf);
  const cx = Math.max(0, Math.floor(x));
  const cy = Math.max(0, Math.floor(y));
  const cw = Math.min(Math.floor(w), img.width - cx);
  const ch = Math.min(Math.floor(h), img.height - cy);
  if (cw <= 0 || ch <= 0) throw new Error('crop region empty');
  const rows = [];
  for (let ry = 0; ry < ch; ry++) {
    const src = (cy + ry) * img.stride + cx * img.channels;
    rows.push(Buffer.from(img.data.subarray(src, src + cw * img.channels)));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cw, 0);
  ihdr.writeUInt32BE(ch, 4);
  ihdr[8] = 8;
  ihdr[9] = img.colorType;
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), r])));
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
