/**
 * 背景の流動マーブル（煙）。最深部の固定レイヤーで、アプリ面（半透明）越しに透ける。
 *
 * 以前は擬似要素2枚をそれぞれ1本のキーフレームで動かしていたため、動きが単調で
 * 輪郭も見えていた。ここでは**大きく薄いブロブを6個**独立に置き、1個あたり
 *   - translate（漂う経路・6〜8点のウェイポイント）
 *   - scale（膨らみ縮み）
 *   - rotate（ゆっくり回る）
 * を**別々の CSS プロパティ・別々の周期**で回す。周期をすべて互いにずらしてあるので
 * 合成された見た目はほとんど繰り返さない＝縦横無尽に見える。
 * 色は radial-gradient を長く減衰させるだけで輪郭を消しており、filter: blur は使わない
 * （全画面 blur は毎フレーム再計算になり、低スペック端末で目に見えて重くなるため）。
 *
 * reduced-motion では styles.css の一括ルールで停止する。
 */
export function Marble(): JSX.Element {
  return (
    <div className="marble" aria-hidden="true">
      {[1, 2, 3, 4, 5, 6].map((n) => (
        <span key={n} className={`mb mb${n}`} />
      ))}
    </div>
  );
}
