import { useRef, useState } from 'react';
import type { FeedAuthor, ThreadComment, ThreadDetail } from '../supabase/feed';
import { ResultCard } from './ResultCard';
import { Avatar, relTime } from './feedShared';

type Ack = { ok: boolean; message?: string };

/**
 * スレッド詳細（M6）。公開結果の見出しカード＋♡＋コメント一覧＋返信（画像添付）。
 * 自分のコメントは編集/削除できる。ミューテーション後は親（App）が再取得して反映する。
 */
export function Thread(props: {
  detail: ThreadDetail;
  onOpenResult: () => void;
  onOpenAuthor: (author: FeedAuthor) => void;
  onToggleLike: (on: boolean) => void;
  onReply: (input: { body: string; imageFile: File | null }) => Promise<Ack>;
  onEditComment: (commentId: string, body: string) => Promise<Ack>;
  onDeleteComment: (commentId: string) => Promise<Ack>;
}): JSX.Element {
  const d = props.detail;
  return (
    <div className="thread">
      <div className="thread-head">
        <Avatar author={d.author} onClick={() => props.onOpenAuthor(d.author)} />
        <div className="col">
          <div className="meta">
            <button type="button" className="meta-author" onClick={() => props.onOpenAuthor(d.author)}>
              <b>{d.author.display_name}</b>
              <i>@{d.author.handle}</i>
            </button>
            <i>・{relTime(d.created_at)}</i>
          </div>
          <ResultCard result={d.result} onOpen={props.onOpenResult} />
          <div className="acts">
            <span>💬 {d.comments.length}</span>
            <button
              type="button"
              className={d.liked_by_me ? 'liked' : undefined}
              aria-pressed={d.liked_by_me}
              onClick={() => props.onToggleLike(!d.liked_by_me)}
            >
              {d.liked_by_me ? '♥' : '♡'} {d.like_count}
            </button>
          </div>
        </div>
      </div>

      <div className="comments">
        {d.comments.length === 0 && <p className="feed-note">まだ返信はありません。最初のひとことをどうぞ。</p>}
        {d.comments.map((c) => (
          <CommentRow
            key={c.id}
            comment={c}
            onOpenAuthor={() => props.onOpenAuthor(c.author)}
            onEdit={(body) => props.onEditComment(c.id, body)}
            onDelete={() => props.onDeleteComment(c.id)}
          />
        ))}
      </div>

      <Composer onReply={props.onReply} />
    </div>
  );
}

function CommentRow(props: {
  comment: ThreadComment;
  onOpenAuthor: () => void;
  onEdit: (body: string) => Promise<Ack>;
  onDelete: () => Promise<Ack>;
}): JSX.Element {
  const c = props.comment;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function saveEdit(): Promise<void> {
    setBusy(true);
    setErr('');
    const res = await props.onEdit(draft);
    setBusy(false);
    if (res.ok) setEditing(false);
    else setErr(res.message ?? '編集できませんでした');
  }

  async function del(): Promise<void> {
    if (!confirm('このコメントを削除しますか？')) return;
    setBusy(true);
    setErr('');
    const res = await props.onDelete();
    setBusy(false);
    if (!res.ok) setErr(res.message ?? '削除できませんでした');
  }

  return (
    <article className="cmt">
      <Avatar author={c.author} onClick={props.onOpenAuthor} />
      <div className="col">
        <div className="meta">
          <button type="button" className="meta-author" onClick={props.onOpenAuthor}>
            <b>{c.author.display_name}</b>
            <i>@{c.author.handle}</i>
          </button>
          <i>・{relTime(c.created_at)}</i>
          {c.updated_at && <i>（編集済み）</i>}
        </div>
        {editing ? (
          <div className="cmt-edit">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={2000}
              rows={2}
              disabled={busy}
            />
            {err && <p className="auth-err">{err}</p>}
            <div className="cmt-edit-acts">
              <button type="button" className="btn sm" onClick={() => void saveEdit()} disabled={busy || !draft.trim()}>
                {busy ? '保存中…' : '保存'}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  setEditing(false);
                  setDraft(c.body ?? '');
                  setErr('');
                }}
                disabled={busy}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <>
            {c.body && <p>{c.body}</p>}
            {c.image_url && (
              <a href={c.image_url} target="_blank" rel="noreferrer" className="cmt-img">
                <img src={c.image_url} alt="添付画像" />
              </a>
            )}
            {err && <p className="auth-err">{err}</p>}
            {c.mine && (
              <div className="cmt-own-acts">
                <button type="button" onClick={() => setEditing(true)} disabled={busy}>
                  編集
                </button>
                <button type="button" onClick={() => void del()} disabled={busy}>
                  削除
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function Composer(props: {
  onReply: (input: { body: string; imageFile: File | null }) => Promise<Ack>;
}): JSX.Element {
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  function pickImage(f: File | null): void {
    setFile(f);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return f ? URL.createObjectURL(f) : null;
    });
  }

  async function send(): Promise<void> {
    if (!body.trim() && !file) return;
    setBusy(true);
    setErr('');
    const res = await props.onReply({ body: body.trim(), imageFile: file });
    setBusy(false);
    if (res.ok) {
      setBody('');
      pickImage(null);
      if (fileRef.current) fileRef.current.value = '';
    } else {
      setErr(res.message ?? '投稿できませんでした');
    }
  }

  return (
    <div className="composer">
      {preview && (
        <div className="composer-preview">
          <img src={preview} alt="添付プレビュー" />
          <button type="button" onClick={() => pickImage(null)} aria-label="画像を外す">
            ✕
          </button>
        </div>
      )}
      {err && <p className="auth-err">{err}</p>}
      <div className="composer-row">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="返信する…"
          maxLength={2000}
          rows={1}
          disabled={busy}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => pickImage(e.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          className="composer-img"
          onClick={() => fileRef.current?.click()}
          aria-label="画像を添付"
          disabled={busy}
        >
          📷
        </button>
        <button type="button" className="btn sm" onClick={() => void send()} disabled={busy || (!body.trim() && !file)}>
          {busy ? '送信中…' : '返信'}
        </button>
      </div>
    </div>
  );
}
