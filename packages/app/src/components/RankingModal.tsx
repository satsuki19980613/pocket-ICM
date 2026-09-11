/**
 * Training ▸ ランキング。Slumbot HU の通算成績（ハンド数と収支）をクラブ内で並べる。
 * 並びは通算収支の降順、同点はハンド数の多い順（supabase/huStats.ts の order と対応）。
 *
 * 画面遷移ではなく**重なり（モーダル）**として開く。対局中にヘッダの ▲ から覗いても
 * 進行中のハンドが消えないようにするため（画面を切り替えると SlumbotView が
 * アンマウントされ、打ちかけのハンドが失われる）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useBackLayer } from './BackLayer';
import { signedBbLabel } from '../slumbot/rules';
import { fetchRanking, flushPending, type RankRow } from '../supabase/huStats';
import { useStorageImage } from '../supabase/storageUrls';

type State = 'loading' | 'ready' | 'error';

function Avatar(props: { row: RankRow }): JSX.Element {
  const initial = props.row.handle.trim().charAt(0).toUpperCase() || '?';
  // アイコンはこのアプリの Storage の参照だけを署名 URL にして出す（storageUrls.ts）。
  const src = useStorageImage(props.row.avatarUrl, 'avatars');
  return <div className="av">{src ? <img src={src} alt="" /> : initial}</div>;
}

function Body(props: { state: State; rows: RankRow[]; onReload: () => void }): JSX.Element {
  if (props.state === 'loading') {
    return (
      <div className="panel solving">
        <div className="spinner" />
        <p>ランキングを読み込み中…</p>
      </div>
    );
  }

  if (props.state === 'error') {
    return (
      <>
        <div className="panel err-view">
          <ul className="issues">
            <li>ランキングを取得できませんでした。</li>
          </ul>
        </div>
        <button type="button" className="btn wide" onClick={props.onReload}>
          再読み込み
        </button>
      </>
    );
  }

  return (
    <>
      <div className="rk-head">
        <span className="rk-h-rank">#</span>
        <span className="rk-h-name">プレイヤー</span>
        <span className="rk-h-hands">ハンド</span>
        <span className="rk-h-net">収支</span>
      </div>

      {props.rows.length === 0 ? (
        <div className="home-empty">
          <p>まだ誰も対戦していません。</p>
          <p className="sub">Slumbot HU で 1 ハンド打つと、ここに載ります。</p>
        </div>
      ) : (
        <ol className="rk-list">
          {props.rows.map((r, i) => (
            <li key={r.userId} className={`rk-row${r.isMe ? ' me' : ''}`}>
              <span className={`rk-rank r${i + 1 <= 3 ? i + 1 : ''}`}>{i + 1}</span>
              <Avatar row={r} />
              <span className="rk-name">
                <b>{r.displayName}</b>
                <span className="rk-handle">@{r.handle}</span>
              </span>
              <span className="rk-hands">{r.hands}</span>
              <span className={`rk-net ${r.netChips >= 0 ? 'up' : 'down'}`}>
                {signedBbLabel(r.netChips)}
                <span className="rk-unit">bb</span>
              </span>
            </li>
          ))}
        </ol>
      )}

      <p className="ocr-hint rk-note">
        収支は Slumbot（ヘッズアップ 200bb）での通算です。数字は各自の端末から送られるため、
        厳密な競技記録ではありません。
      </p>
      <button type="button" className="btn ghost wide" onClick={props.onReload}>
        更新する
      </button>
    </>
  );
}

export function RankingModal(props: { onClose: () => void }): JSX.Element {
  useBackLayer(props.onClose);
  const [state, setState] = useState<State>('loading');
  const [rows, setRows] = useState<RankRow[]>([]);
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    setState('loading');
    // 未送信の対局分があれば先に反映してから読む（自分の行が古く見えないように）。
    try {
      await flushPending(window.localStorage);
    } catch {
      /* 保存領域が使えなくても一覧は読める。 */
    }
    const r = await fetchRanking();
    if (!mounted.current) return; // 読み込み中に閉じられた。
    if (!r.ok) {
      setState('error');
      return;
    }
    setRows(r.data);
    setState('ready');
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  return (
    <div className="modal-backdrop" onClick={props.onClose} role="presentation">
      <div
        className="modal rk-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="ランキング"
      >
        <div className="modal-head">
          <span className="modal-title">▲ ランキング</span>
          <button type="button" className="modal-x" aria-label="閉じる" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body rk-body">
          <Body state={state} rows={rows} onReload={() => void load()} />
        </div>
      </div>
    </div>
  );
}
