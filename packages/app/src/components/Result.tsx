import { formatBbDisplay } from '@oshihiki/core';
import { useState } from 'react';
import type { BoardState } from '@oshihiki/core';
import { gameModeLabel } from '@oshihiki/core';
import type { GameMode } from '@oshihiki/core';
import type { SolveResultDto } from '../solverProtocol';
import { ActionTree } from './ActionTree';
import { evLossOf, headlineNode, verdictOf, type HeroAction } from '../records/model';

/**
 * pt の単位ラベル。求解はモードの実払い pt で行うが、表示は toDto でクラブ尺度に換算している
 * （記録一覧で横比較するため）。クラブ以外で「実払い」と書くと誤りなので換算であることを明示する。
 */
function ptUnit(mode: GameMode | undefined): string {
  return (mode ?? 'club') === 'club' ? '実払い pt' : 'クラブ換算 pt';
}
const ACTION_JA: Record<string, string> = { PU: '先手プッシュ (PU)', CA: 'コール (CA)', OC: 'オーバーコール (OC)' };

type Ack = { ok: boolean; message?: string };

/**
 * EV の符号で色分け（CP2077 配色: 黄=+EV / 赤=−EV）。判定と一致し、モックの
 * evbox（push→黄 / fold→赤）に沿う。赤は「損失」だけに使う原則を保つ。
 */
function evClass(ev: number): 'pos' | 'neg' {
  return ev >= 0 ? 'pos' : 'neg';
}

/**
 * 結果画面（SPEC §5.3, v3 で挙動変更）。
 *
 * v3: 記録は計算開始時点で既に自動保存されているため、この画面に「記録する」ボタンや
 * 保存フェーズ UI は無い。ここにあるのは
 *   1. 自分の選択（ALL IN / FOLD / 未選択の3択・押した時点で `onSelectAction` を呼び即保存）
 *   2. 公開レバー（「ホームで公開する」1本・ON でコメント欄→公開実行、OFF で公開取消）
 * の2つだけ。`record` を渡したとき（記録タブ経由の自分の記録）だけこの2つを編集可能にし、
 * `readOnly`（スレッド由来＝他人の公開結果や参照専用表示）のときは記録済みの値を静的に表示する。
 */
