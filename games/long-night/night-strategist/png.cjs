'use strict';
/**
 * Minimal PNG decoder: 8-bit, non-interlaced, colour types 0/2/4/6.
 * Enough to read the game's rendered board images without any dependency.
 */
const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decode(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let palette = null;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8) throw new Error(`只支持 8 位 PNG（当前 ${bitDepth}）`);
  if (interlace) throw new Error('不支持隔行 PNG');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 PNG colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let position = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[position++];
    const line = Buffer.from(raw.subarray(position, position + stride));
    position += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 0xff;
      else if (filter === 2) line[x] = (line[x] + b) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) line[x] = (line[x] + paeth(a, b, c)) & 0xff;
      else if (filter !== 0) throw new Error(`未知 PNG filter ${filter}`);
    }
    for (let x = 0; x < width; x++) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      if (colorType === 6) {
        pixels[dst] = line[src]; pixels[dst + 1] = line[src + 1]; pixels[dst + 2] = line[src + 2]; pixels[dst + 3] = line[src + 3];
      } else if (colorType === 2) {
        pixels[dst] = line[src]; pixels[dst + 1] = line[src + 1]; pixels[dst + 2] = line[src + 2]; pixels[dst + 3] = 255;
      } else if (colorType === 0) {
        pixels[dst] = pixels[dst + 1] = pixels[dst + 2] = line[src]; pixels[dst + 3] = 255;
      } else if (colorType === 4) {
        pixels[dst] = pixels[dst + 1] = pixels[dst + 2] = line[src]; pixels[dst + 3] = line[src + 1];
      } else if (colorType === 3) {
        const index = line[src] * 3;
        pixels[dst] = palette[index]; pixels[dst + 1] = palette[index + 1]; pixels[dst + 2] = palette[index + 2]; pixels[dst + 3] = 255;
      }
    }
    previous = line;
  }
  return { width, height, data: pixels };
}

/** Composite any transparency over white, the way the sheet is displayed. */
function toRgb(image) {
  const { width, height, data } = image;
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    const alpha = data[i + 3] / 255;
    out[j] = Math.round(data[i] * alpha + 255 * (1 - alpha));
    out[j + 1] = Math.round(data[i + 1] * alpha + 255 * (1 - alpha));
    out[j + 2] = Math.round(data[i + 2] * alpha + 255 * (1 - alpha));
  }
  return { width, height, data: out };
}

module.exports = { decode, toRgb };
