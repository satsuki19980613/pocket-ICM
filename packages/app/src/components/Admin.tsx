import { useEffect, useState } from 'react';
import { getAdminOverview, listInvites, type AdminOverview, type InviteRow } from '../supabase/admin';
import { issueInvite, revokeInvite, setMaxAccounts } from '../supabase/api';
import { canRevoke, effectiveStatus, seatsRemaining, statusLabelJa } from '../admin/format';

/**
 * 管理画面（M7・さつき専用, is_admin のみ）。登録状況／上限編集／招待キーの
 * 発行・一覧・取消。すべてサーバ側（Edge Function・RLS）で管理者を二重強制。
 * 発行された生キーは一度だけ表示（DB はハッシュのみ）。
 */
export function Admin(props: { onBack: () => void }): JSX.Element {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [maxVal, setMaxVal] = useState('');
  const [maxBusy, setMaxBusy] = useState(false);
  const [maxMsg, setMaxMsg] = useState<string | null>(null);

  const [issuing, setIssuing] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function refresh(): Promise<void> {
    const [ov, inv] = await Promise.all([getAdminOverview(), listInvites()]);
    if (ov.ok) {
      setOverview(ov.data);
      setMaxVal(String(ov.data.max_accounts));
    } else setLoadErr(ov.message);
    if (inv.ok) setInvites(inv.data);
    else setLoadErr((prev) => prev ?? inv.message);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function saveMax(): Promise<void> {
    setMaxMsg(null);
    const n = Number(maxVal);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      setMaxMsg('上限は1〜1000の整数で入力してください');
      return;
    }
    setMaxBusy(true);
    try {
      const r = await setMaxAccounts(n);
      if (!r.ok) {
        setMaxMsg(r.message);
        return;
      }
      setOverview((o) => (o ? { ...o, max_accounts: r.data.max_accounts } : o));
      setMaxMsg('保存しました');
    } finally {
      setMaxBusy(false);
    }
  }

  async function onIssue(): Promise<void> {
    setActionErr(null);
    setCopied(false);
    setNewCode(null);
    setIssuing(true);
    try {
      const r = await issueInvite();
      if (!r.ok) {
        setActionErr(r.message);
        return;
      }
      setNewCode(r.data.code);
      await refresh();
    } finally {
      setIssuing(false);
    }
  }

  async function onRevoke(id: string): Promise<void> {
    setActionErr(null);
    const r = await revokeInvite(id);
    if (!r.ok) {
      setActionErr(r.message);
      return;
    }
    await refresh();
  }

  async function copyCode(): Promise<void> {
    if (!newCode) return;
    try {
      await navigator.clipboard.writeText(newCode);
      setCopied(true);
    } catch {
      /* クリップボード不可の環境では手動コピー。 */
    }
  }

  const remaining = overview ? seatsRemaining(overview.current_count, overview.max_accounts) : 0;

  return (
    <div className="admin">
      <div className="pad">
        <h2 className="scr-h sm">登録状況</h2>
        {loadErr && <p className="auth-err">{loadErr}</p>}
        {overview && (
          <div className="capbar">
            <div className="ct">
              <span>Club Seats</span>
              <b>
                残り {remaining} / {overview.max_accounts}
              </b>
            </div>
            <div className="capline">
              {Array.from({ length: overview.max_accounts }, (_, i) => (
                <i key={i} className={i < overview.current_count ? 'f' : ''} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="pad pt0">
        <h2 className="scr-h sm">アカウント上限</h2>
        <div className="maxrow">
          <input
            className="inp"
            type="number"
            min={1}
            max={1000}
            value={maxVal}
            onChange={(e) => setMaxVal(e.target.value)}
          />
          <button type="button" className="btn ghost" disabled={maxBusy} onClick={() => void saveMax()}>
            {maxBusy ? '保存中…' : '保存'}
          </button>
        </div>
        {maxMsg && <p className="note">{maxMsg}</p>}
      </div>

      <div className="pad pt0">
        <h2 className="scr-h sm">招待キー</h2>
        {actionErr && <p className="auth-err">{actionErr}</p>}
        <button type="button" className="btn" disabled={issuing || remaining <= 0} onClick={() => void onIssue()}>
          {issuing ? '発行中…' : '招待キーを発行する'}
        </button>
        {remaining <= 0 && <p className="note">空き枠がありません。上限を増やすと発行できます。</p>}

        {newCode && (
          <div className="newkey">
            <div className="kv">{newCode}</div>
            <button type="button" className="btn ghost" onClick={() => void copyCode()}>
              {copied ? 'コピーしました' : 'コピー'}
            </button>
            <p className="note">このキーは今だけ表示されます。相手に渡してください（7日間有効・使い捨て）。</p>
          </div>
        )}

        <ul className="invlist">
          {invites.length === 0 && <li className="empty">まだ発行していません。</li>}
          {invites.map((row) => {
            const eff = effectiveStatus(row.status, row.expires_at);
            return (
              <li key={row.id} className="invrow">
                <span className="ref">#{row.ref}</span>
                <span className={`badge st-${eff}`}>{statusLabelJa(eff)}</span>
                <span className="exp">{fmtDate(row.expires_at)}まで</span>
                {canRevoke(row.status, row.expires_at) && (
                  <button type="button" className="edit" onClick={() => void onRevoke(row.id)}>
                    取消
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="pad pt0">
        <button type="button" className="btn ghost" onClick={props.onBack}>
          ← 設定に戻る
        </button>
      </div>
    </div>
  );
}

/** yyyy/m/d 形式（時刻は省略）。 */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
