-- RiftGuessr leaderboard: profiles, daily results, Row Level Security and RPCs.
--
-- Rules (keep in sync with src/logic/ranking.ts):
--   * score = guesses for a win, 11 for a loss; lower is better
--   * ranked players need a nickname and at least 5 Daily wins in the period
--   * nicknames: 3-16 chars of A-Z a-z 0-9 space _ -, unique (case-insensitive), profanity-filtered
--
-- Clients never write tables directly. They call submit_daily_result() and set_nickname(), which
-- validate input and run as SECURITY DEFINER. Results are immutable: there is no update or delete path.

-- ---------------------------------------------------------------- tables

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nickname text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_nickname_format check (char_length(nickname) between 3 and 16 and nickname ~ '^[A-Za-z0-9_ -]+$')
);

create unique index profiles_nickname_lower_key on public.profiles (lower(nickname));

create table public.daily_results (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  guesses smallint not null,
  won boolean not null,
  hints_used smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint daily_results_user_day_key primary key (user_id, day),
  constraint daily_results_guesses_range check (guesses between 1 and 10),
  constraint daily_results_loss_uses_all_guesses check (won or guesses = 10),
  constraint daily_results_hints_range check (hints_used between 0 and 3)
);

create index daily_results_day_idx on public.daily_results (day);

-- ---------------------------------------------------------------- row level security

alter table public.profiles enable row level security;
alter table public.daily_results enable row level security;

-- Nicknames are public. Raw results are only readable by their owner; everyone else reads aggregates
-- through the functions below.
create policy "Profiles are readable by everyone" on public.profiles
  for select using (true);

create policy "Players can read their own results" on public.daily_results
  for select to authenticated using (user_id = (select auth.uid()));

-- No insert/update/delete policies: writes only happen inside the SECURITY DEFINER functions.
revoke insert, update, delete, truncate on public.profiles, public.daily_results from anon, authenticated;

-- ---------------------------------------------------------------- helpers

create or replace function public.nickname_is_clean(p_nickname text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with n as (select translate(lower(p_nickname), '013457@$!|8', 'oieastasiib') as s)
  select not (
    regexp_replace(s, '[^a-z]', '', 'g')
      ~ '(fuck|shit|cunt|nigg|fagg|bitch|whore|slut|retard|pussy|penis|vagina|hitler|twat|wank|porn|dildo|jizz|nazi|rapist|molest)'
    or s ~ '(^|[^a-z])(fag|rape|cock|dick|cum|tits|ass|anal|kike|spic|chink|sex)([^a-z]|$)'
  )
  from n;
$$;

create or replace function public.utc_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'utc')::date;
$$;

-- ---------------------------------------------------------------- writes

-- Saves the signed-in player's result for a Daily. Accepts today's UTC day, plus yesterday during the
-- first hour after midnight so games finished just before the rollover (or retried) still count.
-- Re-submitting the same day is a no-op, so client retries are safe and results never change.
create or replace function public.submit_daily_result(p_day date, p_guesses int, p_won boolean, p_hints_used int default 0)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := public.utc_today();
begin
  if v_uid is null then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  if p_day is null or not (
    p_day = v_today
    or (p_day = v_today - 1 and now() < (v_today::timestamp at time zone 'utc') + interval '1 hour')
  ) then
    raise exception 'Only today''s Daily can be submitted' using errcode = '22023';
  end if;
  if p_guesses is null or p_guesses not between 1 and 10 then
    raise exception 'Guesses must be between 1 and 10' using errcode = '22023';
  end if;
  if p_won is null or (not p_won and p_guesses <> 10) then
    raise exception 'A lost game uses all 10 guesses' using errcode = '22023';
  end if;
  if coalesce(p_hints_used, 0) not between 0 and 3 then
    raise exception 'Hints must be between 0 and 3' using errcode = '22023';
  end if;

  insert into public.daily_results (user_id, day, guesses, won, hints_used)
  values (v_uid, p_day, p_guesses, p_won, coalesce(p_hints_used, 0))
  on conflict (user_id, day) do nothing;
end;
$$;

