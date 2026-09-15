/**
 * Slumbot 対戦の設定モーダル（ヘッダの ⚙ から開く）。
 * タブは 2 枚:
 *   ゲーム設定   … Slumbot 側で固定されている条件の明示＋進行の好み
 *   ベットサイズ … 卓の下に並ぶプリセットの編集（カテゴリごとに最大 15 個）
 */

import { useState } from 'react';

import { useBackLayer } from './BackLayer';
import {
  CATEGORY_LABEL,
  CATEGORY_UNITS,
  DEFAULT_BET_SIZES,
  HANDLE_UNITS,
  MAX_PRESETS,
  addPreset,
  presetLabel,
  removePreset,
  resetCategory,
  type BetSizeConfig,
  type HandleUnit,
  type SizeCategory,
  type SizeUnit,
} from '../slumbot/sizes';
import { REVEAL_CHOICES, type GamePrefs } from '../slumbot/prefs';
import { BGM_TRACKS, resolveTrack } from '../slumbot/bgmTracks';

const CATEGORIES: SizeCategory[] = ['pfOpen', 'pfVsRaise', 'postBet', 'postVsBet'];

const UNIT_LABEL: Record<SizeUnit, string> = { bb: 'bb', x: 'x', pct: '%' };

const REVEAL_LABEL: Record<number, string> = {
  0: 'すぐ',
  300: '0.3秒',
  600: '0.6秒',
  1000: '1秒',
};

/**
 * 1 カテゴリぶんの編集ブロック。
 * SIT & GO の設定モーダル（SngSettings.tsx）もベットサイズは同じ形（カテゴリ×プリセット）
 * で編集するため export する（重複実装を避ける）。
 */
