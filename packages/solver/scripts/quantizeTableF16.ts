/**
 * 事前計算テーブルの float32 bin を float16 に量子化して容量を半減（dev専用）。
 *
 * 生成（gen*wayTable.ts）は float32 を master として書く。配信用はこのスクリプトで
 * float16 化し、meta.dtype='f16' を立てる（ランタイム pfTable.decodePfData が読込時に
 * float32 へ復号）。EV差の符号（=ゼロ交差＝押し引き）は float16 で完全保存される。
 *
 * 実行: node --import tsx scripts/quantizeTableF16.ts <basename>
 *   例: node --import tsx scripts/quantizeTableF16.ts pf4way
 *   入力 artifacts/<basename>.f32.bin + <basename>.meta.json
 *   出力 artifacts/<basename>.f16.bin（f16）＋ meta.json を dtype='f16' に更新。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeFloat16, decodeFloat16 } from '../src/halfFloat.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, '..', 'artifacts');

const base = process.argv[2] ?? 'pf4way';
const metaPath = join(ART, `${base}.meta.json`);
const f32Path = join(ART, `${base}.f32.bin`);
const f16Path = join(ART, `${base}.f16.bin`);

const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
const bin = readFileSync(f32Path);
const f32 = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);

const f16 = encodeFloat16(f32);

// 量子化の健全性: 符号一致率（=押し引き判定の保存）と最大絶対誤差を実測。
const back = decodeFloat16(f16);
let signKept = 0, maxAbsErr = 0, maxRelErr = 0, nonzero = 0;
for (let i = 0; i < f32.length; i++) {
  const a = f32[i]!, b = back[i]!;
  if (Math.sign(a) === Math.sign(b)) signKept++;
  const ae = Math.abs(a - b);
  if (ae > maxAbsErr) maxAbsErr = ae;
  if (Math.abs(a) > 1e-6) { nonzero++; const re = ae / Math.abs(a); if (re > maxRelErr) maxRelErr = re; }
}
const signPct = (signKept / f32.length) * 100;

writeFileSync(f16Path, Buffer.from(f16.buffer, 0, f16.byteLength));
meta.dtype = 'f16';
writeFileSync(metaPath, JSON.stringify(meta, null, 2));

log(`# ${base}: float32 → float16 量子化`);
log(`  要素数 ${f32.length.toLocaleString()} / f32 ${(bin.byteLength / 1024 / 1024).toFixed(2)}MB → f16 ${(f16.byteLength / 1024 / 1024).toFixed(2)}MB`);
log(`  符号一致 ${signPct.toFixed(4)}%（=押し引き判定の保存, 100%以外は要注意）`);
log(`  最大絶対誤差 ${maxAbsErr.toExponential(3)} / 最大相対誤差 ${maxRelErr.toExponential(3)}（非ゼロ ${nonzero.toLocaleString()} 要素）`);
log(`  meta.dtype='f16' に更新。配信 bin は ${base}.f16.bin（${base}.f32.bin は master として保持）。`);
