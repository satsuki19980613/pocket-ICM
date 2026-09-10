-- 0007: Training タブ「Slumbot HU」の通算成績とランキング（SPEC §7.4）
--
-- 保存するのは「通算ハンド数」と「通算収支（チップ）」だけ。ハンド履歴は持たない。
-- 収支の単位はチップ（BB=100）。表示はフロントで 100 で割って bb にする。
--
-- 書き込みは RPC public.hu_add_result() 経由のみ。テーブルへの直接
-- insert/update/delete はポリシーを置かない＝RLS が全部拒否する。
-- 読み出しはログイン済みなら全員ぶん（ランキングのため）。

create table if not exists public.hu_stats (
  owner       uuid primary key references public.profiles(id) on delete cascade,
  hands       integer not null default 0,
  net_chips   bigint  not null default 0,
  updated_at  timestamptz not null default now(),
  constraint hu_stats_hands_nonneg check (hands >= 0)
);

-- ランキングの並び順（通算収支の降順）。
create index if not exists hu_stats_rank_idx on public.hu_stats(net_chips desc, hands desc);

alter table public.hu_stats enable row level security;

drop policy if exists hu_stats_select on public.hu_stats;
create policy hu_stats_select on public.hu_stats
  for select to authenticated using (true);

-- insert/update/delete のポリシーは意図的に作らない（RPC 以外から書けないようにする）。

/**
 * 対戦結果を加算する。
 *
 * p_hands     … 加算するハンド数（オフラインで溜めた分をまとめて送ることがある）
 * p_net_chips … その分の純収支（チップ・負値可）
 *
 * 1 ハンドの収支は最大でも ±20000（=±200bb）なので、それを超える申告は弾く。
 * クライアント申告である以上「正しさ」は保証できないが、桁違いの値は入らないようにする。
 */
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

revoke all on function public.hu_add_result(integer, bigint) from public;
grant execute on function public.hu_add_result(integer, bigint) to authenticated;
