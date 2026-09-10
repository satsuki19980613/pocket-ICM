/**
 * Training ▸ Slumbot HU（ヘッズアップ対戦）画面。
 *
 * 進行は「自分の手番 → アクション送信 → Slumbot の応答 → …」の繰り返し。
 * 合法手の判定は端末側（slumbot/rules.ts）で完結させ、API には必ず通る手だけを送る。
 * ハンドが終わるたびに収支をサーバへ加算する（圏外なら端末に溜めて次回まとめて送る）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { HandResult, SlumbotTable } from './SlumbotTable';
import { SlumbotSettings } from './SlumbotSettings';
import { act, newHand, type SlumbotResponse } from '../slumbot/api';
import { describeLastAction, toView, type HandView, type LastAction } from '../slumbot/hand';
import { STREET_LABEL, bbLabel, signedBbLabel } from '../slumbot/rules';
import {
  categoryOf,
  clampBetTo,
  loadBetSizes,
  presetKey,
  presetLabel,
  presetsFor,
  resolvePreset,
  saveBetSizes,
  snapBetTo,
  stepBetTo,
  type BetSizeConfig,
} from '../slumbot/sizes';
import { loadPrefs, loadToken, savePrefs, saveToken, type GamePrefs } from '../slumbot/prefs';
import { createStartLatch } from '../solveJob';
import { addPending, flushPending, readPending, writePending } from '../supabase/huStats';

type Phase = 'starting' | 'acting' | 'sending' | 'over' | 'error';

/** localStorage は環境によっては参照自体が例外になる（プライベートブラウズ等）。 */
function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function SlumbotView(props: { onExit: () => void }): JSX.Element {
  const storeRef = useRef<Storage | null>(null);
  if (storeRef.current === null) storeRef.current = safeStorage();
  const store = storeRef.current;

  const tokenRef = useRef<string | null>(null);
  const mounted = useRef(true);
  /**
   * 送信中を示す**同期**ラッチ（連打対策）。`phase` は state なので、同じティックで
   * 2 回タップされると 2 回目も `canAct` を true と見てしまい、同じアクションが
   * 二重に飛んで Slumbot に "Unexpected action" で弾かれる（実際にモンキーテストで再現）。
   * state を介さないフラグで入口を塞ぐ。解除漏れ＝永久に打てなくなるので必ず finally で戻す。
   */
  const inflight = useRef(createStartLatch());
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [config, setConfig] = useState<BetSizeConfig>(() => loadBetSizes(store));
  const [prefs, setPrefs] = useState<GamePrefs>(() => loadPrefs(store));
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const [phase, setPhase] = useState<Phase>('starting');
  const [view, setView] = useState<HandView | null>(null);
  const [last, setLast] = useState<LastAction | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [betTo, setBetTo] = useState(0);
  /** どのプリセットを選んでいるか（'2-bb' / 'max' / null＝スライダーで直接指定）。
      額が同じになるプリセット（例: ポットが小さいときの 10% と 25%）を取り違えないよう、
      額ではなくキーで持つ。 */
  const [pick, setPick] = useState<string | null>(null);
  /** 相手のアクションを読む時間。false の間は誤タップ防止でボタンを止める。 */
  const [armed, setArmed] = useState(true);
  const [session, setSession] = useState({ hands: 0, netChips: 0 });
  const [settingsOpen, setSettingsOpen] = useState(false);

  const updateConfig = useCallback(
    (next: BetSizeConfig) => {
      setConfig(next);
      saveBetSizes(store, next);
    },
    [store],
  );
  const updatePrefs = useCallback(
    (next: GamePrefs) => {
      setPrefs(next);
      savePrefs(store, next);
    },
    [store],
  );

  /** ハンド終了時: セッション表示を進め、収支をサーバへ加算する。 */
  const recordHand = useCallback(
    (winnings: number) => {
      setSession((s) => ({ hands: s.hands + 1, netChips: s.netChips + winnings }));
      writePending(store, addPending(readPending(store), winnings));
      void flushPending(store);
    },
    [store],
  );

  // apply と begin は互いを呼ぶので、実体は ref 経由で参照する（宣言順に縛られないため）。
  const beginRef = useRef<() => void>(() => {});

  /** レスポンスを画面へ反映する。ここだけが phase を進める。 */
  const apply = useCallback(
    (data: SlumbotResponse) => {
      const r = toView(data);
      if (!r.ok) {
        setErrMsg(`局面を読み取れませんでした（${r.error}）`);
        setPhase('error');
        return;
      }
      const v = r.view;
      const la = describeLastAction(data.action ?? '');
      setView(v);
      setLast(la);
      setErrMsg(null);

      if (v.over) {
        recordHand(v.winnings ?? 0);
        setPhase('over');
        if (prefsRef.current.autoNext) {
          autoTimer.current = setTimeout(() => {
            if (mounted.current) beginRef.current();
          }, 1800);
        }
        return;
      }

      // 次のベット額の初期値＝そのカテゴリの先頭プリセット（無ければミニマム）。
      if (v.legal.canBet) {
        const list = presetsFor(config, categoryOf(v.state));
        const first = list[0];
        setBetTo(first ? resolvePreset(first, v.state) : v.legal.minBetTo);
        setPick(first ? presetKey(first) : null);
      } else {
        setBetTo(0);
        setPick(null);
      }

      setPhase('acting');
      // 相手が動いた直後だけ、読む時間を取ってからボタンを有効化する（誤タップ防止も兼ねる）。
      const wait = prefsRef.current.revealMs;
      if (armTimer.current) clearTimeout(armTimer.current);
      if (wait > 0 && la && la.seat === v.botSeat) {
        setArmed(false);
        armTimer.current = setTimeout(() => {
          if (mounted.current) setArmed(true);
        }, wait);
      } else {
        setArmed(true);
      }
    },
    [config, recordHand],
  );

  const applyRef = useRef(apply);
  applyRef.current = apply;

  /** 新しいハンドを配る。 */
  const begin = useCallback(async (): Promise<void> => {
    if (!inflight.current.acquire()) return; // 「次のハンド」の連打を弾く。
    // 自動送りの予約が残っていたら捨てる。残すと、手動で次へ進めた後にそれが発火して
    // 進行中のハンドを勝手に打ち切ってしまう（並列レビューで検出）。
    if (autoTimer.current) {
      clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }
    try {
      setPhase('starting');
      setLast(null);
      setArmed(true);
      const r = await newHand(tokenRef.current);
      if (!mounted.current) return;
      if (!r.ok) {
        setErrMsg(r.message);
        setPhase('error');
        return;
      }
      if (r.data.token) {
        tokenRef.current = r.data.token;
        saveToken(store, r.data.token);
      }
      applyRef.current(r.data);
    } finally {
      inflight.current.release();
    }
  }, [store]);

  beginRef.current = () => void begin();

  /** アクションを送る（incr は増分だけ）。 */
  const send = useCallback(async (incr: string): Promise<void> => {
    const token = tokenRef.current;
    if (!token) return;
    if (!inflight.current.acquire()) return; // 同じ手の二重送信を弾く。
    try {
      setPhase('sending');
      setLast(null);
      const r = await act(token, incr);
      if (!mounted.current) return;
      if (!r.ok) {
        setErrMsg(r.message);
        setPhase('error');
        return;
      }
      applyRef.current(r.data);
    } finally {
      inflight.current.release();
    }
  }, []);

  // 初回マウントで 1 ハンド目を配る。溜まっている未送信分もここで流す。
  useEffect(() => {
    mounted.current = true;
    tokenRef.current = loadToken(store);
    void flushPending(store);
    beginRef.current();
    return () => {
      mounted.current = false;
      if (armTimer.current) clearTimeout(armTimer.current);
      if (autoTimer.current) clearTimeout(autoTimer.current);
    };
  }, [store]);

  const streetLabel = view ? (STREET_LABEL[view.state.street] ?? 'PREFLOP') : 'PREFLOP';
  const thinking = phase === 'sending' || phase === 'starting';
  const canAct = phase === 'acting' && armed && view?.heroToAct === true;
  const legal = view?.legal;

  // ---- エラー（通信断・想定外の拒否） ----
  if (phase === 'error') {
    return (
      <div className="sb-wrap">
        <div className="panel err-view">
          <ul className="issues">
            <li>{errMsg ?? '通信に失敗しました'}</li>
          </ul>
          <p className="ocr-hint">
            この機能だけは Slumbot のサーバーと通信します（オフラインでは遊べません）。
          </p>
        </div>
        <button type="button" className="btn wide" onClick={() => void begin()}>
          もう一度つなぐ
        </button>
        <button type="button" className="btn ghost wide" onClick={props.onExit}>
          戻る
        </button>
      </div>
    );
  }

  // ---- 配っている間（初回ロード・次のハンド） ----
  // view を残したまま描くと、終わったはずのハンドの卓と無効化されたボタンが
  // 一瞬映る。卓の枠だけ残して中身を差し替え、レイアウトを動かさずに繋ぐ。
  if (!view || phase === 'starting') {
    return (
      <div className="sb-wrap">
        <div className="sb-hud">
          <span className="dh-item">
            <span className="dh-lbl">HANDS</span>
            <b>{session.hands}</b>
          </span>
          <span className="dh-item">
            <span className="dh-lbl">SESSION</span>
            <b className={session.netChips >= 0 ? 'up' : 'down'}>{signedBbLabel(session.netChips)}bb</b>
          </span>
          <span className="sb-gear-sp" />
        </div>
        <div className="sb-felt sb-dealing">
          <div className="sb-deal">
            <div className="spinner" />
            <p>{view ? '次のハンドを配っています…' : 'Slumbot に接続中…'}</p>
            {!view && <p className="sub">ヘッズアップ 200bb・SB 0.5bb / BB 1bb</p>}
          </div>
        </div>
      </div>
    );
  }

  const presets = view.legal.canBet ? presetsFor(config, categoryOf(view.state)) : [];
  const showdown = !view.state.folded;

  return (
    <div className="sb-wrap">
      <div className="sb-hud">
        <span className="dh-item">
          <span className="dh-lbl">HANDS</span>
          <b>{session.hands}</b>
        </span>
        <span className="dh-item">
          <span className="dh-lbl">SESSION</span>
          <b className={session.netChips >= 0 ? 'up' : 'down'}>{signedBbLabel(session.netChips)}bb</b>
        </span>
        <button
          type="button"
          className="sb-gear"
          aria-label="設定"
          onClick={() => setSettingsOpen(true)}
        >
          ⚙
        </button>
      </div>

      <SlumbotTable view={view} last={last} thinking={thinking} streetLabel={streetLabel} />

      {phase === 'over' ? (
        <>
          <HandResult winnings={view.winnings ?? 0} showdown={showdown} />
          <div className="btnrow">
            <button type="button" className="btn ghost" onClick={props.onExit}>
              終了
            </button>
            <button type="button" className="btn" onClick={() => void begin()}>
              次のハンド
            </button>
          </div>
        </>
      ) : (
        <>
          {legal?.canBet && (
            <div className="sb-sizer">
              <div className="sb-presets">
                {presets.map((p) => {
                  const l = presetLabel(p);
                  const key = presetKey(p);
                  const value = resolvePreset(p, view.state);
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`sb-preset${pick === key ? ' on' : ''}`}
                      disabled={!canAct}
                      onClick={() => {
                        setBetTo(value);
                        setPick(key);
                      }}
                    >
                      <span className="sb-preset-v">{l.value}</span>
                      <span className="sb-preset-u">{l.unit}</span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  className={`sb-preset max${pick === 'max' ? ' on' : ''}`}
                  disabled={!canAct}
                  onClick={() => {
                    setBetTo(legal.maxBetTo);
                    setPick('max');
                  }}
                >
                  <span className="sb-preset-v">Max</span>
                </button>
              </div>

              <div className="sb-slide">
                <input
                  type="range"
                  className="sb-range"
                  min={legal.minBetTo}
                  max={legal.maxBetTo}
                  step={Math.max(1, Math.round(config.handleUnit * 100))}
                  value={Math.min(legal.maxBetTo, Math.max(legal.minBetTo, betTo))}
                  disabled={!canAct}
                  onChange={(e) => {
                    setBetTo(snapBetTo(Number(e.target.value), view.state, config.handleUnit));
                    setPick(null);
                  }}
                />
                <div className="sb-stepper">
                  <button
                    type="button"
                    className="sb-step"
                    aria-label="減らす"
                    disabled={!canAct || betTo <= legal.minBetTo}
                    onClick={() => {
                      setBetTo(stepBetTo(betTo, view.state, config.handleUnit, -1));
                      setPick(null);
                    }}
                  >
                    −
                  </button>
                  <span className="sb-amount">
                    {bbLabel(betTo, 1)}
                    <span className="sb-amount-u">bb</span>
                  </span>
                  <button
                    type="button"
                    className="sb-step"
                    aria-label="増やす"
                    disabled={!canAct || betTo >= legal.maxBetTo}
                    onClick={() => {
                      setBetTo(stepBetTo(betTo, view.state, config.handleUnit, 1));
                      setPick(null);
                    }}
                  >
                    ＋
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="sb-actions">
            {legal?.canFold && (
              <button
                type="button"
                className="sb-act fold"
                disabled={!canAct}
                onClick={() => void send('f')}
              >
                FOLD
              </button>
            )}
            {legal?.canCheck && (
              <button
                type="button"
                className="sb-act check"
                disabled={!canAct}
                onClick={() => void send('k')}
              >
                CHECK
              </button>
            )}
            {legal?.canCall && (
              <button
                type="button"
                className="sb-act call"
                disabled={!canAct}
                onClick={() => void send('c')}
              >
                CALL
                <span className="sb-act-sub">{bbLabel(legal.callAmount, 1)}bb</span>
              </button>
            )}
            {legal?.canBet && (
              <button
                type="button"
                className="sb-act raise"
                disabled={!canAct}
                onClick={() => void send(`b${clampBetTo(betTo, view.state)}`)}
              >
                {legal.isRaise ? 'RAISE' : 'BET'}
                <span className="sb-act-sub">{bbLabel(clampBetTo(betTo, view.state), 1)}bb</span>
              </button>
            )}
          </div>
        </>
      )}

      {settingsOpen && (
        <SlumbotSettings
          config={config}
          prefs={prefs}
          onChangeConfig={updateConfig}
          onChangePrefs={updatePrefs}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
