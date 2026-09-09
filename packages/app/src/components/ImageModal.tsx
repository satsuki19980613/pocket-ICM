import { useEffect, useState } from 'react';
import type { OcrReadout } from '@oshihiki/ocr';
import { buildOcrReadoutView } from './ocrReadoutView';

/**
 * 元画像の確認モーダル（M3 補助 → SPEC §5.2.3 で「元画像 × OCR 出力」の照合ビューへ拡張）。
 * OCR プリフィルの読取値と、添付した実スクショを照合するために使う。既定は全体表示（幅フィット）、
 * 画像タップで原寸（コンテナ内スクロール）に切り替え。背景クリック / ✕ / Esc で閉じる。
 *
 * `readout` を渡したときだけ、画像の下に OCR 出力の照合表を出す（渡さなければ従来どおり画像だけ＝
 * 後方互換）。数値の桁揃え・CHECK 判定・日本語ラベル化は `ocrReadoutView.ts`（純関数）に追い出し、
 * ここでは表示するだけにする。
 */
export function ImageModal(props: {
  src: string;
  onClose: () => void;
  /** OCR 出力（SPEC §5.2.3）。渡されたときだけ照合表を出す。 */
  readout?: OcrReadout;
  /** 元画像の寸法（ヘッダの「画像サイズ」表示用）。readout と併用。 */
  imageSize?: { w: number; h: number };
}): JSX.Element {
  const [zoom, setZoom] = useState(false);
  const view = props.readout ? buildOcrReadoutView(props.readout, { imageSize: props.imageSize }) : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div
      className="imgmodal-backdrop"
      onClick={(e) => {
        // 親（手入力モーダルの backdrop）へバブリングして一緒に閉じるのを防ぐ。
        e.stopPropagation();
        props.onClose();
      }}
      role="presentation"
    >
      <div
        className="imgmodal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={view ? '元画像とOCR結果' : '元画像'}
      >
        <div className="imgmodal-head">
          <span className="imgmodal-title">
            {view ? '元画像とOCR結果' : '元画像'} ・ タップで{zoom ? '全体表示' : '原寸'}
          </span>
          <button type="button" className="modal-x" aria-label="閉じる" onClick={props.onClose}>
            ✕
          </button>
        </div>
        {/* 画像（従来の原寸/全体トグル用スクロール）と OCR 照合表を1つの外枠でスクロール
            させる（読取表があっても全体表示のはみ出しを防ぐ）。画像自体のズーム時の
            内部スクロールは .imgmodal-body 側にそのまま残す（入れ子で問題ない）。 */}
        <div className="imgmodal-scroll">
          <div className={`imgmodal-body${zoom ? ' zoom' : ''}`}>
            <img
              src={props.src}
              alt="読み取り元のスクリーンショット"
              onClick={() => setZoom((z) => !z)}
            />
          </div>

          {view && (
            <div className="imgmodal-readout">
              <h2 className="scr-h sm">OCR読み取り</h2>
              <div className="readout">
                {view.header.map((h) => (
                  <div key={h.label} className={`row${h.low ? ' low' : ''}`}>
                    <span className="lb">{h.label}</span>
                    <span className="vl">
                      {h.value}
                      {h.confPct && <b className="conf">{h.confPct}</b>}
                    </span>
                  </div>
                ))}
              </div>

              <h2 className="scr-h sm">Seats</h2>
              <div className="seats-ro imgmodal-seats-ro">
                {view.seats.map((s) => (
                  <div key={s.id} className={`seatrow-ro${s.isHero ? ' hero' : ''}`}>
                    <span className={`posbadge sm pos-${s.posLabel}`}>{s.posLabel}</span>
                    {s.isHero && <span className="imgmodal-tag hero">hero</span>}
                    {s.isButton && <span className="imgmodal-tag dbtn">D</span>}
                    <span className={`imgmodal-field${s.occupancyLow ? ' lowconf' : ''}`}>
                      {s.occupancyText}
                      <b className="conf">{s.occupancyConfPct}</b>
                    </span>
                    <span className={`imgmodal-field${s.actionLow ? ' lowconf' : ''}`}>
                      {s.actionText}
                      <b className="conf">{s.actionConfPct}</b>
                    </span>
                    <span className={`stk${s.stackLow ? ' lowconf' : ''}`}>
                      {s.stackText}
                      <b className="conf">{s.stackConfPct}</b>
                    </span>
                    {s.betText && (
                      <span className={`betchip${s.betLow ? ' lowconf' : ''}`}>
                        bet {s.betText}
                        <b className="conf">{s.betConfPct}</b>
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {view.chipCheckNote && <p className="imgmodal-chipcheck">⚙ {view.chipCheckNote}</p>}

              {view.issues.length > 0 && (
                <>
                  <div className="check-h">読み取れなかった理由</div>
                  <ul className="check">
                    {view.issues.map((m) => (
                      <li key={m} className="ng">
                        <span className="mark">!</span>
                        <div>{m}</div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
