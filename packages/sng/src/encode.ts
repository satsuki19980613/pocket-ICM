/**
 * ハンド記録の圧縮表現 v1（docs/SNG_DESIGN.md §4）。
 *
 *   1|L<level>|B<btn>,<sbSeat|->,<bbSeat>|S<stack0>,...|C<seat>=<c1><c2>;...|D<board>|A<pre>/<flop>/<turn>/<river>|W<won0>,...|E<seat>:<place>;...
 *
 * `decodeHand(encodeHand(r), meta)` は r と同値（gameId / handNo / playedAt / sb / bb / ante は
 * 文字列に含めず、呼び出し側が meta（DB の他の列）から補う）。
 *
 * 解釈のメモ（実装時に決めたこと）:
 * - `A` フィールドのトークンは `<seat><k>[<betTo>][!]`。`betTo` を明示するのは bet/raise/allin
 *   （それ以外は "そのストリートの直前の値のまま" なので、街を先頭から replay すれば一意に復元できる。
 *   fold/check は現在の streetLastBetTo、call は現在の streetLastBetTo と同値）。
 *   replay は `meta.sb` / `meta.bb`（プリフロップの streetBet の種）だけを使う純粋な bookkeeping で、
 *   合法手判定などのゲームルールは一切持ち込まない。
 * - ストリートは「到達した数」を `board.length`（0→1 街 / 3→2 街 / 4→3 街 / 5→4 街）から決める。
 *   全員オールインで誰も動かずに配られたストリートは、対応する区間を空文字列のまま `/` で残す
 *   （例: プリフロップで全員オールイン→ `A<pre>///`）。
 * - `won` は常に全席分（サイズ = players）で、fold 決着でも埋まっている前提。
 */

import type { ActionKind, ActionRecord, SngHandRecord } from './types';

/** 文字列に含めない列（DB の他の列で持つ）。 */
export type HandMeta = Pick<SngHandRecord, 'gameId' | 'handNo' | 'playedAt' | 'sb' | 'bb' | 'ante'>;

const KIND_LETTER: Readonly<Record<ActionKind, string>> = {
  fold: 'f',
  check: 'k',
  call: 'c',
  bet: 'b',
  raise: 'r',
  allin: 'a',
};

const LETTER_KIND: Readonly<Record<string, ActionKind>> = {
  f: 'fold',
  k: 'check',
  c: 'call',
  b: 'bet',
  r: 'raise',
  a: 'allin',
};

const NEEDS_BET_TO: ReadonlySet<ActionKind> = new Set(['bet', 'raise', 'allin']);

/** board の長さ → 到達したストリート数（1=preflop止まり … 4=river到達）。 */
function reachedStreetsFromBoardLen(len: number): number | null {
  if (len === 0) return 1;
  if (len === 3) return 2;
  if (len === 4) return 3;
  if (len === 5) return 4;
  return null;
}

function encodeAction(a: ActionRecord): string {
  const letter = KIND_LETTER[a.kind];
  const betTo = NEEDS_BET_TO.has(a.kind) ? String(a.betTo) : '';
  return `${a.seat}${letter}${betTo}${a.auto ? '!' : ''}`;
}

export function encodeHand(rec: SngHandRecord): string {
  const reached = reachedStreetsFromBoardLen(rec.board.length);
  if (reached === null) throw new Error(`encodeHand: bad board length ${rec.board.length}`);

  const parts: string[] = ['1'];
  parts.push(`L${rec.level}`);
  parts.push(`B${rec.btn},${rec.sbSeat === null ? '-' : rec.sbSeat},${rec.bbSeat}`);
  parts.push(`S${rec.startStacks.join(',')}`);

  const shownEntries = Object.entries(rec.shown).map(([seat, cards]) => `${seat}=${cards[0]}${cards[1]}`);
  parts.push(`C${shownEntries.join(';')}`);

  parts.push(`D${rec.board.join('')}`);

  const streets: string[] = [];
  for (let s = 0; s < reached; s++) {
    const tokens = rec.actions.filter((a) => a.street === s).map(encodeAction);
    streets.push(tokens.join('.'));
  }
  parts.push(`A${streets.join('/')}`);

  parts.push(`W${rec.won.join(',')}`);

  const elimEntries = rec.eliminated.map((e) => `${e.seat}:${e.place}`);
  parts.push(`E${elimEntries.join(';')}`);

  return parts.join('|');
}

const UINT_RE = /^\d+$/;

