import { formatBbDisplay } from '@oshihiki/core';
import { useState } from 'react';
import type { BoardState } from '@oshihiki/core';
import type { OcrReadout } from '@oshihiki/ocr';
import { ImageModal } from './ImageModal';
import { potRowView } from './confirmPot';
import { InfoMark, InfoModal } from './InfoModal';
import { GameModeSelect, type GameSel } from './GameModeSelect';

/**
 * 条件確認（3-1c・M3）。読み取った内容を項目別に読み上げ、各行の「修正」で手入力
 * モーダルを開く。OCR 低信頼フィールドは CHECK バッジで強調。ポット検算も表示。
 * 写真経由（imageUrl あり）のときは「元画像を確認」で原寸照合できる（readout があれば
 * SPEC §5.2.3 の元画像×OCR出力の照合表も一緒に出す）。
 */
export function Confirm(props: {
  state: BoardState;
  /** OCR 由来の低信頼フィールド（"UTG.stack" / "UTG.bet"）。強調表示する。 */
  lowConfidenceFields?: string[];
  /** OCR で読み取った元画像（objectURL）。あれば「元画像を確認」ボタンを出す。 */
  imageUrl?: string | null;
  /** OCR 出力（SPEC §5.2.3）。あれば「元画像を確認」モーダルに照合表を出す。 */
  readout?: OcrReadout;
  /** 元画像の寸法（照合表ヘッダの「画像サイズ」用）。 */
  imageSize?: { w: number; h: number };
  /** 手入力モーダルを開く（項目別「修正」・全体「修正」共通）。 */
  onEdit: () => void;
  /**
   * 検出人数を確認画面でその場修正する（安全網）。写真取り込みで席のスタックが読めないと
   * その席が空席扱いで抜け、人数が少なく出る。指定時のみ「検出人数」ブロックを出す。
   */
  onFixPlayers?: (n: number) => void;
  /** ゲーム選択（入力画面で選んだもの。ここでも計算直前に切り替えられる）。 */
  gameSel: GameSel;
  onGameModeChange: (next: GameSel) => void;
  /** 選んだモードの総チップと場のチップ総量が食い違う＝モード取り違えの疑い。 */
  modeMismatch?: boolean;
  /** 未読 1 席のスタックを、選んだゲームの総チップから復元した（値がゲーム選択に依存する）。 */
  stackRecovered?: boolean;
  /** スタックを読めないまま残った席。2 席以上は保存則でも埋められず仮値 0bb が入っている。 */
  unresolvedStacks?: string[];
  onSolve: () => void;
}): JSX.Element {
  const { state } = props;
  const [showImage, setShowImage] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const low = new Set(props.lowConfidenceFields ?? []);
  const hasLow = low.size > 0;
  const anteText = state.ante.scheme === 'none' ? 'なし' : `${state.ante.scheme} ${state.ante.amount}bb`;
  // ポット欄: ゲームと同じ丸め（小数第 2 位を四捨五入）で出し、スクショから読んだポットが
  // あればそれと照合する（オールイン等の上乗せ分も読み取り結果から足す・confirmPot.ts）。
  const pot = potRowView(state, props.readout);
  // 席スタックのいずれかが低信頼なら Players 行を CHECK 強調（モックの low 行に対応）。
  const stacksLow = state.seats.some((s) => low.has(`${s.pos}.stack`));
  // 写真取り込みのときは「検出人数」を大きく確認させ、その場で人数を直せるようにする（安全網）。
  const showPlayersCheck = !!props.onFixPlayers && !!props.imageUrl;

  const Edit = (): JSX.Element => (
    <button type="button" className="edit" onClick={props.onEdit}>
      修正
    </button>
  );

  return (
    <div className="panel confirm">
      <div className="confirm-head">
        <InfoMark label="この画面の説明" onClick={() => setShowInfo(true)} />
        {props.imageUrl && (
          <button type="button" className="btn line img-check" onClick={() => setShowImage(true)}>
            {props.readout ? '🖼 元画像とOCR結果' : '🖼 元画像を確認'}
          </button>
        )}
      </div>

      <GameModeSelect sel={props.gameSel} onChange={props.onGameModeChange} />

      {props.modeMismatch && (
        <p className="mode-warn">
          場のチップ総量が、選んだゲームの想定と食い違っています。ゲームの選択をご確認ください。
        </p>
      )}

      {(props.unresolvedStacks?.length ?? 0) > 0 && (
        <p className="mode-warn stack-warn">
          {props.unresolvedStacks!.join('・')} のスタックが読み取れませんでした（
          <b>0bb</b> を仮に置いています）。
          {props.unresolvedStacks!.length >= 2
            ? '2 席以上が読めないと合計からは割り出せません。'
            : ''}
          「修正」から正しい値を入れてください。
        </p>
      )}

      {props.stackRecovered && !props.modeMismatch && (
        <p className="mode-warn">
          読み取れなかった 1 席のスタックを、選んだゲームの総チップから割り出しました。ゲームの選択が違うとこの値がずれます。下の Stacks でご確認ください。
        </p>
      )}

      {showPlayersCheck && (
        <div className="players-check">
          <div className="pc-head">
            <span className="pc-label">検出人数</span>
            <span className="pc-count">{state.playersLeft}人</span>
          </div>
          <div className="seg pc-seg">
            {[2, 3, 4, 5, 6].map((n) => (
              <button
                key={n}
                type="button"
                className={`segbtn${state.playersLeft === n ? ' on' : ''}`}
                onClick={() => props.onFixPlayers!(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="readout">
        <div className="row">
          <span className="lb">Blinds</span>
          <span className="vl">
            {state.blinds.sb} / {state.blinds.bb}
            {state.ante.scheme !== 'none' && <>　ante {state.ante.amount}</>}
          </span>
          <Edit />
        </div>
        <div className="row">
          <span className="lb">Hand</span>
          <span className="vl">{state.heroHand}</span>
          <Edit />
        </div>
        <div className="row">
          <span className="lb">Hero</span>
          <span className="vl">{state.heroPos}</span>
          <Edit />
        </div>
        {!showPlayersCheck && (
          <div className={`row${stacksLow ? ' low' : ''}`}>
            <span className="lb">Players</span>
            <span className="vl">{state.playersLeft}</span>
            <Edit />
          </div>
        )}
        <div className="row">
          <span className="lb">Pot</span>
          <span className={`vl ${pot.ok ? 'ok' : 'warn'}`}>{pot.text}</span>
          <Edit />
        </div>
      </div>

      <h2 className="scr-h sm" style={{ marginTop: 'var(--s4)' }}>
        Stacks
      </h2>
      <div className="seats-ro">
        {state.seats.map((s) => (
          <div key={s.pos} className={`seatrow-ro${s.pos === state.heroPos ? ' hero' : ''}`}>
            <span className={`posbadge sm pos-${s.pos}`}>{s.pos}</span>
            <span className={`stk${low.has(`${s.pos}.stack`) ? ' lowconf' : ''}`}>{formatBbDisplay(s.stack)}bb</span>
            {s.bet > 0 && (
              <span className={`betchip${low.has(`${s.pos}.bet`) ? ' lowconf' : ''}`}>bet {formatBbDisplay(s.bet)}</span>
            )}
            {s.pos === state.heroPos && <span className="herotag">hero</span>}
          </div>
        ))}
      </div>

      <div className="btnrow">
        <button type="button" className="btn ghost" onClick={props.onEdit}>
          修正
        </button>
        <button type="button" className="btn" onClick={props.onSolve}>
          この内容で計算する
        </button>
      </div>

      {showImage && props.imageUrl && (
        <ImageModal
          src={props.imageUrl}
          readout={props.readout}
          imageSize={props.imageSize}
          onClose={() => setShowImage(false)}
        />
      )}

      {showInfo && (
        <InfoModal title="この画面について" onClose={() => setShowInfo(false)}>
          {showPlayersCheck && (
            <>
              <h3>検出人数について</h3>
              <p>
                フォールドした席のスタックが読み取れないと、その席が抜けて人数が少なく出ることがあります。テーブルの実際の人数と合っているかご確認ください。違う人数を選ぶと席を補います（補った席のスタックは下の Stacks でご確認ください）。
              </p>
            </>
          )}
          {hasLow && (
            <>
              <h3>CHECK の付いた項目</h3>
              <p>自動読取の信頼度が低めです。値をご確認ください。</p>
            </>
          )}
          <h3>ゲームの選択</h3>
          <p>
            ゲームによって順位ごとのポイントと開始スタックが違うため、どのゲームの局面かで計算結果が変わります。スクリーンショットからはゲームを判別できないので、必ずご自身で選んでください。
          </p>
          <p>
            <b>ランクマッチ</b>は STAGE ごとに開始スタックも順位ごとのポイントも違うので、打った STAGE を選んでください。
          </p>
          <p>
            <b>レジェンドマッチ</b>は1試合で「シーズンレート」と「ベースレート」の2つが同時に動き、順位ごとのポイントが異なります。<b>平均</b>は両方をならしたもの（迷ったらこれで構いません）、<b>シーズン</b>は降格に関わる月ごとのポイント、<b>ベース</b>は持ち越される恒久のポイントで計算します。
          </p>
          {props.stackRecovered && (
            <>
              <h3>割り出したスタックについて</h3>
              <p>
                1 席だけスタックが読み取れなかったので、テーブル全体のチップは一定であることを使って残りから逆算しました。この計算は選んだゲームの開始スタックを前提にしているため、<b>ゲームの選択が違うとこの席の値だけ大きくずれます</b>。値が実際と違う場合は「修正」から直してください。
              </p>
            </>
          )}
          {(props.unresolvedStacks?.length ?? 0) > 0 && (
            <>
              <h3>読み取れなかったスタック</h3>
              <p>
                スタックが 1 席だけ読めなかったときは、テーブル全体のチップが一定であることを使って残りから割り出せます。ところが<b>2 席以上が読めないと、その 2 つの組み合わせが無数にある</b>ため割り出せません。そのままでは計算できないので、「修正」から実際の値を入れてください。
              </p>
            </>
          )}
          <h3>修正のしかた</h3>
          <p>違っていたら「修正」から直せます。直した内容がそのまま計算に使われます。</p>
        </InfoModal>
      )}
    </div>
  );
}
