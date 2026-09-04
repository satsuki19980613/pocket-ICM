/**
 * IEEE 754 half-precision（float16, 2バイト）⇔ float32 変換（依存ゼロ）。
 *
 * 事前計算テーブルは EV差（符号がゼロ交差＝押し引き判定を決める）と eqPost を格納する。
 * float16 は相対精度 ~3桁・ゼロ近傍は非正規化数で細かく刻めるため、符号（=戦略）を完全に
 * 保ちつつ容量を半減できる（float32 22.8MB → float16 11.4MB）。int8 はゼロ近傍で符号反転
 * しうるので使わない。ランタイムは読込時に一度だけ float32 へ復号する（探索は従来どおり）。
 */

/** float32 値 → float16 のビット（Uint16）。最近接丸め・オーバーフローは ±Inf。 */
export function floatToHalfBits(value: number): number {
  const f = new Float32Array(1);
  const i = new Int32Array(f.buffer);
  f[0] = value;
  const x = i[0]!;
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  const mantissa = x & 0x7fffff;

  if (((x >>> 23) & 0xff) === 0xff) {
    // Inf / NaN
    return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  }
  if (exp >= 0x1f) return sign | 0x7c00; // オーバーフロー → Inf
  if (exp <= 0) {
    // 非正規化数 or アンダーフロー
    if (exp < -10) return sign; // 完全アンダーフロー → ±0
    const m = (mantissa | 0x800000) >>> (1 - exp);
    // 最近接丸め
    let half = sign | (m >>> 13);
    if (m & 0x1000) half += 1;
    return half & 0xffff;
  }
  // 正規化数（最近接丸め、桁上げで指数繰上げも吸収）
  let half = sign | (exp << 10) | (mantissa >>> 13);
  if (mantissa & 0x1000) half += 1; // round-to-nearest（Inf への繰上げも自然に処理）
  return half & 0xffff;
}

// ビット再解釈用のスクラッチ（モジュール共有・単一スレッドJVなので再入なし）。
// 呼び出しごとの new Int32Array/Float32Array 確保を避ける（大量復号の主要コスト源だった）。
const _i = new Int32Array(1);
const _f = new Float32Array(_i.buffer);

/** float16 のビット（Uint16）→ float32 値。 */
export function halfBitsToFloat(h: number): number {
  const sign = (h & 0x8000) << 16;
  const exp = (h >>> 10) & 0x1f;
  const mantissa = h & 0x3ff;
  const i = _i;
  const f = _f;

  if (exp === 0) {
    if (mantissa === 0) {
      i[0] = sign; // ±0
    } else {
      // 非正規化数 → 正規化
      let e = -1, m = mantissa;
      do { e++; m <<= 1; } while ((m & 0x400) === 0);
      m &= 0x3ff;
      i[0] = sign | ((127 - 15 - e) << 23) | (m << 13);
    }
  } else if (exp === 0x1f) {
    i[0] = sign | 0x7f800000 | (mantissa << 13); // Inf / NaN
  } else {
    i[0] = sign | ((exp - 15 + 127) << 23) | (mantissa << 13);
  }
  return f[0]!;
}

/** Float32Array → float16 ビット列（Uint16Array）。 */
export function encodeFloat16(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = floatToHalfBits(src[i]!);
  return out;
}

// 全 65536 通りの half → float32 を一度だけ表引き化（初回のみ生成・以後共有）。
// これで大量復号は「アロケーション・分岐なしのメモリコピー」になる（~1s → 数十ms）。
let HALF_LUT: Float32Array | null = null;
function halfLut(): Float32Array {
  if (HALF_LUT) return HALF_LUT;
  const lut = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) lut[h] = halfBitsToFloat(h);
  HALF_LUT = lut;
  return lut;
}

/** float16 ビット列（Uint16Array）→ Float32Array（65536 エントリの LUT で高速復号）。 */
export function decodeFloat16(src: Uint16Array): Float32Array {
  const lut = halfLut();
  const n = src.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = lut[src[i]!]!;
  return out;
}
