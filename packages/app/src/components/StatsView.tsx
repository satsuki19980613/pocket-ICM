/**
 * Training ▸ STATS（Slumbot / SIT & GO の切替, docs/SNG_DESIGN.md §5）。
 *
 * 選択したタブは localStorage に持つ（次回もそこから開く）。中身はそれぞれ既存の
 * `HuStatsView`（Slumbot）と新しい `SngStatsView`（SIT & GO）に任せ、ここは切替の
 * 骨組みだけを持つ。
 */

import { useState } from 'react';

import { HuStatsView } from './HuStatsView';
import { SngStatsView } from './SngStatsView';

type Tab = 'slumbot' | 'sng';

const TAB_KEY = 'icm.stats.tab.v1';

function readTab(): Tab {
  try {
    const v = window.localStorage.getItem(TAB_KEY);
    return v === 'sng' ? 'sng' : 'slumbot';
  } catch {
    return 'slumbot';
  }
}

function writeTab(tab: Tab): void {
  try {
    window.localStorage.setItem(TAB_KEY, tab);
  } catch {
    /* 保存できなくても表示の切替自体は効く。 */
  }
}

export function StatsView(props: { onOpenHuHistory: () => void; onOpenSngHistory: () => void }): JSX.Element {
  const [tab, setTab] = useState<Tab>(readTab);

  function pick(next: Tab): void {
    setTab(next);
    writeTab(next);
  }

  return (
    <div className="sv-wrap">
      <div className="sv-tabs" role="tablist" aria-label="STATS">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'slumbot'}
          className={`segbtn${tab === 'slumbot' ? ' on' : ''}`}
          onClick={() => pick('slumbot')}
        >
          Slumbot
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'sng'}
          className={`segbtn${tab === 'sng' ? ' on' : ''}`}
          onClick={() => pick('sng')}
        >
          SIT &amp; GO
        </button>
      </div>

      {tab === 'slumbot' ? (
        <HuStatsView onOpenHistory={props.onOpenHuHistory} />
      ) : (
        <SngStatsView onOpenHistory={props.onOpenSngHistory} />
      )}
    </div>
  );
}
