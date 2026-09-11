import { applyUpdateNow, dismissUpdateBanner, useAppUpdate } from '../pwa/appUpdate';

/**
 * 使っている途中に新しい版が届いたときのお知らせ（ヘッダの下）。
 * 起動直後・裏から戻った直後（入力途中でないとき）は自動で入れ替わるので、これが出るのは
 * 触っている最中に届いたときだけ。✕ で閉じても、次に起動・復帰したときに自動で入る。
 * 計算中は入れ替えると計算が止まるので、押せないようにして理由を添える。
 */
export function UpdateBanner(props: { blocked: boolean }): JSX.Element | null {
  const upd = useAppUpdate();

  if (upd.phase === 'applying') {
    return (
      <div className="upd-banner" role="status">
        <span className="upd-msg">新しいバージョンに更新しています…</span>
      </div>
    );
  }
  if (upd.phase !== 'available' || upd.bannerDismissed) return null;

  return (
    <div className="upd-banner" role="status">
      <span className="upd-msg">
        {props.blocked ? '新しいバージョンがあります（計算が終わると更新できます）' : '新しいバージョンがあります'}
      </span>
      <button type="button" className="upd-go" disabled={props.blocked} onClick={applyUpdateNow}>
        今すぐ更新
      </button>
      <button type="button" className="upd-x" aria-label="閉じる" onClick={dismissUpdateBanner}>
        ✕
      </button>
    </div>
  );
}
