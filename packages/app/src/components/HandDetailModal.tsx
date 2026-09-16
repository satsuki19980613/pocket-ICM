/**
 * ハンド履歴の「詳細」モーダル（Slumbot HU / SIT & GO 共通、SPEC §7.4.6 / SNG_DESIGN §5）。
 *
 * tenfour-poker.com のハンド画像に寄せた構成：見出し → プレイヤー表 → ストリートごとに
 * 「ラベル + ポット + ボード」と「アクション一覧」→ 最後に Result。データは
 * `history/handView.ts` の `HandDetailView` だけを見る（HU/SNG どちらの記録形式かは
 * 呼び出し側のビルダー（`huHandView` / `sngHandView`）が吸収済み）。
 *
 * 作法は `InfoModal.tsx` に完全に倣う（`useBackLayer` で戻る/Esc、backdrop クリックで閉じる、
 * 中身クリックは stopPropagation）。ポジションバッジは SNG の 6 色（`.sh-pos`）に統一し、
 * HU（SB/BB の 2 色しか使わない）もここから同じ見た目になる。
 */

import type { HandDetailView, HandPlayerView, HandStepView, HandStreetView } from '../history/handView';

import { useBackLayer } from './BackLayer';

const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

const POS_CLASS: Record<string, string> = {
  UTG: 'p-utg',
  HJ: 'p-hj',
  CO: 'p-co',
  BTN: 'p-btn',
  SB: 'p-sb',
  BB: 'p-bb',
};

/** bb 表示（末尾の 0 を落とす）。`handView.ts` はすでに bb 単位・小数第 2 位丸め済みなので、
 * ここではチップ換算はせず桁の整形だけする。 */
