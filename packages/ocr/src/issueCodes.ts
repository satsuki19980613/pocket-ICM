/**
 * issue メッセージ → 安定した理由コード（SPEC §12.2 / BETA_PLAN WP-A2）。
 *
 * `gate.ts` / `spotReconstruction.ts` / `prefill.ts`（chips 表示棄却）などが生成する
 * 「人間向けの日本語メッセージ」は文言変更に弱く、サーバ側の集計キーには使えない。
 * ここでは**既存のメッセージ生成箇所を一切変更せず**、出力済みの文字列を正規表現で
 * 分類する純関数だけを新設する（メッセージ文字列はこのファイルの外では確定値として
 * 固定しない＝表記ゆれがあっても分類側だけ直せばよい）。
 *
 * 対応コード一覧（SPEC §12.2）:
 *   street_not_preflop / street_unknown / display_mode_chips / out_of_scope_raise /
 *   out_of_scope_limp / out_of_scope_unclassified_bet / walk / seat_read_failed /
 *   checksum_mismatch / too_many_players / not_club_match /
 *   hero_hand_unreadable / pot_unreadable / unknown
 */

export type IssueCode =
  | 'street_not_preflop'
  | 'street_unknown'
  | 'display_mode_chips'
  | 'out_of_scope_raise'
  | 'out_of_scope_limp'
  | 'out_of_scope_unclassified_bet'
  | 'walk'
  | 'seat_read_failed'
  | 'checksum_mismatch'
  | 'too_many_players'
  | 'not_club_match'
  // 「読めなかった」系。zod のスキーマ検証が英語で落とすので、従来は全部 unknown に
  // 落ちてサーバー側で集計できなかった（実測: 装飾テーマ卓の実機フレーム）。
  | 'hero_hand_unreadable'
  | 'pot_unreadable'
  | 'unknown';

interface Rule {
  readonly code: IssueCode;
  readonly test: (message: string) => boolean;
}

/**
 * 分類ルール（先勝ち・上から順に判定）。各パターンは実際のメッセージ生成箇所
 * （下記コメント参照）の文言に対応する。文言そのものは変更しないので、ここが
 * ずれたらこのファイルとテストだけを直せばよい。
 */
const RULES: readonly Rule[] = [
  // gate.ts streetGate: 'ストリート表示が読めませんでした（プリフロップか確認してください）'
  { code: 'street_unknown', test: (m) => /ストリート表示が読めません/.test(m) },
  // gate.ts streetGate: 'プリフロップの画面ではありません（検出: ...）。...'
  { code: 'street_not_preflop', test: (m) => /プリフロップの画面ではありません/.test(m) },
  // prefill.ts CHIPS_MODE_ISSUE: 'このスクショはチップ表示です。...'
  { code: 'display_mode_chips', test: (m) => /チップ表示です/.test(m) },
  // spotReconstruction.ts detectOutOfScope: '${pos} がレイズ（非オールイン）しています...'
  { code: 'out_of_scope_raise', test: (m) => /がレイズ（非オールイン）/.test(m) },
  // spotReconstruction.ts detectOutOfScope: '${pos} がコール（リンプ/非オールインへのコール）しています...'
  { code: 'out_of_scope_limp', test: (m) => /がコール（リンプ/.test(m) },
  // spotReconstruction.ts detectOutOfScope: '${pos} に未分類のベット ...bb があります（要手入力確認）'
  { code: 'out_of_scope_unclassified_bet', test: (m) => /未分類のベット/.test(m) },
  // spotReconstruction.ts detectOutOfScope: 'hero が BB で pot が未レイズです（ウォーク＝...）'
  { code: 'walk', test: (m) => /ウォーク/.test(m) },
  // pipeline.ts notClubIssue: 'クラブマッチの局面として整合しません（場のチップ合計 ...）。...'
  { code: 'not_club_match', test: (m) => /クラブマッチの局面として整合しません/.test(m) },
  // App.tsx OVER_SCOPE_MSG: '現在は${MAX_PLAYERS}人までの局面に対応しています。'
  { code: 'too_many_players', test: (m) => /人までの局面に対応/.test(m) },
  // confidence.ts のポット・チェックサム不一致（画面表示は Confirm.tsx が動的に組む数値付き文言のため、
  // ここでは緩めのキーワード一致にする。将来 corrections/ocrLog 側が定型メッセージを渡す想定・§12.2）。
  { code: 'checksum_mismatch', test: (m) => /チェックサム/.test(m) && /(不一致|一致しません)/.test(m) },
  // positionDerivation.ts: D ボタン検出/複数/empty、hero 席数、生存席数、hero 不在。
  {
    code: 'seat_read_failed',
    test: (m) =>
      /D ?ボタン/.test(m) || /hero 席は/.test(m) || /hero が生存席/.test(m) || /席数は\s*2\.\.6/.test(m),
  },
  // pipeline.ts の zod 検証が返す英語メッセージ（BoardState スキーマ）。
  // 例: 'heroHand: invalid hand-class notation'（カード検出が 2 枚揃わず空文字）。
  { code: 'hero_hand_unreadable', test: (m) => /^heroHand:/.test(m) || /手札が読めません/.test(m) },
  // 例: 'pot: Expected number, received nan'（中央ピルの数字が読めず NaN）。
  { code: 'pot_unreadable', test: (m) => /^pot:/.test(m) || /ポットが読めません/.test(m) },
];

/** 1 件のメッセージを理由コードへ分類する。どれにも一致しなければ 'unknown'。 */
export function classifyIssueCode(message: string): IssueCode {
  for (const rule of RULES) {
    if (rule.test(message)) return rule.code;
  }
  return 'unknown';
}

/**
 * 複数メッセージをまとめて分類する（重複除去・出現順）。
 * `checksumOk === false` を渡すと、メッセージには現れないポット・チェックサム不一致
 * （§6.3・conf.checksum）を 'checksum_mismatch' として追加する（成功扱いの読み取りでも
 * 確認画面上は不一致表示になるケースを OCR 改善データ基盤に残すため）。
 */
export function classifyIssueCodes(
  messages: readonly string[],
  opts: { readonly checksumOk?: boolean } = {},
): IssueCode[] {
  const codes: IssueCode[] = [];
  for (const m of messages) {
    const code = classifyIssueCode(m);
    if (!codes.includes(code)) codes.push(code);
  }
  if (opts.checksumOk === false && !codes.includes('checksum_mismatch')) {
    codes.push('checksum_mismatch');
  }
  return codes;
}