function parseUint(s: string): number | null {
  if (!UINT_RE.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function stripPrefix(part: string | undefined, letter: string): string | null {
  if (part === undefined || part.length === 0 || part[0] !== letter) return null;
  return part.slice(1);
}

const ACTION_TOKEN_RE = /^(\d+)([fkcbra])(\d+)?(!)?$/;

export function decodeHand(encoded: string, meta: HandMeta): SngHandRecord | null {
  try {
    const parts = encoded.split('|');
    if (parts.length !== 9) return null;
    const [ver, lPart, bPart, sPart, cPart, dPart, aPart, wPart, ePart] = parts;
    if (ver !== '1') return null;

    // --- L ---
    const lContent = stripPrefix(lPart, 'L');
    if (lContent === null) return null;
    const level = parseUint(lContent);
    if (level === null) return null;

    // --- B ---
    const bContent = stripPrefix(bPart, 'B');
    if (bContent === null) return null;
    const bFields = bContent.split(',');
    if (bFields.length !== 3) return null;
    const btn = parseUint(bFields[0]!);
    const sbSeat = bFields[1] === '-' ? null : parseUint(bFields[1]!);
    const bbSeat = parseUint(bFields[2]!);
    if (btn === null || bbSeat === null || (bFields[1] !== '-' && sbSeat === null)) return null;

    // --- S ---
    const sContent = stripPrefix(sPart, 'S');
    if (sContent === null) return null;
    const startStacks = sContent.split(',').map(parseUint);
    if (startStacks.length === 0 || startStacks.some((v) => v === null)) return null;

    // --- C ---
    const cContent = stripPrefix(cPart, 'C');
    if (cContent === null) return null;
    const shown: Record<number, readonly [string, string]> = {};
    if (cContent.length > 0) {
      for (const entry of cContent.split(';')) {
        const eq = entry.indexOf('=');
        if (eq < 0) return null;
        const seat = parseUint(entry.slice(0, eq));
        const cards = entry.slice(eq + 1);
        if (seat === null || cards.length !== 4) return null;
        shown[seat] = [cards.slice(0, 2), cards.slice(2, 4)];
      }
    }

    // --- D ---
    const dContent = stripPrefix(dPart, 'D');
    if (dContent === null) return null;
    if (dContent.length % 2 !== 0) return null;
    const board: string[] = [];
    for (let i = 0; i < dContent.length; i += 2) board.push(dContent.slice(i, i + 2));
    const reached = reachedStreetsFromBoardLen(board.length);
    if (reached === null) return null;

    // --- A (replay to recover betTo/put) ---
    const aContent = stripPrefix(aPart, 'A');
    if (aContent === null) return null;
    const streetStrs = aContent.split('/');
    if (streetStrs.length !== reached) return null;

    const actions: ActionRecord[] = [];
    for (let s = 0; s < reached; s++) {
      const localStreetBet = new Map<number, number>();
      let streetLastBetTo = 0;
      if (s === 0) {
        if (sbSeat !== null) localStreetBet.set(sbSeat, meta.sb);
        localStreetBet.set(bbSeat, meta.bb);
        streetLastBetTo = meta.bb;
      }
      const tokenStr = streetStrs[s]!;
      if (tokenStr.length > 0) {
        for (const tok of tokenStr.split('.')) {
          const m = ACTION_TOKEN_RE.exec(tok);
          if (!m) return null;
          const seat = Number(m[1]);
          const kind = LETTER_KIND[m[2]!];
          if (!kind) return null;
          const auto = m[4] === '!';
          const hasBetTo = m[3] !== undefined;
          if (NEEDS_BET_TO.has(kind) !== hasBetTo) return null;
          const betTo = hasBetTo ? Number(m[3]) : streetLastBetTo;
          const prevSeatBet = localStreetBet.get(seat) ?? 0;
          const put = kind === 'fold' || kind === 'check' ? 0 : betTo - prevSeatBet;
          if (put < 0) return null;
          localStreetBet.set(seat, betTo);
          if (betTo > streetLastBetTo) streetLastBetTo = betTo;
          actions.push({ seat, kind, betTo, put, auto, street: s });
        }
      }
    }

    // --- W ---
    const wContent = stripPrefix(wPart, 'W');
    if (wContent === null) return null;
    const won = wContent.split(',').map(parseUint);
    if (won.length === 0 || won.some((v) => v === null)) return null;

    // --- E ---
    const eContent = stripPrefix(ePart, 'E');
    if (eContent === null) return null;
    const eliminated: { readonly seat: number; readonly place: number }[] = [];
    if (eContent.length > 0) {
      for (const entry of eContent.split(';')) {
        const colon = entry.indexOf(':');
        if (colon < 0) return null;
        const seat = parseUint(entry.slice(0, colon));
        const place = parseUint(entry.slice(colon + 1));
        if (seat === null || place === null) return null;
        eliminated.push({ seat, place });
      }
    }

    return {
      gameId: meta.gameId,
      handNo: meta.handNo,
      playedAt: meta.playedAt,
      level,
      sb: meta.sb,
      bb: meta.bb,
      ante: meta.ante,
      btn,
      sbSeat,
      bbSeat,
      startStacks: startStacks as number[],
      shown,
      board,
      actions,
      won: won as number[],
      eliminated,
    };
  } catch {
    return null;
  }
}
