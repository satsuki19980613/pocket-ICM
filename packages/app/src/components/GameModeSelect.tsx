import type { GameKind, GameMode } from '@oshihiki/core';
import { GAME_KINDS, GAME_KIND_LABELS, GAME_MODE_SPECS, MODES_BY_KIND } from '@oshihiki/core';

/**
 * ゲーム選択（2段セグメント）。スクショ選択画面と条件確認画面で共用する。
 *
 * 上段＝ゲーム（クラブ／ランク／レジェンド）、下段＝そのゲームの内訳。
 * ランクマッチは **STAGE で開始スタックも順位別ポイントも変わる**ので STAGE を選ばせる。
 * レジェンドマッチは **どのレートで解くか**（平均／シーズン／ベース）を選ばせる。
 * クラブマッチは内訳が無いので下段は空。
 *
 * 概念の違うものを1列に混ぜると意味が壊れるので段を分ける。ラベルだけで説明は置かない
 * （説明は各画面の ℹ️ に格納する。さつき指示 2026-09-12）。
 *
 * **下段は常に描き、内訳の無いゲームでは `visibility: hidden` で見えなくするだけ。** 段が出没すると
 * 下にある「この内容で計算する」ボタンが動き、押す瞬間にずれて誤タップを招くため（同指示）。
 * 高さを min-height で予約する手も試したが、実測で 43px と置いたところ実際の行は 57px あり
 * 14px ずれた。**中身を残せば高さは定義上一致する**ので、フォントや余白を変えても崩れない。
 * visibility: hidden はアクセシビリティツリーからもタブ順からも外れる。
 *
 * 選択は系統ごとに保持する（ランク→クラブ→ランクで STAGE が戻らない・レジェンドも同様）。
 * 保持は呼び出し側が `GameSel` として持ち、ここは表示と通知だけを行う。
 */
export interface GameSel {
  kind: GameKind;
  /** 系統ごとに最後に選んだモード（往復しても失わないように全系統ぶん持つ）。 */
  last: { [K in GameKind]: GameMode };
}

export const DEFAULT_GAME_SEL: GameSel = {
  kind: 'club',
  last: { club: 'club', rank: 'rank-4', legend: 'legend-avg' },
};

/** いま選ばれている GameMode。 */
export function selectedMode(sel: GameSel): GameMode {
  return sel.last[sel.kind];
}

/** GameMode → 選択状態（記録の復元・保存値の読み戻し用）。 */
export function selFromMode(mode: GameMode | undefined): GameSel {
  const spec = GAME_MODE_SPECS[mode ?? 'club'];
  return { kind: spec.kind, last: { ...DEFAULT_GAME_SEL.last, [spec.kind]: spec.id } };
}

export function GameModeSelect(props: {
  sel: GameSel;
  onChange: (next: GameSel) => void;
  /** 計算中など、操作させたくないとき。 */
  disabled?: boolean;
}): JSX.Element {
  const { sel, disabled } = props;
  const variants = MODES_BY_KIND[sel.kind];
  const hasVariants = variants.length > 1;

  return (
    <div className="gmsel">
      <div className="seg gmsel-row">
        {GAME_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={`segbtn${sel.kind === k ? ' on' : ''}`}
            disabled={disabled}
            onClick={() => props.onChange({ ...sel, kind: k })}
          >
            {GAME_KIND_LABELS[k]}
          </button>
        ))}
      </div>

      {/* 内訳の無いゲーム（クラブ）でも同じ中身を描いたまま隠す（下のボタンを1pxも動かさないため）。 */}
      <div
        className={`seg gmsel-row gmsel-variant${hasVariants ? '' : ' is-hidden'}`}
        aria-hidden={hasVariants ? undefined : true}
      >
        {(hasVariants ? variants : MODES_BY_KIND.legend).map((m) => {
          const spec = GAME_MODE_SPECS[m];
          return (
            <button
              key={m}
              type="button"
              className={`segbtn${selectedMode(sel) === m ? ' on' : ''}`}
              disabled={disabled || !hasVariants}
              onClick={() => props.onChange({ ...sel, last: { ...sel.last, [sel.kind]: m } })}
            >
              {spec.kind === 'rank' ? `STAGE ${spec.variant}` : spec.variant}
            </button>
          );
        })}
      </div>
    </div>
  );
}
