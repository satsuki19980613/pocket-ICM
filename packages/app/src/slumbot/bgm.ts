/**
 * Slumbot 対戦画面の BGM。
 *
 * 音源は `packages/app/public/bgm/slumbot.mp3`（置き方はそこの README）。ビルドに取り込まず
 * そのまま配信するので、差し替えはファイルの置き換えだけで済む。**PWA の事前キャッシュには
 * 入れていない**（音源は大きく、入れるとインストールが重くなる）。
 *
 * ブラウザは「利用者の操作なしに音を鳴らす」ことを禁じている。ON/OFF ボタンのタップから
 * 始まる再生は許されるが、画面に入り直したときの自動再生は拒否されることがある。拒否されたら
 * 呼び出し側に伝えてボタンを OFF に戻す——**鳴っていないのに ON と表示するのが一番困る**ため。
 */

import { useEffect, useRef } from 'react';

/** 音源の場所。BASE_URL を通すのは、配信がサブパスに移っても壊れないようにするため。 */
export const BGM_SRC = `${import.meta.env.BASE_URL}bgm/slumbot.mp3`;

/** 音量。対戦の邪魔をしない程度に絞る（音源側でも小さめに書き出してもらう）。 */
export const BGM_VOLUME = 0.35;

/** 鳴らせなかった理由。missing=音源が無い/壊れている, blocked=ブラウザに止められた。 */
export type BgmFailure = 'missing' | 'blocked';

/**
 * `on` の間だけ BGM をループ再生する。
 *
 * - 画面を離れる（アンマウント）と必ず止める。裏で鳴り続けるのを防ぐ。
 * - アプリが背面に回ったら止め、戻ったら鳴らし直す（ホーム画面に戻しても鳴り続けない）。
 * - 失敗したら `onFail` を呼ぶ。呼び出し側は `on` を false に戻すこと。
 */
export function useBgm(on: boolean, onFail: (why: BgmFailure) => void): void {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** 最新の値を効果の外から参照するための控え（効果を張り直さずに済ませる）。 */
  const failRef = useRef(onFail);
  failRef.current = onFail;
  const onRef = useRef(on);
  onRef.current = on;
  /** アンマウント後に遅れて届くイベントで setState しないための印。 */
  const disposed = useRef(false);

  useEffect(() => {
    if (!on) {
      audioRef.current?.pause();
      return;
    }
    let el = audioRef.current;
    if (!el) {
      el = new Audio(BGM_SRC);
      el.loop = true;
      el.volume = BGM_VOLUME;
      // 404・壊れたファイル・対応していない形式はここに来る（play() の失敗より先のことも後のこともある）。
      el.addEventListener('error', () => {
        if (!disposed.current) failRef.current('missing');
      });
      audioRef.current = el;
    }
    const audio = el;
    void audio.play().catch(() => {
      if (disposed.current) return;
      // el.error が入っていれば音源そのものの問題。入っていなければ自動再生の拒否。
      failRef.current(audio.error ? 'missing' : 'blocked');
    });
    return () => audio.pause();
  }, [on]);

  // アプリが背面に回っている間は止める（戻ったときは、まだ ON なら鳴らし直す）。
  useEffect(() => {
    const onVisibility = (): void => {
      const el = audioRef.current;
      if (!el) return;
      if (document.hidden) el.pause();
      // 復帰時の再生拒否は黙って無視する。一度鳴った音源の再開はふつう通るし、
      // ここで OFF に倒すと「戻るたびに勝手に切れる」方が分かりにくい。
      else if (onRef.current) void el.play().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // 画面を離れたら完全に破棄する（src を空にして、読み込み途中なら中断させる）。
  useEffect(
    () => () => {
      disposed.current = true;
      const el = audioRef.current;
      if (!el) return;
      el.pause();
      el.removeAttribute('src');
      el.load();
      audioRef.current = null;
    },
    [],
  );
}
