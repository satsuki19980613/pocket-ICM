-- 0011: SIT & GO（会員同士の対人トーナメント）。docs/SNG_DESIGN.md §3。
--
-- 審判役は Cloudflare Durable Objects（無料プラン・SQLite クラス）で、ハンド行・試合結果は
-- **DO が service role キーで書く**。RLS は select だけ（insert/update/delete のポリシーは
-- 作らない＝service role だけが書ける。service role は RLS を素通りするので grant も不要）。
--
-- sng_games      : 試合が終わるたびに1回（cancelled も status 付きで書く。pt は付けない）。
-- sng_results    : 参加者ごとに1行（順位・pt・モード・人数。games と 1:N）。
-- sng_hands      : ハンドが終わるたびに1行。手札は共有行に入れず、圧縮表現（hand 列, v1・
--                  docs/SNG_DESIGN.md §4）にショーダウンで公開されたものだけを埋め込む。
--                  jsonb 禁止（1日10試合×100ハンドで年 ≈ 270MB の見積り。jsonb だと膨らむ）。
-- sng_hole_cards : 各自の手札を本人行だけに（他人からは読めない。折れたハンドの分も含む）。
--
-- 適用: Supabase ダッシュボードの SQL Editor に貼り付けて1回実行。冪等（何度実行しても壊れない）。

-- =============================================================================
-- sng_games
-- =============================================================================
create table if not exists public.sng_games (
  id            text primary key,
  host          uuid not null references public.profiles(id) on delete cascade,
  config        jsonb not null,
  participants  uuid[] not null,
  status        text not null,
  started_at    timestamptz,
  ended_at      timestamptz not null,
  hands         integer not null default 0,
  seats         jsonb not null default '[]',
  created_at    timestamptz not null default now(),
  constraint sng_games_id_shape check (id ~ '^sg_[0-9a-z]{8,24}$'),
  constraint sng_games_status   check (status in ('finished', 'cancelled')),
  constraint sng_games_hands_nn check (hands >= 0),
  constraint sng_games_seats_arr check (jsonb_typeof(seats) = 'array')
);

create index if not exists sng_games_created_idx on public.sng_games(created_at);

alter table public.sng_games enable row level security;
drop policy if exists sng_games_select on public.sng_games;
create policy sng_games_select on public.sng_games
  for select to authenticated using (auth.uid() = any(participants));

comment on table public.sng_games is 'SIT & GO: 試合が終わるたびに1回（Worker の service role が書く）。cancelled も記録する。';
comment on column public.sng_games.seats is '席順 [{seat, user_id, name}]。ハンド履歴で相手の表示名を出すため。';

-- =============================================================================
-- sng_results
-- =============================================================================
create table if not exists public.sng_results (
  game_id   text not null references public.sng_games(id) on delete cascade,
  owner     uuid not null references public.profiles(id) on delete cascade,
  seat      smallint not null,
  place     integer,
  pt        numeric,
  players   smallint not null,
  mode      text not null,
  ended_at  timestamptz not null,
  primary key (game_id, owner),
  constraint sng_results_seat    check (seat >= 0 and seat < 6),
  constraint sng_results_place   check (place is null or (place >= 1 and place <= 6)),
  constraint sng_results_players check (players >= 2 and players <= 6),
  constraint sng_results_mode    check (mode in ('club', 'rank-3', 'rank-4', 'rank-5', 'legend-avg', 'legend-season', 'legend-base'))
);

create index if not exists sng_results_owner_ended_idx on public.sng_results(owner, ended_at);

alter table public.sng_results enable row level security;
drop policy if exists sng_results_select on public.sng_results;
create policy sng_results_select on public.sng_results
  for select to authenticated using (owner = auth.uid());

comment on table public.sng_results is 'SIT & GO: 参加者ごとの順位・pt。本人だけ読める。';

-- =============================================================================
-- sng_hands
-- =============================================================================
create table if not exists public.sng_hands (
  game_id       text not null references public.sng_games(id) on delete cascade,
  hand_no       integer not null,
  played_at     timestamptz not null,
  participants  uuid[] not null,
  level         smallint not null,
  sb            integer not null,
  bb            integer not null,
  ante          integer not null,
  hand          text not null,
  created_at    timestamptz not null default now(),
  primary key (game_id, hand_no),
  constraint sng_hands_no_ge1 check (hand_no >= 1),
  constraint sng_hands_level  check (level >= 1),
  constraint sng_hands_chips  check (sb >= 0 and bb >= 0 and ante >= 0)
);

create index if not exists sng_hands_participants_idx on public.sng_hands using gin(participants);
create index if not exists sng_hands_created_idx on public.sng_hands(created_at);

alter table public.sng_hands enable row level security;
drop policy if exists sng_hands_select on public.sng_hands;
create policy sng_hands_select on public.sng_hands
  for select to authenticated using (auth.uid() = any(participants));

comment on table public.sng_hands is 'SIT & GO: ハンドごとの圧縮表現（docs/SNG_DESIGN.md §4）。jsonb 禁止。';

-- =============================================================================
-- sng_hole_cards
-- =============================================================================
create table if not exists public.sng_hole_cards (
  game_id     text not null,
  hand_no     integer not null,
  owner       uuid not null references public.profiles(id) on delete cascade,
  cards       text not null,
  created_at  timestamptz not null default now(),
  primary key (game_id, hand_no, owner),
  foreign key (game_id, hand_no) references public.sng_hands(game_id, hand_no) on delete cascade,
  constraint sng_hole_cards_len check (char_length(cards) = 4)
);

create index if not exists sng_hole_cards_owner_created_idx on public.sng_hole_cards(owner, created_at);

alter table public.sng_hole_cards enable row level security;
drop policy if exists sng_hole_cards_select on public.sng_hole_cards;
create policy sng_hole_cards_select on public.sng_hole_cards
  for select to authenticated using (owner = auth.uid());

comment on table public.sng_hole_cards is 'SIT & GO: 各自の手札（本人だけ読める。ショーダウンで非公開のままの分も含む）。';
