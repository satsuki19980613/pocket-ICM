/**
 * SIT & GO と Slumbot HU が共有する「ガラス卓」の描画（2〜6 席）。
 *
 * 元は SngTable.tsx にだけ実装されていた（Ten-Four（実在のポーカーアプリ）の卓を参考にした
 * 視認性重視の構成。さつき指示: 名前・スタックを大きく明るく／プレートやチップが重ならない／
 * 席のプレートが主役）。Slumbot HU 側だけが旧デザイン（`.sb-felt`/`.sb-seat`/丸い吹き出し）の
 * まま取り残されていたため、ここへ卓ごと切り出して両画面が同じ DOM・同じクラス名（`sgt-*`）を
 * 出すようにした。SIT & GO の見た目は 1px も変えてはいけない制約があるので、切り出しは
 * 「値の意味づけを props（`FeltSeat`）に外へ出すだけ」で行い、JSX の構造・条件分岐・
 * クラス名の組み立て方は元の実装から変えていない（移植時にコメントも含めてそのまま持ってきている。
 * 実機で潰した罠の記録なので、消すと同じ罠を踏み直す）。
 *
 * ゲーム固有の文言・数値整形（bb 換算・自動処理の注記・ハイライトの文言等）は呼び出し側
 * （`SngTable.tsx`/`SlumbotTable.tsx`）の責務にして、ここは「整形済みの値を並べるだけ」に徹する。
 */

import { useStorageImage } from '../supabase/storageUrls';

const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

/**
 * "Ah" / "Td" のような表記を 1 枚のカードに描く。
 * SIT & GO・Slumbot HU 両方の卓（このファイル）で使うため export する（重複実装を避ける）。
 */
export function Card(props: { code: string; big?: boolean }): JSX.Element | null {
  const rank = props.code[0];
  const suit = props.code[1]?.toLowerCase();
  if (!rank || !suit || !SUIT_GLYPH[suit]) return null;
  return (
    <div className={`pt-card suit-${suit}${props.big ? ' sb-big' : ''}`}>
      <span className="pt-rank">{rank === 'T' ? '10' : rank}</span>
      <span className="pt-suit">{SUIT_GLYPH[suit]}</span>
    </div>
  );
}

export function Hand(props: { cards: readonly string[]; big?: boolean }): JSX.Element {
  return (
    <div className="pt-hand">
      {props.cards.map((c, i) => (
        <Card key={`${c}-${i}`} code={c} big={props.big} />
      ))}
    </div>
  );
}

export function Backs(): JSX.Element {
  return (
    <div className="pt-backs">
      <span className="pt-back" />
      <span className="pt-back" />
    </div>
  );
}

/**
 * 人数別の席スロット（コンテナ % 座標, [x,y]）。先頭=手前(下)中央, 以降は時計回り。
 * 卓が縦長カプセルになったため（Ten-Four 準拠）、上下に長く・左右は端へ寄せる座標にしている。
 */
const SLOTS: Record<number, readonly (readonly [number, number])[]> = {
  2: [
    [50, 93],
    [50, 9],
  ],
  3: [
    [50, 93],
    [8, 26],
    [92, 26],
  ],
  4: [
    [50, 93],
    [8, 74],
    [50, 9],
    [92, 74],
  ],
  5: [
    [50, 93],
    [8, 74],
    [22, 12],
    [78, 12],
    [92, 74],
  ],
  6: [
    [50, 93],
    [8, 74],
    [8, 26],
    [50, 9],
    [92, 26],
    [92, 74],
  ],
};

/** 席のアンカー（左右端は中央寄せにせず画面端へ固定する。sng-play.css 側の同名クラス参照）。 */
type Anchor = 'anchor-l' | 'anchor-c' | 'anchor-r';
function anchorFor(x: number): Anchor {
  if (x <= 20) return 'anchor-l';
  if (x >= 80) return 'anchor-r';
  return 'anchor-c';
}

/** 直前アクションのピルの色分け（Fold=青 / Check=グレー / Call=緑 / Bet・Raise=赤 / All-in=黄）。 */
export interface PillTag {
  readonly cls: string;
  readonly label: string;
}

/** 席の状態タグ（切断中・SIT OUT・退室・脱落順位）。SngTable.tsx だけが埋める（Slumbot は常に空）。 */
export interface SeatTag {
  readonly key: string;
  readonly cls: string;
  readonly text: string;
}

/**
 * ゲーム非依存の 1 席ぶんの view-model。文言や数値の整形（bb 換算など）は呼び出し側の
 * 責務にして、ここでは「もう出すだけの値」を渡す（GlassTable は並べるだけに徹する）。
 */
