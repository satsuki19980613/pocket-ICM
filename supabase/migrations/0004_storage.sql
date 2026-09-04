-- 0004: Storage バケット + ポリシー（SPEC §8: 本人のみ書込み・サイズ/MIME 制限）
-- パス規約: '<uid>/<filename>' — 先頭フォルダ名を所有者 uid とし、本人のみ書き込み可。

-- avatars: プロフィール画像（2MB 上限・画像のみ）。閲覧は公開（フィードでアイコン表示のため）。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152,
        array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- thread-images: スレッド添付画像（5MB 上限・画像のみ）。閲覧は公開（フィード表示のため）。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('thread-images', 'thread-images', true, 5242880,
        array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 閲覧: 両バケットは public=true なので匿名 URL で読める（機微でない画像想定）。
-- 書き込み系: 自分の uid フォルダ配下のみ。
drop policy if exists "own avatar write" on storage.objects;
create policy "own avatar write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own avatar update" on storage.objects;
create policy "own avatar update" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own avatar delete" on storage.objects;
create policy "own avatar delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own thread-image write" on storage.objects;
create policy "own thread-image write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'thread-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own thread-image update" on storage.objects;
create policy "own thread-image update" on storage.objects
  for update to authenticated
  using (bucket_id = 'thread-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own thread-image delete" on storage.objects;
create policy "own thread-image delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'thread-images' and (storage.foldername(name))[1] = auth.uid()::text);
