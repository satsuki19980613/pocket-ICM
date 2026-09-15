/**
 * Training ▸ Hand History（Slumbot HU のハンド履歴, SPEC §7.4.6）。
 * 新しい順の一覧だけを出す。行をタップすると `HandDetailModal` でストリート別の
 * ポット・アクション・相手の手札を見られる（詳細はここでは組み立てず、
 * `history/huHandView.ts` に委ねる。契約は `history/handView.ts` の `HandDetailView`）。
 */

import { useMemo, useState } from 'react';

import type { HandDetailView } from '../history/handView';
import { huHandView } from '../history/huHandView';
import { signedBbLabel } from '../slumbot/rules';
import { useHuHands } from '../slumbot/useHuHands';
import type { HuHandRecord } from '../slumbot/history';
import { Cards, HandDetailModal, fmtBb } from './HandDetailModal';

const PAGE = 50;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function HandRow(props: { rec: HuHandRecord; onOpen: (view: HandDetailView) => void }): JSX.Element {
  const { rec: r, onOpen } = props;
  // 詳細ビューはここで一度だけ組み立て、行の POT タグとモーダル起動の両方に使う
  // （失敗しても一覧は壊さない。ビルダーが例外を投げても POT タグを出さないだけにする）。
  const view = useMemo(() => {
    try {
      return huHandView(r);
    } catch {
      return null;
    }
  }, [r]);

  return (
    <button type="button" className="hh-row" onClick={() => view && onOpen(view)}>
      <span className="hh-main">
        <span className="hh-time">{fmtTime(r.playedAt)}</span>
        <span className={`sh-pos ${r.heroSeat === 1 ? 'p-sb' : 'p-bb'}`}>{r.heroSeat === 1 ? 'SB' : 'BB'}</span>
        <Cards cards={r.heroCards} />
        {r.board.length > 0 && (
          <span className="hh-board">
            <span className="hh-board-lbl">BOARD</span>
            <Cards cards={r.board} dim />
          </span>
        )}
      </span>
      <span className="hh-side">
        {view && <span className="hh-tag pot">POT {fmtBb(view.result.finalPotBb)}bb</span>}
        <b className={`hh-net${r.winnings < 0 ? ' loss' : r.winnings > 0 ? ' gain' : ''}`}>
          {signedBbLabel(r.winnings, 1)}
          <span className="hh-unit">bb</span>
        </b>
        <span className={`hh-tag${r.showdown ? ' sd' : ''}`}>{r.showdown ? 'SD' : 'NSD'}</span>
      </span>
    </button>
  );
}

export function HuHistoryView(): JSX.Element {
  const { hands, note } = useHuHands();
  const [openView, setOpenView] = useState<HandDetailView | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const desc = useMemo(() => (hands ? [...hands].reverse() : []), [hands]);

  if (hands === null) {
    return (
      <div className="hh-wrap">
        <div className="panel solving">
          <div className="spinner" />
          <p>読み込み中…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="hh-wrap">
      <div className="panel hh-top">
        <div className="hh-top-row">
          <span className="hh-count">
            <b>{hands.length.toLocaleString()}</b> hands
          </span>
        </div>
        {note && <p className="hh-msg">{note}</p>}
      </div>

      {desc.length === 0 ? (
        <div className="panel emptyrec">まだ履歴がありません。Slumbot HU を打つと、ここに貯まります。</div>
      ) : (
        <div className="hh-list">
          {desc.slice(0, limit).map((r) => (
            <div key={r.id} className="hh-item">
              <HandRow rec={r} onOpen={setOpenView} />
            </div>
          ))}
          {desc.length > limit && (
            <button type="button" className="btn ghost wide" onClick={() => setLimit((l) => l + PAGE)}>
              もっと見る（残り {desc.length - limit}）
            </button>
          )}
        </div>
      )}

      {openView && <HandDetailModal view={openView} onClose={() => setOpenView(null)} />}
    </div>
  );
}
