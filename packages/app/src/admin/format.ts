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
