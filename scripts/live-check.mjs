// 公開中のサイトとサーバーを、ログインせずに外から確かめる（書き込みはしない）。
// GitHub Actions の Live（.github/workflows/live.yml）が毎週と、配信やサーバーを変えたときに走らせる。
//
//   1. サイト: トップページが返るか
//   2. ヘッダ: 公開中の応答ヘッダが packages/app/public/_headers の `/*` と一致するか
//   3. Worker: Slumbot 中継が login を通さないか・SIT & GO がトークン無しを断るか
//   4. Supabase: ログインしていない人に、表・画像の一覧・管理用の関数が何も返さないか
//      （公開キーはサイトの JS に入っているもの＝誰でも見られる値を使う）
//   5. Mozilla HTTP Observatory: 保護ヘッダの評価（等級・点数・合格した項目数）
//
// 使い方: node scripts/live-check.mjs
//   SITE           確かめるサイト（既定 https://pocket-icm.wsk641.workers.dev）
//   ENFORCE=1      2 と 5 を合否に含める（既定ブランチ・定期実行）。0 だと結果を出すだけ
//                  （作業ブランチでは、まだ配信されていない _headers と比べることになるため）
//   WAIT_SECONDS   2 が一致するまで待つ秒数（push 直後は Workers Builds の配信を待つ）
//   MIN_GRADE      5 で求める等級（既定 A+）
import { readFileSync, appendFileSync } from 'node:fs';

const SITE = (process.env.SITE || 'https://pocket-icm.wsk641.workers.dev').replace(/\/+$/, '');
const ENFORCE = process.env.ENFORCE === '1';
const WAIT_SECONDS = Number(process.env.WAIT_SECONDS || 0);
const MIN_GRADE = process.env.MIN_GRADE || 'A+';
const GRADES = ['F', 'D-', 'D', 'D+', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+'];

let failed = 0;
const summary = [];
function check(name, ok, detail = '', { soft = false } = {}) {
  const mark = ok ? 'PASS' : soft ? 'WARN' : 'FAIL';
  if (!ok && !soft) failed++;
  console.log(`${mark}  ${name}${detail ? `  — ${detail}` : ''}`);
  summary.push(`| ${mark} | ${name} | ${detail.replace(/\|/g, '\\|')} |`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(url, init = {}) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000), ...init });
  const text = await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, text };
}

