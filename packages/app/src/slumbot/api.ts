/**
 * Slumbot API クライアント。
 *
 * 直接 https://slumbot.com/slumbot/api/* を叩くことはできない（実測: OPTIONS の
 * プリフライトが Origin に関係なく 401 で落ちる。本体の POST は許可されているのに、
 * Content-Type: application/json が必須なのでブラウザは必ずプリフライトを飛ばす）。
 * そのため同一オリジンの中継 `/api/slumbot/*` を経由する。
 *   - 本番: Cloudflare Worker（worker/index.ts）
 *   - 開発: Vite の server.proxy（packages/app/vite.config.ts）
 */

/** 中継のベースパス。Worker / Vite proxy の両方がこの形で受ける。 */
export const SLUMBOT_PROXY = '/api/slumbot';

/** API の生レスポンス（sample_api.py と実測に基づく）。 */
export interface SlumbotResponse {
  /** このリクエストを送る前までのアクション列。 */
  readonly old_action?: string;
  /** 現在までの全アクション列（両者ぶん）。 */
  readonly action?: string;
  /** 自分の席。0=BB / 1=SB(BTN)。 */
  readonly client_pos?: number;
  readonly hole_cards?: readonly string[];
  readonly board?: readonly string[];
  /** new_hand のときだけ返る。以降 act に渡し続ける。 */
  readonly token?: string;

  // ---- ハンド終了時のみ ----
  readonly bot_hole_cards?: readonly string[];
  /** このハンドの純収支（チップ）。 */
  readonly winnings?: number;
  /** 勝った/負けたポットの総額（チップ）。 */
  readonly won_pot?: number;
  readonly session_num_hands?: number;
  readonly session_total?: number;
  readonly baseline_winnings?: number;
  readonly session_baseline_total?: number;

  /** 不正なアクション等。HTTP は 200 のまま返るので必ず見る。 */
  readonly error_msg?: string;
}

export type SlumbotResult =
  | { ok: true; data: SlumbotResponse }
  | { ok: false; kind: 'network' | 'server' | 'rejected'; message: string };

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<SlumbotResult> {
  let res: Response;
  try {
    res = await fetch(`${SLUMBOT_PROXY}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    return { ok: false, kind: 'network', message: '通信に失敗しました。電波の良い場所で再度お試しください。' };
  }
  if (!res.ok) {
    return {
      ok: false,
      kind: 'server',
      message: `Slumbot に接続できませんでした（${res.status}）。しばらく待って再度お試しください。`,
    };
  }
  let data: SlumbotResponse;
  try {
    data = (await res.json()) as SlumbotResponse;
  } catch {
    return { ok: false, kind: 'server', message: 'Slumbot からの応答を読み取れませんでした。' };
  }
  if (data.error_msg) {
    // 合法手の判定はこちら側で済ませているので、ここに来るのは想定外（＝バグかセッション切れ）。
    return { ok: false, kind: 'rejected', message: `アクションが受け付けられませんでした（${data.error_msg}）` };
  }
  return { ok: true, data };
}

/** 新しいハンドを始める。token を渡すとセッション（通算成績）が継続する。 */
export function newHand(token: string | null, signal?: AbortSignal): Promise<SlumbotResult> {
  return post('new_hand', token ? { token } : {}, signal);
}

/** アクションを送る。incr は「増分だけ」（'k' / 'c' / 'f' / 'b600'）。 */
export function act(token: string, incr: string, signal?: AbortSignal): Promise<SlumbotResult> {
  return post('act', { token, incr }, signal);
}
