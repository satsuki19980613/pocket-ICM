import { useRef, useState } from 'react';
import { MAX_POST_BODY } from '../supabase/feed';
import { useBackLayer } from './BackLayer';
import { CameraIcon } from './feedShared';

type Ack = { ok: boolean; message?: string };

/**
 * 通常投稿コンポーザ（v3 新設・SPEC §5.1.2）。ホームの FAB から開くモーダル。
 * 本文（最大2000字・残り字数カウンタ）＋画像1枚（プレビュー・外す）＋送信。
 * `IcmInput`/スレッド返信 `Composer` と同じ file input の作法（
 * `accept="image/png,image/jpeg,image/webp"`）に合わせる。
 * 本文・画像とも空なら送信不可。送信は親（App）の `createPost` を叩き、成功したら自分を閉じる
 * （失敗時はエラーを表示したまま開いておく＝入力を失わない）。
 */
export function PostComposer(props: {
  onSubmit: (input: { body: string; imageFile: File | null }) => Promise<Ack>;
  onClose: () => void;
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

  const canSend = !busy && (body.trim().length > 0 || file != null);

  async function send(): Promise<void> {
    if (!canSend) return;
    setBusy(true);
    setErr('');
    const res = await props.onSubmit({ body: body.trim(), imageFile: file });
    setBusy(false);
    if (res.ok) {
      props.onClose();
    } else {
      setErr(res.message ?? '投稿できませんでした');
    }
  }

  // 端末の戻る／Esc で閉じる。
  useBackLayer(props.onClose);

  return (
    <div className="modal-backdrop" onClick={props.onClose} role="presentation">
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="投稿する">
        <div className="modal-head">
          <span className="modal-title">投稿する</span>
          <button type="button" className="modal-x" aria-label="閉じる" onClick={props.onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {preview && (
            <div className="composer-preview">
              <img src={preview} alt="添付プレビュー" />
              <button type="button" onClick={() => pickImage(null)} aria-label="画像を外す" disabled={busy}>
                ✕
              </button>
            </div>
          )}

          <textarea
            className="post-compose-body"
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, MAX_POST_BODY))}
            placeholder="いま考えていること、共有したいハンドの話など…"
            rows={6}
            maxLength={MAX_POST_BODY}
            disabled={busy}
            autoFocus
          />

          <div className="post-compose-foot">
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
              <CameraIcon />
            </button>
            <span className="post-compose-count">
              {body.length}/{MAX_POST_BODY}
            </span>
          </div>

          {err && <p className="auth-err">{err}</p>}

          <button type="button" className="btn wide" disabled={!canSend} onClick={() => void send()}>
            {busy ? '投稿中…' : '投稿する'}
          </button>
        </div>
      </div>
    </div>
  );
}
