// 初回アカウント作成（ブートストラップ）。アプリの signup 画面がまだ無いので、
// デプロイ済みの signup Edge Function をローカルから直接叩いてアカウントを作る。
// パスワードは引数として端末内で完結する（チャットには出さない）。
//
// 前提: gen-invite.mjs で生成した招待キーを SQL Editor で INSERT 済みであること。
//
// 使い方（リポジトリのルートで, cmd/PowerShell）:
//   node supabase/scripts/bootstrap-signup.mjs <招待キー> <handle> "<表示名>" "<パスワード>"
// 例:
//   node supabase/scripts/bootstrap-signup.mjs POCKET-AB3F-CD7K satsuki "さつき" "MyPassw0rd!"
//
// handle: 英小文字/数字/アンダースコア 3〜20 文字。パスワード: 8 文字以上。
import fs from 'node:fs';
import path from 'node:path';

const [, , invite, handle, displayName, password] = process.argv;
if (!invite || !handle || !displayName || !password) {
  console.error(
    '\n使い方: node supabase/scripts/bootstrap-signup.mjs <招待キー> <handle> "<表示名>" "<パスワード>"\n',
  );
  process.exit(1);
}

// .env.local から URL と公開キーを読む（実値は端末内に留まる）。
const envPath = path.resolve('packages/app/.env.local');
let envText;
try {
  envText = fs.readFileSync(envPath, 'utf8');
} catch {
  console.error(`\n.env.local が見つかりません: ${envPath}\n`);
  process.exit(1);
}
const readEnv = (key) => {
  const m = envText.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
};
const url = readEnv('VITE_SUPABASE_URL').replace(/\/+$/, '');
const anon = readEnv('VITE_SUPABASE_ANON_KEY');
if (!url || !anon) {
  console.error('\n.env.local に VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が見つかりません。\n');
  process.exit(1);
}

const EMAIL_DOMAIN = 'users.pocket-icm.app';
const email = `${handle.trim().toLowerCase()}@${EMAIL_DOMAIN}`;

async function main() {
  // 1) signup 関数でアカウント作成
  console.log('\n[1/2] signup 関数を呼び出し中…');
  const signupRes = await fetch(`${url}/functions/v1/signup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anon,
      Authorization: `Bearer ${anon}`,
    },
    body: JSON.stringify({ handle, display_name: displayName, password, invite_code: invite }),
  });
  const signupBody = await signupRes.json().catch(() => ({}));
  if (!signupRes.ok || signupBody.error) {
    console.error(`  ✗ signup 失敗 (HTTP ${signupRes.status}):`, JSON.stringify(signupBody));
    console.error('    → 招待キー/handle/パスワードを確認してください。');
    process.exit(1);
  }
  console.log('  ✓ アカウント作成:', JSON.stringify(signupBody));

  // 2) ログイン確認（GoTrue password grant）
  console.log('[2/2] ログイン確認中…');
  const loginRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anon },
    body: JSON.stringify({ email, password }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || !loginBody.access_token) {
    console.error(`  ✗ ログイン失敗 (HTTP ${loginRes.status}):`, JSON.stringify(loginBody));
    process.exit(1);
  }
  console.log('  ✓ ログイン成功（access_token 取得）\n');

  console.log('=== 完了 ===');
  console.log(`アカウント handle: ${handle}`);
  console.log('次の SQL を SQL Editor で実行して自分を管理者にしてください:');
  console.log(`  update public.profiles set is_admin = true where handle = '${handle}';\n`);
}

main().catch((e) => {
  console.error('予期しないエラー:', e);
  process.exit(1);
});
