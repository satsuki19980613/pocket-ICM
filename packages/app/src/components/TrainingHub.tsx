/**
 * Training タブのハブ画面（SPEC §7.4）。
 * トレーニングは複数の機能を抱えるので、タブ直下はメニューにして各機能へ送り出す。
 */

import { useEffect, useState } from 'react';

import { signedBbLabel } from '../slumbot/rules';
import { fetchMyStats, type MyStats } from '../supabase/huStats';

interface MenuProps {
  readonly glyph: string;
  readonly title: string;
  readonly sub: string;
  readonly soon?: boolean;
  readonly onClick?: () => void;
}

function MenuCard(props: MenuProps): JSX.Element {
  return (
    <button
      type="button"
      className={`tr-card${props.soon ? ' soon' : ''}`}
      disabled={props.soon}
      onClick={props.onClick}
    >
      <span className="tr-glyph">{props.glyph}</span>
      <span className="tr-text">
        <span className="tr-title">{props.title}</span>
        <span className="tr-sub">{props.sub}</span>
      </span>
      {props.soon ? <span className="tr-badge">COMING SOON</span> : <span className="tr-go">›</span>}
    </button>
  );
}

export function TrainingHub(props: { onOpenSlumbot: () => void }): JSX.Element {
  const [stats, setStats] = useState<MyStats | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchMyStats().then((r) => {
      if (alive && r.ok) setStats(r.data);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="tr-wrap">
      <div className="tr-menu">
        <MenuCard
          glyph="♠"
          title="Slumbot HU"
          sub="世界トップ級のボットとヘッズアップ 200bb"
          onClick={props.onOpenSlumbot}
        />
        <MenuCard
          glyph="◎"
          title="AOF ドリル"
          sub="このアプリの ICM 計算で出題する ALL IN / FOLD テスト"
          soon
        />
      </div>

      {stats && stats.hands > 0 && (
        <div className="panel tr-mine">
          <div className="scr-h sm">あなたの通算（Slumbot HU）</div>
          <div className="statrow">
            <div className="stat">
              <span className="statlbl">ハンド数</span>
              <b className="statval">{stats.hands}</b>
            </div>
            <div className="stat">
              <span className="statlbl">収支</span>
              <b className={`statval ${stats.netChips < 0 ? 'loss' : ''}`}>
                {signedBbLabel(stats.netChips)}bb
              </b>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
