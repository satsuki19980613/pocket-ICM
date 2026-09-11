// 診断ログ（管理者専用, 0009）の純ロジック（Node テスト可）。計算の状態の導出・ラベル・OCR 修正差分の読み下し。
// サーバの行（jsonb 列）は形を信用せず防御的に読む。

/** 「計算中」のまま止まったとみなすまでの時間。0009 の SQL（interval '10 minutes'）と揃える。 */
export const STUCK_AFTER_MS = 10 * 60 * 1000;

/** 表示用の計算の状態。stuck = solving のまま STUCK_AFTER_MS 以上経った（端末で計算が止まった）。 */
export type RunState = 'done' | 'failed' | 'aborted' | 'solving' | 'stuck';

export function runState(status: string, updatedAt: string, now: number = Date.now()): RunState {
  switch (status) {
    case 'done':
    case 'failed':
    case 'aborted':
      return status;
    case 'solving': {
      const t = Date.parse(updatedAt);
      return Number.isFinite(t) && now - t >= STUCK_AFTER_MS ? 'stuck' : 'solving';
    }
    default:
      // DB の CHECK で起こらないが、知らない状態は問題ありとして目立たせる。
      return 'failed';
  }
}

export function runStateLabelJa(s: RunState): string {
  switch (s) {
    case 'done':
      return '完了';
    case 'failed':
      return '失敗';
    case 'aborted':
      return '中断';
    case 'solving':
      return '計算中';
    case 'stuck':
      return '止まったまま';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * OCR の読み取りから利用者が1か所でも直したか（0009 の diag_has_corrections と同じ判定）。
 * corrections は ocrLog.ts の diffStates の形（seats は常にあり、他は変わったときだけ入る）。
 */
export function hasCorrections(c: unknown): boolean {
  if (!isObj(c)) return false;
  if (Object.keys(c).some((k) => k !== 'seats')) return true;
  return Array.isArray(c.seats) && c.seats.length > 0;
}

const SEAT_FIELD_JA: Record<string, string> = { stack: 'スタック', bet: 'ベット', state: '状態' };

const fmtValue = (v: unknown): string => (typeof v === 'number' || typeof v === 'string' ? String(v) : '?');

function diffLine(label: string, d: unknown): string | null {
  if (!isObj(d) || !('from' in d) || !('to' in d)) return null;
  return `${label}: ${fmtValue(d.from)} → ${fmtValue(d.to)}`;
}

/** 利用者が直した箇所を1行ずつ（「BTN スタック: 12.5 → 15」など）。 */
export function describeCorrections(c: unknown): string[] {
  if (!isObj(c)) return [];
  const out: string[] = [];
  const push = (line: string | null): void => {
    if (line) out.push(line);
  };
  push(diffLine('人数', c.playersLeft));
  push(diffLine('ヒーローの位置', c.heroPos));
  push(diffLine('ハンド', c.heroHand));
  if (isObj(c.blinds)) {
    push(diffLine('SB', c.blinds.sb));
    push(diffLine('BB', c.blinds.bb));
  }
  if (isObj(c.ante)) {
    push(diffLine('アンティ方式', c.ante.scheme));
    push(diffLine('アンティ', c.ante.amount));
  }
  if (Array.isArray(c.seats)) {
    for (const s of c.seats) {
      if (!isObj(s)) continue;
      const field = typeof s.field === 'string' ? (SEAT_FIELD_JA[s.field] ?? s.field) : '?';
      push(diffLine(`${fmtValue(s.pos)} ${field}`, s));
    }
  }
  return out;
}

/** jsonb の文字列配列（issues / issue_codes / low_confidence）を防御的に読む。 */
export function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

/** client_errors.kind の日本語ラベル（errorReport.ts の ClientErrorKind と揃える）。 */
export function clientErrorKindLabelJa(kind: string): string {
  switch (kind) {
    case 'error':
      return '実行時エラー';
    case 'rejection':
      return '非同期処理の失敗';
    case 'render':
      return '画面の表示失敗';
    case 'ocr':
      return 'OCR の例外';
    case 'sync':
      return 'サーバへの保存失敗';
    default:
      return kind;
  }
}

/** 端末の時刻で「9/11 09:05」。 */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 計算にかかった時間（1秒未満は ms、以上は秒・小数1桁）。 */
export function formatSolveMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}秒`;
}

/** 端末の種類と画面の大きさ（device = { ua, w, h, ... }）。iPhone の UA は "like Mac OS X" を含むので先に見る。 */
export function deviceSummary(device: unknown): string {
  if (!isObj(device)) return '—';
  const ua = typeof device.ua === 'string' ? device.ua : '';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : 'その他';
  const w = typeof device.w === 'number' && device.w > 0 ? device.w : null;
  const h = typeof device.h === 'number' && device.h > 0 ? device.h : null;
  return w && h ? `${os} ${w}×${h}` : os;
}

/** 計算1件の中身の要約（「5人 · BTN AKo · 2.3秒 · 非公開」）。 */
export function runSpotLine(run: {
  players_left: number | null;
  hero_pos: string | null;
  hero_hand: string | null;
  solve_ms: number | null;
  is_public: boolean;
}): string {
  const parts: string[] = [];
  if (run.players_left) parts.push(`${run.players_left}人`);
  const hero = [run.hero_pos, run.hero_hand].filter(Boolean).join(' ');
  if (hero) parts.push(hero);
  if (run.solve_ms !== null) parts.push(formatSolveMs(run.solve_ms));
  parts.push(run.is_public ? '公開' : '非公開');
  return parts.join(' · ');
}