export interface FeltSeat {
  readonly key: string;
  readonly name: string;
  /** プレート 2 行目の数値。整形済み（例 "24.5bb"）。 */
  readonly stackText: string;
  readonly badge: 'BTN' | 'SB' | 'BB' | null;
  /** 表向きに見せる手札。null なら裏（backs）か空。 */
  readonly cards: readonly string[] | null;
  /** cards が null のとき裏を出すか。 */
  readonly backs: boolean;
  readonly hero: boolean;
  readonly acting: boolean;
  readonly folded: boolean;
  readonly out: boolean;
  /** 手番の残り時間（S&G だけ。Slumbot は null）。 */
  readonly timer: { readonly sec: number; readonly pct: number } | null;
  /** 相手の応答待ち（Slumbot だけ）。timer と同じ場所に出す。 */
  readonly waiting: boolean;
  readonly pill: PillTag | null;
  /** そのストリートに出した額。整形済み（例 "2.5bb"）。出さないときは null。 */
  readonly betText: string | null;
  readonly tags: readonly SeatTag[];
  /**
   * 席のアイコン（プロフィール画像、または Slumbot の bot 席のような専用記号）。
   * `src` は **表示してよい URL ではなく、DB の生の参照**（`profiles.avatar_url` の値、または
   * null）を渡す約束にしている——ここで署名 URL への変換（`SeatAvatar`／`useStorageImage`）
   * まで済ませる設計で、呼び出し側（`SngTable.tsx`/`SlumbotTable.tsx`）に「生の参照を
   * `<img src>` に入れてしまう」経路を作らせないため（avatars バケットは非公開・
   * `storagePathFromRef` の検証を必ず通す。`supabase/storageUrls.ts` 冒頭コメント参照）。
   * `initial` は画像が無い/読み込み中のときのフォールバック文字（頭文字や記号 1 文字）。
   * 省略時（undefined/null）は何も描かない。
   */
  readonly avatar?: { readonly src: string | null; readonly initial: string } | null;
}

/**
 * avatar の中身（画像 or 頭文字）を描く部品。`src` は DB の生の参照なので、ここで
 * `useStorageImage('avatars')` に通して署名 URL に変換してから `<img>` に渡す
 * （非公開バケット＋参照の形の検証を必ず経由させるため。迂回して `src` をそのまま
 * `<img src>` に入れてはいけない）。6 席ぶん呼ばれても、`useStorageImage` の内部実装
 * （`storageUrls.ts` の `createSignedUrlResolver`）が同一ティックの要求をまとめて 1 回の
 * 署名リクエストにバッチするので、ここでは何も気にせず素直に呼ぶだけでよい。
 */
function SeatAvatar(props: { avatar: { readonly src: string | null; readonly initial: string } }): JSX.Element {
  const url = useStorageImage(props.avatar.src, 'avatars');
  return url ? <img src={url} alt="" /> : <span>{props.avatar.initial}</span>;
}

interface FeltSeatViewProps {
  readonly seat: FeltSeat;
  readonly x: number;
  readonly y: number;
}