-- Creates or renames the signed-in player's profile. Renames are rate limited to one per 30 seconds.
create or replace function public.set_nickname(p_nickname text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_nick text := regexp_replace(btrim(coalesce(p_nickname, '')), '\s+', ' ', 'g');
  v_saved boolean;
begin
  if v_uid is null then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  if char_length(v_nick) not between 3 and 16 or v_nick !~ '^[A-Za-z0-9_ -]+$' then
    raise exception 'Use 3-16 letters, numbers, spaces, - or _' using errcode = '22023';
  end if;
  if not public.nickname_is_clean(v_nick) then
    raise exception 'Please pick a different nickname' using errcode = '22023';
  end if;

  begin
    insert into public.profiles as p (id, nickname)
    values (v_uid, v_nick)
    on conflict (id) do update
      set nickname = excluded.nickname, updated_at = now()
      where p.updated_at < now() - interval '30 seconds' or p.nickname = excluded.nickname;
    v_saved := found;
  exception when unique_violation then
    raise exception 'That nickname is taken' using errcode = '23505';
  end;
  if not v_saved then
    raise exception 'Please wait a moment before changing your nickname again' using errcode = '22023';
  end if;
  return v_nick;
end;
$$;

-- ---------------------------------------------------------------- reads

-- Per-player aggregates for a period ('all' or '30d'). Only players with a nickname and >= 5 wins get a rank.
create or replace function public.ranked_players(p_period text)
returns table (user_id uuid, nickname text, avg_score numeric, wins bigint, played bigint, rnk bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with agg as (
    select r.user_id as uid,
           avg(case when r.won then r.guesses else 11 end)::numeric as avg_s,
           count(*) filter (where r.won) as w,
           count(*) as n
    from public.daily_results r
    where coalesce(p_period, 'all') <> '30d' or r.day > public.utc_today() - 30
    group by r.user_id
  ),
  joined as (
    select a.*, p.nickname as nick, (a.w >= 5 and p.nickname is not null) as eligible
    from agg a
    left join public.profiles p on p.id = a.uid
  )
  select j.uid, j.nick, j.avg_s, j.w, j.n,
         case when j.eligible then rank() over (partition by j.eligible order by j.avg_s, j.w desc) end
  from joined j;
$$;

-- Top players for a period ('all' or '30d'). Also returns the caller's row (is_me) when they rank outside the top.
create or replace function public.leaderboard(p_period text default 'all', p_limit int default 50)
returns table (rank bigint, nickname text, avg_guesses numeric, wins bigint, played bigint, win_rate numeric, is_me boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select r.rnk, r.nickname, round(r.avg_score, 2), r.wins, r.played,
         round(100.0 * r.wins / r.played, 1), coalesce(r.user_id = auth.uid(), false)
  from public.ranked_players(p_period) r
  where r.rnk is not null
    and (r.rnk <= least(greatest(coalesce(p_limit, 50), 1), 100) or r.user_id = auth.uid())
  order by r.rnk, r.nickname;
$$;

-- The caller's own standing for a period, ranked or not.
create or replace function public.my_standing(p_period text default 'all')
returns table (nickname text, rank bigint, ranked_total bigint, better_than numeric, avg_guesses numeric, wins bigint, played bigint, win_rate numeric, wins_needed int)
language sql
stable
security definer
set search_path = ''
as $$
  with all_rows as (select * from public.ranked_players(p_period)),
  ranked as (select * from all_rows where rnk is not null),
  me as (select * from all_rows a where a.user_id = auth.uid()),
  total as (select count(*) as c from ranked)
  select (select p.nickname from public.profiles p where p.id = auth.uid()),
         me.rnk,
         total.c,
         case when me.rnk is null or total.c <= 1 then null
              else round(100.0 * (select count(*) from ranked r where r.avg_score > me.avg_score) / (total.c - 1))
         end,
         round(me.avg_score, 2),
         coalesce(me.wins, 0),
         coalesce(me.played, 0),
         case when me.played > 0 then round(100.0 * me.wins / me.played, 1) end,
         greatest(0, 5 - coalesce(me.wins, 0))::int
  from total
  left join me on true
  where auth.uid() is not null;
$$;

-- How everyone did on one Daily: number of players per score (1-10 = solved in N, 11 = lost).
create or replace function public.daily_distribution(p_day date)
returns table (score int, players bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select (case when r.won then r.guesses else 11 end)::int, count(*)
  from public.daily_results r
  where r.day = p_day
  group by 1
  order by 1;
$$;

-- The caller's result for one Daily and the share of other players who did strictly worse.
create or replace function public.my_percentile(p_day date)
returns table (score int, better_than numeric, total bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with day_rows as (
    select r.user_id as uid, case when r.won then r.guesses else 11 end as s
    from public.daily_results r
    where r.day = p_day
  ),
  me as (select d.s from day_rows d where d.uid = auth.uid()),
  total as (select count(*) as c from day_rows)
  select me.s::int,
         case when total.c <= 1 then null
              else round(100.0 * (select count(*) from day_rows d where d.s > me.s) / (total.c - 1))
         end,
         total.c
  from me, total;
$$;

-- ---------------------------------------------------------------- permissions

revoke execute on function
  public.nickname_is_clean(text),
  public.utc_today(),
  public.ranked_players(text),
  public.leaderboard(text, int),
  public.my_standing(text),
  public.daily_distribution(date),
  public.my_percentile(date),
  public.submit_daily_result(date, int, boolean, int),
  public.set_nickname(text)
from public, anon, authenticated;

grant execute on function public.leaderboard(text, int) to anon, authenticated;
grant execute on function public.daily_distribution(date) to anon, authenticated;
grant execute on function public.my_standing(text) to authenticated;
grant execute on function public.my_percentile(date) to authenticated;
grant execute on function public.submit_daily_result(date, int, boolean, int) to authenticated;
grant execute on function public.set_nickname(text) to authenticated;
