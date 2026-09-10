import { useRef, useState } from 'react';
import { PokerTable } from './PokerTable';
import { RangeGrid } from './RangeGrid';
import { Result } from './Result';
import { solveInWorker } from '../solverClient';
import {
  DEFAULT_FILTER,
  drillOpts,
  generateSpot,
  mulberry32,
  type Rng,
} from '../drill/generate';
import { judge, makeAttempt, summarize, type DrillAttempt, type SolvedSpot } from '../drill/model';
import { headlineNode, type HeroAction } from '../records/model';

type Phase = 'config' | 'loading' | 'answering' | 'revealed' | 'summary';

const ACT_JA: Record<HeroAction, string> = { PUSH: 'ALL IN', FOLD: 'FOLD' };

/**
 * Training（§7.4 トレーニング）画面。ドリル（AOF 出題）モード。ランタイム出題→ポーカーテーブル→FOLD/ALL IN→開示→次へ。
 * 求解は単一 Worker が直列化するので、回答中に「次の手札」を裏で先読み求解しておく
 * （さつき承認: 速い卓 2〜4 人に限定＋パイプライン）。
 */
export function DrillView(props: { onExit: () => void }): JSX.Element {
  const rngRef = useRef<Rng>(mulberry32((Date.now() ^ 0x9e3779b9) >>> 0));
  const nextRef = useRef<Promise<SolvedSpot> | null>(null);

  const [phase, setPhase] = useState<Phase>('config');
  const [counts, setCounts] = useState<number[]>([...DEFAULT_FILTER.counts]);
  const [current, setCurrent] = useState<SolvedSpot | null>(null);
  const [answer, setAnswer] = useState<HeroAction | null>(null);
  const [attempts, setAttempts] = useState<DrillAttempt[]>([]);
  const [reviewing, setReviewing] = useState<DrillAttempt | null>(null);
  const [failed, setFailed] = useState(false);

  /** 1 局面を生成→求解する Promise を起こす（await はしない＝先読みに使える）。 */
  function spawn(): Promise<SolvedSpot> {
    const state = generateSpot(rngRef.current, { ...DEFAULT_FILTER, counts: counts.length ? counts : [2] });
    return solveInWorker(state, drillOpts(state.playersLeft)).then(({ result, ms }) => ({ state, result, ms }));
  }

  async function begin(): Promise<void> {
    setAttempts([]);
    setAnswer(null);
    setReviewing(null);
    setFailed(false);
    setPhase('loading');
    try {
      const first = await spawn();
      setCurrent(first);
      setPhase('answering');
      nextRef.current = spawn(); // 回答中に次を先読み
    } catch {
      setFailed(true);
      setPhase('config');
    }
  }

  function onAnswer(a: HeroAction): void {
    if (!current) return;
    setAttempts((prev) => [...prev, makeAttempt(current, a)]);
    setAnswer(a);
    setPhase('revealed');
  }

  async function onNext(): Promise<void> {
    setAnswer(null);
    const p = nextRef.current;
    nextRef.current = null;
    if (!p) {
      void begin();
      return;
    }
    setPhase('loading');
    try {
      const spot = await p;
      setCurrent(spot);
      setPhase('answering');
      nextRef.current = spawn();
    } catch {
      setFailed(true);
      setPhase('config');
    }
  }

  function toggleCount(n: number): void {
    setCounts((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n].sort()));
  }

  // ---- config（開始前）----
  if (phase === 'config') {
    return (
      <div className="drill-wrap">
        <div className="panel">
          <div className="scr-h sm">トレーニング設定</div>
          <label className="lbl">出題する残り人数</label>
          <div className="seg">
            {[2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                className={`segbtn${counts.includes(n) ? ' on' : ''}`}
                onClick={() => toggleCount(n)}
              >
                {n}人
              </button>
            ))}
          </div>
          <p className="ocr-hint">
            未開（フォールドで回ってきた）局面で「オールイン or フォールド」を裁定します。5〜6 人は求解が重いため対象外。
          </p>
        </div>
        {failed && <div className="panel err-view"><ul className="issues"><li>局面の生成に失敗しました。もう一度お試しください。</li></ul></div>}
        <button type="button" className="btn wide" disabled={counts.length === 0} onClick={() => void begin()}>
          トレーニング開始
        </button>
        <button type="button" className="btn ghost wide" onClick={props.onExit}>
          戻る
        </button>
      </div>
    );
  }

  // ---- summary（終わる）----
  if (phase === 'summary') {
    const sum = summarize(attempts);
    if (reviewing) {
      return (
        <Result
          state={reviewing.state}
          result={reviewing.result}
          ms={reviewing.ms}
          readOnly
          savedAction={reviewing.action}
          savedEvLoss={reviewing.evLoss}
          onBack={() => setReviewing(null)}
        />
      );
    }
    return (
      <div className="drill-wrap">
        <div className="panel">
          <div className="scr-h sm">セッション成績</div>
          <div className="drill-score">
            <span className="ds-acc">{Math.round(sum.accuracy * 100)}%</span>
            <span className="ds-sub">{sum.correct} / {sum.hands} 正解</span>
          </div>
          <div className="statrow">
            <div className="stat">
              <span className="statlbl">ハンド数</span>
              <b className="statval">{sum.hands}</b>
            </div>
            <div className="stat">
              <span className="statlbl">EV loss 合計（pt）</span>
              <b className={`statval ${sum.totalEvLoss > 0 ? 'loss' : ''}`}>{sum.totalEvLoss.toFixed(3)}</b>
            </div>
          </div>
        </div>

        {sum.misses.length > 0 && (
          <div className="panel">
            <div className="scr-h sm">外した場面（EV loss 降順）</div>
            <div className="reclist">
              {sum.misses.map((m) => (
                <button key={m.id} type="button" className="recmain" onClick={() => setReviewing(m)}>
                  <span className="rechand">{m.heroHand}</span>
                  <span className="recmeta">{m.heroPos}・{m.playersLeft} left</span>
                  <span className={`recverd ${m.verdict === 'PUSH' ? 'push' : 'fold'}`}>{ACT_JA[m.verdict]}</span>
                  <span className="recact">
                    選択 {ACT_JA[m.action]}
                    <span className="recloss"> −{m.evLoss.toFixed(3)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <button type="button" className="btn wide" onClick={() => void begin()}>もう一度</button>
        <button type="button" className="btn ghost wide" onClick={props.onExit}>終了</button>
      </div>
    );
  }

  // ---- loading ----
  if (phase === 'loading' || !current) {
    return (
      <div className="panel solving">
        <div className="spinner" />
        <p>局面を生成中…</p>
        <p className="sub">端末内 Web Worker で求解しています。</p>
      </div>
    );
  }

  // ---- answering / revealed ----
  const answeredCount = attempts.length;
  const correctCount = attempts.reduce((a, x) => a + (x.correct ? 1 : 0), 0);
  const handNo = phase === 'answering' ? answeredCount + 1 : answeredCount;
  const acc = answeredCount ? Math.round((correctCount / answeredCount) * 100) : 0;
  const last = attempts[attempts.length - 1];
  const head = headlineNode(current.result);

  return (
    <div className="drill-wrap">
      <div className="drill-hud">
        <span className="dh-item"><span className="dh-lbl">HAND</span><b>{handNo}</b></span>
        <span className="dh-item"><span className="dh-lbl">CORRECT</span><b>{correctCount}/{answeredCount}</b></span>
        <span className="dh-item"><span className="dh-lbl">ACC</span><b>{acc}%</b></span>
      </div>

      <PokerTable state={current.state} heroHand={current.result.heroHand} />

      {phase === 'answering' && (
        <>
          <p className="drill-q">この局面、あなたの選択は？</p>
          <div className="btnrow drill-choice">
            <button type="button" className="btn ghost drill-fold" onClick={() => onAnswer('FOLD')}>FOLD</button>
            <button type="button" className="btn drill-push" onClick={() => onAnswer('PUSH')}>ALL IN</button>
          </div>
        </>
      )}

      {phase === 'revealed' && last && (
        <>
          <div className={`panel drill-reveal ${last.correct ? 'ok' : 'ng'}`}>
            <div className="dr-banner">
              <span className="dr-mark">
                {last.action === last.verdict ? '✓ 正解' : last.correct ? '≈ ほぼ最適' : '✕ 不正解'}
              </span>
              <span className="dr-detail">
                推奨 <b className={last.verdict === 'PUSH' ? 'push' : 'fold'}>{ACT_JA[last.verdict]}</b>
                <span className="dr-sep">·</span>
                選択 {ACT_JA[last.action]}
              </span>
            </div>
            <p className={`evloss-note ${last.evLoss > 0 ? 'loss' : 'ok'}`}>
              {last.evLoss > 0 ? `EV loss −${last.evLoss.toFixed(3)} pt` : 'EV loss 0（最適）'}
            </p>
            {head && (
              <>
                <div className="freqbar">
                  <div className="freqfill" style={{ width: `${Math.min(100, head.pct)}%` }} />
                  <span className="freqtxt">推奨レンジ {head.pct.toFixed(1)}%</span>
                </div>
                <RangeGrid hands={head.hands} heroHand={current.result.heroHand} />
              </>
            )}
          </div>
          <div className="btnrow">
            <button type="button" className="btn ghost" onClick={() => setPhase('summary')}>終わる</button>
            <button type="button" className="btn" onClick={() => void onNext()}>次のハンド</button>
          </div>
        </>
      )}
    </div>
  );
}
