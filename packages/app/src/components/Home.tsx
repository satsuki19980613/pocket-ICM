/**
 * ホーム（プレースホルダ）。モックの Home は公開結果の投稿フィード（SNS）だが、
 * それは M6「ホーム/スレッド」で実装する。現状は下段タブの骨組みに合わせた仮置きで、
 * 中核の ICM 計算へ即移動できる CTA を出す。
 */
export function Home(props: { onGoIcm: () => void }): JSX.Element {
  return (
    <div className="home-empty">
      <div className="glyph">⌂</div>
      <h3>ホーム</h3>
      <p>
        クラブのみんなが公開した計算が
        <br />
        ここに流れます（準備中）。
      </p>
      <button type="button" className="btn" onClick={props.onGoIcm}>
        ICM を計算する
      </button>
      <span className="badge">COMING SOON</span>
    </div>
  );
}
