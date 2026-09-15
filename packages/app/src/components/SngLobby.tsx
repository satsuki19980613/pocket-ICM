/**
 * SIT & GO ロビー（作成パネル＋募集中一覧）。docs/SNG_DESIGN.md §5（A3a 所有）。
 *
 * 上半分＝作成パネル（人数・開始スタック・構造・上昇間隔・ゲームモード）＋参加中の部屋への
 * バナー。下半分＝募集中の一覧をパネル内スクロール。一覧は `LobbyClient` で即時更新し、
 * 繋がっていない間だけ `listRooms()` を 5 秒間隔でポーリングする。
 */

import { useEffect, useRef, useState } from 'react';

import {
  LEVEL_MINUTES,
  PLAYER_COUNTS,
  SPEEDS,
  START_BBS,
  type LevelMinutes,
  type PlayerCount,
  type RoomSummary,
  type Speed,
  type StartBb,
} from '@oshihiki/sng';

import { DEFAULT_GAME_SEL, GameModeSelect, selectedMode, type GameSel } from './GameModeSelect';
import { LobbyClient } from '../sng/client';
import { createRoom, listRooms } from '../sng/lobbyApi';
import { createStartLatch } from '../solveJob';

const SPEED_LABEL: Record<Speed, string> = { normal: '通常', slow: 'ゆっくり', veryslow: 'もっとゆっくり' };

function speedLabel(cfg: RoomSummary['config']): string {
  return SPEED_LABEL[cfg.speed];
}

export function SngLobby(props: { onOpenRoom: (roomId: string) => void }): JSX.Element {
  const [players, setPlayers] = useState<PlayerCount>(6);
  const [startBb, setStartBb] = useState<StartBb>(100);
  const [speed, setSpeed] = useState<Speed>('normal');
  const [levelMin, setLevelMin] = useState<LevelMinutes>(4);
  const [gameSel, setGameSel] = useState<GameSel>(DEFAULT_GAME_SEL);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const latch = useRef(createStartLatch());

  const [allRooms, setAllRooms] = useState<readonly RoomSummary[]>([]);
  // 一覧は「募集中」だけ（設計 §5）。進行中の部屋は一覧に出さず、自分が居る部屋は上部のバナーで扱う。
  const rooms = allRooms.filter((r) => r.status === 'waiting');
  const [mine, setMine] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  // ロビーの一覧をリアルタイムに受け取る。
  useEffect(() => {
    const client = new LobbyClient({
      onRooms: (r, m) => {
        setAllRooms(r);
        setMine(m);
      },
      onError: () => {},
      onConnected: setConnected,
    });
    client.connectLobby();
    return () => client.close();
  }, []);

  // 繋がっていない間だけ 5 秒ポーリングで補う。
  useEffect(() => {
    if (connected) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      const r = await listRooms();
      if (!cancelled && r.ok) {
        setAllRooms(r.data.rooms);
        setMine(r.data.mine);
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connected]);

  async function onCreate(): Promise<void> {
    if (!latch.current.acquire()) return;
    setCreating(true);
    setCreateErr(null);
    try {
      const r = await createRoom({ players, startBb, speed, levelMin, mode: selectedMode(gameSel) });
      if (!r.ok) {
        setCreateErr(r.message);
        return;
      }
      props.onOpenRoom(r.data.roomId);
    } finally {
      setCreating(false);
      latch.current.release();
    }
  }

  return (
    <div className="sg-lobby">
      <div className="panel sg-create">
        <div className="scr-h sm">SIT &amp; GO を作る</div>

        {mine && (
          <button type="button" className="sg-mine-banner" onClick={() => props.onOpenRoom(mine)}>
            参加中の部屋へ戻る
          </button>
        )}

        <span className="lbl">人数</span>
        <div className="seg">
          {PLAYER_COUNTS.map((n) => (
            <button
              key={n}
              type="button"
              className={`segbtn${players === n ? ' on' : ''}`}
              disabled={creating}
              onClick={() => setPlayers(n)}
            >
              {n}人
            </button>
          ))}
        </div>

        <span className="lbl">開始スタック</span>
        <div className="seg">
          {START_BBS.map((bb) => (
            <button
              key={bb}
              type="button"
              className={`segbtn${startBb === bb ? ' on' : ''}`}
              disabled={creating}
              onClick={() => setStartBb(bb)}
            >
              {bb}bb
            </button>
          ))}
        </div>

        <span className="lbl">ブラインド構造</span>
        <div className="seg">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={`segbtn${speed === s ? ' on' : ''}`}
              disabled={creating}
              onClick={() => setSpeed(s)}
            >
              {SPEED_LABEL[s]}
            </button>
          ))}
        </div>

        <span className="lbl">上昇間隔</span>
        <div className="seg">
          {LEVEL_MINUTES.map((m) => (
            <button
              key={m}
              type="button"
              className={`segbtn${levelMin === m ? ' on' : ''}`}
              disabled={creating}
              onClick={() => setLevelMin(m)}
            >
              {m}分
            </button>
          ))}
        </div>

        <span className="lbl">ゲームモード（プライズ）</span>
        <GameModeSelect sel={gameSel} onChange={setGameSel} disabled={creating} />

        {createErr && (
          <ul className="issues">
            <li>{createErr}</li>
          </ul>
        )}

        <button type="button" className="btn wide" disabled={creating} onClick={() => void onCreate()}>
          {creating ? '作成しています…' : 'SIT & GO を作成'}
        </button>
      </div>

      <div className="panel sg-list-panel">
        <div className="scr-h sm">募集中</div>
        <div className="sg-list-scroll">
          {rooms.length === 0 ? (
            <p className="ocr-hint">いま募集中の部屋はありません。</p>
          ) : (
            <ul className="sg-room-list">
              {rooms.map((r) => (
                <li key={r.roomId}>
                  <button type="button" className="sg-room-row" onClick={() => props.onOpenRoom(r.roomId)}>
                    <span className="sg-room-host">{r.hostName}</span>
                    <span className="sg-room-meta">
                      {r.seated}/{r.config.players}人 ・ {r.config.startBb}bb ・ {speedLabel(r.config)} ・{' '}
                      {r.config.levelMin}分
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