export function Result(props: {
  state: BoardState;
  result: SolveResultDto;
  onBack: () => void;
  ms: number;
  /** 戻るボタンの文言（未指定なら readOnly=記録一覧 / 通常=別のスポット）。 */
  backLabel?: string;

  /** 読み取り専用（スレッド由来）。選択・公開の編集 UI を出さない。 */
  readOnly?: boolean;
  /** readOnly 時に表示する、記録済みの実行動・EV loss・公開状態。 */
  savedAction?: HeroAction | null;
  savedEvLoss?: number | null;
  savedPublished?: boolean;

  /**
   * 記録タブ経由で開いた自分の記録（編集可能, SPEC §5.3/§5.4）。渡されたときだけ
   * 「自分の選択」「公開レバー」を操作できるようにする。
   */
  record?: { heroAction: HeroAction | null; published: boolean };
  /**
   * 設定の「計算したら最初から公開する」（profiles.default_public）。true なら公開レバーを
   * 最初からオンにしてコメント欄を開く（SPEC §5.3）。オンにするだけで公開はされず、
   * 「この内容で公開する」を押すまで外には出ない。
   */
  defaultPublish?: boolean;
  /** 自分の選択を保存（`setHeroAction` のサーバ配線＋ローカル反映は呼び出し側の責務）。 */
  onSelectAction?: (action: HeroAction | null) => Promise<Ack>;
  /**
   * 公開レバーの実行。on=true で公開（`comment` を一言として使う）、on=false で公開取消。
   * 呼び出し側（App.tsx）が `publishRecord`/`unpublishRecord` を配線する。
   */
  onTogglePublish?: (on: boolean, comment: string) => Promise<Ack>;
}): JSX.Element {
  const { result, state } = props;
  const headline = headlineNode(result);
  const heroSeat = state.seats.find((s) => s.pos === result.heroPos);

  // 公開レバー（onTogglePublish）は任意。無ければ「自分の選択」だけ出す（ローカル版）。
  const editable = !props.readOnly && !!props.record && !!props.onSelectAction;

  // ---- 自分の選択（3択: ALL IN / FOLD / 未選択） ----
  const [action, setAction] = useState<HeroAction | null>(props.record?.heroAction ?? null);
  const [actionPhase, setActionPhase] = useState<'idle' | 'saving' | 'error'>('idle');
  const [actionErr, setActionErr] = useState('');
  const evLoss = action != null ? (headline ? evLossOf(headline.heroEv, action) : (props.savedEvLoss ?? null)) : null;

  async function selectAction(a: HeroAction | null): Promise<void> {
    if (!props.onSelectAction || actionPhase === 'saving' || a === action) return;
    const prev = action;
    setAction(a);
    setActionPhase('saving');
    setActionErr('');
    const res = await props.onSelectAction(a);
    if (res.ok) {
      setActionPhase('idle');
    } else {
      setAction(prev);
      setActionErr(res.message ?? '選択の保存に失敗しました');
      setActionPhase('error');
    }
  }

  // ---- 公開レバー ----
  const [published, setPublished] = useState(props.record?.published ?? false);
  // まだ公開していない状態で ON にした直後（コメント欄が開いている＝公開の意思表示のみ、
  // 実際の公開実行は別ボタン）。
  const [pubOpen, setPubOpen] = useState(props.record?.published ?? props.defaultPublish ?? false);
  const [comment, setComment] = useState('');
  const [pubPhase, setPubPhase] = useState<'idle' | 'working' | 'error'>('idle');
  const [pubErr, setPubErr] = useState('');

  function onSwitchClick(): void {
    if (!props.onTogglePublish || pubPhase === 'working') return;
    if (published) {
      void doUnpublish();
      return;
    }
    // 未公開: トグルはコメント欄の開閉のみ（ここではまだサーバへ書かない）。
    setPubOpen((v) => !v);
  }

  async function doPublish(): Promise<void> {
    if (!props.onTogglePublish) return;
    setPubPhase('working');
    setPubErr('');
    const res = await props.onTogglePublish(true, comment);
    if (res.ok) {
      setPublished(true);
      setPubPhase('idle');
    } else {
      setPubErr(res.message ?? '公開に失敗しました');
      setPubPhase('error');
    }
  }

  async function doUnpublish(): Promise<void> {
    if (!props.onTogglePublish) return;
    setPubPhase('working');
    setPubErr('');
    const res = await props.onTogglePublish(false, '');
    if (res.ok) {
      setPublished(false);
      setPubOpen(false);
      setComment('');
      setPubPhase('idle');
    } else {
      setPubErr(res.message ?? '公開の取り消しに失敗しました');
      setPubPhase('error');
    }
  }

  return (
    <div className="result-wrap">
      {headline ? (
        <div className={`panel vhero ${verdictOf(headline) === 'PUSH' ? '' : 'fold'}`}>
          <div className={`verdict ${verdictOf(headline) === 'PUSH' ? 'push' : 'fold'}`}>{verdictOf(headline)}</div>
          <div className="vmeta">
            <b className="vhand">{result.heroHand}</b>
            <span>
              {result.heroPos}・{heroSeat ? `${formatBbDisplay(heroSeat.stack)}bb` : ''}・{result.playersLeft} left
            </span>
            <span className="vaction">
              {ACTION_JA[headline.actionType] ?? headline.actionType}・レンジ {headline.pct.toFixed(1)}%
            </span>
            {/* どのゲームのプライズで解いた結果かを必ず出す（pt は表示上クラブ尺度にそろえて
                いるので、モードが分からないと数字の意味を取り違える）。 */}
            <span className="modetag">{gameModeLabel(state.gameMode)}</span>
          </div>
          <div className="evbox">
            <span className="evlabel">EV（フォールド比, {ptUnit(state.gameMode)}）</span>
            <b className={`evval ${evClass(headline.heroEv)}`}>
              {headline.heroEv >= 0 ? '+' : ''}
              {headline.heroEv.toFixed(3)}
            </b>
          </div>
        </div>
      ) : (
        <div className="panel">hero の決定ノードがありません（BB のウォーク等）。下の Action tree を参照。</div>
      )}

      <div className="panel">
        <h2 className="scr-h">Action tree</h2>
        <ActionTree result={result} stacks={Object.fromEntries(state.seats.map((s) => [s.pos, s.stack]))} />
      </div>

      {/* ---- この局面での自分の選択（任意・押した時点で保存, SPEC §5.3） ---- */}
      {editable && (
        <div className="panel saverec">
          <div className="scr-h sm">この局面での自分の選択</div>
          <div className="seg actsel">
            {(
              [
                { v: 'PUSH' as HeroAction, label: 'ALL IN' },
                { v: 'FOLD' as HeroAction, label: 'FOLD' },
                { v: null, label: '未選択' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.label}
                type="button"
                className={`segbtn ${action === opt.v ? 'on' : ''}`}
                onClick={() => void selectAction(opt.v)}
                disabled={actionPhase === 'saving'}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {evLoss !== null && (
            <p className={`evloss-note ${evLoss > 0 ? 'loss' : 'ok'}`}>
              {evLoss > 0
                ? `EV loss −${evLoss.toFixed(3)} pt（最適は ${headline && verdictOf(headline) === 'PUSH' ? 'ALL IN' : 'FOLD'}）`
                : 'EV loss 0（最適な選択）'}
            </p>
          )}
          {actionPhase === 'error' && <p className="auth-err">{actionErr}</p>}

          {props.onTogglePublish && (
            <>
          <div className="tog">
            <div>
              ホームで公開する
              <small>クラブのみんなが見られ、スレッドで話せます</small>
            </div>
            <button
              type="button"
              className="sw"
              role="switch"
              aria-checked={published || pubOpen}
              aria-label="ホームで公開する"
              onClick={onSwitchClick}
              disabled={pubPhase === 'working'}
            />
          </div>
          {published && <p className="evloss-note ok">公開中です。オフにすると公開を取り消します。</p>}
          {!published && pubOpen && (
            <div className="pub-confirm">
              <textarea
                className="pub-comment"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="一言そえる（例: 3人残りだと思ったより広く押していい）"
                maxLength={2000}
                rows={2}
                disabled={pubPhase === 'working'}
              />
              <button
                type="button"
                className="btn wide"
                onClick={() => void doPublish()}
                disabled={pubPhase === 'working'}
              >
                {pubPhase === 'working' ? '公開中…' : 'この内容で公開する'}
              </button>
            </div>
          )}
          {pubPhase === 'error' && <p className="auth-err">{pubErr}</p>}
            </>
          )}
        </div>
      )}

      {/* ---- 読み取り専用（スレッド由来・記録済み情報の静的表示） ---- */}
      {props.readOnly && props.savedAction !== undefined && (
        <div className="panel saverec">
          <div className="scr-h sm">記録した選択</div>
          <div className="row">
            <span>自分の選択</span>
            <b>{props.savedAction ? (props.savedAction === 'PUSH' ? 'ALL IN' : 'FOLD') : '未選択'}</b>
          </div>
          {props.savedAction && (
            <div className="row">
              <span>EV loss（pt）</span>
              <b className={props.savedEvLoss && props.savedEvLoss > 0 ? 'warn' : 'ok'}>
                {(props.savedEvLoss ?? 0) > 0 ? `−${(props.savedEvLoss ?? 0).toFixed(3)}` : '0'}
              </b>
            </div>
          )}
          <div className="row">
            <span>公開状態</span>
            <b>
              <span className={`tag${props.savedPublished ? ' pub' : ''}`}>
                {props.savedPublished ? '公開中' : '非公開'}
              </span>
            </b>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="scr-h sm">ICM equity（{ptUnit(state.gameMode)}）</div>
        <table className="eqt">
          <thead>
            <tr><th>pos</th><th>EQPre</th><th>EQPost</th><th>EQDiff</th></tr>
          </thead>
          <tbody>
            {Object.entries(result.equity).map(([pos, e]) => (
              <tr key={pos} className={pos === result.heroPos ? 'herorow' : ''}>
                <td>{pos}</td>
                <td>{e.pre.toFixed(3)}</td>
                <td>{e.post.toFixed(3)}</td>
                <td>{(e.post - e.pre).toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel quality">
        <div className="row"><span>求解時間</span><b>{(props.ms / 1000).toFixed(2)} s</b></div>
        <div className="row"><span>iterations</span><b>{result.iterations}</b></div>
        <div className="row"><span>exploitability</span><b>{result.exploitabilityPt.toFixed(4)} pt</b></div>
        {!result.converged && (
          <p className="convnote">
            ⚠ 収束不十分（exploitability がしきい値超）。境界ハンドの押し引きは目安として扱ってください。
          </p>
        )}
      </div>

      <button type="button" className="btn ghost wide" onClick={props.onBack}>
        {props.backLabel ?? (props.readOnly ? 'スレッドに戻る' : '記録一覧に戻る')}
      </button>
    </div>
  );
}
