-- 0010: Training「Slumbot HU」のハンド履歴の控え（SPEC §7.4.6）
--
-- 端末（IndexedDB）が正で、ここは控え。目的は 2 つ:
--   1. 端末のサイトデータが消えても履歴を失わない
--   2. 別の端末（PC のブラウザ）で同じ履歴を出し、解析ツール向けに書き出せる
--
-- 1 ハンド 1 行。id は端末が作る `sb_…`（冪等キー）。本人だけが読み書きできる。
-- 行の大きさは 200〜300 バイト程度（1 万ハンドで数 MB・無料枠 500MB の 1% 未満）。
-- 通算成績（hu_stats）とは独立で、ランキングはこれまでどおり hu_stats を見る。

create table if not exists public.hu_hands (
  id           text primary key,
  owner        uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  played_at    timestamptz not null,
  hero_seat    smallint not null,
  action       text not null,
  hero_cards   text not null,
  bot_cards    text,
  board        text not null default '',
  winnings     integer not null,
  showdown     boolean not null default false,
  ev_winnings  integer,
  created_at   timestamptz not null default now(),
  constraint hu_hands_id_shape     check (id ~ '^sb_[0-9a-z]{6,24}$'),
  constraint hu_hands_seat         check (hero_seat in (0, 1)),
  constraint hu_hands_action_len   check (char_length(action) between 1 and 200),
  constraint hu_hands_action_shape check (action ~ '^[kcfb0-9/]*$'),
  constraint hu_hands_hero_cards   check (char_length(hero_cards) = 4),
  constraint hu_hands_bot_cards    check (bot_cards is null or char_length(bot_cards) = 4),
  constraint hu_hands_board        check (char_length(board) <= 10 and char_length(board) % 2 = 0),
  -- 1 ハンドの収支は最大でも ±20000（=±200bb）。
  constraint hu_hands_winnings     check (abs(winnings) <= 20000),
  constraint hu_hands_ev           check (ev_winnings is null or abs(ev_winnings) <= 20000)
);

-- 差分取得（owner ごとに created_at の昇順）と、時系列の一覧。
create index if not exists hu_hands_owner_created_idx on public.hu_hands(owner, created_at);
create index if not exists hu_hands_owner_played_idx  on public.hu_hands(owner, played_at);

alter table public.hu_hands enable row level security;

drop policy if exists hu_hands_select on public.hu_hands;
create policy hu_hands_select on public.hu_hands
  for select to authenticated using (owner = auth.uid());

drop policy if exists hu_hands_insert on public.hu_hands;
create policy hu_hands_insert on public.hu_hands
  for insert to authenticated with check (owner = auth.uid());

-- upsert（同じ id の再送・EV の後埋め）のため update も本人に許す。owner は書き換えられない。
drop policy if exists hu_hands_update on public.hu_hands;
create policy hu_hands_update on public.hu_hands
  for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists hu_hands_delete on public.hu_hands;
create policy hu_hands_delete on public.hu_hands
  for delete to authenticated using (owner = auth.uid());