/** _headers の `/*` の段だけを { 小文字の名前: 値 } にする（vite の preview と同じ読み方）。 */
function expectedHeaders() {
  const out = {};
  let inAll = false;
  for (const line of readFileSync(new URL('../packages/app/public/_headers', import.meta.url), 'utf8').split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      inAll = line.trim() === '/*';
      continue;
    }
    const i = line.indexOf(':');
    if (inAll && i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function headerDiff(headers, want) {
  return Object.entries(want)
    .filter(([k, v]) => headers.get(k) !== v)
    .map(([k]) => k);
}

async function checkSite() {
  const home = await req(`${SITE}/`);
  check('サイトのトップページ', home.status === 200 && home.text.includes('<div id="root">'), `HTTP ${home.status}`);
  return home;
}

async function checkHeaders(home) {
  const want = expectedHeaders();
  let diff = headerDiff(home.headers, want);
  const until = Date.now() + WAIT_SECONDS * 1000;
  while (diff.length > 0 && Date.now() < until) {
    console.log(`  ヘッダがまだ違う（${diff.join(', ')}）。配信を待つ…`);
    await sleep(30_000);
    diff = headerDiff((await req(`${SITE}/`)).headers, want);
  }
  check(
    `保護ヘッダが _headers と一致（${Object.keys(want).length} 件）`,
    diff.length === 0,
    diff.length === 0 ? Object.keys(want).join(', ') : `違うもの: ${diff.join(', ')}`,
    { soft: !ENFORCE },
  );
}

async function checkWorker() {
  const login = await req(`${SITE}/api/slumbot/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  check('Slumbot 中継は login を通さない', login.status === 404, `HTTP ${login.status}（404 が正しい）`);

  const noToken = await req(`${SITE}/api/sng/rooms`);
  check('SIT & GO はトークン無しを断る', noToken.status === 401, `HTTP ${noToken.status}（401 が正しい）`);

  const badToken = await req(`${SITE}/api/sng/rooms`, { headers: { authorization: 'Bearer not-a-token' } });
  check('SIT & GO は偽のトークンを断る', badToken.status === 401, `HTTP ${badToken.status}（401 が正しい）`);
}

/** サイトの JS から Supabase の住所と公開キーを拾う（ビルド時に埋め込まれる、誰でも見られる値）。 */
async function findSupabase(home) {
  const seen = new Set();
  const queue = [...home.text.matchAll(/(?:\.\/|\/)?assets\/[\w.-]+\.js/g)].map((m) => m[0]);
  let url = null;
  let key = null;
  while (queue.length > 0 && seen.size < 40 && !(url && key)) {
    const path = queue.shift().replace(/^\.?\//, '').replace(/^(?!assets\/)/, 'assets/');
    if (seen.has(path)) continue;
    seen.add(path);
    const js = await req(`${SITE}/${path}`);
    url ??= js.text.match(/https:\/\/[a-z0-9]{20}\.supabase\.co/)?.[0] ?? null;
    key ??= js.text.match(/sb_publishable_[\w-]+|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/)?.[0] ?? null;
    for (const m of js.text.matchAll(/[\w.-]+\.js/g)) {
      if (/^[\w-]+-[\w-]{8}\.js$/.test(m[0]) && !seen.has(`assets/${m[0]}`)) queue.push(m[0]);
    }
  }
  return { url, key };
}

// 会員でない人（ここではログインしていない人）には、どの表も 1 行も返らないはず（supabase/migrations/0008_security.sql ほか）
const TABLES = [
  'profiles', 'results', 'threads', 'comments', 'likes', 'hu_stats', 'hu_hands', 'images', 'ocr_reads',
  'client_errors', 'app_config', 'invite_codes', 'sng_games', 'sng_results', 'sng_hands', 'sng_hole_cards',
];
const BUCKETS = ['avatars', 'thread-images', 'spot-images'];
// 管理者か本人のログインが要る関数。ログインしていなければ断られるはず（どれも何も作らない・消さない）
const FUNCTIONS = ['issue-invite', 'revoke-invite', 'set-max-accounts', 'delete-account', 'purge-images'];

async function checkSupabase(home) {
  const { url, key } = await findSupabase(home);
  check('サイトの JS から Supabase の住所と公開キーが分かる', Boolean(url && key), url ?? '見つからない');
  if (!url || !key) return;
  const h = { apikey: key, authorization: `Bearer ${key}` };

  const leaked = [];
  for (const t of TABLES) {
    const r = await req(`${url}/rest/v1/${t}?select=*&limit=1`, { headers: h });
    let rows = 0;
    try {
      const j = JSON.parse(r.text);
      rows = Array.isArray(j) ? j.length : 0;
    } catch {}
    if (r.status === 200 && rows > 0) leaked.push(t);
  }
  check(`ログインしていない人に表の中身が返らない（${TABLES.length} 表）`, leaked.length === 0, leaked.length ? `返った表: ${leaked.join(', ')}` : '');

  const listed = [];
  for (const b of BUCKETS) {
    const r = await req(`${url}/storage/v1/object/list/${b}`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 1 }),
    });
    let n = 0;
    try {
      const j = JSON.parse(r.text);
      n = Array.isArray(j) ? j.length : 0;
    } catch {}
    if (r.status === 200 && n > 0) listed.push(b);
  }
  check(`ログインしていない人に画像の一覧が返らない（${BUCKETS.length} 箇所）`, listed.length === 0, listed.length ? `返った箇所: ${listed.join(', ')}` : '');

  const open = [];
  for (const f of FUNCTIONS) {
    const r = await req(`${url}/functions/v1/${f}`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: '{}',
    });
    if (r.status < 400) open.push(`${f}(${r.status})`);
  }
  check(`管理用・本人用の関数がログイン無しで断る（${FUNCTIONS.length} 個）`, open.length === 0, open.length ? `通った: ${open.join(', ')}` : '');

  const signup = await req(`${url}/functions/v1/signup`, {
    method: 'POST',
    headers: { ...h, 'content-type': 'application/json' },
    body: JSON.stringify({ handle: 'zz_live_check', display_name: 'check', password: 'not-a-real-pass', invite_code: 'POCKET-ZZZZ-ZZZZ' }),
  });
  check('はずれの招待キーでは登録できない', signup.status >= 400, `HTTP ${signup.status}`);
}

async function checkObservatory() {
  const host = new URL(SITE).host;
  let j = null;
  for (let i = 0; i < 3 && !j?.grade; i++) {
    if (i > 0) await sleep(20_000);
    try {
      const r = await req(`https://observatory-api.mdn.mozilla.net/api/v2/scan?host=${encodeURIComponent(host)}`, { method: 'POST' });
      j = JSON.parse(r.text);
    } catch {}
  }
  if (!j?.grade) {
    check('Mozilla HTTP Observatory', false, `結果を取れなかった${j?.error ? `: ${j.error}` : ''}`, { soft: !ENFORCE });
    return;
  }
  const detail = `${j.grade}（${j.score} 点、${j.tests_passed}/${j.tests_quantity} 項目合格）${j.details_url ?? ''}`;
  check(`Mozilla HTTP Observatory が ${MIN_GRADE} 以上`, GRADES.indexOf(j.grade) >= GRADES.indexOf(MIN_GRADE), detail, { soft: !ENFORCE });
}

/** 通信の失敗も、その段の失敗として記録して次へ進む。 */
async function step(name, fn) {
  try {
    return await fn();
  } catch (e) {
    check(name, false, `通信に失敗: ${e.cause?.code ?? e.message}`);
    return null;
  }
}

const home = await step('サイトのトップページ', checkSite);
if (home) {
  await step('保護ヘッダ', () => checkHeaders(home));
  await step('Worker', checkWorker);
  await step('Supabase', () => checkSupabase(home));
}
await checkObservatory();

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [`### Live（${SITE}）`, '', '| 結果 | 確認 | 詳しく |', '|---|---|---|', ...summary, ''].join('\n'),
  );
}
if (failed > 0) {
  console.error(`\n${failed} 件の確認に失敗した`);
  process.exit(1);
}
console.log('\nすべて通った');
