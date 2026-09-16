-- 0012: アバターの「枠」と「バッジ」（2026-09-16 さつき依頼）
--
-- 1) frame_color: アイコンの枠の色。本人が6色から自由に選べる（既定は 'steel'）。
-- 2) special_frame: 管理者だけが付与できる特別な枠（色指定 or 虹色 'prism'）。
--    本人は「付与された特別枠を選ぶ（frame_color を 'special' にする）」ことはできるが、
--    special_frame 自体の値は本人からは一切書き換えられない（＝自分で特別枠を作れない）。
-- 3) badge: 管理者だけが付与できるバッジ（今はカニ 🦀 のみ）。本人向けの設定は無く、
--    付与されていれば常に表示するだけ（アプリ側にも選択 UI を作らない）。
--
-- 付与は Supabase ダッシュボードの SQL Editor で直接 update する（管理 UI は今回作らない）。
-- 例はこのファイルの末尾「管理者の付与手順」を参照。
--
-- 適用: Supabase ダッシュボードの SQL Editor に貼り付けて1回実行。冪等（何度実行しても壊れない）。
-- 順番: **アプリ・Worker の配信より必ず先に実行する**。アプリ（フィード・スレッド・設定・ランキング）と
--   Worker（SIT & GO の認証）はこの3列を select するため、列が無いと PostgREST が 400 を返し、
--   フィードや SIT & GO の入室ごと失敗する。

-- =============================================================================
-- 1) 列の追加
-- =============================================================================
alter table public.profiles
  add column if not exists frame_color   text not null default 'steel',
  add column if not exists special_frame text,
  add column if not exists badge         text;

-- frame_color: 本人が選べる6色 + 'special'（special_frame が付与されているときだけ選べる。
--   実際に付与なしで 'special' を書けないようにするのは下のトリガの役目。ここは形だけ縛る）。
alter table public.profiles drop constraint if exists profiles_frame_color_check;
alter table public.profiles add constraint profiles_frame_color_check check (
  frame_color in ('steel', 'yellow', 'cyan', 'red', 'white', 'purple', 'special')
);

-- special_frame: null（未付与）/ 'prism'（虹色）/ 小文字6桁16進カラーコードのみ。
--   管理者は SQL Editor で小文字（例 '#f5c542'）で書くこと。大文字で書いても下のトリガが
--   小文字に正規化してから保存する（このチェックが通るように）。
alter table public.profiles drop constraint if exists profiles_special_frame_check;
alter table public.profiles add constraint profiles_special_frame_check check (
  special_frame is null
  or special_frame = 'prism'
  or special_frame ~ '^#[0-9a-f]{6}$'
);

-- badge: null（未付与）/ 'crab'（カニ）のみ。今後バッジが増えたらここに追加する。
alter table public.profiles drop constraint if exists profiles_badge_check;
alter table public.profiles add constraint profiles_badge_check check (
  badge is null or badge in ('crab')
);

-- =============================================================================
-- 2) 特権列の保護（0008_security.sql の protect_profile_privileged を拡張）
--    トリガ本体（before update on profiles）は 0002_functions.sql で作成済みで、
--    関数名を参照しているだけなので create or replace のみでよい（作り直し不要）。
-- =============================================================================
create or replace function public.protect_profile_privileged()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service_role / postgres からの操作（管理者の付与作業を含む）は制限しない
  -- 設定が無い・空文字（接続を使い回したとき等）・authenticated 以外は制限しない。
  if coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), '') <> 'authenticated' then
    -- 管理者が special_frame を書いたときだけ、値を軽く整える（本人の更新には触れない）。
    -- 大文字で書かれた16進カラーコード（例 '#F5C542'）を小文字へ正規化（上の CHECK は小文字のみ許可）。
    if new.special_frame is not null and new.special_frame <> 'prism' then
      new.special_frame := lower(new.special_frame);
    end if;
    -- 特別枠を取り消した（special_frame を null に戻した）のに frame_color が 'special' の
    -- ままだと、アプリは steel 扱いで描くので値そのものも 'steel' に戻して食い違いを残さない。
    if new.special_frame is null and new.frame_color = 'special' then
      new.frame_color := 'steel';
    end if;
    return new;
  end if;
  -- authenticated（本人）が書き換えられない列: 既存の特権列 + special_frame・badge。
  new.is_admin      := old.is_admin;
  new.id            := old.id;
  new.handle        := old.handle;
  new.created_at    := old.created_at;
  new.special_frame := old.special_frame;
  new.badge         := old.badge;
  -- frame_color を 'special' にできるのは、既に特別枠が付与されている（special_frame がある）
  -- ときだけ。未付与なのに 'special' を書こうとしたら元の色に戻す（＝自分では特別枠を名乗れない）。
  -- old.frame_color も 'special' かつ special_frame が無い（付与取り消し後の残骸）ときは
  -- 'steel' に落とす。
  if new.frame_color = 'special' and old.special_frame is null then
    new.frame_color := case when old.frame_color = 'special' then 'steel' else old.frame_color end;
  end if;
  return new;
end;
$$;

-- =============================================================================
-- 管理者の付与手順（Supabase ダッシュボード → SQL Editor で1行ずつ実行）
-- =============================================================================
-- 特別枠（色指定・小文字16進）: update public.profiles set special_frame = '#f5c542' where handle = 'xxx';
-- 特別枠（プリズム）        : update public.profiles set special_frame = 'prism' where handle = 'xxx';
-- バッジ（カニ）            : update public.profiles set badge = 'crab' where handle = 'xxx';
-- 取り消し                  : update public.profiles set special_frame = null, badge = null where handle = 'xxx';
--   ※ 特別枠を取り消すと、その人が frame_color = 'special' を選んでいても自動で 'steel' に戻る。
