/**
 * SIT & GO の部屋（待機 → 卓 → 結果を 1 画面で切替）。docs/SNG_DESIGN.md §5（A3a 所有）。
 *
 * 通信は `sng/useTable.ts`（`TableClient` を React に包んだもの）。合法手の判定は
 * `@oshihiki/sng` の `engine.legalActions`（サーバーと同じ純関数）。ベットサイズの
 * プリセット計算は `sng/betting.ts`（`slumbot/sizes.ts` の一般化コアを共用）。
 *
 * 端末の戻る対策: 進行中（running/paused）に端末の戻る/Esc を押すと、まず退室確認を出す
 * （history.pushState は自分では触らない。App.tsx が「画面の深さ＋重なりの数」で履歴を
 * 一括管理しているので、重なりの登録簿 `backLayers`/`useBackLayer` に相乗りするだけでよい。
 * これなら navHistory.ts の深さ計算と衝突しない）。もう一度戻る/Esc を押すと確認を閉じる。
 */

import { useEffect, useRef, useState } from 'react';

import { formatBbDisplay, gameModeSpec } from '@oshihiki/core';
import { BETWEEN_HANDS_MS, engine, type ActionKind, type PublicTable, type SngConfig, type Speed } from '@oshihiki/sng';

import { useBackLayer } from './BackLayer';
import { SngTable } from './SngTable';
import { allInBetTo, categoryOf, clampBetTo, resolvePreset, snapBetTo, stepBetTo } from '../sng/betting';
import { useTable } from '../sng/useTable';
import { createStartLatch } from '../solveJob';
import {
  loadBetSizes,
  presetKey,
  presetLabel,
  presetsFor,
  type BetSizeConfig,
} from '../slumbot/sizes';

// SngLobby.tsx の SPEED_LABEL と同じ表記（待機画面の条件表示にも使う・小さいので複製）。
const SPEED_LABEL: Record<Speed, string> = { normal: '通常', slow: 'ゆっくり', veryslow: 'もっとゆっくり' };

