/**
 * 準備中の機能を示す共通パネル（モック .soon 準拠）。
 * 現在は未使用（Training タブはハブのカード内で COMING SOON を出す形になった）だが、
 * 今後別の機能をタブ丸ごと準備中にするときのために温存する。
 */
export function ComingSoon(props: { glyph?: string; title: string; body: React.ReactNode }): JSX.Element {
  return (
    <div className="soon">
      <div className="glyph">{props.glyph ?? '◎'}</div>
      <h3>{props.title}</h3>
      <p>{props.body}</p>
      <span className="badge">COMING SOON</span>
    </div>
  );
}
