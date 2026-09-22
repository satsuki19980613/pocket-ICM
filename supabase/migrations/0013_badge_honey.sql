-- 0013: バッジの2種類目「はちみつ 🍯」を追加（2026-09-22 さつき依頼）
--
-- 0012 で作った badge 列の CHECK 制約（'crab' のみ許可）を広げて 'honey' も通すだけ。
-- 列・トリガ（protect_profile_privileged）は 0012 のものをそのまま使う（本人からは
-- 書き換えられない・管理者のみ SQL Editor で付与、という付与方式に変更は無い）。
--
-- 順番について: アプリ側に honey バッジの SVG・表示対応が無い状態で先に付与しても、
-- resolveAvatarDeco は未知の badge 値と同じ扱い（バッジ無し表示）に丸めるため壊れない
-- （0012 のコメント「badge が未知/欠損 → null」を参照）。とはいえ見た目が出ないまま
-- 付与しても意味が無いので、実際の付与はアプリのデプロイ後に行うこと。
--
-- 適用: Supabase ダッシュボードの SQL Editor に貼り付けて1回実行。冪等（何度実行しても壊れない）。
--   0012 は変更しない（このファイルだけで完結する）。

-- =============================================================================
-- 1) badge の CHECK 制約を拡張
-- =============================================================================
alter table public.profiles drop constraint if exists profiles_badge_check;
alter table public.profiles add constraint profiles_badge_check check (
  badge is null or badge in ('crab', 'honey')
);

-- =============================================================================
-- 管理者の付与手順（Supabase ダッシュボード → SQL Editor で1行ずつ実行）
-- =============================================================================
-- バッジ（カニ）      : update public.profiles set badge = 'crab' where handle = 'xxx';
-- バッジ（はちみつ）  : update public.profiles set badge = 'honey' where handle = 'xxx';
-- 取り消し            : update public.profiles set badge = null where handle = 'xxx';
