import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { FeedAuthor, ThreadComment, ThreadDetail } from '../supabase/feed';
import { ResultCard } from './ResultCard';
import { Avatar, relTime } from './feedShared';
import { useBackLayer } from './BackLayer';
import { useStorageImage } from '../supabase/storageUrls';

type Ack = { ok: boolean; message?: string };

/**
 * 添付画像（タップで別タブに原寸表示）。このアプリの Storage の参照だけを署名 URL にして出す。
 * 形の不正な参照（javascript: や外部 URL）はリンクにも画像にもしない（storageUrls.ts）。
 */
function AttachedImage(props: { refUrl: string | null }): JSX.Element | null {
  const src = useStorageImage(props.refUrl, 'thread-images');
  if (!src) return null;
  return (
    <a href={src} target="_blank" rel="noreferrer noopener" className="cmt-img">
      <img src={src} alt="添付画像" />
    </a>
  );
}

/**
 * スレッド画面を開いている間だけ、ソフトキーボードが出たらレイアウトごと縮めるようブラウザに頼む
 * （viewport の interactive-widget=resizes-content）。こうするとキーボードの上端がレイアウトの下端になり、
 * bottom:0 の返信欄は CSS だけでキーボードの真上に固定される（スクロールで JS が追いかけないのでがたつかない）。
 * 既定（resizes-visual）のままだと、見えている範囲が縮むだけで返信欄はキーボードの裏に回る。
 * Chrome/Samsung Internet（Android）と Firefox Android が対応。iOS Safari は未対応で、下の
 * useKeyboardInset が代わりに持ち上げる。アプリ全体に掛けると他画面の下段タブまでキーボードの上に
 * 乗ってしまうので、この画面の間だけにして、離れたら元に戻す（Chromium は meta の書き換えを即反映する）。
 */
function useResizesContentKeyboard(): void {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const original = meta.content;
    if (/interactive-widget/.test(original)) return;
    meta.content = `${original}, interactive-widget=resizes-content`;
    return () => {
      meta.content = original;
    };
  }, []);
}

/**
 * useResizesContentKeyboard が効かない端末（iOS Safari）向けの代替。キーボードに隠れている画面下端の
 * 高さを el の CSS 変数 --kb（px）に書き、返信欄の bottom に足す。
 * 対応端末ではレイアウトごと縮むので、この差（innerHeight − 見えている範囲の下端）は常に 0 になり何もしない。
 * iOS ではスクロールのたびに見えている範囲がずれるので scroll も聞く（その分 1 フレーム遅れて追従する）。
 */
function useKeyboardInset(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return;
    let current = -1;
    const update = (): void => {
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      if (inset === current) return;
      current = inset;
      el.style.setProperty('--kb', `${inset}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [ref]);
}

/**
 * スレッド詳細（M6・v3 で通常投稿にも対応）。見出しは種別で切り替える
 * （結果投稿＝ResultCard / 通常投稿＝本文＋画像, SPEC §5.1.3）。＋♡＋コメント一覧＋返信（画像添付）。
 * 自分のコメントに加え、自分の通常投稿も本文の編集/削除ができる（PostHead）。
 * ミューテーション後は親（App）が再取得して反映する。
 */
export function Thread(props: {
  detail: ThreadDetail;
  onOpenResult: () => void;
  onOpenAuthor: (author: FeedAuthor) => void;
  onToggleLike: (on: boolean) => void;
  onReply: (input: { body: string; imageFile: File | null }) => Promise<Ack>;
  onEditComment: (commentId: string, body: string) => Promise<Ack>;
  onDeleteComment: (commentId: string) => Promise<Ack>;
  /** 自分の通常投稿の本文編集（SPEC §5.1.2）。 */
  onEditPost: (body: string) => Promise<Ack>;
  /** 自分の通常投稿の削除（削除後は呼び出し側=App がホームへ戻す）。 */
  onDeletePost: () => Promise<Ack>;
}): JSX.Element {
  const d = props.detail;
  const rootRef = useRef<HTMLDivElement>(null);
  useResizesContentKeyboard();
  useKeyboardInset(rootRef);
  return (
    <div className="thread" ref={rootRef}>
      <div className="thread-head">
        <Avatar author={d.author} onClick={() => props.onOpenAuthor(d.author)} />
        <div className="col">
          <div className="meta">
            <button type="button" className="meta-author" onClick={() => props.onOpenAuthor(d.author)}>
              <b>@{d.author.handle}</b>
            </button>
            <i>・{relTime(d.created_at)}</i>
            {d.kind === 'post' && d.updated_at && <i>（編集済み）</i>}
          </div>
          {d.kind === 'result' && d.result ? (
            <>
              {d.body && <p className="post-body-text">{d.body}</p>}
              <ResultCard result={d.result} onOpen={props.onOpenResult} />
            </>
          ) : (
            <PostHead
              body={d.body}
              imageUrl={d.image_url}
              mine={d.mine}
              onEdit={props.onEditPost}
              onDelete={props.onDeletePost}
            />
          )}
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

/**
 * 通常投稿の見出し（本文＋画像）。自分の投稿なら編集/削除ができる（CommentRow と同じ作法）。
 * 画像はコメント添付画像と同じ「タップで別タブに原寸表示」（SPEC §5.1.3 の「既存コメント画像と
 * 同じ作法」）。
 */
function PostHead(props: {
  body: string | null;
  imageUrl: string | null;
  mine: boolean;
  onEdit: (body: string) => Promise<Ack>;
  onDelete: () => Promise<Ack>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.body ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // 編集中の端末の戻る／Esc は「取消」（スレッドから出てしまわない）。
  useBackLayer(() => setEditing(false), editing);

  async function saveEdit(): Promise<void> {
    setBusy(true);
    setErr('');
    const res = await props.onEdit(draft);
    setBusy(false);
    if (res.ok) setEditing(false);
    else setErr(res.message ?? '編集できませんでした');
  }

  async function del(): Promise<void> {
    if (!confirm('この投稿を削除しますか？返信もすべて削除されます。')) return;
    setBusy(true);
    setErr('');
    const res = await props.onDelete();
    setBusy(false);
    if (!res.ok) setErr(res.message ?? '削除できませんでした');
  }

  if (editing) {
    return (
      <div className="cmt-edit">
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={2000} rows={4} disabled={busy} />
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
              setDraft(props.body ?? '');
              setErr('');
            }}
            disabled={busy}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {props.body && <p className="post-body-text">{props.body}</p>}
      <AttachedImage refUrl={props.imageUrl} />
      {err && <p className="auth-err">{err}</p>}
      {props.mine && (
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

  // 編集中の端末の戻る／Esc は「取消」（スレッドから出てしまわない）。
  useBackLayer(() => setEditing(false), editing);

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
            <b>@{c.author.handle}</b>
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
            <AttachedImage refUrl={c.image_url} />
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
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // LINE のように行数に合わせて縦に伸ばす（CSS の max-height＝5 行で頭打ち、その先は中でスクロール）。
  // 送信後に空へ戻したときも 1 行に縮むよう、本文が変わるたびに測り直す。
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [body]);

  // 返信欄が伸びた分だけスレッドの下余白も広げ、最後の返信が返信欄の裏に隠れないようにする。
  useEffect(() => {
    const el = rootRef.current;
    const host = el?.parentElement;
    if (!el || !host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => host.style.setProperty('--composer-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      host.style.removeProperty('--composer-h');
    };
  }, []);

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
    <div className="composer" ref={rootRef}>
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
          ref={textRef}
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
