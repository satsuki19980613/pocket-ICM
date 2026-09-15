/**
 * SIT & GO 対戦の設定モーダル（ヘッダの ⚙ から開く）。Slumbot HU の `SlumbotSettings.tsx`
 * と**同じ枠**（`bs-*` クラス・タブ 2 枚）を使う。
 *
 * 「ゲーム設定」タブの中身は Slumbot と違う: Slumbot は固定条件（SB/BB・スタック・HU）を
 * 見せるだけだったが、SIT & GO は部屋ごとに人数・開始スタック・上昇速度・ゲームモードが
 * 変わるので、その部屋の条件を見せる。自動送り／相手の思考時間プレビューは対人戦には無い
 * 概念なので出さない。BGM は Slumbot と共通の音源・共通の好み保存（`slumbot/prefs.ts`）を
 * そのまま使う——Training タブ全体で「選んだ曲・鳴らすかどうか」は 1 つでよい。
 *
 * 「ベットサイズ」タブは Slumbot の `CategoryBlock`（`SlumbotSettings.tsx` から export）を
 * そのまま再利用する。カテゴリ（プリフロップ オープン/対レイズ・ポストフロップ ベット/対ベット）
 * も保存キー（`slumbot/sizes.ts` の `loadBetSizes`/`saveBetSizes`）も Slumbot と共用。
 */

import { useState } from 'react';

import type { SngConfig } from '@oshihiki/sng';
import { gameModeSpec } from '@oshihiki/core';

import { useBackLayer } from './BackLayer';
import { CategoryBlock } from './SlumbotSettings';
import { type BetSizeConfig, HANDLE_UNITS, type HandleUnit } from '../slumbot/sizes';
import { BGM_TRACKS, resolveTrack } from '../slumbot/bgmTracks';
import type { GamePrefs } from '../slumbot/prefs';

const CATEGORIES = ['pfOpen', 'pfVsRaise', 'postBet', 'postVsBet'] as const;

const SPEED_LABEL: Record<SngConfig['speed'], string> = { normal: '通常', slow: 'ゆっくり', veryslow: 'もっとゆっくり' };

export function SngSettings(props: {
  roomConfig: SngConfig;
  config: BetSizeConfig;
  prefs: GamePrefs;
  /** いまこの部屋で鳴っているか（Slumbot の保存値ではなく、この画面のトグル）。 */
  bgmOn: boolean;
  onChangeConfig: (next: BetSizeConfig) => void;
  onChangePrefs: (next: GamePrefs) => void;
  onClose: () => void;
}): JSX.Element {
  useBackLayer(props.onClose);
  const [tab, setTab] = useState<'game' | 'sizes'>('sizes');
  const selectedTrack = resolveTrack(BGM_TRACKS, props.prefs.bgmTrack);
  const spec = gameModeSpec(props.roomConfig.mode);
  const modeLabel = spec.variant ? `${spec.game}${spec.variant}` : spec.game;

  return (
    <div className="modal-backdrop" onClick={props.onClose} role="presentation">
      <div
        className="modal sb-settings"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="SIT & GO 設定"
      >
        <div className="modal-head">
          <span className="modal-title">⚙ 設定</span>
          <button type="button" className="modal-x" aria-label="閉じる" onClick={props.onClose}>
            ✕
          </button>
        </div>

        <div className="bs-tabs">
          <button type="button" className={`bs-tab${tab === 'game' ? ' on' : ''}`} onClick={() => setTab('game')}>
            ゲーム設定
          </button>
          <button type="button" className={`bs-tab${tab === 'sizes' ? ' on' : ''}`} onClick={() => setTab('sizes')}>
            ベットサイズ
          </button>
        </div>

        <div className="modal-body bs-body">
          {tab === 'game' ? (
            <>
              <div className="bs-fixed">
                <div className="bs-fixed-h">この部屋の条件</div>
                <dl className="bs-fixed-list">
                  <div>
                    <dt>人数</dt>
                    <dd>{props.roomConfig.players}人</dd>
                  </div>
                  <div>
                    <dt>開始スタック</dt>
                    <dd>{props.roomConfig.startBb}bb</dd>
                  </div>
                  <div>
                    <dt>上昇速度</dt>
                    <dd>
                      {SPEED_LABEL[props.roomConfig.speed]}（{props.roomConfig.levelMin}分/レベル）
                    </dd>
                  </div>
                  <div>
                    <dt>ゲームモード</dt>
                    <dd>{modeLabel}</dd>
                  </div>
                </dl>
                <p className="bs-note">部屋の条件は開始後は変更できません。</p>
              </div>

              <div className="bs-h">BGM</div>
              {BGM_TRACKS.length === 0 ? (
                <p className="bs-note">音源が入っていません。</p>
              ) : (
                <>
                  <div className="bs-bgm-list" role="radiogroup" aria-label="BGM の曲">
                    {BGM_TRACKS.map((t) => {
                      const on = selectedTrack?.id === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          className={`bs-bgm-row${on ? ' on' : ''}`}
                          onClick={() => props.onChangePrefs({ ...props.prefs, bgmTrack: t.id })}
                        >
                          <span className="bs-bgm-mark">{on ? '♪' : ''}</span>
                          <span className="bs-bgm-name">{t.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="bs-note">
                    鳴らす・止めるは対戦画面の ♪ です。
                    {props.bgmOn
                      ? ' 鳴っている間に選び直すと、その場で切り替わります。'
                      : ' いま選んでいる曲は ♪ を押すと鳴ります。'}
                  </p>
                </>
              )}
            </>
          ) : (
            <>
              <div className="bs-handle">
                <div className="bs-h">
                  ベットサイズハンドル 調整単位
                  <span className="bs-h-val">{props.config.handleUnit}bb</span>
                </div>
                <div className="bs-units">
                  {HANDLE_UNITS.map((u) => (
                    <button
                      key={u}
                      type="button"
                      className={`bs-unit-dot${props.config.handleUnit === u ? ' on' : ''}${
                        u <= props.config.handleUnit ? ' filled' : ''
                      }`}
                      onClick={() => props.onChangeConfig({ ...props.config, handleUnit: u as HandleUnit })}
                    >
                      <span className="bs-dot" />
                      <span className="bs-dot-l">{u}</span>
                    </button>
                  ))}
                </div>
              </div>

              {CATEGORIES.map((c) => (
                <CategoryBlock key={c} cat={c} config={props.config} onChange={props.onChangeConfig} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
