// delete-account: ログイン中の本人が自分のアカウントを削除。
// auth.users の削除には service_role が要る（クライアントからは不可）。
// profiles→results/threads/comments/likes/images/ocr_reads/hu_stats は FK cascade で連鎖削除される。
// ただし Storage のファイル本体（スクショ・スレッド画像・アイコン）は DB の連鎖では消えないので、
// アカウントを消す前にここで本人フォルダを全部消す。SPEC §2。
import { preflight, json } from '../_shared/cors.ts';
import { serviceClient, getCaller } from '../_shared/util.ts';
import { removeUserFiles, type StorageLike } from '../_shared/userFiles.ts';

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const caller = await getCaller(req);
  if (!caller) return json({ error: 'unauthorized' }, 401);

  const svc = serviceClient();

  // 1) ファイル本体を先に消す。失敗したらアカウントは消さない（「消えたはずの画像が残る」を防ぎ、
  //    利用者には再試行してもらう）。
  const files = await removeUserFiles(svc.storage as unknown as StorageLike, caller.id);
  if ('error' in files) {
    return json(
      { error: 'delete_failed', message: '画像の削除に失敗しました。時間をおいてもう一度お試しください' },
      500,
    );
  }

  // 2) アカウント削除（記録・投稿・コメント・♡・画像行・読み取りログ・成績は連鎖削除）。
  const del = await svc.auth.admin.deleteUser(caller.id);
  if (del.error) return json({ error: 'delete_failed', message: '削除に失敗しました' }, 500);

  return json({ ok: true, removed_files: files.removed });
});
