/**
 * OCR 失敗データの取得（SPEC §12.3・運用スクリプト、依存ゼロ流儀は不可のため唯一の例外で
 * `@supabase/supabase-js` のみ使う＝ワークスペースに既存）。
 *
 * さつきがローカルで実行し、サーバに溜まった OCR 失敗・低信頼の `ocr_reads` 行と、
 * それに紐づく元画像（`images` / `spot-images` private バケット）を
 * `packages/ocr/local-fixtures/failures/`（gitignore 済み）へ落とす。
 *
 * 認証は service_role キーを**環境変数からのみ**読む。キーはリポジトリに書かない・
 * コミットしない（RLS を無視して全件を読むための強い権限のため、ローカル実行専用）。
 *
 *   SUPABASE_URL=https://xxxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=xxxxxxxxxxxxxxxx   （Supabase ダッシュボード → Project Settings → API）
 *
 * 使い方（リポジトリのルートから）:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx packages/ocr/scripts/pullFailures.ts
 *   npx tsx packages/ocr/scripts/pullFailures.ts --since=2026-08-01 --limit=200 --only=lowconf
 *
 * オプション（すべて任意）:
 *   --since=YYYY-MM-DD   この日付以降に作成された ocr_reads のみ（既定: 30日前）
 *   --limit=N            最大取得件数（既定: 100）
 *   --only=failed|lowconf|all
 *       failed  = ok=false のみ（既定・OCR が棄却/失敗した行）
 *       lowconf = ok=true かつ low_confidence が1件以上ある行（成功したが低信頼フィールドあり）
 *       all     = 期間内の全 ocr_reads（成功も含めて棚卸ししたい時用）
 *
 * 出力（`packages/ocr/local-fixtures/failures/`、1件＝1ファイル・ディレクトリはフラット）:
 *   <ocr_read_id>.<ext>   元画像（webp/jpg/png のいずれか。image_id が無い/取得失敗なら無し）
 *   <ocr_read_id>.json    ocr_reads の行そのまま（issues/raw_reads/state/final_state/
 *                          corrections/device などを含む。corrections が暗黙の正解ラベル）
 *   index.csv             一覧（id/created_at/ok/display_mode/issue_codes/aspect/device）。
 *                          表計算で機種別・原因別にフィルタ/ソートして眺める用。
 *
 * 較正ハーネス（verifyFrame.ts / extractFrame.ts）は現状 PNG 専用（`pngCodec.ts` の自前
 * デコーダで WebP/JPEG は読めない）。出力ファイル名は `<input.png>` 単体を渡す既存ハーネスの
 * 引数の取り方に合わせてあるが、拡張子が .webp/.jpg の画像はそのままでは食わせられないため、
 * 較正に使う前に PNG へ変換すること（手順は docs/OCR_ANALYSIS.md）。
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'local-fixtures', 'failures');

type OnlyMode = 'failed' | 'lowconf' | 'all';

interface Options {
  since: string; // YYYY-MM-DD
  limit: number;
  only: OnlyMode;
}

function usageAndExit(reason?: string): never {
  if (reason) console.error(`エラー: ${reason}\n`);
  console.error(`OCR 失敗データの取得（SPEC §12.3）。

必須の環境変数:
  SUPABASE_URL                 例: https://xxxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY    Supabase ダッシュボード → Project Settings → API → service_role
                                （**このキーは絶対にリポジトリへコミットしない**）

使い方:
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx packages/ocr/scripts/pullFailures.ts [オプション]

オプション:
  --since=YYYY-MM-DD    この日付以降に作成された ocr_reads のみ（既定: 30日前）
  --limit=N             最大取得件数（既定: 100）
  --only=failed|lowconf|all
                         failed  = ok=false のみ（既定）
                         lowconf = ok=true かつ low_confidence が1件以上ある行
                         all     = 期間内の全 ocr_reads（成功も含む）

出力先: packages/ocr/local-fixtures/failures/ （gitignore 済み）
`);
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  const raw: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([a-z]+)=(.*)$/.exec(a);
    if (m?.[1] !== undefined && m[2] !== undefined) raw[m[1]] = m[2];
  }

  const sinceDefault = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const since = raw.since ?? sinceDefault;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) usageAndExit(`--since は YYYY-MM-DD 形式で指定してください（受け取った値: ${since}）`);

  const limit = Number(raw.limit ?? '100');
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isInteger(limit)) {
    usageAndExit(`--limit は正の整数で指定してください（受け取った値: ${raw.limit}）`);
  }

  const only = (raw.only ?? 'failed') as OnlyMode;
  if (only !== 'failed' && only !== 'lowconf' && only !== 'all') {
    usageAndExit(`--only は failed|lowconf|all のいずれかで指定してください（受け取った値: ${only}）`);
  }

  return { since, limit, only };
}

/** MIME → 拡張子。`packages/app/src/supabase/images.ts#extForMime` と同じ判断（画像パッケージを
 * 跨いで import すると結合が増えるため、ここではローカルに小さく複製する）。 */
