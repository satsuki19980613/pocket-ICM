-- 0008: セキュリティ強化（2026-09-11 セキュリティレビュー・さつき依頼「すべての穴を塞ぐ」）
--
-- 塞ぐ穴:
--   1) 招待を通らずに作られた Auth ユーザー（Supabase の新規登録が有効なままだと作れてしまう）でも、
--      ログインさえすればプロフィール・投稿・コメント・公開結果・ランキングを読めた
--      → 読み書きを「メンバー（profiles 行を持つ＝招待で入った人）」だけに限定する（is_member）。
--   2) 画像 URL 列（threads/comments.image_url・profiles.avatar_url）に任意の文字列（javascript: 等）を
--      入れられた → このアプリの Storage の、本人フォルダの画像の形だけを許す。
--   3) スレッド画像・アイコンのバケットが公開で、URL を知っていれば誰でも見られた
--      → 非公開にし、メンバーだけが署名 URL で見る。
--   4) サーバ専用の claim_invite が未ログインでも呼べた → service_role 専用。新規登録で招待キーを
--      先に確かめる check_invite と、プロフィール作成＋キー消費を1トランザクションで行う
--      register_member を追加（途中で失敗しても「招待キーを使っていないメンバー」が残らない）。
--   5) 本人が profiles の handle（ログイン名）を書き換えられた → is_admin と同じくトリガで固定。
--   6) 投稿の種別・紐づく結果・日時、コメントの所属スレッドを書き換えられた（日時を未来にして
--      フィードの先頭に居座る等）→ トリガで固定し、作成日時はサーバの時刻にする。
--   7) images 行の bucket / path / bytes が自由に書けたため、他人のファイルのパスを書いた期限切れ行や
--      巨大な bytes の行を作ると、purge-images（サーバ権限）に他人の画像を消させることができた
--      → 本人の spot-images フォルダのパスしか入らない・保持方針以外は更新できないようにする
--      （purge-images 側も行の値を信じず Storage の実物で判断する）。
--   8) Storage に規約外のファイル名（<uid>/evil.html・<uid>/x/y.png 等）を置けた → 名前の形を縛る。
--   9) 記録・読み取りログから他人の画像・結果・ログを参照できた → 本人のものだけ参照できる。
--  10) 細かい穴: 画像参照に別の Supabase プロジェクトの URL を入れられた（→ このプロジェクトに固定）、
--      非メンバーが他人の id で is_member / is_admin を問い合わせられた（→ 自分自身についてだけ答える）、
--      非公開の結果を指す結果投稿を作れた（→ 公開済みの自分の結果だけ）、記録の作成日時を偽れた（→ 固定）。
--      ※ 画像参照の CHECK はこのプロジェクト（bpxrbxnylgedjhvhfsvk）に固定している。別プロジェクトへ移すときは書き換える。
--
-- 適用: Supabase ダッシュボードの SQL Editor に貼り付けて1回実行。冪等（何度実行しても壊れない）。
-- 順番: **新しいアプリ（画像を署名 URL で表示する版）をデプロイしてから**実行すること。
--   先に実行すると、古いアプリは公開 URL で画像を出しているので、アプリが切り替わるまで
--   スレッド画像・アイコンが表示されなくなる（データは消えない）。

-- =============================================================================
-- 1) 権限判定の関数と、関数の実行権限・書き換えてはいけない列の保護
-- =============================================================================

