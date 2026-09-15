/**
 * SIT & GO のハンド履歴（docs/SNG_DESIGN.md §5）。試合ごとにまとめた新しい順の一覧。
 * 試合の見出しをタップせずとも見えるようにし、ハンド行をタップして展開する
 * （`slumbot/HuHistoryView.tsx` と同じ操作感）。
 *
 * 圧縮表現のデコード（`@oshihiki/sng` の `decodeHand`）は担当 A1 と並行実装中で、
 * 今はまだ throw する仮置きの可能性がある。**ここでは必ず try/catch で包み**、
 * 失敗しても一覧そのものは壊さない（該当ハンドだけ「詳細を読み込めませんでした」を出す）。
 *
 * 相手の表示名・試合の見出し（人数・開始bb・構造・上昇間隔・モード）は `sng_games`
 * （`useSngHands` の `games`）が唯一の材料。このカラム追加前の古い試合は `game` が
 * 無い（または `seats` が空）ので、その場合だけ `Seat n` にフォールバックする。
 */

import { decodeHand } from '@oshihiki/sng';
import type { ActionRecord, SngHandRecord } from '@oshihiki/sng';
import { useMemo, useState } from 'react';

import { STREET_LABEL } from '../slumbot/rules';
import type { SngGameLocal, SngHandLocal, SngResultLocal } from '../sng/historyStore';
import { chipsToBbSng, namesFromSeats, netOf, positionMapOf, sngConfigSummary } from '../sng/tenfour';
import { useSngHands } from '../sng/useSngHands';

const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const PAGE = 50;

const ACTION_DISPLAY: Record<ActionRecord['kind'], string> = {
  fold: 'FOLD',
  check: 'CHECK',
  call: 'CALL',
  bet: 'BET',
  raise: 'RAISE',
  allin: 'ALL IN',
};

const POS_CLASS: Record<string, string> = {
  UTG: 'p-utg',
  HJ: 'p-hj',
  CO: 'p-co',
  BTN: 'p-btn',
  SB: 'p-sb',
  BB: 'p-bb',
};

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

function PosBadge(props: { pos: string }): JSX.Element {
  return <span className={`sh-pos ${POS_CLASS[props.pos] ?? ''}`}>{props.pos}</span>;
}

function Cards(props: { cards: readonly string[]; dim?: boolean }): JSX.Element {
  return (
    <span className={`hh-cards${props.dim ? ' dim' : ''}`}>
      {props.cards.map((c, i) => {
        const suit = c[1]?.toLowerCase() ?? '';
        const rank = c[0] === 'T' ? '10' : c[0];
        return (
          <span key={`${c}-${i}`} className={`hh-card suit-${suit}`}>
            {rank}
            {SUIT_GLYPH[suit] ?? ''}
          </span>
        );
      })}
    </span>
  );
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

function HandDetail(props: { rec: SngHandRecord; mySeat: number | null; game: SngGameLocal | null }): JSX.Element {
  const { rec, mySeat, game } = props;
  const posMap = positionMapOf(rec);
  // 表示名は `sng_games.seats` が唯一の材料。無い（古い試合・未同期）席だけ `Seat n`。
  const names = useMemo(
    () => namesFromSeats(game?.seats ?? [], game?.config.players ?? rec.startStacks.length),
    [game, rec.startStacks.length],
  );
  const nameOf = (seat: number): string => (seat === mySeat ? 'YOU' : names[seat] ?? `Seat ${seat}`);
  const byStreet: ActionRecord[][] = [[], [], [], []];
  for (const a of rec.actions) byStreet[a.street]?.push(a);
  const shownEntries = Object.entries(rec.shown);

  return (
    <div className="hh-detail">
      {byStreet.map((steps, s) =>
        steps.length === 0 ? null : (
          <div key={s} className="hh-street">
            <span className="hh-street-lbl">{STREET_LABEL[s]}</span>
            <ul>
              {steps.map((a, i) => (
                <li key={i} className={a.seat === mySeat ? 'me' : 'bot'}>
                  <PosBadge pos={posMap?.get(a.seat) ?? '?'} />
                  <span className="hh-who">{nameOf(a.seat)}</span>
                  <span className="hh-act">
                    {ACTION_DISPLAY[a.kind]}
                    {a.kind !== 'fold' && a.kind !== 'check' ? ` ${chipsToBbSng(a.betTo, rec.bb)}bb` : ''}
                    {a.auto ? ' (自動)' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
      {shownEntries.length > 0 && (
        <div className="hh-foot">
          {shownEntries.map(([seat, cards]) => (
            <span key={seat} className="hh-foot-item">
              {nameOf(Number(seat))} <Cards cards={cards} />
            </span>
          ))}
        </div>
      )}
      {rec.eliminated.length > 0 && (
        <div className="hh-foot">
          {rec.eliminated.map((e) => (
            <span key={e.seat} className="hh-foot-item">
              {nameOf(e.seat)} <b className="loss">脱落（{e.place}位）</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function HandRow(props: {
  hand: SngHandLocal;
  game: SngGameLocal | null;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { hand, game, open, onToggle } = props;
  const rec = useMemo(() => decodeSafe(hand), [hand]);
  const mySeat = hand.mySeat;
  const eliminated = rec && mySeat !== null ? rec.eliminated.find((e) => e.seat === mySeat) ?? null : null;
  const net = rec && mySeat !== null ? chipsToBbSng(netOf(mySeat, rec), rec.bb) : null;

  return (
    <div className={`hh-item${open ? ' open' : ''}`}>
      <button type="button" className="hh-row" aria-expanded={open} onClick={onToggle}>
        <span className="hh-main">
          <span className="hh-time">
            #{hand.handNo} L{hand.level}
          </span>
          {hand.myCards && <Cards cards={hand.myCards} />}
          {rec && rec.board.length > 0 && <Cards cards={rec.board} dim />}
          {eliminated && <span className="sh-out">OUT #{eliminated.place}</span>}
        </span>
        <span className="hh-side">
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
      {open &&
        (rec ? (
          <HandDetail rec={rec} mySeat={mySeat} game={game} />
        ) : (
          <div className="hh-detail">
            <span className="hh-foot-item dim">詳細を読み込めませんでした。</span>
          </div>
        ))}
    </div>
  );
}

export function SngHistoryView(): JSX.Element {
  const { hands, results, games, note } = useSngHands();
  const groups = useGroups(hands, results, games);
  const [openHand, setOpenHand] = useState<string | null>(null);
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
                  {g.hands.map((h) => {
                    const key = `${h.gameId}:${h.handNo}`;
                    return (
                      <HandRow
                        key={key}
                        hand={h}
                        game={g.game}
                        open={openHand === key}
                        onToggle={() => setOpenHand(openHand === key ? null : key)}
                      />
                    );
                  })}
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
    </div>
  );
}
