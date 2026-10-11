/**
 * 較正スクリプト（dev 専用）の CLI 引数パスを検証する共通ヘルパ。
 *
 * argv 由来のパスを path.resolve（cwd 基準＝従来どおり相対/絶対どちらも可）し、許可ディレクトリ配下に
 * 収まることを確かめてから返す。外れたら例外（`..` 等で意図しない場所を読み書きしない）。
 *
 * 許可ディレクトリ:
 *   - リポジトリルート（このファイルの位置から算出）
 *   - OS の一時ディレクトリ（os.tmpdir(): オーバーレイ等の出力先に使う）
 *   - 環境変数 OCR_SCRIPT_ALLOWED_DIRS（path.delimiter 区切り。Windows は `;`, それ以外は `:`）
 *     例: OCR_SCRIPT_ALLOWED_DIRS="$HOME/Downloads" npx tsx scripts/annotate.ts ~/Downloads/a.png out.png
 */
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** リポジトリルート（packages/ocr/scripts/ から 3 階層上）。 */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

function allowedBases(): string[] {
  const extra = (process.env.OCR_SCRIPT_ALLOWED_DIRS ?? '')
    .split(delimiter)
    .filter((d) => d.trim() !== '')
    .map((d) => resolve(d));
  return [REPO_ROOT, resolve(tmpdir()), ...extra];
}

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  if (rel === '') return true;
  // 別ドライブ（Windows）は絶対パスが返る。`..` で始まる要素は base の外。
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * CLI 引数のパスを解決し、許可ディレクトリ配下なら絶対パスを返す。外なら例外。
 * @param p    argv 由来のパス（相対なら cwd 基準）
 * @param what エラーメッセージ用の引数名
 */
export function safePath(p: string, what = 'path'): string {
  const abs = resolve(p);
  const bases = allowedBases();
  if (bases.some((b) => isInside(b, abs))) return abs;
  throw new Error(
    `${what}: 許可ディレクトリ外のパスです: ${abs}\n` +
      `  許可: ${bases.join(', ')}\n` +
      `  （必要なら OCR_SCRIPT_ALLOWED_DIRS にディレクトリを追加）`,
  );
}
