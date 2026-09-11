import { useRef } from 'react';
import { CameraIcon } from './feedShared';

/**
 * 読み取れる条件のチェックリスト（撮り方ガイド）。icm とエラー画面で共有。
 * SPEC §5.2.1（v3）: 文言は実際に弾いている条件と一字一句そろえる。判定箇所は以下（要約・
 * 詳細は BETA_PLAN WP-B1 の報告を参照）。
 *   1. `streetGate`（packages/ocr/src/gate.ts）… preflop 以外 / unknown を棄却
 *   2. `prefill.ts` の `reads.displayMode !== 'bb'` 判定・`CHIPS_MODE_ISSUE`
 *   3-4. `detectOutOfScope`（packages/ocr/src/spotReconstruction.ts）… raise / 非オールイン call /
 *        hero=BB かつ未レイズ（ウォーク）を棄却
 *   5. `MAX_PLAYERS = 6`（App.tsx）… 実装の保険としては残すが、ポーカーチェイス自体が
 *      6人までなので**チェックリストには出さない**（さつき指示 2026-09-10）
 *   6. `extractAnchored`（packages/ocr/src/extractAnchored.ts）… 画面全体のランドマーク前提
 *   7. `chipConsistency`（packages/ocr/src/chipConsistency.ts）… ブラインドが公式表に
 *      一致しない（level=0）**かつ**場のチップ総量が 6人×15,000=90,000 と 15% 以上
 *      食い違うときだけ `not-club-skip` → pipeline が棄却
 */
export const READ_CONDITIONS: { title: string; hint: string }[] = [
  { title: 'プリフロップの画面', hint: 'フロップ以降・ストリート表示が読めないものは対象外です' },
  { title: 'スタックがBB表示', hint: '例: 20.2 BB。チップ総額表示（例: 19,453）は取り込めません' },
  {
    title: 'オールインとフォールドだけで進んだ場面',
    hint: 'レイズ・ミニレイズ・3bet・リンプ（非オールインへのコール）が入った局面は対象外です',
  },
  { title: '自分の判断がある場面', hint: '全員フォールドで BB に手番が回ったウォークは対象外です' },
  { title: '切り抜いていない全画面のスクショ', hint: '一部を切り抜くとスタックやポジションが読み取れません' },
  {
    title: 'Sit & Go の局面',
    hint: 'ブラインド構造が公式のもの（通常／ゆっくり／もっとゆっくり）である必要があります',
  },
];

/** チェックリスト下の小さな補足（対応形式・解析場所）。icm とエラー画面で共有（SPEC §5.2.1）。 */
export const READ_CONDITIONS_NOTE =
  '対応形式: PNG / JPEG / WebP。画像の解析は端末内で完結します。';

/**
 * ICM 入力の起点（3-1a）。写真選択を最上位に据え、なければ手入力へ。下に
 * 「読み取れる条件」チェックリストを常設（SPEC §6.1・M3）。
 */
export function IcmInput(props: {
  /** スクショ添付 → OCR プリフィル。 */
  onScreenshot: (file: File) => void;
  /** 手入力モーダルを開く。 */
  onManual: () => void;
  /** OCR 実行中は写真選択を抑止。 */
  ocrBusy: boolean;
  /**
   * 計算中は次の入力を受け付けない（SPEC §5.7 の3: 同時1件の制約）。
   * 「写真を選ぶ」「手入力する」の両方を無効化し、専用の注意文を出す。
   */
  blocked?: boolean;
}): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);

  function onPick(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    e.target.value = ''; // 同じファイルを続けて選べるよう値をリセット。
    if (file) props.onScreenshot(file);
  }

  return (
    <div className="icm">
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPick} disabled={props.blocked} />

      {props.blocked && (
        <p className="icm-blocked">計算中は次の画像を追加できません（完了までお待ちください）。</p>
      )}

      <div className="shot">
        <div className="ic">
          <CameraIcon />
        </div>
        <b>スクリーンショットを選ぶ</b>
        <span className="sub">
          自分の手番が回ってきた場面を
          <br />
          そのまま撮ったものを選んでください
        </span>
        <button
          type="button"
          className="btn"
          disabled={props.ocrBusy || props.blocked}
          onClick={() => fileRef.current?.click()}
        >
          {props.ocrBusy ? '読み取り中…' : '写真を選ぶ'}
        </button>
      </div>

      <button type="button" className="btn line" disabled={props.blocked} onClick={props.onManual}>
        手入力する
      </button>
      <p className="icm-note">写真がなくても、手入力だけで計算できます。</p>

      <div className="check-h">読み取れる条件</div>
      <ul className="check">
        {READ_CONDITIONS.map((c) => (
          <li key={c.title} className="ok">
            <span className="mark">✓</span>
            <div>
              {c.title}
              <small>{c.hint}</small>
            </div>
          </li>
        ))}
      </ul>
      <p className="check-note">{READ_CONDITIONS_NOTE}</p>
    </div>
  );
}