function extForMime(mime: string | null | undefined): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  return 'webp';
}

/** CSV の1セル（カンマ・改行・引用符を含む値はダブルクオートで囲む）。 */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

interface OcrReadRow {
  id: string;
  created_at: string;
  ok: boolean;
  display_mode: string | null;
  issue_codes: unknown;
  low_confidence: unknown;
  image_id: string | null;
  device: { aspect?: number; ua?: string; dpr?: number; w?: number; h?: number } | null;
  // その他の列（raw_reads/state/final_state/corrections/app_version/ocr_version 等）は
  // そのまま JSON へ書き出すだけなので、ここでは個別に型付けしない。
  [key: string]: unknown;
}

interface ImageRow {
  id: string;
  bucket: string;
  path: string;
  mime: string | null;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) usageAndExit('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です');

  const { since, limit, only } = parseArgs(process.argv.slice(2));
  const sinceIso = new Date(`${since}T00:00:00.000Z`).toISOString();

  const admin = createClient(url, key, { auth: { persistSession: false } });

  console.log(`取得条件: since=${since} limit=${limit} only=${only}`);

  let query = admin.from('ocr_reads').select('*').gte('created_at', sinceIso).order('created_at', { ascending: false });
  if (only === 'failed') query = query.eq('ok', false);
  // lowconf/all は jsonb 配列長のサーバ側フィルタが複雑になるため取得後にフィルタする
  // （β運用の件数規模なら問題にならない）。lowconf は該当行を取りこぼさないよう広めに取得。
  const fetchLimit = only === 'lowconf' ? Math.max(limit * 5, 500) : limit;
  query = query.limit(fetchLimit);

  const { data, error } = await query;
  if (error) {
    console.error('ocr_reads の取得に失敗しました:', error.message);
    process.exit(1);
  }

  let rows = (data ?? []) as OcrReadRow[];
  if (only === 'lowconf') {
    rows = rows.filter((r) => r.ok && Array.isArray(r.low_confidence) && r.low_confidence.length > 0);
  }
  rows = rows.slice(0, limit);

  if (rows.length === 0) {
    console.log('該当する ocr_reads はありませんでした。');
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });

  // 画像メタ（bucket/path/mime）をまとめて引く。
  const imageIds = [...new Set(rows.map((r) => r.image_id).filter((x): x is string => Boolean(x)))];
  const imagesById = new Map<string, ImageRow>();
  if (imageIds.length > 0) {
    const { data: imgs, error: imgErr } = await admin.from('images').select('id, bucket, path, mime').in('id', imageIds);
    if (imgErr) {
      console.warn('images の取得に失敗しました（画像なしで続行）:', imgErr.message);
    } else {
      for (const img of (imgs ?? []) as ImageRow[]) imagesById.set(img.id, img);
    }
  }

  const csvLines = ['id,created_at,ok,display_mode,issue_codes,aspect,device'];
  let imgOk = 0;
  let imgFail = 0;

  for (const row of rows) {
    writeFileSync(join(OUT_DIR, `${row.id}.json`), JSON.stringify(row, null, 2), 'utf8');

    const img = row.image_id ? imagesById.get(row.image_id) : undefined;
    if (img) {
      const { data: blob, error: dlErr } = await admin.storage.from(img.bucket).download(img.path);
      if (dlErr || !blob) {
        imgFail++;
        console.warn(`  画像取得失敗: ${row.id} (${img.bucket}/${img.path}) — ${dlErr?.message ?? '不明なエラー'}`);
      } else {
        const buf = Buffer.from(await blob.arrayBuffer());
        writeFileSync(join(OUT_DIR, `${row.id}.${extForMime(img.mime)}`), buf);
        imgOk++;
      }
    }

    const issueCodes = Array.isArray(row.issue_codes) ? row.issue_codes.join(';') : '';
    csvLines.push(
      [
        csvCell(row.id),
        csvCell(row.created_at),
        csvCell(row.ok),
        csvCell(row.display_mode ?? ''),
        csvCell(issueCodes),
        csvCell(row.device?.aspect ?? ''),
        csvCell(row.device ? JSON.stringify(row.device) : ''),
      ].join(','),
    );
  }

  writeFileSync(join(OUT_DIR, 'index.csv'), `${csvLines.join('\n')}\n`, 'utf8');

  console.log(`\n${rows.length}件の ocr_reads を書き出しました → ${OUT_DIR}`);
  console.log(`  画像: 取得${imgOk}件 / 取得失敗${imgFail}件 / 画像なし${rows.length - imgOk - imgFail}件`);
  console.log('  index.csv も書き出しました（表計算で機種別・原因別に眺められます）。');
}

void main();
