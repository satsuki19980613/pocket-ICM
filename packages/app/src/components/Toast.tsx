import { useEffect } from 'react';

const AUTO_CLOSE_MS = 5000;

/**
 * 画面下（タブバーの上）に出る CP2077 調のトースト（SPEC §5.7 の4）。
 * 計算完了/失敗の通知専用。`role="status"` でスクリーンリーダーにも伝わる。5秒で自動的に
 * 消え、本文タップで `onTap`（結果画面/記録タブへ）、✕で即閉じる。同時に1つだけ表示する方針
 * のため、呼び出し側（App.tsx）は state を1スロットに保つだけでよい（新しいトーストは
 * 古いものを置き換える）。OS プッシュ通知は使わない（アプリ内のみ・SPEC §5.7）。
 */
export function Toast(props: {
  message: string;
  /** 'err' は左のアクセント線を赤にする（失敗通知）。既定は黄（完了通知）。 */
  kind?: 'done' | 'err';
  /** 本文タップで呼ぶ（結果画面/記録タブへの遷移など）。 */
  onTap: () => void;
  /** ✕ ボタン・自動消灯で呼ぶ。 */
  onClose: () => void;
}): JSX.Element {
  const { onClose } = props;

  useEffect(() => {
    const t = window.setTimeout(onClose, AUTO_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [onClose]);

  return (
    <div className="toast-wrap">
      <div
        className={`toast${props.kind === 'err' ? ' err' : ''}`}
        role="status"
        onClick={() => {
          props.onTap();
          props.onClose();
        }}
      >
        <span className="toast-msg">{props.message}</span>
        <button
          type="button"
          className="toast-x"
          aria-label="閉じる"
          onClick={(e) => {
            e.stopPropagation();
            props.onClose();
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
