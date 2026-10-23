-- Daily win streaks for the leaderboard (🔥 next to the nickname).
-- A streak is the run of consecutive winning Dailies that ends today or yesterday, so it only
-- breaks once a whole day has been missed or lost.

create or replace function public.player_streaks()
returns table (user_id uuid, streak int)
language sql
stable
security definer
set search_path = ''
as $$
  with wins as (
    select r.user_id as uid, r.day,
           r.day - (row_number() over (partition by r.user_id order by r.day))::int as grp
    from public.daily_results r
    where r.won
  ),
  runs as (
    select uid, count(*)::int as len, max(day) as last_day
    from wins
    group by uid, grp
  )
  select uid, len from runs where last_day >= public.utc_today() - 1;
$$;

drop function if exists public.leaderboard(text, int);
create or replace function public.leaderboard(p_period text default 'all', p_limit int default 50)
returns table (rank bigint, nickname text, avg_guesses numeric, wins bigint, played bigint, win_rate numeric, is_me boolean, streak int)
language sql
stable
security definer
set search_path = ''
as $$
  select r.rnk, r.nickname, round(r.avg_score, 2), r.wins, r.played,
         round(100.0 * r.wins / r.played, 1), coalesce(r.user_id = auth.uid(), false),
         coalesce(s.streak, 0)
  from public.ranked_players(p_period) r
  left join public.player_streaks() s on s.user_id = r.user_id
  where r.rnk is not null
    and (r.rnk <= least(greatest(coalesce(p_limit, 50), 1), 100) or r.user_id = auth.uid())
  order by r.rnk, r.nickname;
$$;

drop function if exists public.my_standing(text);
create or replace function public.my_standing(p_period text default 'all')
returns table (nickname text, rank bigint, ranked_total bigint, better_than numeric, avg_guesses numeric, wins bigint, played bigint, win_rate numeric, wins_needed int, streak int)
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
         greatest(0, 5 - coalesce(me.wins, 0))::int,
         coalesce((select s.streak from public.player_streaks() s where s.user_id = auth.uid()), 0)
  from total
  left join me on true
  where auth.uid() is not null;
$$;

revoke execute on function public.player_streaks() from public, anon, authenticated;
revoke execute on function public.leaderboard(text, int), public.my_standing(text) from public, anon, authenticated;
grant execute on function public.leaderboard(text, int) to anon, authenticated;
grant execute on function public.my_standing(text) to authenticated;
