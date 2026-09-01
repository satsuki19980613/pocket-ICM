/**
 * 依存ゼロの PNG デコード/エンコード（**dev/較正専用**）。
 *
 * アプリ本体はブラウザの Canvas / createImageBitmap で PNG を復号するため、この
 * コーデックは出荷物ではない。golden dataset のスクショから領域を切り出して目視検証
 * したり、カード/数字テンプレを生成したりする較正スクリプトのためだけに使う。
 * 対応: 8bit, colorType 2(RGB)/6(RGBA), interlace 0（今回のスクショは全て RGB 8bit）。
 * Node stdlib の zlib のみ使用。
 */

import { inflateSync, deflateSync } from 'node:zlib';

export interface Raster {
  width: number;
  height: number;
  /** RGBA, 行優先, length = width*height*4。 */
  rgba: Uint8Array;
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function makeCrcTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC_TABLE = makeCrcTable();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** PNG バッファ → Raster（RGBA）。 */
export function decodePng(buf: Uint8Array): Raster {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('not a PNG');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (off < buf.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4]!, buf[off + 5]!, buf[off + 6]!, buf[off + 7]!);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      bitDepth = buf[off + 16]!;
      colorType = buf[off + 17]!;
      const interlace = buf[off + 20]!;
      if (bitDepth !== 8) throw new Error(`unsupported bitDepth ${bitDepth}`);
      if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported colorType ${colorType}`);
      if (interlace !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') {
      idat.push(data.slice());
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat.map((u) => Buffer.from(u))));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]!;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[p++]!;
      const a = x >= channels ? cur[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let val: number;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: val = rawByte + paeth(a, b, c); break;
        default: throw new Error(`bad filter ${filter}`);
      }
      cur[x] = val & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      rgba[dst] = cur[src]!;
      rgba[dst + 1] = cur[src + 1]!;
      rgba[dst + 2] = cur[src + 2]!;
      rgba[dst + 3] = channels === 4 ? cur[src + 3]! : 255;
    }
    prev.set(cur);
  }
  return { width, height, rgba };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  dv.setUint32(8 + data.length, crc);
  return out;
}

/** Raster（RGBA）→ PNG バッファ（colorType 6, filter None）。 */
export function encodePng(r: Raster): Uint8Array {
  const { width, height, rgba } = r;
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const compressed = deflateSync(Buffer.from(raw));
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 6; // colorType RGBA
  const parts = [
    new Uint8Array(SIG),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(compressed)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((a, u) => a + u.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
