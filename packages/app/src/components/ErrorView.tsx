import { useState } from 'react';
import type { OcrReadout } from '@oshihiki/ocr';
import { ImageModal } from './ImageModal';
import { READ_CONDITIONS, READ_CONDITIONS_NOTE } from './IcmInput';

/**
 * エラー画面（3-1d・M3）。求解不能・対象外フレーム・検証失敗の理由を出し、写真経路なら
 * 「別の写真を選ぶ」、常に「手入力する（読めた分を手で埋める）」で入力へ戻す。
 *
 * SPEC §5.2.3（v3）: 写真由来のエラーは `imageUrl`（+ あれば `readout`）を渡すと
 * 「🖼 元画像とOCR結果を見る」から元画像×OCR出力の照合表を開ける（何が読めて何が
 * 読めなかったかを見せるため）。SPEC §5.2.1: 「次はこの条件で撮ってください」として
 * `IcmInput.READ_CONDITIONS` と同じチェックリストを出す（icm 画面と文言を一致させる）。
 */
export function ErrorView(props: {
  title?: string;
  desc?: string;
  issues: string[];
  /** 手入力モーダルを開く（読めた分を手で埋める）。 */
  onManual: () => void;
  /** 写真経路のときだけ渡す（別の写真を選ぶ → 起点へ）。 */
  onRetry?: () => void;
  /** OCR で読み取った元画像（objectURL）。あるときだけ「🖼 元画像とOCR結果を見る」を出す。 */
  imageUrl?: string;
  /** OCR 出力（SPEC §5.2.3）。あれば照合表も一緒に出す。 */
  readout?: OcrReadout;
  /** 元画像の寸法（照合表ヘッダの「画像サイズ」用）。 */
  imageSize?: { w: number; h: number };
}): JSX.Element {
  const fromPhoto = !!props.onRetry;
  const [showImage, setShowImage] = useState(false);
  return (
    <div className="panel err-view">
      <div className="errbanner">
        <div className="et">{props.title ?? 'この内容では計算できません'}</div>
        <div className="ed">
          {props.desc ??
            (fromPhoto
              ? '条件が揃っていません。直して撮り直すか、読めた分を手で埋めてください。'
              : '入力を見直してください。手入力から直せます。')}
        </div>
      </div>

      {props.imageUrl && (
        <button type="button" className="btn line img-check" onClick={() => setShowImage(true)}>
          🖼 元画像とOCR結果を見る
        </button>
      )}

      {props.issues.length > 0 && (
        <>
          <div className="check-h">見つかった問題</div>
          <ul className="check">
            {props.issues.map((m) => (
              <li key={m} className="ng">
                <span className="mark">!</span>
                <div>{m}</div>
              </li>
            ))}
          </ul>
        </>
      )}

      {fromPhoto && (
        <>
          <div className="check-h">次はこの条件で撮ってください</div>
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
        </>
      )}

      <div className="err-actions">
        {fromPhoto && (
          <button type="button" className="btn" onClick={props.onRetry}>
            別の写真を選ぶ
          </button>
        )}
        <button type="button" className={`btn${fromPhoto ? ' ghost' : ''}`} onClick={props.onManual}>
          {fromPhoto ? '読めた分を手で埋める' : '手入力する'}
        </button>
      </div>

      {showImage && props.imageUrl && (
        <ImageModal
          src={props.imageUrl}
          readout={props.readout}
          imageSize={props.imageSize}
          onClose={() => setShowImage(false)}
        />
      )}
    </div>
  );
}
