/**
 * Training ▸ Hand History（Slumbot HU のハンド履歴, SPEC §7.4.6）。
 * 新しい順の一覧。タップで展開してストリート別のアクションと相手の手札を見る。
 */

import { useMemo, useState } from 'react';

import { walkActions, type ActionStep, type HuHandRecord } from '../slumbot/history';
import { STREET_LABEL, bbLabel, signedBbLabel } from '../slumbot/rules';
import { useHuHands } from '../slumbot/useHuHands';

const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const PAGE = 50;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

function stepLabel(st: ActionStep): string {
  switch (st.kind) {
    case 'fold':
      return 'FOLD';
    case 'check':
      return 'CHECK';
    case 'call':
      return st.allIn ? `CALL ${bbLabel(st.betTo, 1)}bb (ALL IN)` : `CALL ${bbLabel(st.betTo, 1)}bb`;
    case 'bet':
      return st.allIn ? `ALL IN ${bbLabel(st.betTo, 1)}bb` : `BET ${bbLabel(st.betTo, 1)}bb`;
    case 'raise':
      return st.allIn ? `ALL IN ${bbLabel(st.betTo, 1)}bb` : `RAISE ${bbLabel(st.betTo, 1)}bb`;
  }
}

function Detail(props: { rec: HuHandRecord }): JSX.Element {
  const { rec } = props;
  const w = walkActions(rec.action);
  if (!w) return <div className="hh-detail">（アクションを読み取れません）</div>;
  const byStreet: ActionStep[][] = [[], [], [], []];
  for (const st of w.steps) byStreet[st.street]!.push(st);
  const evDelta = rec.evWinnings === null ? null : rec.evWinnings - rec.winnings;
  return (
    <div className="hh-detail">
      {byStreet.map((steps, s) =>
        steps.length === 0 ? null : (
          <div key={s} className="hh-street">
            <span className="hh-street-lbl">{STREET_LABEL[s]}</span>
            <ul>
              {steps.map((st, i) => (
                <li key={i} className={st.seat === rec.heroSeat ? 'me' : 'bot'}>
                  <span className={`sb-pos p-${st.seat === 1 ? 'sb' : 'bb'}`}>{st.seat === 1 ? 'SB' : 'BB'}</span>
                  <span className="hh-who">{st.seat === rec.heroSeat ? 'YOU' : 'SLUMBOT'}</span>
                  <span className="hh-act">{stepLabel(st)}</span>
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
      <div className="hh-foot">
        {rec.botCards ? (
          <span className="hh-foot-item">
            SLUMBOT <Cards cards={rec.botCards} />
          </span>
        ) : (
          <span className="hh-foot-item dim">相手の手札は非公開（降りて終了）</span>
        )}
        {evDelta !== null && evDelta !== 0 && (
          <span className="hh-foot-item">
            ALL-IN EV <b className={evDelta > 0 ? 'gain' : 'loss'}>{signedBbLabel(evDelta, 1)}bb</b>
          </span>
        )}
      </div>
    </div>
  );
}

export function HuHistoryView(): JSX.Element {
  const { hands, note } = useHuHands();
  const [open, setOpen] = useState<string | null>(null);
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
          {desc.slice(0, limit).map((r) => {
            const isOpen = open === r.id;
            return (
              <div key={r.id} className={`hh-item${isOpen ? ' open' : ''}`}>
                <button type="button" className="hh-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.id)}>
                  <span className="hh-main">
                    <span className="hh-time">{fmtTime(r.playedAt)}</span>
                    <span className={`sb-pos p-${r.heroSeat === 1 ? 'sb' : 'bb'}`}>{r.heroSeat === 1 ? 'SB' : 'BB'}</span>
                    <Cards cards={r.heroCards} />
                    {r.board.length > 0 && <Cards cards={r.board} dim />}
                  </span>
                  <span className="hh-side">
                    <b className={`hh-net${r.winnings < 0 ? ' loss' : r.winnings > 0 ? ' gain' : ''}`}>
                      {signedBbLabel(r.winnings, 1)}
                      <span className="hh-unit">bb</span>
                    </b>
                    <span className={`hh-tag${r.showdown ? ' sd' : ''}`}>{r.showdown ? 'SD' : 'NSD'}</span>
                  </span>
                </button>
                {isOpen && <Detail rec={r} />}
              </div>
            );
          })}
          {desc.length > limit && (
            <button type="button" className="btn ghost wide" onClick={() => setLimit((l) => l + PAGE)}>
              もっと見る（残り {desc.length - limit}）
            </button>
          )}
        </div>
      )}
    </div>
  );
}
