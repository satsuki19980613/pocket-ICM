/**
 * Slumbot（https://slumbot.com/）のヘッズアップ NLHE ルール層。
 *
 * 本家 sample_api.py の ParseAction を TypeScript へ移植し、さらに描画に要る
 * 「席ごとの拠出額」まで復元する。API は不正なアクションを送ると
 * `{"error_msg": ...}`（HTTP 200）で弾くので、送る前にこちらで合法手を確定させる。
 *
 * 単位は一貫して **チップ**（BB=100）。表示の bb 換算は chipsToBb() だけで行う。
 *
 * 席番号（Slumbot の client_pos と同じ）:
 *   0 = BB（プリフロップ後手・ポストフロップ先手）
 *   1 = SB/BTN（プリフロップ先手・ポストフロップ後手）
 *
 * スタックは毎ハンド 20000（=200bb）にリセットされ、両者常に同額。
 * よってサイドポットは発生せず、コールは常に不足額ちょうどで足りる。
 */

export const SB = 50;
export const BB = 100;
export const STACK = 20000;
export const NUM_STREETS = 4;

export const STREET_LABEL = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'] as const;
/** そのストリートまでにめくれているボードの枚数。 */
export const BOARD_COUNT = [0, 3, 4, 5] as const;

export interface HandState {
  /** 0=preflop … 3=river */
  readonly street: number;
  /** 次に行動する席。-1 ならハンド終了。 */
  readonly toAct: number;
  /** このストリートのトップベット額（「そこまで」）。誰も張っていなければ 0。 */
  readonly streetLastBetTo: number;
  /** トップのベット主がハンド全体で出した累計（残りスタックの基準）。 */
  readonly totalLastBetTo: number;
  /** 直前のベット/レイズの上乗せ幅（ミニマムレイズの基準）。 */
  readonly lastBetSize: number;
  /** 席ごとの、このストリートで出した額。 */
  readonly streetBet: readonly [number, number];
  /** 席ごとの、前のストリートまでに出した累計。 */
  readonly carry: readonly [number, number];
  /** 誰かが降りて終わった。 */
  readonly folded: boolean;
  /** 降りた席（folded のときのみ有効。それ以外は -1）。 */
  readonly folder: number;
  /** 両者オールインでショーダウンまで走った。 */
  readonly allIn: boolean;
}

export type ParseResult = { ok: true; state: HandState } | { ok: false; error: string };

function fail(error: string): ParseResult {
  return { ok: false, error };
}

/**
 * Slumbot の action 文字列（例 `b200c/kb200c/kk/kk`）を状態へ復元する。
 *
 * 文法:
 *   f=fold / k=check / c=call / b<N>=そのストリートの累計ベット額を N まで上げる / `/`=ストリート区切り
 * 末尾の `/` は有っても無くてもよい（本家と同じ）。
 */
export function parseAction(action: string): ParseResult {
  let street = 0;
  let streetLastBetTo = BB;
  let totalLastBetTo = BB;
  let lastBetSize = BB - SB; // SB は BB に 50 不足＝「50 のベットを受けている」扱い。
  let toAct = 1; // プリフロップの先手は SB/BTN。
  const streetBet: [number, number] = [BB, SB];
  const carry: [number, number] = [0, 0];
  let checkOrCallEndsStreet = false;

  const done = (over: { folded?: boolean; folder?: number; allIn?: boolean } = {}): ParseResult => ({
    ok: true,
    state: {
      street,
      toAct,
      streetLastBetTo,
      totalLastBetTo,
      lastBetSize,
      streetBet: [streetBet[0], streetBet[1]],
      carry: [carry[0], carry[1]],
      folded: over.folded ?? false,
      folder: over.folder ?? -1,
      allIn: over.allIn ?? false,
    },
  });

  /** ストリートが閉じたときの締め（拠出を carry へ畳む）。 */
  const closeStreet = (): void => {
    carry[0] += streetBet[0];
    carry[1] += streetBet[1];
    streetBet[0] = 0;
    streetBet[1] = 0;
    streetLastBetTo = 0;
    lastBetSize = 0;
    checkOrCallEndsStreet = false;
  };

  const sz = action.length;
  let i = 0;
  while (i < sz) {
    if (street >= NUM_STREETS) return fail('アクションが多すぎます');
    const c = action[i]!;
    i += 1;

    if (c === 'k') {
      if (lastBetSize > 0) return fail('チェックできない場面です');
      if (checkOrCallEndsStreet) {
        // リバー以外でストリートが閉じたら、直後は `/` か文字列終端。
        if (street < NUM_STREETS - 1 && i < sz) {
          if (action[i] !== '/') return fail('ストリート区切りがありません');
          i += 1;
        }
        if (street === NUM_STREETS - 1) {
          closeStreet();
          toAct = -1; // ショーダウン
          return done();
        }
        closeStreet();
        street += 1;
        toAct = 0; // ポストフロップの先手は BB。
      } else {
        toAct = (toAct + 1) % 2;
        checkOrCallEndsStreet = true;
      }
    } else if (c === 'c') {
      if (lastBetSize === 0) return fail('コールできない場面です');
      streetBet[toAct] = streetLastBetTo; // 両者同スタックなので常にちょうど足りる。

      if (totalLastBetTo === STACK) {
        // オールインへのコール。残りのストリート分の `/` を読み飛ばしてショーダウン。
        if (i !== sz) {
          for (let s = street; s < NUM_STREETS - 1; s += 1) {
            if (i === sz) return fail('ストリート区切りが足りません');
            if (action[i] !== '/') return fail('ストリート区切りがありません');
            i += 1;
          }
        }
        if (i !== sz) return fail('アクションの末尾に余分な文字があります');
        closeStreet();
        street = NUM_STREETS - 1;
        toAct = -1;
        return done({ allIn: true });
      }

      if (checkOrCallEndsStreet) {
        if (street < NUM_STREETS - 1 && i < sz) {
          if (action[i] !== '/') return fail('ストリート区切りがありません');
          i += 1;
        }
        if (street === NUM_STREETS - 1) {
          closeStreet();
          toAct = -1;
          return done();
        }
        closeStreet();
        street += 1;
        toAct = 0;
      } else {
        toAct = (toAct + 1) % 2;
        checkOrCallEndsStreet = true;
        lastBetSize = 0;
      }
    } else if (c === 'f') {
      if (lastBetSize === 0) return fail('フォールドできない場面です');
      if (i !== sz) return fail('アクションの末尾に余分な文字があります');
      const folder = toAct;
      toAct = -1;
      return done({ folded: true, folder });
    } else if (c === 'b') {
      const j = i;
      while (i < sz && action[i]! >= '0' && action[i]! <= '9') i += 1;
      if (i === j) return fail('ベット額がありません');
      const betTo = Number.parseInt(action.slice(j, i), 10);
      if (!Number.isFinite(betTo)) return fail('ベット額が数値ではありません');

      const inc = betTo - streetLastBetTo;
      const remaining = STACK - totalLastBetTo;
      let minInc = lastBetSize > 0 ? Math.max(lastBetSize, BB) : BB;
      if (minInc > remaining) minInc = remaining; // オールインは常に合法。
      if (inc < minInc) return fail('ベットが小さすぎます');
      if (inc > remaining) return fail('ベットが大きすぎます');

      lastBetSize = inc;
      streetLastBetTo = betTo;
      totalLastBetTo += inc;
      streetBet[toAct] = betTo;
      toAct = (toAct + 1) % 2;
      checkOrCallEndsStreet = true;
    } else if (c === '/') {
      return fail('ストリート区切りの位置が不正です');
    } else {
      return fail('アクション文字列に未知の文字があります');
    }
  }

  return done();
}

