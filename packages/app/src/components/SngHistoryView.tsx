/**
 * SIT & GO のハンド履歴（docs/SNG_DESIGN.md §5）。試合ごとにまとめた新しい順の一覧。
 * 試合の見出しは今まで通りタップせずに見えるが、ハンド行は一覧だけを出し、
 * タップすると `HandDetailModal` を開いて個別の詳細（ポット・アクション・結果）を見る
 * （`HuHistoryView.tsx` と同じ操作感）。
 *
 * 圧縮表現のデコード（`@oshihiki/sng` の `decodeHand`）は担当 A1 と並行実装中で、
 * 今はまだ throw する仮置きの可能性がある。**ここでは必ず try/catch で包み**、
 * 失敗しても一覧そのものは壊さない（該当ハンドだけ「詳細を読み込めませんでした」を出す）。
 * `history/sngHandView.ts` の組み立てが失敗した場合も同様に扱う（行は出すがモーダルは開かない）。
 *
 * 相手の表示名・試合の見出し（人数・開始bb・構造・上昇間隔・モード）は `sng_games`
 * （`useSngHands` の `games`）が唯一の材料。このカラム追加前の古い試合は `game` が
 * 無い（または `seats` が空）ので、その場合だけ `Seat n` にフォールバックする。
 */

import { decodeHand } from '@oshihiki/sng';
import type { SngHandRecord } from '@oshihiki/sng';
import { useMemo, useState } from 'react';

import type { HandDetailView } from '../history/handView';
import { sngHandView } from '../history/sngHandView';
import type { SngGameLocal, SngHandLocal, SngResultLocal } from '../sng/historyStore';
import { chipsToBbSng, netOf, sngConfigSummary } from '../sng/tenfour';
import { useSngHands } from '../sng/useSngHands';
import { Cards, HandDetailModal, fmtBb } from './HandDetailModal';

const PAGE = 50;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function signedNum(v: number): string {
  if (v === 0) return '±0';
  const s = (Math.round(Math.abs(v) * 100) / 100).toString();
  return `${v > 0 ? '+' : '−'}${s}`;
}

function decodeSafe(hand: SngHandLocal): SngHandRecord | null {
  try {
    return decodeHand(hand.encoded, {
      gameId: hand.gameId,
      handNo: hand.handNo,
      playedAt: hand.playedAt,
      sb: hand.sb,
      bb: hand.bb,
      ante: hand.ante,
    });
  } catch {
    return null; // decodeHand が未実装（throw）でも一覧は壊さない。
  }
}

/** そのハンドの開始スタックからの「開始 bb」（level 1 の BB は常に 200 チップ）。 */
function startBbOf(hands: readonly SngHandLocal[]): number | null {
  const first = hands.find((h) => h.handNo === 1);
  if (!first) return null;
  const rec = decodeSafe(first);
  if (!rec) return null;
  const max = Math.max(0, ...rec.startStacks);
  return max > 0 ? Math.round(max / 200) : null;
}

interface GameGroup {
  readonly gameId: string;
  readonly hands: readonly SngHandLocal[];
  readonly result: SngResultLocal | null;
  readonly game: SngGameLocal | null;
}

function useGroups(
  hands: readonly SngHandLocal[] | null,
  results: readonly SngResultLocal[] | null,
  games: readonly SngGameLocal[] | null,
): GameGroup[] {
  return useMemo(() => {
    if (!hands) return [];
    const byGame = new Map<string, SngHandLocal[]>();
    for (const h of hands) {
      const arr = byGame.get(h.gameId);
      if (arr) arr.push(h);
      else byGame.set(h.gameId, [h]);
    }
    const resultByGame = new Map((results ?? []).map((r) => [r.gameId, r]));
    const gameByGame = new Map((games ?? []).map((g) => [g.gameId, g]));
    const groups: GameGroup[] = [];
    for (const [gameId, hs] of byGame) {
      const sorted = [...hs].sort((a, b) => a.handNo - b.handNo);
      groups.push({
        gameId,
        hands: sorted,
        result: resultByGame.get(gameId) ?? null,
        game: gameByGame.get(gameId) ?? null,
      });
    }
    // 新しい試合が先（そのゲームの最後のハンドの playedAt で判定）。
    groups.sort((a, b) => {
      const at = a.hands[a.hands.length - 1]?.playedAt ?? 0;
      const bt = b.hands[b.hands.length - 1]?.playedAt ?? 0;
      return bt - at;
    });
    return groups;
  }, [hands, results, games]);
}

