/**
 * Slumbot 対戦画面の BGM 再生。
 *
 * 曲の一覧と URL は bgmTracks.ts（`src/assets/bgm/*.mp3` をビルド時に自動で拾う）。
 * ここは「鳴らす/止める」だけを受け持つ。音源は **PWA の事前キャッシュに入れていない**
 * （曲が増えてもインストールが重くならないように。鳴らした曲だけ落ちてくる）。
 *
 * ブラウザは「利用者の操作なしに音を鳴らす」ことを禁じている。ON/OFF ボタンのタップから
 * 始まる再生は許されるが、画面に入り直したときの自動再生は拒否されることがある。拒否されたら
 * 呼び出し側に伝えてボタンを OFF に戻す——**鳴っていないのに ON と表示するのが一番困る**ため。
 */

import { useEffect, useRef } from 'react';

/** 音量。対戦の邪魔をしない程度に絞る（音源側でも小さめに書き出してもらう）。 */
export const BGM_VOLUME = 0.35;

/** 鳴らせなかった理由。missing=音源を読めない/壊れている, blocked=ブラウザに止められた。 */
export type BgmFailure = 'missing' | 'blocked';

/**
 * `on` の間だけ `src` をループ再生する。
 *
 * - 鳴っている最中に `src` が変わったら、その曲に切り替える（設定で曲を選び直したとき）。
 * - 画面を離れる（アンマウント）と必ず止める。裏で鳴り続けるのを防ぐ。
 * - アプリが背面に回ったら止め、戻ったら鳴らし直す（ホーム画面に戻しても鳴り続けない）。
 * - 失敗したら `onFail` を呼ぶ。呼び出し側は `on` を false に戻すこと。
 */
export function useBgm(src: string | null, on: boolean, onFail: (why: BgmFailure) => void): void {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** いま audio に入れてある src（毎回入れ直すと、同じ曲でも頭から鳴り直してしまう）。 */
  const srcRef = useRef<string | null>(null);
  /** 最新の値を効果の外から参照するための控え（効果を張り直さずに済ませる）。 */
  const failRef = useRef(onFail);
  failRef.current = onFail;
  const onRef = useRef(on);
  onRef.current = on;
  /** アンマウント後に遅れて届くイベントで setState しないための印。 */
  const disposed = useRef(false);

  useEffect(() => {
    if (!on || !src) {
      audioRef.current?.pause();
      return;
    }
    let el = audioRef.current;
    if (!el) {
      el = new Audio();
      el.loop = true;
      el.volume = BGM_VOLUME;
      // 読めない・壊れている・対応していない形式はここに来る（play() の失敗より先のことも後のこともある）。
      el.addEventListener('error', () => {
        if (!disposed.current) failRef.current('missing');
      });
      audioRef.current = el;
    }
    const audio = el;
    if (srcRef.current !== src) {
      audio.src = src;
      srcRef.current = src;
    }
    void audio.play().catch(() => {
      if (disposed.current) return;
      // el.error が入っていれば音源そのものの問題。入っていなければ自動再生の拒否。
      failRef.current(audio.error ? 'missing' : 'blocked');
    });
    return () => audio.pause();
  }, [on, src]);

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
      srcRef.current = null;
    },
    [],
  );
}
