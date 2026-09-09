// 管理画面の純ロジック（Node テスト可）。招待キーの状態導出・残枠計算。
// invite_codes.status は unused/used/revoked。expired は expires_at からの導出（DB に列は無い）。

export type InviteStatus = 'unused' | 'used' | 'revoked';

/** 残り枠（負にはしない）。 */
export function seatsRemaining(current: number, max: number): number {
  return Math.max(0, max - current);
}

/** 未使用キーが期限切れか（now は ISO or epoch ms）。 */
export function isExpired(expiresAt: string, now: number = Date.now()): boolean {
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= now;
}

/** 表示用の実効ステータス（未使用でも期限切れは 'expired'）。 */
export function effectiveStatus(
  status: InviteStatus,
  expiresAt: string,
  now: number = Date.now(),
): 'unused' | 'used' | 'revoked' | 'expired' {
  if (status === 'unused' && isExpired(expiresAt, now)) return 'expired';
  return status;
}

/** 取消できるのは「未使用かつ未期限切れ」のみ。 */
export function canRevoke(status: InviteStatus, expiresAt: string, now: number = Date.now()): boolean {
  return status === 'unused' && !isExpired(expiresAt, now);
}

/** 実効ステータスの日本語ラベル。 */
export function statusLabelJa(s: 'unused' | 'used' | 'revoked' | 'expired'): string {
  switch (s) {
    case 'unused':
      return '未使用';
    case 'used':
      return '使用済み';
    case 'revoked':
      return '取消済み';
    case 'expired':
      return '期限切れ';
  }
}

// ---------------------------------------------------------------------------
// ストレージ使用量（SPEC §4.2/§7.2）。
// `admin.ts` は `images` の生行（bytes/protected）を返すだけに留め、合算・比率・
// 警告判定はここに純関数として置く（Node テスト可能にするため）。
// ---------------------------------------------------------------------------

/** 集計に使う `images` の最小行（`admin.ts#listImageStats` が返す形）。 */
export interface ImageStatRow {
  bytes: number | null;
  protected: boolean;
}

export interface StorageSummary {
  totalBytes: number;
  totalCount: number;
  /** 成功画像（`protected=false`）＝90日で自動削除される側。 */
  successBytes: number;
  successCount: number;
  /** 保護画像（`protected=true`）＝OCR 失敗・低信頼で無期限保持される側。 */
  protectedBytes: number;
  protectedCount: number;
  /** 総量の上限（既定 700MB・§7.2-3）。 */
  capBytes: number;
  /** 上限までの余裕（負にはしない）。 */
  headroomBytes: number;
  /** 保護画像だけの警告しきい値（既定 300MB・§7.2-3）。 */
  protectedWarnBytes: number;
  /** 保護画像だけでしきい値を超えたか（超えたら管理画面で赤警告）。 */
  protectedWarn: boolean;
}

/** 総量の上限（§7.2-3: これを超えたら古い成功画像から自動削除）。 */
export const STORAGE_CAP_BYTES = 700 * 1024 * 1024;
/** 保護画像だけの警告しきい値（§7.2-3: 超えたら管理画面で警告し、さつきが手動整理）。 */
export const PROTECTED_WARN_BYTES = 300 * 1024 * 1024;

/** `images` の生行から総量・内訳・上限までの余裕・警告有無を計算する（純関数）。 */
export function summarizeStorage(
  rows: readonly ImageStatRow[],
  capBytes: number = STORAGE_CAP_BYTES,
  protectedWarnBytes: number = PROTECTED_WARN_BYTES,
): StorageSummary {
  let totalBytes = 0;
  let successBytes = 0;
  let successCount = 0;
  let protectedBytes = 0;
  let protectedCount = 0;
  for (const row of rows) {
    const bytes = row.bytes ?? 0;
    totalBytes += bytes;
    if (row.protected) {
      protectedBytes += bytes;
      protectedCount += 1;
    } else {
      successBytes += bytes;
      successCount += 1;
    }
  }
  return {
    totalBytes,
    totalCount: rows.length,
    successBytes,
    successCount,
    protectedBytes,
    protectedCount,
    capBytes,
    headroomBytes: Math.max(0, capBytes - totalBytes),
    protectedWarnBytes,
    protectedWarn: protectedBytes > protectedWarnBytes,
  };
}

/** バイト数を読みやすい MB/GB 表記へ（1000MB 未満は MB、以上は GB）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1000) return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// OCR 失敗の件数（SPEC §4.2/§12.3）。
// `admin.ts` は `ocr_reads`（ok=false・直近N日）の生行（issue_codes/display_mode）を
// 返すだけに留め、内訳の集計はここに置く。画像そのものはここでも扱わない（一覧表示しない）。
// ---------------------------------------------------------------------------

/** 集計に使う `ocr_reads` の最小行（`admin.ts#listOcrFailures` が返す形）。 */
export interface OcrFailureRow {
  issue_codes: unknown;
  display_mode: string | null;
}

export interface IssueCodeCount {
  code: string;
  count: number;
}

export interface DisplayModeCount {
  /** 'bb' | 'chips' | 'unknown'（display_mode 未記録＝street_not_preflop 等で手前棄却）。 */
  mode: string;
  count: number;
}

export interface OcrFailureSummary {
  total: number;
  /** 件数の多い順（同数は理由コードの辞書順）。 */
  byIssueCode: IssueCodeCount[];
  /** 件数の多い順。 */
  byDisplayMode: DisplayModeCount[];
}

/** `display_mode` が無い行（プリフロップ以外棄却等でここまで届かない）のラベル。 */
export const UNKNOWN_DISPLAY_MODE = 'unknown';

/**
 * `ocr_reads`（ok=false）の生行から、issue_codes 別・display_mode 別の内訳を集計する（純関数）。
 * `issue_codes` は jsonb（文字列配列）なので形を信用せず防御的に読む。
 */
export function summarizeOcrFailures(rows: readonly OcrFailureRow[], topN = 5): OcrFailureSummary {
  const issueCounts = new Map<string, number>();
  const modeCounts = new Map<string, number>();
  for (const row of rows) {
    const codes = Array.isArray(row.issue_codes) ? row.issue_codes : [];
    for (const code of codes) {
      if (typeof code !== 'string' || code.length === 0) continue;
      issueCounts.set(code, (issueCounts.get(code) ?? 0) + 1);
    }
    const mode = row.display_mode && row.display_mode.length > 0 ? row.display_mode : UNKNOWN_DISPLAY_MODE;
    modeCounts.set(mode, (modeCounts.get(mode) ?? 0) + 1);
  }
  const byCount = <T extends { count: number }>(a: T, b: T, key: (x: T) => string): number =>
    b.count - a.count || key(a).localeCompare(key(b));
  const byIssueCode = [...issueCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => byCount(a, b, (x) => x.code))
    .slice(0, topN);
  const byDisplayMode = [...modeCounts.entries()]
    .map(([mode, count]) => ({ mode, count }))
    .sort((a, b) => byCount(a, b, (x) => x.mode));
  return { total: rows.length, byIssueCode, byDisplayMode };
}

/** 表示モードの日本語ラベル（管理画面用）。 */
export function displayModeLabelJa(mode: string): string {
  switch (mode) {
    case 'bb':
      return 'BB表示';
    case 'chips':
      return 'チップ表示';
    default:
      return '不明';
  }
}