function HandRow(props: { hand: SngHandLocal; game: SngGameLocal | null; onOpen: (view: HandDetailView) => void }): JSX.Element {
  const { hand, game, onOpen } = props;
  const rec = useMemo(() => decodeSafe(hand), [hand]);
  const mySeat = hand.mySeat;
  const eliminated = rec && mySeat !== null ? (rec.eliminated.find((e) => e.seat === mySeat) ?? null) : null;
  const net = rec && mySeat !== null ? chipsToBbSng(netOf(mySeat, rec), rec.bb) : null;
  // 詳細ビューは行の POT タグとモーダル起動の両方に使う。rec がデコードできていても
  // ビルダー側の事情で null が返ることはあり得るので、その場合は POT タグを省くだけにする。
  const view = useMemo(() => {
    if (!rec) return null;
    try {
      return sngHandView({ rec, game, mySeat, handNo: hand.handNo, level: hand.level, myCards: hand.myCards });
    } catch {
      return null;
    }
  }, [rec, game, mySeat, hand.handNo, hand.level, hand.myCards]);

  if (!rec) {
    return (
      <div className="hh-item hh-item-err">
        <span className="hh-row hh-row-err">
          <span className="hh-time">#{hand.handNo} L{hand.level}</span>
          <span className="hh-foot-item dim">詳細を読み込めませんでした</span>
        </span>
      </div>
    );
  }

  return (
    <div className="hh-item">
      <button type="button" className="hh-row" onClick={() => view && onOpen(view)}>
        <span className="hh-main">
          <span className="hh-time">
            #{hand.handNo} L{hand.level}
          </span>
          {hand.myCards && <Cards cards={hand.myCards} />}
          {rec.board.length > 0 && (
            <span className="hh-board">
              <span className="hh-board-lbl">BOARD</span>
              <Cards cards={rec.board} dim />
            </span>
          )}
          {eliminated && <span className="sh-out">OUT #{eliminated.place}</span>}
        </span>
        <span className="hh-side">
          {view && <span className="hh-tag pot">POT {fmtBb(view.result.finalPotBb)}bb</span>}
          {net !== null ? (
            <b className={`hh-net${net < 0 ? ' loss' : net > 0 ? ' gain' : ''}`}>
              {signedNum(net)}
              <span className="hh-unit">bb</span>
            </b>
          ) : (
            <span className="hh-tag">?</span>
          )}
        </span>
      </button>
    </div>
  );
}

export function SngHistoryView(): JSX.Element {
  const { hands, results, games, note } = useSngHands();
  const groups = useGroups(hands, results, games);
  const [openView, setOpenView] = useState<HandDetailView | null>(null);
  const [limit, setLimit] = useState(PAGE);

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
            <b>{groups.length.toLocaleString()}</b> games
          </span>
        </div>
        {note && <p className="hh-msg">{note}</p>}
      </div>

      {groups.length === 0 ? (
        <div className="panel emptyrec">まだ履歴がありません。SIT &amp; GO を打つと、ここに貯まります。</div>
      ) : (
        <div className="hh-list">
          {groups.slice(0, limit).map((g) => {
            const startBb = startBbOf(g.hands);
            const last = g.hands[g.hands.length - 1];
            return (
              <div key={g.gameId} className="sh-game">
                <div className="sh-game-head">
                  <span className="sh-game-time">{last ? fmtTime(last.playedAt) : ''}</span>
                  <span className="sh-game-meta">
                    {g.game
                      ? sngConfigSummary(g.game.config)
                      : `${g.result ? `${g.result.players}人` : `${g.hands.length}ハンド`}${startBb ? ` ・ ${startBb}bb開始` : ''}`}
                  </span>
                  <span className="sh-game-result">
                    {g.result ? (
                      <>
                        <b>{g.result.place}位</b>
                        <span className={`sh-pt${g.result.pt < 0 ? ' loss' : g.result.pt > 0 ? ' gain' : ''}`}>
                          {signedNum(g.result.pt)}pt
                        </span>
                      </>
                    ) : (
                      <span className="sh-game-result-pending">進行中 / 未確定</span>
                    )}
                  </span>
                </div>
                <div className="hh-list sh-hands">
                  {g.hands.map((h) => (
                    <HandRow key={`${h.gameId}:${h.handNo}`} hand={h} game={g.game} onOpen={setOpenView} />
                  ))}
                </div>
              </div>
            );
          })}
          {groups.length > limit && (
            <button type="button" className="btn ghost wide" onClick={() => setLimit((l) => l + PAGE)}>
              もっと見る（残り {groups.length - limit}）
            </button>
          )}
        </div>
      )}

      {openView && <HandDetailModal view={openView} onClose={() => setOpenView(null)} />}
    </div>
  );
}