function FeltSeatView(props: FeltSeatViewProps): JSX.Element {
  const { seat, x, y } = props;

  const anchor = anchorFor(x);
  // ピル（アクション/ベット）を出す向きは卓の中心へ寄る方向を座席の位置から決める
  // （上半分は下向き＝席の下、下半分は上向き＝席の上）。anchor-l/anchor-r の席は左右の
  // 向きだけで決まるため dir クラスの CSS 側では参照しない（sng-play.css 参照）。
  const dir = y < 50 ? 'dir-down' : 'dir-up';
  // 上端・下端の席は「％で中心を置く」と、カード＋プレート＋タイマーの高さぶん卓の外へ
  // はみ出す（縦に余裕が無い端末ほど顕著）。端の席だけは % を使わず CSS 側で上下端に
  // 貼り付ける（`.sgt-seat.edge-top` / `.edge-bottom`）。
  const edge = y <= 12 ? ' edge-top' : y >= 88 ? ' edge-bottom' : '';
  const style =
    edge !== '' ? (anchor === 'anchor-c' ? { left: `${x}%` } : {}) : anchor === 'anchor-c' ? { top: `${y}%`, left: `${x}%` } : { top: `${y}%` };

  return (
    <div
      className={`sgt-seat ${anchor} ${dir}${edge}${seat.hero ? ' hero' : ' bot'}${seat.acting ? ' acting' : ''}${seat.folded || seat.out ? ' folded' : ''}${seat.out ? ' out' : ''}`}
      style={style}
    >
      <div className="sgt-cards">
        {seat.cards ? <Hand cards={seat.cards} big={seat.hero} /> : !seat.out && (seat.backs ? <Backs /> : <div className="sgt-cardsp" />)}
      </div>
      {/* .sgt-plate には clip-path（面取り）が掛かっており、子孫もろとも切り取る。
          プレートの左辺からはみ出す丸アイコン（さつき指定）をそのまま .sgt-plate の
          子にすると、はみ出た部分が半月状に消えてしまう（実機で確認済みの罠）。
          そのため clip-path を持たない薄いラッパー .sgt-plateline で .sgt-plate を包み、
          丸はそのラッパーの「きょうだい」として置く。ラッパーは position:relative だけの
          素の div で、.sgt-seat（flex-direction:column, align-items:center）の子として
          プレートの幅にそのまま shrink-wrap されるので、.sgt-plate 自身の width/height・
          見た目は 1px も変わらない。 */}
      <div className="sgt-plateline">
        {seat.avatar && (
          <span className="sgt-av" aria-hidden="true">
            <SeatAvatar avatar={seat.avatar} />
          </span>
        )}
        <div className="sgt-plate">
          <span className="sgt-name" title={seat.name}>
            {seat.name}
          </span>
          <span className="sgt-sub">
            {seat.badge && <span className={`sgt-pos p-${seat.badge.toLowerCase()}`}>{seat.badge}</span>}
            <span className="sgt-stack">{seat.stackText}</span>
          </span>
        </div>
      </div>
      {seat.timer != null && (
        <div className="sgt-timer">
          <i style={{ width: `${seat.timer.pct}%` }} />
          <b>{seat.timer.sec}</b>
        </div>
      )}
      {/* Slumbot HU（相手が考えている間）だけが使う枠。タイマーと同じ場所・同じ見た目で、
          残り時間の代わりに「思考中」を出す（sng-play.css の .sgt-wait 参照）。 */}
      {seat.timer == null && seat.waiting && (
        <div className="sgt-wait">
          <b>思考中</b>
        </div>
      )}
      {seat.tags.length > 0 && (
        <div className="sgt-tags">
          {seat.tags.map((t) => (
            <span key={t.key} className={`sgt-tag ${t.cls}`}>
              {t.text}
            </span>
          ))}
        </div>
      )}
      {/* アクションのピルと出したチップは 1 つの箱に積む（個別に絶対配置すると、片方が
          無いときに隙間が空き、隣の席のピルと近づいて読みづらくなる）。フォールド/脱落
          した席のチップは出さない判断（そのストリートに出した額はポットへ流れた扱いで、
          「降りた席にチップが残っている」ように見せない）は呼び出し側が betText=null に
          することで表現する。 */}
      {(seat.pill || seat.betText != null) && (
        <div className="sgt-pills">
          {seat.pill && <span className={`sgt-act ${seat.pill.cls}`}>{seat.pill.label}</span>}
          {seat.betText != null && <span className="sgt-bet">{seat.betText}</span>}
        </div>
      )}
    </div>
  );
}

export function GlassTable(props: {
  /** 先頭が hero（手前・下）。以降は時計回り。長さ 2〜6。 */
  readonly seats: readonly FeltSeat[];
  readonly street: string | null;
  /** 整形済み（例 "12.5bb"）。 */
  readonly potText: string;
  /** 整形済み（例 "SPR 3.2"）。出さないときは null。 */
  readonly sprText: string | null;
  readonly board: readonly string[];
  /** 卓の上に覆いを出す（Slumbot の「次のハンドを配っています…」）。座席は消えるが卓の
      枠（.sgt-felt）はそのまま残るので、配っている間もレイアウト（卓の高さ・位置）が
      動かない。 */
  readonly overlay?: JSX.Element | null;
}): JSX.Element {
  const slots = SLOTS[props.seats.length] ?? SLOTS[6]!;

  return (
    <div className="sgt">
      <div className="sgt-felt" />
      {/* 覆いを出している間（配っている最中）は中央も描かない。空の局面を渡されると
          「POT」のラベルと額の無い数値・空のボード枠だけが覆いの下に透けて、壊れた卓に
          見える（覆いは中身を隠すためのものなので、そもそも下に何も置かないのが正しい）。 */}
      {props.overlay == null && (
        <div className="sgt-mid">
          {props.street != null && <span className="sgt-street">{props.street}</span>}
          <div className="sgt-potline">
            <span className="sgt-pot-lbl">POT</span>
            <b className="sgt-pot">{props.potText}</b>
            {props.sprText != null && <span className="sgt-spr">{props.sprText}</span>}
          </div>
          <div className="sgt-board">
            {[0, 1, 2, 3, 4].map((i) => {
              const c = props.board[i];
              return c ? <Card key={`${c}-${i}`} code={c} /> : <span key={i} className="sgt-slot" />;
            })}
          </div>
        </div>
      )}

      {props.seats.map((seat, i) => {
        const [x, y] = slots[i] ?? slots[0]!;
        return <FeltSeatView key={seat.key} seat={seat} x={x} y={y} />;
      })}

      {props.overlay != null && <div className="sgt-overlay">{props.overlay}</div>}
    </div>
  );
}
