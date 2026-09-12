/**
 * BGM の曲一覧。
 *
 * 音源は `src/assets/bgm/*.mp3` を **ビルド時に自動で拾う**（`import.meta.glob`）。曲を増やすのは
 * ファイルを置くだけで済み、コードを触る必要はない（置き方はそのフォルダの README）。
 *
 * 配信 URL には内容ハッシュが付く（`/assets/xxx-<hash>.mp3`）ので、
 *   - 差し替えても古い音源が残らない（URL が変わる）
 *   - `_headers` の `/assets/*` で長期キャッシュが効く
 * の両方が同時に成り立つ。**保存に使う id はハッシュ付き URL ではなくファイル名**——URL は
 * ビルドごとに変わるので、選んだ曲を覚えるのには使えない。
 */

export interface BgmTrack {
  /** 保存用の id（＝拡張子付きのファイル名）。 */
  readonly id: string;
  /** 画面に出す曲名（ファイル名から作る）。 */
  readonly label: string;
  /** 配信 URL（内容ハッシュ付き）。 */
  readonly src: string;
}

/**
 * ファイル名から曲名を作る。
 * 先頭の並び順の指定（`01-` `02_`）は外し、`-` `_` は空白にする。
 * 例: `01-neon-drive.mp3` → `neon drive`
 */
export function labelFromFileName(file: string): string {
  const base = file.replace(/\.[^.]+$/, '');
  // 「数字＋区切り」で始まるときだけ外す（`2024年.mp3` のような曲名は消さない）。
  const withoutOrder = base.replace(/^\d+\s*[-_]\s*/, '');
  const label = withoutOrder.replace(/[-_]+/g, ' ').trim();
  // 全部が並び順だった（`01.mp3` など）ときは、元の名前をそのまま見せる。
  return label === '' ? base : label;
}

/** `import.meta.glob` の結果（パス → URL）から曲一覧を作る。並びはファイル名順。 */
export function buildTracks(map: Record<string, string>): BgmTrack[] {
  return Object.entries(map)
    .map(([path, src]) => {
      const id = path.slice(path.lastIndexOf('/') + 1);
      return { id, label: labelFromFileName(id), src };
    })
    .sort((a, b) => a.id.localeCompare(b.id, 'ja'));
}

/** 置いてある曲の一覧（0 件なら BGM ボタンそのものを出さない）。 */
export const BGM_TRACKS: readonly BgmTrack[] = buildTracks(
  import.meta.glob('../assets/bgm/*.mp3', {
    query: '?url',
    import: 'default',
    eager: true,
  }) as Record<string, string>,
);

/**
 * 保存された id から鳴らす曲を決める。
 * 見つからなければ先頭の曲に落とす（曲を消した・名前を変えた後も鳴らなくならないように）。
 */
export function resolveTrack(tracks: readonly BgmTrack[], id: string | null): BgmTrack | null {
  if (tracks.length === 0) return null;
  return tracks.find((t) => t.id === id) ?? tracks[0]!;
}
