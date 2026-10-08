/**
 * カメラの線画アイコン（画像添付・スクショ選択のボタン用。絵文字 📷 の置き換え）。
 * 大きさは周りの文字サイズ（1em）、色は文字色（currentColor）に従う。
 */
export function CameraIcon(): JSX.Element {
  return (
    <svg
      className="ic-camera"
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.6l1.6-2.2h6.6L16.9 7h2.6A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
      <circle cx="12" cy="12.8" r="3.4" />
    </svg>
  );
}
