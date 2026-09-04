// 4色デッキの表示用カード型（♠黒/♥赤/♦青/♣緑）。フィードの結果カード描画で使う。
export type Suit = 'spade' | 'heart' | 'diamond' | 'club';

export interface SampleCard {
  r: string;
  s: Suit;
}
