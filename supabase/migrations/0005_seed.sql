-- 0005: 初期データ（app_config の単一行）
-- 招待キーのブートストラップ（さつきの初回アカウント）は別途 supabase/README.md の手順で行う。

insert into public.app_config (id, max_accounts, invite_ttl_days)
values (1, 25, 7)
on conflict (id) do nothing;
