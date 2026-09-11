import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FnResult } from '../supabase/api';
import {
  DIAG_PAGE,
  getDiagSummary,
  listDiagClientErrors,
  listDiagOcrReads,
  listDiagRuns,
  type DiagClientError,
  type DiagOcrRead,
  type DiagRun,
  type DiagSummary,
} from '../supabase/diagnostics';
import { listOcrFailures } from '../supabase/admin';
import { signedSpotImageUrl } from '../supabase/images';
import { displayModeLabelJa, summarizeOcrFailures, type OcrFailureSummary } from '../admin/format';
import {
  clientErrorKindLabelJa,
  describeCorrections,
  deviceSummary,
  fmtDateTime,
  hasCorrections,
  runSpotLine,
  runState,
  runStateLabelJa,
  stringList,
} from '../admin/diagnosticsFormat';

/** 上の件数の集計期間（日数）。 */
const SUMMARY_DAYS = 7;
/** OCR 失敗の内訳の集計期間（日数）。以前クラブ管理にあった表示と同じ。 */
const OCR_FAILURE_WINDOW_DAYS = 30;
/** スクショの署名 URL の有効時間（秒）。開いたまま眺める前提で少し長め。 */
const SHOT_URL_SEC = 600;

type Tab = 'runs' | 'ocr' | 'errors';
const TABS: { key: Tab; label: string }[] = [
  { key: 'runs', label: '計算' },
  { key: 'ocr', label: 'OCR' },
  { key: 'errors', label: 'エラー' },
];

/**
 * 診断ログ（管理者専用, 0009）。全員の計算の記録（非公開を含む）・OCR の読み取りとスクショ・
 * アプリのエラー（利用者の画面では気づかれにくいもの）を1か所で確かめる。
 * データはすべて管理者専用のサーバ関数から読む（管理者以外にはサーバが中身を渡さない）。
 */
