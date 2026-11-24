// Minimal PNG reader for screenshot checks (8-bit gray/RGB/RGBA, non-interlaced). No dependencies.
import { inflateSync } from 'node:zlib';

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Decodes a PNG into { width, height, channels, data } (unfiltered rows, row-major). */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      channels = CHANNELS[body[9]] ?? 0;
      if (depth !== 8 || !channels || body[12] !== 0) throw new Error('unsupported PNG format');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = v & 0xff;
    }
  }
  return { width, height, channels, data };
}

/** How many pixels in rows [y0, y1) are lit (brightest channel above `threshold`, not transparent). */
export function litPixels(img, y0, y1, threshold = 64) {
  let lit = 0;
  const color = img.channels >= 3 ? 3 : 1;
  for (let y = y0; y < Math.min(y1, img.height); y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * img.channels;
      let max = 0;
      for (let k = 0; k < color; k++) max = Math.max(max, img.data[i + k]);
      const alpha = img.channels === 4 || img.channels === 2 ? img.data[i + img.channels - 1] : 255;
      if (max > threshold && alpha > 0) lit++;
    }
  }
  return lit;
}