export function fmtBb(n: number, digits = 2): string {
  const s = n.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** 符号付き bb 表示（+3.5 / −1.2 / ±0）。 */
export function fmtSignedBb(n: number, digits = 2): string {
  if (n === 0) return '±0';
  return `${n > 0 ? '+' : '−'}${fmtBb(Math.abs(n), digits)}`;
}

/** ポジションバッジ（HU/SNG 共通）。未知のポジション（'?'）はグレー表示にする。 */
export function PosBadge(props: { pos: string }): JSX.Element {
  return <span className={`sh-pos ${POS_CLASS[props.pos] ?? 'p-unk'}`}>{props.pos}</span>;
}

/** 手札 / ボードの表示（`.hh-cards` / `.hh-card.suit-*` をそのまま使う）。
 * `highlight` は「今ここで新しくめくれた」札に付ける目印（ストリートブロックの新カード）。 */
export function Cards(props: { cards: readonly string[]; dim?: boolean; highlight?: boolean }): JSX.Element {
  return (
    <span className={`hh-cards${props.dim ? ' dim' : ''}`}>
      {props.cards.map((c, i) => {
        const suit = c[1]?.toLowerCase() ?? '';
        const rank = c[0] === 'T' ? '10' : c[0];
        return (
          <span key={`${c}-${i}`} className={`hh-card suit-${suit}${props.highlight ? ' new' : ''}`}>
            {rank}
            {SUIT_GLYPH[suit] ?? ''}
          </span>
        );
      })}
    </span>
  );
}

/** 非公開の手札のプレースホルダ（裏向き 2 枚）。 */
function HiddenCards(): JSX.Element {
  return (
    <span className="hh-cards">
      <span className="hh-card back">?</span>
      <span className="hh-card back">?</span>
    </span>
  );
}

function PlayerRow(props: { p: HandPlayerView }): JSX.Element {
  const { p } = props;
  return (
    <li className={`hhd-prow${p.isHero ? ' me' : ''}`}>
      <PosBadge pos={p.pos} />
      <span className="hhd-pname">{p.name}</span>
      {p.cards ? <Cards cards={p.cards} /> : <HiddenCards />}
      {p.netBb === null ? (
        <span className="hhd-pnet unk">?</span>
      ) : (
        <span className={`hhd-pnet${p.netBb < 0 ? ' loss' : p.netBb > 0 ? ' gain' : ''}`}>
          {fmtSignedBb(p.netBb, 1)}
          <span className="hh-unit">bb</span>
        </span>
      )}
    </li>
  );
}

function StepRow(props: { st: HandStepView }): JSX.Element {
  const { st } = props;
  return (
    <li className={st.isHero ? 'me' : ''}>
      <PosBadge pos={st.pos} />
      <span className="hh-who">{st.name}</span>
      <span className="hh-act">
        {st.label}
        {st.amountBb !== null && ` ${fmtBb(st.amountBb)}bb`}
      </span>
      {st.allIn && st.label !== 'ALL IN' && <span className="hhd-flag allin">ALL IN</span>}
      {st.auto && <span className="hhd-flag auto">自動</span>}
    </li>
  );
}

function StreetBlock(props: { st: HandStreetView; board: readonly string[] }): JSX.Element {
  const { st, board } = props;
  // board は累積（前ストリートまでの分 + 今回めくれた分）。今回の分だけ強調し、
  // 前から続いているカードは沈める（tenfour の「新しい 1 枚だけ出す」見せ方と、
  // 全体を一望できる累積表示の両立）。
  const newCount = st.board.length;
  const oldCards = board.slice(0, board.length - newCount);
  const newCards = board.slice(board.length - newCount);
  return (
    <div className="hhd-street">
      <div className="hhd-street-head">
        <span className="hh-street-lbl">{st.label}</span>
        <span className="hhd-pot">{fmtBb(st.potBb)}bb</span>
        {oldCards.length > 0 && <Cards cards={oldCards} dim />}
        {newCards.length > 0 && <Cards cards={newCards} highlight />}
      </div>
      {st.steps.length > 0 && (
        <ul className="hhd-steps">
          {st.steps.map((s, i) => (
            <StepRow key={i} st={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function HandDetailModal(props: { view: HandDetailView; onClose: () => void; actions?: React.ReactNode }): JSX.Element {
  const { view, onClose, actions } = props;
  // 端末の戻る／Esc で閉じる（InfoModal と同じ作法）。
  useBackLayer(onClose);

  // ストリートの board は「そのストリートで新たにめくれた分」だけなので、表示は積み上げる
  // （FLOP=3枚 → TURN=4枚 → RIVER=5枚。tenfour のハンド画像と同じ見え方にする）。
  const cumBoards: readonly string[][] = view.streets.reduce<string[][]>((acc, st) => {
    const prev = acc[acc.length - 1] ?? [];
    acc.push([...prev, ...st.board]);
    return acc;
  }, []);

  // Result の「獲得」（勝者がポットから持ち帰った額）と自分の「収支」（このハンドの純増減）は
  // 別物で混同しやすい（獲得はポットの取り分、収支はそこから自分の拠出を引いた額）。
  // ラベルを分けて両方出し、一覧の ±bb と収支が一致することが一目で分かるようにする。
  const heroNet = view.players.find((p) => p.isHero)?.netBb ?? null;

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      role="presentation"
    >
      <div className="modal hh-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={view.title}>
        <div className="modal-head">
          <span className="modal-title">{view.title}</span>
          <button type="button" className="modal-x" aria-label="閉じる" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body hhd-body">
          {view.subtitle && <p className="hhd-sub">{view.subtitle}</p>}

          <ul className="hhd-players">
            {view.players.map((p) => (
              <PlayerRow key={p.seat} p={p} />
            ))}
          </ul>

          <div className="hhd-streets">
            {view.streets.map((st, i) => (
              <StreetBlock key={st.street} st={st} board={cumBoards[i] ?? st.board} />
            ))}
          </div>

          <div className="hhd-result">
            <span className="hhd-result-lbl">RESULT</span>
            {view.result.winners.length > 0 && (
              <p className="hhd-result-line">
                <span className="hhd-result-tag">獲得</span> {view.result.winners.join(' / ')}
                {view.result.wonBb !== null && (
                  <>
                    {' '}
                    <b className="hhd-won">{fmtBb(view.result.wonBb, 1)}bb</b>
                  </>
                )}
              </p>
            )}
            {heroNet !== null && (
              <p className="hhd-result-line">
                <span className="hhd-result-tag">収支</span> YOU
                <b className={`hhd-mynet${heroNet < 0 ? ' loss' : heroNet > 0 ? ' gain' : ''}`}> {fmtSignedBb(heroNet, 1)}bb</b>
              </p>
            )}
            <p className="hhd-result-line sub">
              POT {fmtBb(view.result.finalPotBb)}bb{view.result.showdown && ' ・ SHOWDOWN'}
            </p>
            {view.result.notes.map((n, i) => (
              <p key={i} className="hhd-result-line sub">
                {n}
              </p>
            ))}
          </div>

          {actions && <div className="hhd-actions">{actions}</div>}
        </div>
      </div>
    </div>
  );
}
