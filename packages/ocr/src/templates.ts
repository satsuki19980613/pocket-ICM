/**
 * テンプレ JSON → Template[]（同梱テンプレの読み込み中核）。
 *
 * 確定版テンプレは `packages/ocr/assets/*.json` にコミットして同梱する
 * （さつき承認方針: src へコミット同梱）。生成は dev スクリプトが行うが、
 * JSON → Template の変換はここに集約して「単一の真実」にする
 * （dev スクリプト・製品アプリの双方が本 helper を通す）。
 *
 * JSON は 2 形式を受ける（生成器の履歴差）:
 *  - object 形: `{ templates: { "<label>": { w, h, data } } }`（例: digits）
 *  - array  形: `{ templates: [ { label, w, h, data } ] }`（例: ranks/actions/letters）
 *
 * `data` は Gray のグレースケール画素列（0-255）。JSON では number[] なので
 * Uint8Array に詰め直す。
 */

import type { Template } from './match.js';

interface RawGlyph {
  readonly label?: string;
  readonly w: number;
  readonly h: number;
  readonly data: readonly number[];
}

interface RawTemplatesFile {
  readonly templates: readonly RawGlyph[] | Readonly<Record<string, RawGlyph>>;
}

function toTemplate(label: string, g: RawGlyph): Template {
  return { label, img: { w: g.w, h: g.h, data: Uint8Array.from(g.data) } };
}

/**
 * テンプレ JSON（object 形／array 形の双方）を Template[] に変換する。
 * array 形の各要素は `label` を必須とする。
 */
export function templatesFromJson(json: RawTemplatesFile): Template[] {
  const t = json.templates;
  if (Array.isArray(t)) {
    return t.map((g) => {
      if (g.label === undefined) {
        throw new TypeError('templatesFromJson: array template is missing "label"');
      }
      return toTemplate(g.label, g);
    });
  }
  return Object.entries(t as Record<string, RawGlyph>).map(([label, g]) => toTemplate(label, g));
}
