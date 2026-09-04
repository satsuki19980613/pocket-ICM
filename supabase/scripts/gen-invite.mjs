// ブートストラップ用の招待キー生成（ローカル実行）。
// さつきの初回アカウント作成に使う「最初の1本」を、生キーを他人（AI含む）に見せずに作るための道具。
//
// 使い方（PowerShell）:
//   node supabase/scripts/gen-invite.mjs
// → 生キー（アプリのサインアップに入力）と、code_hash（SQL に貼る）を表示する。
//
// アルゴリズムは Edge Function の _shared/util.ts と一致:
//   normalize = 大文字化して英数字以外を除去、hash = SHA-256 hex。
import crypto from 'node:crypto';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 0/O/1/I/L 除外

function generateCode() {
  const chars = [];
  for (let i = 0; i < 8; i++) chars.push(ALPHABET[crypto.randomInt(ALPHABET.length)]);
  return `POCKET-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}`;
}

function normalize(code) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const code = generateCode();
const hash = sha256Hex(normalize(code));
const expires = new Date(Date.now() + 7 * 86400_000).toISOString();

console.log('\n=== ブートストラップ招待キー（初回アカウント用）===\n');
console.log('生キー（アプリのサインアップ画面に入力）:');
console.log('  ' + code + '\n');
console.log('SQL（Supabase SQL Editor に貼って実行）:');
console.log(
  `  insert into public.invite_codes (code_hash, ref, expires_at, status)\n` +
    `  values ('${hash}', 'boot', '${expires}', 'unused');\n`,
);
console.log('※ 生キーはこの画面にしか出ません。コピーしてから閉じてください。\n');
