/**
 * Cloudflare Worker — 静的アセット配信 ＋ Slumbot API の中継。
 *
 * なぜ中継が要るか:
 *   Slumbot の API（https://slumbot.com/slumbot/api/*）は POST 本体には
 *   Access-Control-Allow-Origin を返すが、OPTIONS のプリフライトを Origin に関係なく
 *   401 で拒否する。Content-Type: application/json が必須なのでブラウザは必ず
 *   プリフライトを飛ばす＝フロントから直接は叩けない。そこで同一オリジンで受けて
 *   サーバ間通信に置き換える。
 *
 * 課金について（SPEC §7「どのサービスにもカードを登録しない」）:
 *   静的アセットへのリクエストはこの Worker を起動しない（アセットが先に解決される）。
 *   起動するのは /api/slumbot/* だけなので、無料枠（10万リクエスト/日）を消費するのは
 *   対局中のアクション送信のみ。無料プランは上限超過で課金されず停止する。
 */

interface Env {
  /** wrangler.jsonc の assets.binding。ビルド成果物（packages/app/dist）。 */
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
}

const UPSTREAM = 'https://slumbot.com/slumbot/api';
const PREFIX = '/api/slumbot/';
/** 中継してよいエンドポイント。login は扱わない（パスワードを預からない方針）。 */
const ALLOWED = new Set(['new_hand', 'act']);
/** リクエストボディの上限（token + incr しか送らないので十分すぎる）。 */
const MAX_BODY = 4096;
/** 上流が詰まったときに待ち続けない。 */
const TIMEOUT_MS = 20_000;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function proxy(request: Request, name: string): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error_msg: 'method not allowed' }, 405);
  }

  const body = await request.text();
  if (body.length > MAX_BODY) {
    return json({ error_msg: 'payload too large' }, 413);
  }
  // 上流は application/json しか受けないので、ここで形を確かめてから投げる。
  try {
    JSON.parse(body || '{}');
  } catch {
    return json({ error_msg: 'invalid json' }, 400);
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(`${UPSTREAM}/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body || '{}',
      signal: ctl.signal,
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return json({ error_msg: 'upstream unavailable' }, 502);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(PREFIX)) {
      const name = url.pathname.slice(PREFIX.length);
      if (!ALLOWED.has(name)) return json({ error_msg: 'not found' }, 404);
      return proxy(request, name);
    }
    // それ以外はビルド成果物（＝これまでどおりの静的配信）。
    return env.ASSETS.fetch(request);
  },
};