export function CategoryBlock(props: {
  cat: SizeCategory;
  config: BetSizeConfig;
  onChange: (next: BetSizeConfig) => void;
}): JSX.Element {
  const units = CATEGORY_UNITS[props.cat];
  const list = props.config[props.cat];
  const [draft, setDraft] = useState('');
  const [unit, setUnit] = useState<SizeUnit>(units[0]!);
  const [err, setErr] = useState<string | null>(null);
  const dirty = JSON.stringify(list) !== JSON.stringify(DEFAULT_BET_SIZES[props.cat]);

  function add(): void {
    const v = Number.parseFloat(draft);
    const r = addPreset(props.config, props.cat, unit, v);
    if (!r.ok) {
      setErr(r.message);
      return;
    }
    setErr(null);
    setDraft('');
    props.onChange(r.config);
  }

  return (
    <div className="bs-cat">
      <div className="bs-cat-head">
        <span className="bs-cat-name">{CATEGORY_LABEL[props.cat]}</span>
        {dirty && (
          <button
            type="button"
            className="bs-reset"
            onClick={() => props.onChange(resetCategory(props.config, props.cat))}
          >
            ↺ デフォルトに戻す
          </button>
        )}
      </div>

      <div className="bs-add">
        <input
          type="number"
          inputMode="decimal"
          className="bs-num"
          placeholder="0"
          value={draft}
          min={0}
          step="0.1"
          onChange={(e) => {
            setDraft(e.target.value);
            setErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        {units.length > 1 ? (
          <div className="bs-unit-seg">
            {units.map((u) => (
              <button
                key={u}
                type="button"
                className={`bs-unit${unit === u ? ' on' : ''}`}
                onClick={() => setUnit(u)}
              >
                {UNIT_LABEL[u]}
              </button>
            ))}
          </div>
        ) : (
          <span className="bs-unit-fixed">{UNIT_LABEL[units[0]!]}</span>
        )}
        <button
          type="button"
          className="bs-addbtn"
          disabled={draft.trim() === '' || list.length >= MAX_PRESETS}
          onClick={add}
        >
          ＋ 追加
        </button>
      </div>

      {err && <p className="bs-err">{err}</p>}

      <div className="bs-chips">
        {list.map((p, i) => {
          const l = presetLabel(p);
          return (
            <button
              key={`${p.unit}-${p.value}`}
              type="button"
              className="bs-chip"
              onClick={() => props.onChange(removePreset(props.config, props.cat, i))}
              aria-label={`${l.value}${l.unit} を削除`}
            >
              <span className="bs-chip-v">{l.value}</span>
              <span className="bs-chip-u">{l.unit}</span>
              <span className="bs-chip-x">×</span>
            </button>
          );
        })}
        <span className="bs-chip max">Max</span>
      </div>
      <div className="bs-count">
        {list.length}/{MAX_PRESETS}
      </div>
    </div>
  );
}

export function SlumbotSettings(props: {
  config: BetSizeConfig;
  prefs: GamePrefs;
  onChangeConfig: (next: BetSizeConfig) => void;
  onChangePrefs: (next: GamePrefs) => void;
  onClose: () => void;
}): JSX.Element {
  useBackLayer(props.onClose);
  const [tab, setTab] = useState<'game' | 'sizes'>('sizes');
  // 選んだ曲が消えていても先頭に落ちる（対戦画面が実際に鳴らす曲と必ず一致させる）。
  const selectedTrack = resolveTrack(BGM_TRACKS, props.prefs.bgmTrack);

  return (
    <div className="modal-backdrop" onClick={props.onClose} role="presentation">
      <div
        className="modal sb-settings"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Slumbot 設定"
      >
        <div className="modal-head">
          <span className="modal-title">⚙ 設定</span>
          <button type="button" className="modal-x" aria-label="閉じる" onClick={props.onClose}>
            ✕
          </button>
        </div>

        <div className="bs-tabs">
          <button
            type="button"
            className={`bs-tab${tab === 'game' ? ' on' : ''}`}
            onClick={() => setTab('game')}
          >
            ゲーム設定
          </button>
          <button
            type="button"
            className={`bs-tab${tab === 'sizes' ? ' on' : ''}`}
            onClick={() => setTab('sizes')}
          >
            ベットサイズ
          </button>
        </div>

        <div className="modal-body bs-body">
          {tab === 'game' ? (
            <>
              <div className="bs-fixed">
                <div className="bs-fixed-h">Slumbot 側で固定されている条件</div>
                <dl className="bs-fixed-list">
                  <div>
                    <dt>ブラインド</dt>
                    <dd>SB 0.5bb / BB 1bb</dd>
                  </div>
                  <div>
                    <dt>スタック</dt>
                    <dd>200bb（毎ハンド リセット）</dd>
                  </div>
                  <div>
                    <dt>形式</dt>
                    <dd>ヘッズアップ NLHE・アンティ無し</dd>
                  </div>
                  <div>
                    <dt>ポジション</dt>
                    <dd>1 ハンドごとに SB / BB が入れ替わる</dd>
                  </div>
                </dl>
                <p className="bs-note">
                  これらは Slumbot の API 側で決まっており、アプリからは変更できません。
                </p>
              </div>

              <label className="bs-toggle">
                <input
                  type="checkbox"
                  checked={props.prefs.autoNext}
                  onChange={(e) => props.onChangePrefs({ ...props.prefs, autoNext: e.target.checked })}
                />
                <span>ハンドが終わったら自動で次へ</span>
              </label>

              <div className="bs-h">相手のアクションを見せる時間</div>
              <div className="bs-seg">
                {REVEAL_CHOICES.map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`segbtn${props.prefs.revealMs === v ? ' on' : ''}`}
                    onClick={() => props.onChangePrefs({ ...props.prefs, revealMs: v })}
                  >
                    {REVEAL_LABEL[v]}
                  </button>
                ))}
              </div>
              <p className="bs-note">
                Slumbot の応答自体に 0.5 秒ほどかかります。ここで指定するのは、返ってきた
                アクションを読む時間です。
              </p>

              <div className="bs-h">BGM</div>
              {BGM_TRACKS.length === 0 ? (
                <p className="bs-note">音源が入っていません。</p>
              ) : (
                <>
                  {/* 選ぶのは曲だけ。鳴らす/止めるは対戦画面の ♪ で行う（音は本人の操作で出す）。 */}
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
                    {props.prefs.bgmOn
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
