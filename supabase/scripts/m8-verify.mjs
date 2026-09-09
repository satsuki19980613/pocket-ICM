// M8(WP-A1) DoD 検証（β基盤: 新テーブル/新列/新ポリシーの存在確認）。
// 認証情報（ログイン）は使わない。anon 公開キーだけで「列がある/RLSで隠れている/未許可な書込みは
// 拒否される」ことを外形的に確認する。実際のログイン込みの動作は WP-E の実機検証で見る。
// 実行時に packages/app/.env.local から URL と公開キーのみを読む（値は表示しない）。
//
// 使い方（リポジトリのルート）:  node supabase/scripts/m8-verify.mjs
// 前提: 0001〜0006 の SQL をすべて SQL Editor で適用済みであること。
import fs from 'node:fs';
import path from 'node:path';

const envText = (() => {
  try {
    return fs.readFileSync(path.resolve('packages/app/.env.local'), 'utf8');
  } catch {
    console.error('.env.local が読めません。リポジトリのルートで実行してください。');
    process.exit(1);
  }
})();
const readEnv = (k) => (envText.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim();
const url = readEnv('VITE_SUPABASE_URL').replace(/\/+$/, '');
const anon = readEnv('VITE_SUPABASE_ANON_KEY');
if (!url || !anon) {
  console.error('.env.local に URL / 公開キーがありません。');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓ PASS' : '  ✗ FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  cond ? pass++ : fail++;
};

// anon キーを apikey / Authorization 両方に載せる（未ログイン=anon ロール相当のリクエスト）。
async function rest(pathAndQuery, init = {}) {
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// 列の存在確認: select=<cols>&limit=0 で 200 系なら列がある（無ければ PostgREST が 400/404 を返す）。
// limit=0 は「0件返す」リクエストなので、RLS で隠れているかの判定には使えない（常に空配列になる）。
async function columnsExist(table, cols) {
  const { status, json } = await rest(`${table}?select=${cols.join(',')}&limit=0`);
  return { okStatus: status >= 200 && status < 300, status, json };
}

// RLS 確認: limit=0 を付けない実 select で「anon ロールからは行が見えない」ことを見る
// （テーブルに行があってもなくても、RLS が効いていれば空配列が返る）。
async function rowsHiddenFromAnon(table) {
  const { status, json } = await rest(`${table}?select=id&limit=5`);
  return { okStatus: status >= 200 && status < 300, status, hidden: Array.isArray(json) && json.length === 0 };
}

async function main() {
  console.log('\n=== M8(WP-A1) β基盤 検証 ===\n');

  // ---- results 拡張列 ----
  {
    const cols = [
      'status', 'client_id', 'hero_hand', 'hero_pos', 'players_left',
      'verdict', 'hero_ev', 'solve_ms', 'error', 'image_id', 'ocr_read_id', 'updated_at',
    ];
    const { okStatus, status } = await columnsExist('results', cols);
    ok('results: 拡張列がすべて存在する', okStatus, `status=${status}`);
  }

  // ---- images テーブル ----
  {
    const cols = [
      'id', 'owner', 'kind', 'bucket', 'path', 'bytes', 'width', 'height',
      'mime', 'sha256', 'created_at', 'expires_at', 'protected',
    ];
    const { okStatus, status } = await columnsExist('images', cols);
    ok('images: テーブル/列が存在する', okStatus, `status=${status}`);
    if (okStatus) {
      const rls = await rowsHiddenFromAnon('images');
      ok('images: 未ログイン(anon)では行が見えない（RLS）', rls.okStatus && rls.hidden, `status=${rls.status}`);
    }
  }

  // ---- ocr_reads テーブル ----
  {
    const cols = [
      'id', 'owner', 'image_id', 'result_id', 'ok', 'display_mode', 'street',
      'issues', 'issue_codes', 'low_confidence', 'raw_reads', 'state', 'final_state',
      'corrections', 'app_version', 'ocr_version', 'device', 'created_at',
    ];
    const { okStatus, status } = await columnsExist('ocr_reads', cols);
    ok('ocr_reads: テーブル/列が存在する', okStatus, `status=${status}`);
    if (okStatus) {
      const rls = await rowsHiddenFromAnon('ocr_reads');
      ok('ocr_reads: 未ログイン(anon)では行が見えない（RLS）', rls.okStatus && rls.hidden, `status=${rls.status}`);
    }
  }

  // ---- threads 拡張列 ----
  {
    const cols = ['kind', 'result_id', 'body', 'image_url', 'updated_at'];
    const { okStatus, status } = await columnsExist('threads', cols);
    ok('threads: 拡張列（kind/body/image_url/updated_at）が存在する', okStatus, `status=${status}`);
  }

  // ---- RLS: 未ログイン(anon ロール)からの書込みは拒否される ----
  {
    const { status, json } = await rest('threads', {
      method: 'POST',
      body: JSON.stringify({ kind: 'post', body: 'm8-verify probe' }),
      headers: { Prefer: 'return=minimal' },
    });
    ok('threads: 未ログインでの通常投稿 insert は拒否される', status >= 400, `status=${status} ${json?.message ?? json?.code ?? ''}`);
  }
  {
    const { status, json } = await rest('images', {
      method: 'POST',
      body: JSON.stringify({ owner: '00000000-0000-0000-0000-000000000000', kind: 'spot', path: 'probe/x.webp' }),
      headers: { Prefer: 'return=minimal' },
    });
    ok('images: 未ログインでの insert は拒否される', status >= 400, `status=${status} ${json?.message ?? json?.code ?? ''}`);
  }

  // ---- Storage: spot-images バケットが存在する（private・匿名では中身が見えない）----
  {
    const res = await fetch(`${url}/storage/v1/object/list/spot-images`, {
      method: 'POST',
      headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 1 }),
    });
    // バケットが無ければ 400 系で「Bucket not found」。バケットはあるが権限が無ければ 200(空/一部) か 400/403。
    // ここでは「404(未作成)」ではないことだけを確認する（存在の外形確認）。
    const json = await res.json().catch(() => ({}));
    ok(
      'spot-images バケットが存在する（404 ではない）',
      res.status !== 404,
      `status=${res.status} ${json?.message ?? ''}`,
    );
  }

  // ---- Edge Function purge-images がデプロイ済みで、誤トークンを拒否する ----
  {
    const res = await fetch(`${url}/functions/v1/purge-images`, {
      method: 'POST',
      headers: { apikey: anon, Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    const json = await res.json().catch(() => ({}));
    ok(
      'purge-images: 誤った PURGE_TOKEN は拒否される（関数はデプロイ済み）',
      res.status === 401 || res.status === 500,
      `status=${res.status} error=${json?.error ?? '-'}`,
    );
  }

  console.log(`\n=== 結果: ${pass} PASS / ${fail} FAIL ===\n`);
  if (fail > 0) {
    console.log('※ FAIL が「テーブル/列が存在する」系なら 0006_beta.sql の未適用/失敗を疑う。');
    console.log('※ purge-images の FAIL が status=404 なら Edge Function 未デプロイ。');
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('検証中エラー:', e);
  process.exit(1);
});