-- is_member(uid): 招待で入ったメンバーか（profiles 行を持つか）。RLS ポリシーから呼ぶ。
-- 自分自身（auth.uid()）についてしか答えない（他人の id を渡して「メンバーか」を調べられないように）。
-- ポリシーはすべて is_member(auth.uid()) の形で呼ぶので、これで困る呼び出しは無い。
create or replace function public.is_member(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select uid is not distinct from auth.uid()
     and exists (select 1 from public.profiles where id = uid);
$$;
revoke all on function public.is_member(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated, service_role;

-- is_admin も同じく自分自身についてだけ答える（0002 の定義を置き換え。ポリシーは is_admin(auth.uid()) の形のみ。
-- Edge Function の管理者判定は profiles を直接読むのでこの関数に依存しない）。
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select uid is not distinct from auth.uid()
     and coalesce((select is_admin from public.profiles where id = uid), false);
$$;

-- is_admin はポリシー評価のためログインユーザーには残し、未ログインからは呼べなくする。
revoke all on function public.is_admin(uuid) from public, anon;
grant execute on function public.is_admin(uuid) to authenticated, service_role;

-- claim_invite は Edge Function（service_role）専用。
revoke all on function public.claim_invite(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_invite(text, uuid) to service_role;

-- check_invite(code_hash): 招待キーを「消費せずに」確かめる（signup がアカウントを作る前に呼ぶ）。
--   戻り値: 'ok' | 'invalid' | 'expired' | 'used' | 'full'
--   最終判定は register_member（中で claim_invite が原子的に消費）。ここは先に弾くための下見。
create or replace function public.check_invite(p_code_hash text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_status  text;
  v_expires timestamptz;
  v_max     int;
  v_count   int;
begin
  select status, expires_at into v_status, v_expires
    from public.invite_codes where code_hash = p_code_hash;
  if v_status is null then
    return 'invalid';
  elsif v_status <> 'unused' then
    return 'used';
  elsif v_expires <= now() then
    return 'expired';
  end if;

  select max_accounts into v_max from public.app_config where id = 1;
  if v_max is null then v_max := 25; end if;
  select count(*) into v_count from public.profiles;  -- 新規ユーザーはまだ含まれない
  if v_count >= v_max then
    return 'full';
  end if;
  return 'ok';
end;
$$;
revoke all on function public.check_invite(text) from public, anon, authenticated;
grant execute on function public.check_invite(text) to service_role;

-- register_member: プロフィール作成と招待キーの消費を1つのトランザクションで行う（signup 専用）。
--   戻り値: 'ok' | 'handle_taken' | 'invalid' | 'expired' | 'used' | 'full'
--   'ok' 以外のときはプロフィールも作られていない（内側のブロックごと取り消す）。
--   以前はプロフィールを確定してからキーを消費し、失敗時にユーザー削除で後始末していたため、
--   後始末に失敗すると「招待キーを使っていないメンバー」が残りえた。
create or replace function public.register_member(
  p_user uuid,
  p_handle text,
  p_display_name text,
  p_code_hash text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text := 'invalid';
begin
  begin
    insert into public.profiles (id, handle, display_name) values (p_user, p_handle, p_display_name);
    v_status := public.claim_invite(p_code_hash, p_user);
    if v_status <> 'ok' then
      -- このブロックの変更（プロフィール作成）を取り消すために例外で抜ける。
      raise exception 'invite rejected' using errcode = 'P0001';
    end if;
  exception
    when unique_violation then
      return 'handle_taken';
    when sqlstate 'P0001' then
      return v_status;
  end;
  return 'ok';
end;
$$;
revoke all on function public.register_member(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.register_member(uuid, text, text, text) to service_role;

-- hu_add_result: メンバー以外は加算できない（明示的に弾く）。
create or replace function public.hu_add_result(p_hands integer, p_net_chips bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not public.is_member(uid) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if p_hands is null or p_hands <= 0 or p_hands > 500 then
    raise exception 'invalid hands' using errcode = '22023';
  end if;
  if p_net_chips is null or abs(p_net_chips) > 20000::bigint * p_hands then
    raise exception 'invalid net_chips' using errcode = '22023';
  end if;

  insert into public.hu_stats as s (owner, hands, net_chips, updated_at)
  values (uid, p_hands, p_net_chips, now())
  on conflict (owner) do update
    set hands = s.hands + excluded.hands,
        net_chips = s.net_chips + excluded.net_chips,
        updated_at = now();
end;
$$;
revoke all on function public.hu_add_result(integer, bigint) from public, anon;
grant execute on function public.hu_add_result(integer, bigint) to authenticated;

-- profiles の特権列: is_admin に加え、id・handle（ログイン名＝Auth の識別子）・created_at も
-- 本人からは書き換えられないようにする（ユーザー名の変更は準備中＝アプリにも機能が無い）。
create or replace function public.protect_profile_privileged()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service_role / postgres からの操作は制限しない（初期付与・管理用）
  -- 設定が無い・空文字（接続を使い回したとき等）・authenticated 以外は制限しない。
  if coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), '') <> 'authenticated' then
    return new;
  end if;
  new.is_admin   := old.is_admin;
  new.id         := old.id;
  new.handle     := old.handle;
  new.created_at := old.created_at;
  return new;
end;
$$;

-- 投稿・コメント: 作成日時はサーバの時刻、更新では日時・種別・紐づく結果・所属スレッドを変えられない
-- （日時を未来にしてフィードの先頭に居座る・返信を別のスレッドへ移す・投稿の種別をすり替える、を防ぐ）。
create or replace function public.protect_post_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 設定が無い・空文字（接続を使い回したとき等）・authenticated 以外は制限しない。
  if coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), '') <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := null;
    return new;
  end if;
  new.created_at := old.created_at;
  -- 「（編集済み）」の目印（updated_at）は本文・画像が変わったときだけサーバが付ける
  -- （利用者が消したり付けたりできない）。
  if new.body is distinct from old.body or new.image_url is distinct from old.image_url then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
  end if;
  if tg_table_name = 'comments' then
    new.thread_id := old.thread_id;
  else
    new.kind      := old.kind;
    new.result_id := old.result_id;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_post_columns on public.threads;
create trigger protect_post_columns
  before insert or update on public.threads
  for each row execute function public.protect_post_columns();

drop trigger if exists protect_post_columns on public.comments;
create trigger protect_post_columns
  before insert or update on public.comments
  for each row execute function public.protect_post_columns();

-- images: 作成日時はサーバの時刻。更新で変えてよいのは保持方針（expires_at / protected）だけ
-- （OCR が読めなかった画像を無期限保持に切り替える markImageProtected のため）。
create or replace function public.protect_image_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 設定が無い・空文字（接続を使い回したとき等）・authenticated 以外は制限しない。
  if coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), '') <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    return new;
  end if;
  new.id         := old.id;
  new.owner      := old.owner;
  new.kind       := old.kind;
  new.bucket     := old.bucket;
  new.path       := old.path;
  new.bytes      := old.bytes;
  new.width      := old.width;
  new.height     := old.height;
  new.mime       := old.mime;
  new.sha256     := old.sha256;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists protect_image_columns on public.images;
create trigger protect_image_columns
  before insert or update on public.images
  for each row execute function public.protect_image_columns();

-- results: 作成日時はサーバの時刻、更新では変えられない（公開結果の日時を偽れないように。
-- アプリは作成日時を送らない＝DB の既定値に任せているので影響なし）。
create or replace function public.protect_result_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 設定が無い・空文字（接続を使い回したとき等）・authenticated 以外は制限しない。
  if coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), '') <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_result_columns on public.results;
