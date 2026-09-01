import { RANKS, handLabel } from '../handGrid';

/** 読み取り専用 13×13 レンジ表。レンジ入り=強調, hero ハンド=枠。 */
export function RangeGrid(props: { hands: string[]; heroHand: string }): JSX.Element {
  const inRange = new Set(props.hands);
  return (
    <div className="grid ro">
      {RANKS.map((_, r) =>
        RANKS.map((__, c) => {
          const label = handLabel(r, c);
          const kind = r === c ? 'pair' : r < c ? 'suited' : 'offsuit';
          const on = inRange.has(label);
          const hero = label === props.heroHand;
          return (
            <div key={label} className={`cell ${kind}${on ? ' on' : ''}${hero ? ' herocell' : ''}`}>
              {label}
            </div>
          );
        }),
      )}
    </div>
  );
}