/** 待機画面の条件行（例: 「2人 ・ 75bb ・ 通常 ・ 3分 ・ クラブ」）。 */
function roomConditionLine(config: SngConfig): string {
  const spec = gameModeSpec(config.mode);
  const modeLabel = spec.variant ? `${spec.game}${spec.variant}` : spec.game;
  return `${config.players}人 ・ ${config.startBb}bb ・ ${SPEED_LABEL[config.speed]} ・ ${config.levelMin}分 ・ ${modeLabel}`;
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function remainingStackOf(table: PublicTable, seat: number): number {
  const player = table.players[seat];
  const commit = table.hand?.commits[seat] ?? 0;
  return Math.max(0, (player?.stack ?? 0) - commit);
}

export function SngRoom(props: {
  roomId: string;
  onExit: () => void;
  onSwitchRoom: (roomId: string) => void;
  /** App.tsx のヘッダ「‹」用ガード登録。running/paused の間だけ渡し、抜けたら null で解除する。 */
  registerLeaveGuard: (guard: (() => void) | null) => void;
}): JSX.Element {
  const { table, you, error, closed, connected, send, serverNow } = useTable(props.roomId);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // 最終ハンド（誰かが飛んで試合が終わる）は、通常のハンド間と同じ BETWEEN_HANDS_MS だけ
  // ショーダウンの卓（公開手札・結果の帯）を見せてから結果画面へ切り替える。false の間は
  // 結果画面ではなく卓をそのまま描画する。
  const [finishRevealed, setFinishRevealed] = useState(false);
  const storeRef = useRef<Storage | null>(null);
  if (storeRef.current === null) storeRef.current = safeStorage();
  const [config] = useState<BetSizeConfig>(() => loadBetSizes(storeRef.current));

  const hand = table?.hand ?? null;
  const mySeat = you?.seat ?? null;
  const inGame = table?.status === 'running' || table?.status === 'paused';

  // 進行中の端末の戻る/Esc: 1回目で確認、2回目（確認を開いている間）でキャンセル。
  useBackLayer(() => setConfirmLeave(true), inGame && !confirmLeave);
  useBackLayer(() => setConfirmLeave(false), confirmLeave);

  // ヘッダの ‹（App.tsx の backFor）は backLayers を経由しないので、進行中だけ別途ガードを
  // 登録する。これが無いと端末の戻る/Esc では確認が出るのにヘッダの ‹ だけ素通りしてしまう
  // （さつき実機確認済みの罠）。待機中・終了後は null にして即座にロビーへ戻れるようにする。
  useEffect(() => {
    props.registerLeaveGuard(inGame ? () => setConfirmLeave(true) : null);
    return () => props.registerLeaveGuard(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inGame]);

  // finished（誰かが飛んで試合が終わった）になった瞬間: サーバーは game_over と同時に
  // `{t:'closed', reason:'finished'}` を送って WS を閉じるため、素通しだと最後のハンドだけ
  // ショーダウン（相手の手札・ボード・結果の帯）が一切見えないまま結果画面に飛ぶ
  // （さつき実機確認済みの罠）。settleHand は status:'finished' になっても hand をそのまま
  // 残す（table.ts のfinalizeProgression）ので、最後のスナップショットの hand.phase は
  // 'settled' のまま。closed で WS が閉じても useTable の table は保持されるので、
  // 再接続は試みずそのスナップショットを描画に使い続ける。cancelled は今までどおり即座。
  useEffect(() => {
    if (table?.status !== 'finished') {
      setFinishRevealed(false);
      return;
    }
    if (table.hand?.phase !== 'settled') {
      // ショーダウンに乗らずに終わった（本来は無いはずだが安全側）: 即座に結果へ。
      setFinishRevealed(true);
      return;
    }
    setFinishRevealed(false);
    const id = setTimeout(() => setFinishRevealed(true), BETWEEN_HANDS_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table?.status, table?.hand?.handNo]);

  // 手番の残り秒数の表示を1秒ごとに更新する。
  useEffect(() => {
    if (hand?.deadline == null) return;
    setNow(serverNow());
    const id = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(id);
  }, [hand?.deadline, serverNow]);

  const latch = useRef(createStartLatch());
  const [betTo, setBetTo] = useState(0);
  const [pick, setPick] = useState<string | null>(null);

  const myTurn = hand != null && mySeat != null && hand.toAct === mySeat;
  const legal = table && hand && mySeat != null ? engine.legalActions(hand, mySeat, remainingStackOf(table, mySeat)) : null;

  // 自分の手番になったら（新しい handNo/actSeq）、送信ラッチを作り直し、プリセットの初期値を選ぶ。
  useEffect(() => {
    latch.current = createStartLatch();
    if (!table || !hand || mySeat == null || !myTurn) return;
    const stack = remainingStackOf(table, mySeat);
    const l = engine.legalActions(hand, mySeat, stack);
    if (l.betTo) {
      const cat = categoryOf(hand, mySeat, stack);
      const list = presetsFor(config, cat);
      const first = list[0];
      setBetTo(first ? resolvePreset(first, hand, mySeat, stack) : l.betTo.min);
      setPick(first ? presetKey(first) : null);
    } else {
      setBetTo(0);
      setPick(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hand?.handNo, hand?.actSeq, mySeat]);

  function act(kind: ActionKind, betToVal?: number): void {
    if (!hand || mySeat == null) return;
    if (!latch.current.acquire()) return; // 1手番1回（サーバーも actSeq のズレで冗長送信を弾く）。
    send({ t: 'act', handNo: hand.handNo, actSeq: hand.actSeq, kind, betTo: betToVal });
  }

  function leaveNow(): void {
    send({ t: 'leave' });
    props.onExit();
  }

  // ---- エラー ----
  if (error?.code === 'already_seated' && error.roomId) {
    return (
      <div className="sg-wrap">
        <div className="panel err-view">
          <ul className="issues">
            <li>別の部屋に参加中です。</li>
          </ul>
        </div>
        <button type="button" className="btn wide" onClick={() => props.onSwitchRoom(error.roomId!)}>
          その部屋へ移動
        </button>
        <button type="button" className="btn ghost wide" onClick={props.onExit}>
          ロビーへ
        </button>
      </div>
    );
  }
  if (error && !table) {
    return (
      <div className="sg-wrap">
        <div className="panel err-view">
          <ul className="issues">
            <li>{error.message ?? 'この部屋には入れませんでした。'}</li>
          </ul>
        </div>
        <button type="button" className="btn ghost wide" onClick={props.onExit}>
          ロビーへ
        </button>
      </div>
    );
  }

  if (!table || !you) {
    return (
      <div className="sg-wrap">
        <div className="sg-loading">
          <div className="spinner" />
          <p>部屋に接続しています…</p>
        </div>
      </div>
    );
  }

  // ---- 終了（finished / cancelled） ----
  // finished は finishRevealed になるまで（＝BETWEEN_HANDS_MS の間）ここを通さず、下の卓の
  // 描画へ素通しする。cancelled はショーダウンが無いので今までどおり即座。
  const isCancelled = table.status === 'cancelled' || closed === 'cancelled';
  const isFinished = table.status === 'finished' || closed === 'finished';
  if (isCancelled || (isFinished && finishRevealed)) {
    const sorted = [...table.players].sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
    return (
      <div className="sg-wrap">
        <div className="panel sg-result-panel">
          <div className="scr-h sm">{isCancelled ? '中止' : '結果'}</div>
          <ul className="sg-standings">
            {sorted.map((p) => (
              <li key={p.userId} className={p.userId === you.userId ? 'me' : ''}>
                <span className="sg-place">{p.place ? `${p.place}位` : '-'}</span>
                <span className="sg-pname">{p.name}</span>
                <span className={`sg-pt ${(p.pt ?? 0) < 0 ? 'neg' : ''}`}>
                  {p.pt != null ? `${p.pt > 0 ? '+' : ''}${p.pt}pt` : '-'}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <button type="button" className="btn wide" onClick={props.onExit}>
          ロビーへ
        </button>
      </div>
    );
  }

  // ---- 待機中 ----
  if (table.status === 'waiting') {
    return (
      <div className="sg-wrap">
        <div className="panel">
          <div className="scr-h sm">待機中（{table.players.length}/{table.config.players}）</div>
          <p className="sg-room-cond">{roomConditionLine(table.config)}</p>
          <ul className="sg-standings">
            {table.players.map((p) => (
              <li key={p.userId} className={p.userId === you.userId ? 'me' : ''}>
                <span className="sg-pname">{p.name}</span>
                {!p.connected && <span className="sg-tag warn">切断中</span>}
              </li>
            ))}
          </ul>
          <p className="ocr-hint">{table.config.players}人揃うと自動で開始します。</p>
        </div>
        <button type="button" className="btn ghost wide" onClick={leaveNow}>
          退室する
        </button>
      </div>
    );
  }

  // ---- 進行中（running / paused）／最終ハンドの結果表示中（finished・reveal 待ち） ----
  const heroCards = you.hole;
  const canAct = myTurn && table.status === 'running';
  const stack = mySeat != null ? remainingStackOf(table, mySeat) : 0;
  const presets = legal?.betTo && hand && mySeat != null ? presetsFor(config, categoryOf(hand, mySeat, stack)) : [];
  // finished（reveal 待ち）の間は手番も SIT OUT 復帰も無い（ハンドは終わっている）。
  const showActionArea = table.status === 'running' || table.status === 'paused';
  const mySitout = showActionArea && mySeat != null ? table.players[mySeat]?.status === 'sitout' : false;

  return (
    <div className="sg-wrap">
      {!connected && showActionArea && <p className="sg-connwarn">サーバーとの接続が不安定です…</p>}
      {table.status === 'paused' && <p className="sg-connwarn">一時停止中（誰かの復帰を待っています）</p>}

      <SngTable table={table} you={you} heroCards={heroCards} now={now} />

      {showActionArea && (mySitout ? (
        <button type="button" className="btn wide" onClick={() => send({ t: 'sitin' })}>
          SIT IN（復帰する）
        </button>
      ) : (
        <>
          {legal?.betTo && hand && mySeat != null && (
            <div className="sg-sizer">
              <div className="sg-presets">
                {presets.map((p) => {
                  const l = presetLabel(p);
                  const key = presetKey(p);
                  const value = resolvePreset(p, hand, mySeat, stack);
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`sg-preset${pick === key ? ' on' : ''}`}
                      disabled={!canAct}
                      onClick={() => {
                        setBetTo(value);
                        setPick(key);
                      }}
                    >
                      <span className="sg-preset-v">{l.value}</span>
                      <span className="sg-preset-u">{l.unit}</span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  className={`sg-preset max${pick === 'max' ? ' on' : ''}`}
                  disabled={!canAct}
                  onClick={() => {
                    setBetTo(allInBetTo(hand, mySeat, stack));
                    setPick('max');
                  }}
                >
                  <span className="sg-preset-v">Max</span>
                </button>
              </div>

              <div className="sg-slide">
                <input
                  type="range"
                  className="sg-range"
                  min={legal.betTo.min}
                  max={legal.betTo.max}
                  step={Math.max(1, Math.round(config.handleUnit * hand.bb))}
                  value={Math.min(legal.betTo.max, Math.max(legal.betTo.min, betTo))}
                  disabled={!canAct}
                  onChange={(e) => {
                    setBetTo(snapBetTo(Number(e.target.value), hand, mySeat, stack, config.handleUnit));
                    setPick(null);
                  }}
                />
                <div className="sg-stepper">
                  <button
                    type="button"
                    className="sg-step"
                    aria-label="減らす"
                    disabled={!canAct || betTo <= legal.betTo.min}
                    onClick={() => {
                      setBetTo(stepBetTo(betTo, hand, mySeat, stack, config.handleUnit, -1));
                      setPick(null);
                    }}
                  >
                    −
                  </button>
                  <span className="sg-amount">{formatBbDisplay(betTo / hand.bb)}bb</span>
                  <button
                    type="button"
                    className="sg-step"
                    aria-label="増やす"
                    disabled={!canAct || betTo >= legal.betTo.max}
                    onClick={() => {
                      setBetTo(stepBetTo(betTo, hand, mySeat, stack, config.handleUnit, 1));
                      setPick(null);
                    }}
                  >
                    ＋
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="sg-actions">
            {legal?.canFold && (
              <button type="button" className="sg-act fold" disabled={!canAct} onClick={() => act('fold')}>
                FOLD
              </button>
            )}
            {legal?.canCheck && (
              <button type="button" className="sg-act check" disabled={!canAct} onClick={() => act('check')}>
                CHECK
              </button>
            )}
            {legal?.callPut != null && (
              <button type="button" className="sg-act call" disabled={!canAct} onClick={() => act('call')}>
                CALL
                <span className="sg-act-sub">{formatBbDisplay(legal.callPut / (hand?.bb ?? 200))}bb</span>
              </button>
            )}
            {legal?.betTo && hand && mySeat != null && (
              <button
                type="button"
                className="sg-act raise"
                disabled={!canAct}
                onClick={() => act(legal.aggression === 'raise' ? 'raise' : 'bet', clampBetTo(betTo, hand, mySeat, stack))}
              >
                {legal.aggression === 'raise' ? 'RAISE' : 'BET'}
                <span className="sg-act-sub">{formatBbDisplay(clampBetTo(betTo, hand, mySeat, stack) / hand.bb)}bb</span>
              </button>
            )}
          </div>
        </>
      ))}

      {confirmLeave && (
        <div className="sg-confirm-backdrop">
          <div className="panel sg-confirm">
            <p>試合の途中です。退室しますか？（SIT OUT 扱いになり、手番が来ると自動で処理されます）</p>
            <div className="btnrow">
              <button type="button" className="btn ghost" onClick={() => setConfirmLeave(false)}>
                続ける
              </button>
              <button type="button" className="btn" onClick={leaveNow}>
                退室する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