create trigger protect_result_columns
  before insert or update on public.results
  for each row execute function public.protect_result_columns();

-- 結果を非公開に戻したら、その結果の投稿（kind='result' のスレッド）も消す。アプリの手順
-- （records.ts unpublishRecord: スレッド削除 → 非公開）を通らずに非公開にされても、中身の見えない
-- 壊れた投稿がフィードに残らないように。返信・♡は FK cascade で一緒に消える。
create or replace function public.unpublish_result_threads()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.is_public and not new.is_public then
    delete from public.threads where result_id = new.id and kind = 'result';
  end if;
  return null;
end;
$$;

drop trigger if exists unpublish_result_threads on public.results;
create trigger unpublish_result_threads
  after update of is_public on public.results
  for each row execute function public.unpublish_result_threads();

-- =============================================================================
-- 2) RLS: 読み書きをメンバーに限定する
--    `(select public.is_member(auth.uid()))` は1クエリにつき1回だけ評価される書き方。
-- =============================================================================

-- ----- profiles -----
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using ((select public.is_member(auth.uid())));

-- ----- results（参照できる画像・読み取りログは本人のものだけ）-----
drop policy if exists results_select on public.results;
create policy results_select on public.results
  for select to authenticated
  using ((select public.is_member(auth.uid())) and (owner = auth.uid() or is_public));

drop policy if exists results_insert on public.results;
create policy results_insert on public.results
  for insert to authenticated
  with check (
    owner = auth.uid()
    and (select public.is_member(auth.uid()))
    and (image_id is null or exists (select 1 from public.images i where i.id = image_id and i.owner = auth.uid()))
    and (ocr_read_id is null or exists (select 1 from public.ocr_reads o where o.id = ocr_read_id and o.owner = auth.uid()))
  );

drop policy if exists results_update on public.results;
create policy results_update on public.results
  for update to authenticated
  using (owner = auth.uid())
  with check (
    owner = auth.uid()
    and (image_id is null or exists (select 1 from public.images i where i.id = image_id and i.owner = auth.uid()))
    and (ocr_read_id is null or exists (select 1 from public.ocr_reads o where o.id = ocr_read_id and o.owner = auth.uid()))
  );

-- ----- threads -----
drop policy if exists threads_select on public.threads;
create policy threads_select on public.threads
  for select to authenticated using ((select public.is_member(auth.uid())));

