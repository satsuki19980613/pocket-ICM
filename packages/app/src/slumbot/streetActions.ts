/**
 * Slumbot HU の卓を SIT & GO の卓（SngTable.tsx）と同じ見た目にするための橋渡し。
 *
 * SIT & GO 側はエンジンが `hand.actions`（席・ストリート付き）をそのまま持っているが、
 * Slumbot は `"b200c/kb200c/kk"` のような 1 本の action 文字列しか返さない。
 * ここでは「そのストリートで各席が最後に取ったアクション」を action 文字列から復元し、
 * 卓の各席に最後の一手（チェック/コール/ベット/フォールドの吹き出し）を出せるようにする。
 *
 * パーサは新しく書かない。`rules.ts` の `parseAction()`（状態遷移）と `hand.ts` の
 * `describeLastAction()`（1 手の意味づけ・ALL IN 判定・bb ラベル）を再利用する。
 * 2 本目のパーサを持つと必ず両者がズレる（オールインの境界条件など、直しても片方にしか
 * 反映されない）ので、ここは「action 文字列を 1 手ずつに割って、既存の 2 関数を
 * 繰り返し呼ぶだけ」に徹する。
 */

import { describeLastAction, type LastAction } from './hand';
import { parseAction, STACK } from './rules';

/** 1 手ぶん。LastAction に「何ストリート目か」「それでオールインになったか」を足したもの。 */
export interface StreetAction extends LastAction {
  /** 0=preflop … 3=river */
  readonly street: number;
  /** その bet/raise で自分のスタックを出し切ったか（call は false）。 */
  readonly allIn: boolean;
  /**
   * そのアクションで実際に場へ出したチップの増分（S&G 側の ActionRecord.put と同じ意味）。
   * check/fold は 0。call/bet/raise は「そこまでの額 − それまでにそのストリートで
   * 既に出していた額」で、ブラインドなど先に置いてある分を二重に数えないための引き算。
   */
  readonly put: number;
}

/** 1 トークン（f/k/c/b<数字>）の文字列上の範囲。`/` は含まない。 */
interface Token {
  readonly start: number;
  readonly end: number;
}

/**
 * action 文字列をトークン（f/k/c/b<数字列>）に割る。`/`（ストリート区切り）は読み飛ばす。
 * 未知の文字に当たったら、そこで打ち切ってそれまでのトークンだけを返す
 * （壊れた文字列でも例外を投げないため。数字の続かない裸の `b` は 1 文字トークンとして
 * 返し、その妥当性チェックは呼び出し側の describeLastAction() に任せる）。
 */
function tokenize(action: string): Token[] {
  const tokens: Token[] = [];
  const len = action.length;
  let i = 0;
  while (i < len) {
    const c = action[i]!;
    if (c === '/') {
      i += 1;
      continue;
    }
    if (c === 'f' || c === 'k' || c === 'c') {
      tokens.push({ start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (c === 'b') {
      let j = i + 1;
      while (j < len && action[j]! >= '0' && action[j]! <= '9') j += 1;
      tokens.push({ start: i, end: j });
      i = j;
      continue;
    }
    // 未知の文字＝ここで文字列が壊れている。以降は読まない。
    break;
  }
  return tokens;
}

/**
 * action 文字列を 1 手ずつ時系列に復元する。壊れた文字列ならそこまでの分を返す（例外は投げない）。
 *
 * 各トークンについて、まず `parseAction(直前までの文字列)` で「その手を打つ直前」の状態を得る
 * （ここから street と seat＝toAct が分かる）。次に `describeLastAction(そのトークンまでの文字列)`
 * で種類・betTo・ラベルを得る。どちらかが失敗したら、そこで打ち切る。
 */
export function listActions(action: string): readonly StreetAction[] {
  const result: StreetAction[] = [];

  for (const { start, end } of tokenize(action)) {
    const before = parseAction(action.slice(0, start));
    if (!before.ok) break;

    const last = describeLastAction(action.slice(0, end));
    if (last === null) break;

    // オールイン判定は describeLastAction() の中の判定式とそろえる
    // （あちらのラベルが `ALL IN ...` になる条件と食い違うと表示と実体がズレるため）。
    const s = before.state;
    const allIn =
      (last.kind === 'bet' || last.kind === 'raise') &&
      last.betTo >= s.streetLastBetTo + (STACK - s.totalLastBetTo);

    // put（そのアクションで実際に出した増分）:
    //   check/fold は 0。
    //   call は「そのストリートのトップベット額 − 自分がそれまでにそのストリートで出していた額」
    //   （describeLastAction() が CALL のラベルに使っている amount と同じ式。ズレるとラベルの
    //   数字と put が食い違うので必ずそろえる）。
    //   bet/raise は「そこまでの額 − 自分がそれまでにそのストリートで出していた額」
    //   （ブラインドや前のレイズ分を二重に数えないための引き算）。
    const already = s.streetBet[last.seat] ?? 0;
    const put =
      last.kind === 'check' || last.kind === 'fold'
        ? 0
        : last.kind === 'call'
          ? s.streetLastBetTo - already
          : last.betTo - already;

    // street は「直前状態」のもの（describeLastAction は返さないし、ベット自体では
    // ストリートは進まないので、この時点で before.state.street を使えば必ずそのトークン
    // が打たれたストリートと一致する）。
    result.push({ ...last, street: s.street, allIn, put });
    if (last.kind === 'fold') break; // フォールドで打ち切り（以降トークンは無い想定）。
  }

  return result;
}

/** 指定ストリートで各席が最後に取った 1 手（席番号 → その手）。該当が無ければ空の Map。 */
export function lastActionsOnStreet(action: string, street: number): ReadonlyMap<number, StreetAction> {
  const map = new Map<number, StreetAction>();
  for (const a of listActions(action)) {
    if (a.street === street) map.set(a.seat, a); // 後の手が勝つ＝上書きするだけでよい。
  }
  return map;
}
