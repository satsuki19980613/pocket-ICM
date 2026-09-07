import { useRef } from 'react';

/** 読み取れる条件のチェックリスト（撮り方ガイド）。icm とエラー画面で共有。 */
export const READ_CONDITIONS: { title: string; hint: string }[] = [
  { title: 'プリフロップの画面', hint: 'フロップ以降は押し引きの計算対象外です' },
  { title: '自分の手番が回ってきた状態', hint: 'アクション前・後の画面は状況が確定しません' },
  { title: '全画面のまま', hint: '切り抜くとスタックやポジションが読めません' },
  { title: 'BB表示', hint: 'チップ総額表示でも動きますが、BB表示が確実です' },
  { title: '6人までの局面', hint: '2〜6人のプリフロップに対応しています' },
];

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
}): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);

  function onPick(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    e.target.value = ''; // 同じファイルを続けて選べるよう値をリセット。
    if (file) props.onScreenshot(file);
  }

  return (
    <div className="icm">
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPick} />

      <div className="shot">
        <div className="ic">📷</div>
        <b>スクリーンショットを選ぶ</b>
        <span className="sub">
          自分の手番が回ってきた場面を
          <br />
          そのまま撮ったものを選んでください
        </span>
        <button type="button" className="btn" disabled={props.ocrBusy} onClick={() => fileRef.current?.click()}>
          {props.ocrBusy ? '読み取り中…' : '写真を選ぶ'}
        </button>
      </div>

      <button type="button" className="btn line" onClick={props.onManual}>
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
    </div>
  );
}