drop policy if exists threads_insert on public.threads;
create policy threads_insert on public.threads
  for insert to authenticated
  with check (
    author = auth.uid()
    and (select public.is_member(auth.uid()))
    and (
      (kind = 'post' and result_id is null)
      or (
        kind = 'result'
        and result_id is not null
        -- 結果投稿は公開済みの自分の結果だけ（非公開の結果を指すと中身の見えない壊れた投稿になる）。
        -- 公開の流れ（records.ts publishRecord）は is_public=true にしてからスレッドを作る。
        and exists (
          select 1 from public.results r where r.id = result_id and r.owner = auth.uid() and r.is_public
        )
      )
    )
  );

-- 更新は本人の投稿だけ。種別・紐づく結果・日時は protect_post_columns が固定するので、
-- 実際に変えられるのは本文と画像。
drop policy if exists threads_update on public.threads;
create policy threads_update on public.threads
  for update to authenticated
  using (author = auth.uid())
  with check (author = auth.uid() and (select public.is_member(auth.uid())));

-- ----- comments -----
drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments
  for select to authenticated using ((select public.is_member(auth.uid())));

drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments
  for insert to authenticated
  with check (author = auth.uid() and (select public.is_member(auth.uid())));

-- ----- likes -----
drop policy if exists likes_select on public.likes;
create policy likes_select on public.likes
  for select to authenticated using ((select public.is_member(auth.uid())));

drop policy if exists likes_insert on public.likes;
create policy likes_insert on public.likes
  for insert to authenticated
  with check (user_id = auth.uid() and (select public.is_member(auth.uid())));

-- ----- hu_stats -----
drop policy if exists hu_stats_select on public.hu_stats;
create policy hu_stats_select on public.hu_stats
  for select to authenticated using ((select public.is_member(auth.uid())));

-- ----- images（閲覧は従来どおり本人 or 管理者。書き込みにメンバー条件を足す）-----
drop policy if exists images_insert on public.images;
create policy images_insert on public.images
  for insert to authenticated
  with check (owner = auth.uid() and (select public.is_member(auth.uid())));

-- ----- ocr_reads（参照できる画像・結果は本人のものだけ）-----
drop policy if exists ocr_reads_insert on public.ocr_reads;
create policy ocr_reads_insert on public.ocr_reads
  for insert to authenticated
  with check (
    owner = auth.uid()
    and (select public.is_member(auth.uid()))
    and (image_id is null or exists (select 1 from public.images i where i.id = image_id and i.owner = auth.uid()))
    and (result_id is null or exists (select 1 from public.results r where r.id = result_id and r.owner = auth.uid()))
  );

drop policy if exists ocr_reads_update on public.ocr_reads;
create policy ocr_reads_update on public.ocr_reads
  for update to authenticated
  using (owner = auth.uid())
  with check (
    owner = auth.uid()
    and (image_id is null or exists (select 1 from public.images i where i.id = image_id and i.owner = auth.uid()))
    and (result_id is null or exists (select 1 from public.results r where r.id = result_id and r.owner = auth.uid()))
  );

-- =============================================================================
-- 3) 形の制約
--    画像参照: https://<project>.supabase.co/storage/v1/object/public/<bucket>/<本人uid>/<uuid>.<png|jpg|webp>
--    （バケットは非公開にするが、URL は「どのファイルか」を指す参照としてこの形のまま保存する。
--      表示時にアプリがパスを取り出して署名 URL に替える）
--    アイコンだけは、2026-09 初めの版（e1f1dce）が保存した `<uid>/avatar.(webp|jpg)?v=<数字>` の形も認める
--    （その版で設定したまま変えていない人のアイコンを消さないため）。
--    images 行: bucket='spot-images'・path='<owner>/<uuid>.<ext>'・bytes は 1MB（バケット上限）以内。
--    毎回 drop → add し直す（定義を変えても再実行で揃う）。既存行に合わない値があっても適用が止まらないよう
--    NOT VALID で付け（新規・更新分には必ず効く）、続けて既存行を検証する（合わない行があれば NOTICE のみ）。
-- =============================================================================
alter table public.threads drop constraint if exists threads_image_url_own_storage;
alter table public.threads add constraint threads_image_url_own_storage check (
  image_url is null
  or image_url ~ (
    '^https://bpxrbxnylgedjhvhfsvk\.supabase\.co/storage/v1/object/public/thread-images/'
    || author::text
    || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$'
  )
) not valid;

alter table public.comments drop constraint if exists comments_image_url_own_storage;
alter table public.comments add constraint comments_image_url_own_storage check (
  image_url is null
  or image_url ~ (
    '^https://bpxrbxnylgedjhvhfsvk\.supabase\.co/storage/v1/object/public/thread-images/'
    || author::text
    || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$'
  )
) not valid;

