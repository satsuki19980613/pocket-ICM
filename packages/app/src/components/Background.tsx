import { DigitalRain } from './DigitalRain';

/**
 * 背景。最深部の固定レイヤー（z-index:-2）にグラファイトの下地を敷き、その上に
 * 0/1 デジタルレイン（z-index:-1）を重ねる。
 *
 * 以前は流動マーブル（煙）を敷いていたが、さつき判断で撤去。単色べた塗りだと安っぽく
 * 見えるので、上方向の淡い持ち上げ・下方向の締め・四隅のビネットを重ねた
 * 「濃淡のあるグレー」にしてある（`.bgfield` の多重グラデーション）。
 * アニメーションはしないので描画コストはゼロ（雨だけが動く）。
 */
export function Background(): JSX.Element {
  return (
    <>
      <div className="bgfield" aria-hidden="true" />
      <DigitalRain />
    </>
  );
}