/** ハンドが終わっているか。 */
export function isHandOver(s: HandState): boolean {
  return s.toAct < 0;
}

/** 席の総拠出額。 */
export function committed(s: HandState, seat: number): number {
  return (s.carry[seat] ?? 0) + (s.streetBet[seat] ?? 0);
}

/** 場に出ている総額（ポット）。 */
export function potOf(s: HandState): number {
  return committed(s, 0) + committed(s, 1);
}

/** 席の残りスタック。 */
export function stackOf(s: HandState, seat: number): number {
  return STACK - committed(s, seat);
}

/** 手番の席が用意しなければならないコール額。 */
export function toCallOf(s: HandState): number {
  if (isHandOver(s)) return 0;
  return Math.max(0, s.streetLastBetTo - (s.streetBet[s.toAct] ?? 0));
}

export interface LegalActions {
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly canCall: boolean;
  /** コールに要する額（canCall のときのみ意味を持つ）。 */
  readonly callAmount: number;
  readonly canBet: boolean;
  /** 既にベットが入っている＝レイズ（ボタン表記を切り替える）。 */
  readonly isRaise: boolean;
  /** ベット/レイズの「そこまで」の下限・上限（このストリートの累計額）。 */
  readonly minBetTo: number;
  readonly maxBetTo: number;
}

const NO_ACTIONS: LegalActions = {
  canFold: false,
  canCheck: false,
  canCall: false,
  callAmount: 0,
  canBet: false,
  isRaise: false,
  minBetTo: 0,
  maxBetTo: 0,
};

/** 手番の席が取れる行動。ハンド終了時はすべて false。 */
export function legalActions(s: HandState): LegalActions {
  if (isHandOver(s)) return NO_ACTIONS;

  const call = toCallOf(s);
  const remaining = STACK - s.totalLastBetTo;
  let minInc = s.lastBetSize > 0 ? Math.max(s.lastBetSize, BB) : BB;
  if (minInc > remaining) minInc = remaining;

  return {
    canFold: call > 0,
    canCheck: call === 0,
    canCall: call > 0,
    callAmount: call,
    canBet: remaining > 0,
    isRaise: s.streetLastBetTo > 0,
    minBetTo: s.streetLastBetTo + minInc,
    maxBetTo: s.streetLastBetTo + remaining,
  };
}

/** チップ→bb。表示は必ずここを通す。 */
export function chipsToBb(chips: number): number {
  return chips / BB;
}

/** bb 表示（末尾の 0 を落とす。1.5 / 2 / 12.25 のように出す）。 */
export function bbLabel(chips: number, digits = 2): string {
  const s = chipsToBb(chips).toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** 符号付き bb 表示（+3.5 / -1.2 / ±0）。成績表示用。 */
export function signedBbLabel(chips: number, digits = 1): string {
  if (chips === 0) return '±0';
  const body = bbLabel(Math.abs(chips), digits);
  return `${chips > 0 ? '+' : '−'}${body}`;
}