export function Diagnostics(props: { onBack: () => void }): JSX.Element {
  const [tab, setTab] = useState<Tab>('runs');
  const [summary, setSummary] = useState<DiagSummary | null>(null);
  const [summaryErr, setSummaryErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getDiagSummary(SUMMARY_DAYS).then((r) => {
      if (!alive) return;
      if (r.ok) setSummary(r.data);
      else setSummaryErr(r.message);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="admin diag">
      <div className="pad">
        <h2 className="scr-h sm">直近{SUMMARY_DAYS}日</h2>
        {summaryErr && <p className="auth-err">{summaryErr}</p>}
        {summary && <SummaryView s={summary} />}
      </div>

      <div className="pad pt0">
        <div className="diag-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className="seg"
              aria-pressed={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'runs' && <RunsPanel />}
        {tab === 'ocr' && <OcrPanel />}
        {tab === 'errors' && <ErrorsPanel />}
      </div>

      <div className="pad pt0">
        <button type="button" className="btn ghost" onClick={props.onBack}>
          ← クラブ管理に戻る
        </button>
      </div>
    </div>
  );
}

function SummaryView(props: { s: DiagSummary }): JSX.Element {
  const s = props.s;
  const failed = s.runs_failed + s.runs_aborted;
  return (
    <>
      <div className="statrow">
        <Stat label="計算" value={s.runs_total} />
        <Stat label="失敗・中断" value={failed} warn={failed > 0} />
        <Stat
          label="OCR 失敗 / 修正あり"
          value={
            <>
              <span className={s.ocr_failed > 0 ? 'neg' : undefined}>{s.ocr_failed}</span> / {s.ocr_corrected}
            </>
          }
        />
        <Stat label="アプリのエラー" value={s.errors_total} warn={s.errors_total > 0} />
      </div>
      <p className="note">
        最後の計算: {s.last_run_at ? `${fmtDateTime(s.last_run_at)}（@${s.last_run_handle ?? '?'}）` : 'まだありません'}
        {s.runs_stuck > 0 && `・止まったままの計算 ${s.runs_stuck}件`}
      </p>
    </>
  );
}

function Stat(props: { label: string; value: ReactNode; warn?: boolean }): JSX.Element {
  return (
    <div className="stat">
      <span className="statlbl">{props.label}</span>
      <b className={`statval${props.warn ? ' loss' : ''}`}>{props.value}</b>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 一覧の読み込み（新しい順・「もっと見る」で続き）
// ---------------------------------------------------------------------------

interface Paged<T> {
  items: T[];
  busy: boolean;
  err: string | null;
  done: boolean;
  more: () => void;
}

/**
 * created_at の新しい順に DIAG_PAGE 件ずつ読む。key が変わったら（絞り込みの切り替え）最初から読み直す。
 * 切り替えの後に届いた古い応答は捨てる（一覧が混ざらないように）。
 */
function usePaged<T extends { created_at: string }>(
  load: (before: string | null) => Promise<FnResult<T[]>>,
  key: string,
): Paged<T> {
  const [items, setItems] = useState<T[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  async function fetchPage(before: string | null, reset: boolean): Promise<void> {
    const mine = ++seq.current;
    setBusy(true);
    setErr(null);
    const r = await loadRef.current(before);
    if (mine !== seq.current) return;
    setBusy(false);
    if (!r.ok) {
      setErr(r.message);
      return;
    }
    setItems((prev) => (reset ? r.data : [...prev, ...r.data]));
    setDone(r.data.length < DIAG_PAGE);
  }

  useEffect(() => {
    setItems([]);
    setDone(false);
    void fetchPage(null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return {
    items,
    busy,
    err,
    done,
    more: () => {
      const last = items[items.length - 1];
      if (last && !busy) void fetchPage(last.created_at, false);
    },
  };
}

function ListFooter(props: { list: Paged<unknown>; empty: string }): JSX.Element {
  const { list } = props;
  return (
    <>
      {list.err && <p className="auth-err">{list.err}</p>}
      {!list.busy && !list.err && list.items.length === 0 && <p className="note">{props.empty}</p>}
      {list.busy && <p className="note">読み込み中…</p>}
      {!list.busy && !list.done && list.items.length > 0 && (
        <button type="button" className="btn ghost diag-more" onClick={list.more}>
          もっと見る
        </button>
      )}
    </>
  );
}

function ProblemsToggle(props: { on: boolean; onChange: (on: boolean) => void; hint: string }): JSX.Element {
  return (
    <div className="tog">
      <div>
        問題ありだけ
        <small>{props.hint}</small>
      </div>
      <button
        type="button"
        className="sw"
        role="switch"
        aria-checked={props.on}
        aria-label="問題ありだけ"
        onClick={() => props.onChange(!props.on)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 計算
// ---------------------------------------------------------------------------

function RunsPanel(): JSX.Element {
  const [problemsOnly, setProblemsOnly] = useState(false);
  const list = usePaged((before) => listDiagRuns({ before, problemsOnly }), String(problemsOnly));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <ProblemsToggle on={problemsOnly} onChange={setProblemsOnly} hint="失敗・中断・止まったまま・OCR を直したもの" />
      <ul className="diag-list">
        {list.items.map((r) => (
          <RunRow key={r.id} run={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
        ))}
      </ul>
      <ListFooter list={list} empty="該当する計算はありません。" />
    </>
  );
}

function RunRow(props: { run: DiagRun; open: boolean; onToggle: () => void }): JSX.Element {
  const r = props.run;
  const st = runState(r.status, r.updated_at);
  const corrected = hasCorrections(r.corrections);
  const issues = stringList(r.ocr_issues);
  return (
    <li className="diag-row">
      <button type="button" className="diag-head" aria-expanded={props.open} onClick={props.onToggle}>
        <span className="diag-top">
          <span className="diag-when">{fmtDateTime(r.created_at)}</span>
          <b className="diag-who">@{r.owner_handle}</b>
          <span className={`badge st-${st}`}>{runStateLabelJa(st)}</span>
          {r.ocr_ok === false && <span className="badge st-failed">OCR失敗</span>}
          {corrected && <span className="badge st-fix">修正あり</span>}
        </span>
        <span className="diag-sub">{runSpotLine(r)}</span>
      </button>
      {props.open && (
        <div className="diag-detail">
          {r.error && (
            <DetailBlock title="エラー">
              <pre className="diag-pre">{r.error}</pre>
            </DetailBlock>
          )}
          {issues.length > 0 && (
            <DetailBlock title="OCR の指摘">
              <Lines lines={issues} />
            </DetailBlock>
          )}
          {corrected && (
            <DetailBlock title="利用者が直した箇所">
              <Lines lines={describeCorrections(r.corrections)} />
            </DetailBlock>
          )}
          <DetailBlock title="スクショ">
            <Shot path={r.image_path} />
          </DetailBlock>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

function OcrPanel(): JSX.Element {
  const [problemsOnly, setProblemsOnly] = useState(true);
  const list = usePaged((before) => listDiagOcrReads({ before, problemsOnly }), String(problemsOnly));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <OcrFailureCounts />
      <ProblemsToggle on={problemsOnly} onChange={setProblemsOnly} hint="読めなかったもの・利用者が直したもの" />
      <ul className="diag-list">
        {list.items.map((o) => (
          <OcrRow key={o.id} read={o} open={open === o.id} onToggle={() => setOpen(open === o.id ? null : o.id)} />
        ))}
      </ul>
      <ListFooter list={list} empty="該当する読み取りはありません。" />
    </>
  );
}

/** OCR 失敗の内訳（以前クラブ管理にあった表示をここへ移した）。 */
function OcrFailureCounts(): JSX.Element {
  const [sum, setSum] = useState<OcrFailureSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void listOcrFailures(OCR_FAILURE_WINDOW_DAYS).then((r) => {
      if (!alive) return;
      if (r.ok) setSum(summarizeOcrFailures(r.data));
      else setErr(r.message);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="diag-counts">
      <span className="lbl">OCR 失敗の内訳（直近{OCR_FAILURE_WINDOW_DAYS}日）</span>
      {err && <p className="auth-err">{err}</p>}
      {sum && sum.total === 0 && <p className="note">失敗はありません。</p>}
      {sum && sum.total > 0 && (
        <div className="readout">
          <div className="row">
            <span>件数</span>
            <b>{sum.total}件</b>
          </div>
          <div className="row">
            <span>表示モード別</span>
            <b>{sum.byDisplayMode.map((m) => `${displayModeLabelJa(m.mode)} ${m.count}`).join(' / ')}</b>
          </div>
          {sum.byIssueCode.map((c) => (
            <div key={c.code} className="row">
              <span className="diag-code">{c.code}</span>
              <b>{c.count}件</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OcrRow(props: { read: DiagOcrRead; open: boolean; onToggle: () => void }): JSX.Element {
  const o = props.read;
  const corrected = hasCorrections(o.corrections);
  const issues = stringList(o.issues);
  const lowConf = stringList(o.low_confidence);
  const sub = [displayModeLabelJa(o.display_mode ?? ''), deviceSummary(o.device), stringList(o.issue_codes).join(', ')]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="diag-row">
      <button type="button" className="diag-head" aria-expanded={props.open} onClick={props.onToggle}>
        <span className="diag-top">
          <span className="diag-when">{fmtDateTime(o.created_at)}</span>
          <b className="diag-who">@{o.owner_handle}</b>
          <span className={`badge ${o.ok ? 'st-done' : 'st-failed'}`}>{o.ok ? '読めた' : '読めない'}</span>
          {corrected && <span className="badge st-fix">修正あり</span>}
        </span>
        <span className="diag-sub">{sub}</span>
      </button>
      {props.open && (
        <div className="diag-detail">
          {issues.length > 0 && (
            <DetailBlock title="OCR の指摘">
              <Lines lines={issues} />
            </DetailBlock>
          )}
          {lowConf.length > 0 && (
            <DetailBlock title="自信の低い項目">
              <Lines lines={lowConf} />
            </DetailBlock>
          )}
          {corrected && (
            <DetailBlock title="利用者が直した箇所">
              <Lines lines={describeCorrections(o.corrections)} />
            </DetailBlock>
          )}
          <DetailBlock title="スクショ">
            <Shot path={o.image_path} />
          </DetailBlock>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// アプリのエラー
// ---------------------------------------------------------------------------

function ErrorsPanel(): JSX.Element {
  const list = usePaged((before) => listDiagClientErrors({ before }), 'all');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <p className="note">画面の表示失敗・想定外の例外・サーバへの保存失敗など、利用者の画面では気づかれにくいエラーです（90日で自動削除）。</p>
      <ul className="diag-list">
        {list.items.map((e) => (
          <ErrorRow key={e.id} err={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
        ))}
      </ul>
      <ListFooter list={list} empty="エラーは記録されていません。" />
    </>
  );
}

function ErrorRow(props: { err: DiagClientError; open: boolean; onToggle: () => void }): JSX.Element {
  const e = props.err;
  return (
    <li className="diag-row">
      <button type="button" className="diag-head" aria-expanded={props.open} onClick={props.onToggle}>
        <span className="diag-top">
          <span className="diag-when">{fmtDateTime(e.created_at)}</span>
          <b className="diag-who">@{e.owner_handle}</b>
          <span className="badge st-failed">{clientErrorKindLabelJa(e.kind)}</span>
        </span>
        <span className="diag-sub diag-msg">{e.message}</span>
      </button>
      {props.open && (
        <div className="diag-detail">
          <DetailBlock title="どこで">
            <p className="diag-kv">
              画面 {e.screen ?? '—'} · {deviceSummary(e.device)} · 版 {e.app_version ?? '—'}
            </p>
          </DetailBlock>
          {e.detail && (
            <DetailBlock title="詳細">
              <pre className="diag-pre">{e.detail}</pre>
            </DetailBlock>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// 共通の部品
// ---------------------------------------------------------------------------

function DetailBlock(props: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="diag-block">
      <span className="lbl">{props.title}</span>
      {props.children}
    </div>
  );
}

function Lines(props: { lines: string[] }): JSX.Element {
  return (
    <ul className="diag-lines">
      {props.lines.map((l, i) => (
        <li key={i}>{l}</li>
      ))}
    </ul>
  );
}

/**
 * 解析に使ったスクショ（端末内で圧縮した版）。private バケットなので署名 URL で出す
 * （Storage のポリシーで本人か管理者しか発行できない）。タップで別タブに原寸表示。
 */
function Shot(props: { path: string | null }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!props.path) return;
    let alive = true;
    void signedSpotImageUrl(props.path, SHOT_URL_SEC).then((r) => {
      if (!alive) return;
      if (r.ok) setUrl(r.data.url);
      else setErr(r.message);
    });
    return () => {
      alive = false;
    };
  }, [props.path]);

  if (!props.path) return <p className="note">スクショはありません（手入力、または保存期間が過ぎて削除済み）。</p>;
  if (err) return <p className="auth-err">{err}</p>;
  if (!url) return <p className="note">スクショを読み込み中…</p>;
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className="diag-shot">
      <img src={url} alt="解析に使ったスクショ" loading="lazy" />
    </a>
  );
}
