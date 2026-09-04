// M1 DoD 検証（サーバ側の拒否）。認証情報不要でデプロイ済みバックエンドの拒否経路を確認する。
// 実行時に packages/app/.env.local から URL と公開キーのみを読む（値は表示しない）。
//
// 使い方（リポジトリのルート）:  node supabase/scripts/m1-verify.mjs
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
const rnd = () => 'zz' + Math.random().toString(36).slice(2, 8);

async function post(fnPath, body, extraHeaders = {}) {
  const res = await fetch(`${url}${fnPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anon, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  console.log('\n=== M1 サーバ側 拒否検証 ===\n');

  // 1) 無効な招待キー → signup 拒否（アカウントは作られない）
  {
    const { status, json } = await post(
      '/functions/v1/signup',
      { handle: rnd(), display_name: 'テスト', password: 'abcdefgh12', invite_code: 'POCKET-ZZZZ-ZZZZ' },
      { Authorization: `Bearer ${anon}` },
    );
    ok('無効な招待キーは拒否される', status >= 400 || !!json.error, `status=${status} error=${json.error ?? '-'}`);
  }

  // 2) 短いパスワード → signup 拒否
  {
    const { status, json } = await post(
      '/functions/v1/signup',
      { handle: rnd(), display_name: 'テスト', password: 'short', invite_code: 'POCKET-ZZZZ-ZZZZ' },
      { Authorization: `Bearer ${anon}` },
    );
    ok('短いパスワードは拒否される', status >= 400 || !!json.error, `status=${status} error=${json.error ?? '-'}`);
  }

  // 3) 不正な handle 形式 → signup 拒否
  {
    const { status, json } = await post(
      '/functions/v1/signup',
      { handle: 'Bad Handle!!', display_name: 'テスト', password: 'abcdefgh12', invite_code: 'POCKET-ZZZZ-ZZZZ' },
      { Authorization: `Bearer ${anon}` },
    );
    ok('不正な handle は拒否される', status >= 400 || !!json.error, `status=${status} error=${json.error ?? '-'}`);
  }

  // 4) 非管理者（セッション無し）で管理関数 issue-invite → 拒否
  {
    const { status, json } = await post('/functions/v1/issue-invite', {}, { Authorization: `Bearer ${anon}` });
    ok('未認証での招待キー発行は拒否される', status >= 400 || !!json.error, `status=${status} error=${json.error ?? '-'}`);
  }

  // 5) でたらめな認証情報でのログイン → 拒否
  {
    const { status, json } = await post('/auth/v1/token?grant_type=password', {
      email: `${rnd()}@users.pocket-icm.app`,
      password: 'wrongpass123',
    });
    ok('無効な認証情報のログインは拒否される', status >= 400 || !json.access_token, `status=${status}`);
  }

  console.log(`\n=== 結果: ${pass} PASS / ${fail} FAIL ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('検証中エラー:', e);
  process.exit(1);
});
