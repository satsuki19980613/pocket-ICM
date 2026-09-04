/** 準備中の機能を示す共通パネル（モック .soon 準拠）。Drill 等で使用。 */
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
