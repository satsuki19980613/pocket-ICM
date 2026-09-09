/**
 * `SolveResultDto` の保存形（SPEC v3 §7.2 / §9.2, BETA_PLAN WP-B2）。
 *
 * SPEC §7.2 の方針: 解 JSON（`results.solution`）は保存時に平均サイズを実測し、
 * **60KB を超える場合のみ** `nodes[].hands`（最大169要素のハンドクラス文字列配列）を
 * 169bit マスクの base64（29文字）に畳んで保存する。
 *
 * 実測（`solutionCodec.test.ts`）: 6人局面（62 決定ノード, SPEC 通りの action tree
 * サイズ＝`2^n - 2` は `packages/solver/test/nwaySolver.test.ts` で固定済み）の
 * 代表的な `SolveResultDto` で JSON.stringify().length を測ると **約12〜13KB**
 * （60KB の 1/5 以下）。この値は実際に `solveMultiway` を6人・等スタックで
 * 実行して得た２ケース（15bb: 約12.2KB／8bb 極端な短スタック: 約13.2KB。
 * 短スタックほど push レンジが広がり `hands` 配列が伸びるため悪化方向だが、
 * それでも閾値を大きく下回った）を基にテストで再現している。
 *
 * したがって **圧縮は実装しない**。`encodeSolution`/`decodeSolution` は恒等写像。
 * 将来、局面が複雑化する等で 60KB を超える実測が出た場合にのみ、
 * `nodes[].hands` の 169bit マスク圧縮（169 ハンドクラスの正準順は
 * `../handGrid.ts` を単一の真実として使う）をここに実装する。
 */

import type { SolveResultDto } from '../solverProtocol';

/** 保存形（現状は `SolveResultDto` と同一＝恒等写像）。 */
export type EncodedSolution = SolveResultDto;

/** `SolveResultDto` → 保存形。実測 60KB 未満のため圧縮せず恒等写像（ファイル冒頭コメント参照）。 */
export function encodeSolution(dto: SolveResultDto): EncodedSolution {
  return dto;
}

/** 保存形 → `SolveResultDto`。恒等写像の逆（現状は同じくそのまま）。 */
export function decodeSolution(json: EncodedSolution): SolveResultDto {
  return json;
}
