/**
 * 成績画面（HU・SIT & GO）で共通の数値タイル。正負で色を変える。
 */

export type Tone = 'neg' | 'pos' | null;

/** 値の符号 → tone（0 は色なし）。 */
export function toneOf(v: number): Tone {
  if (v < 0) return 'neg';
  if (v > 0) return 'pos';
  return null;
}

/** tone → 値の修飾クラス（先頭の空白込み）。 */
function toneClass(tone: Tone | undefined): string {
  if (tone === 'neg') return ' loss';
  if (tone === 'pos') return ' gain';
  return '';
}

export function Stat(props: Readonly<{ label: string; value: string; unit?: string; sub?: string; tone?: Tone }>): JSX.Element {
  return (
    <div className="hs-stat">
      <span className="statlbl">{props.label}</span>
      <b className={`hs-val${toneClass(props.tone)}`}>
        {props.value}
        {props.unit && <span className="hs-unit">{props.unit}</span>}
      </b>
      {props.sub && <span className="hs-sub">{props.sub}</span>}
    </div>
  );
}
