import { RANKS, handLabel } from '../handGrid';

/** 13×13 ハンドグリッド。セルをタップで hero ハンドを選ぶ。 */
export function HandPicker(props: { value: string; onChange: (hand: string) => void }): JSX.Element {
  return (
    <div className="grid">
      {RANKS.map((_, r) =>
        RANKS.map((__, c) => {
          const label = handLabel(r, c);
          const kind = r === c ? 'pair' : r < c ? 'suited' : 'offsuit';
          const sel = label === props.value;
          return (
            <button
              key={label}
              type="button"
              className={`cell ${kind}${sel ? ' sel' : ''}`}
              onClick={() => props.onChange(label)}
              aria-label={label}
            >
              {label}
            </button>
          );
        }),
      )}
    </div>
  );
}
