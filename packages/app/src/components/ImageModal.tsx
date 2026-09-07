import { useEffect, useState } from 'react';

/**
 * 元画像の確認モーダル（M3 補助）。OCR プリフィルの読取値と、添付した実スクショを
 * 照合するために使う。既定は全体表示（幅フィット）、画像タップで原寸（コンテナ内スクロール）に
 * 切り替え。背景クリック / ✕ / Esc で閉じる。
 */
export function ImageModal(props: { src: string; onClose: () => void }): JSX.Element {
  const [zoom, setZoom] = useState(false);

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
        aria-label="元画像"
      >
        <div className="imgmodal-head">
          <span className="imgmodal-title">元画像 ・ タップで{zoom ? '全体表示' : '原寸'}</span>
          <button type="button" className="modal-x" aria-label="閉じる" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className={`imgmodal-body${zoom ? ' zoom' : ''}`}>
          <img
            src={props.src}
            alt="読み取り元のスクリーンショット"
            onClick={() => setZoom((z) => !z)}
          />
        </div>
      </div>
    </div>
  );
}
