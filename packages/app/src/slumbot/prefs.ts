/**
 * Slumbot 対戦の「ゲーム設定」（設定モーダルの 1 枚目タブ）。
 * ベットサイズ（sizes.ts）とは別枠の、進行まわりの好みだけを持つ。
 */

export interface GamePrefs {
  /** ハンドが終わったら自動で次のハンドを配る。 */
  readonly autoNext: boolean;
  /** 相手のアクションを見せる最短時間（ms）。0 なら即座に自分の番へ。 */
  readonly revealMs: number;
  /**
   * BGM を鳴らす（対戦画面の ♪ ボタン）。既定は OFF——音は本人が望んだときだけ出す。
   * 覚えておくのは「次に入ったときも鳴らしてほしい」が自然なため。ただしブラウザに
   * 自動再生を拒否されたら、対戦画面側がこの値を false に戻す（bgm.ts）。
   */
  readonly bgmOn: boolean;
}

export const DEFAULT_PREFS: GamePrefs = { autoNext: false, revealMs: 600, bgmOn: false };

export const REVEAL_CHOICES = [0, 300, 600, 1000] as const;

const KEY = 'icm.slumbot.prefs.v1';

export function loadPrefs(store: Pick<Storage, 'getItem'> | null): GamePrefs {
  if (!store) return DEFAULT_PREFS;
  try {
    const raw = store.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const o = JSON.parse(raw) as Record<string, unknown>;
    const reveal = REVEAL_CHOICES.find((v) => v === o.revealMs) ?? DEFAULT_PREFS.revealMs;
    return {
      autoNext: typeof o.autoNext === 'boolean' ? o.autoNext : DEFAULT_PREFS.autoNext,
      revealMs: reveal,
      bgmOn: typeof o.bgmOn === 'boolean' ? o.bgmOn : DEFAULT_PREFS.bgmOn,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(store: Pick<Storage, 'setItem'> | null, p: GamePrefs): void {
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 書けない環境でも進行は止めない。 */
  }
}

/** Slumbot のセッショントークン（席が交互に回るので、アプリを閉じても引き継ぐ）。 */
const TOKEN_KEY = 'icm.slumbot.token.v1';

export function loadToken(store: Pick<Storage, 'getItem'> | null): string | null {
  if (!store) return null;
  try {
    const v = store.getItem(TOKEN_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function saveToken(store: Pick<Storage, 'setItem'> | null, token: string): void {
  if (!store) return;
  try {
    store.setItem(TOKEN_KEY, token);
  } catch {
    /* noop */
  }
}