alter table public.profiles drop constraint if exists profiles_avatar_url_own_storage;
alter table public.profiles add constraint profiles_avatar_url_own_storage check (
  avatar_url is null
  or avatar_url ~ (
    '^https://bpxrbxnylgedjhvhfsvk\.supabase\.co/storage/v1/object/public/avatars/'
    || id::text
    || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$'
  )
  or avatar_url ~ (
    '^https://bpxrbxnylgedjhvhfsvk\.supabase\.co/storage/v1/object/public/avatars/'
    || id::text
    || '/avatar\.(webp|jpg)(\?v=[0-9]+)?$'
  )
) not valid;

alter table public.images drop constraint if exists images_own_spot_path;
alter table public.images add constraint images_own_spot_path check (
  bucket = 'spot-images'
  and path ~ (
    '^'
    || owner::text
    || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$'
  )
) not valid;

alter table public.images drop constraint if exists images_bytes_range;
alter table public.images add constraint images_bytes_range check (
  bytes is null or (bytes >= 0 and bytes <= 1048576)
) not valid;

do $$
begin
  begin
    alter table public.threads validate constraint threads_image_url_own_storage;
  exception when check_violation then
    raise notice 'threads に形の合わない image_url が残っています（新規・更新分には制約が効きます）';
  end;
  begin
    alter table public.comments validate constraint comments_image_url_own_storage;
  exception when check_violation then
    raise notice 'comments に形の合わない image_url が残っています（新規・更新分には制約が効きます）';
  end;
  begin
    alter table public.profiles validate constraint profiles_avatar_url_own_storage;
  exception when check_violation then
    raise notice 'profiles に形の合わない avatar_url が残っています（新規・更新分には制約が効きます）';
  end;
  begin
    alter table public.images validate constraint images_own_spot_path;
  exception when check_violation then
    raise notice 'images に形の合わない bucket/path が残っています（新規・更新分には制約が効きます）';
  end;
  begin
    alter table public.images validate constraint images_bytes_range;
  exception when check_violation then
    raise notice 'images に範囲外の bytes が残っています（新規・更新分には制約が効きます）';
  end;
end $$;

-- =============================================================================
-- 4) Storage: スレッド画像・アイコンを非公開にし、読み書きをメンバーに限定する
--    置けるのは本人の uid フォルダ直下の `<uuid>.<png|jpg|webp>` だけ（アプリが作る名前）。
--    削除は本人フォルダ内なら名前を問わない（古い形のファイルも本人が消せるように）。
-- =============================================================================
update storage.buckets set public = false where id in ('thread-images', 'avatars');

-- 閲覧（新設）: メンバーはスレッド画像・アイコンを読める（署名 URL の発行にも必要）。
drop policy if exists "member read thread-images and avatars" on storage.objects;
create policy "member read thread-images and avatars" on storage.objects
  for select to authenticated
  using (bucket_id in ('thread-images', 'avatars') and (select public.is_member(auth.uid())));

drop policy if exists "own avatar write" on storage.objects;
create policy "own avatar write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and name ~ ('^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$')
    and (select public.is_member(auth.uid()))
  );

drop policy if exists "own avatar update" on storage.objects;
create policy "own avatar update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and name ~ ('^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$')
    and (select public.is_member(auth.uid()))
  );

drop policy if exists "own avatar delete" on storage.objects;
create policy "own avatar delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
    and (select public.is_member(auth.uid()))
  );

drop policy if exists "own thread-image write" on storage.objects;
create policy "own thread-image write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'thread-images'
    and name ~ ('^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$')
    and (select public.is_member(auth.uid()))
  );

drop policy if exists "own thread-image update" on storage.objects;
create policy "own thread-image update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'thread-images'
    and name ~ ('^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$')
    and (select public.is_member(auth.uid()))
  );

drop policy if exists "own thread-image delete" on storage.objects;
create policy "own thread-image delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'thread-images' and (storage.foldername(name))[1] = auth.uid()::text
    and (select public.is_member(auth.uid()))
  );

drop policy if exists "own spot-image write" on storage.objects;
create policy "own spot-image write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'spot-images'
    and name ~ ('^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$')
    and (select public.is_member(auth.uid()))
  );

drop policy if exists "own spot-image update" on storage.objects;
create policy "own spot-image update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'spot-images'
    and name ~ ('^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$')
    and (select public.is_member(auth.uid()))
  );

drop policy if exists "own spot-image delete" on storage.objects;
create policy "own spot-image delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'spot-images' and (storage.foldername(name))[1] = auth.uid()::text
    and (select public.is_member(auth.uid()))
  );
