/**
 * Training タブのハブ画面（SPEC §7.4・docs/SNG_DESIGN.md §5）。
 * トレーニングは複数の機能を抱えるので、タブ直下はメニューにして各機能へ送り出す。
 *
 * メニューは Slumbot HU / SIT & GO / STATS の3枚（AOF ドリルは Coming Soon のまま）。
 * 「あなたの通算」パネルと HAND HISTORY/STATS への直リンクは廃止（`hustats` 画面は
 * `stats` 画面に統合され、成績はそちらから見る）。
 */

interface MenuProps {
  readonly glyph: string;
  readonly title: string;
  readonly sub: string;
  readonly soon?: boolean;
  readonly onClick?: () => void;
}

function MenuCard(props: MenuProps): JSX.Element {
  return (
    <button
      type="button"
      className={`tr-card${props.soon ? ' soon' : ''}`}
      disabled={props.soon}
      onClick={props.onClick}
    >
      <span className="tr-glyph">{props.glyph}</span>
      <span className="tr-text">
        <span className="tr-title">{props.title}</span>
        <span className="tr-sub">{props.sub}</span>
      </span>
      {props.soon ? <span className="tr-badge">COMING SOON</span> : <span className="tr-go">›</span>}
    </button>
  );
}

export function TrainingHub(props: {
  onOpenSlumbot: () => void;
  onOpenSng: () => void;
  onOpenStats: () => void;
}): JSX.Element {
  return (
    <div className="tr-wrap">
      <div className="tr-menu">
        <MenuCard
          glyph="♠"
          title="Slumbot HU"
          sub="世界トップ級のボットとヘッズアップ 200bb"
          onClick={props.onOpenSlumbot}
        />
        <MenuCard
          glyph="♣"
          title="SIT & GO"
          sub="会員同士の対人トーナメント（2〜6人）"
          onClick={props.onOpenSng}
        />
        <MenuCard glyph="⌇" title="STATS" sub="Slumbot HU / SIT & GO の成績とハンド履歴" onClick={props.onOpenStats} />
        <MenuCard
          glyph="◎"
          title="AOF ドリル"
          sub="このアプリの ICM 計算で出題する ALL IN / FOLD テスト"
          soon
        />
      </div>
    </div>
  );
}
