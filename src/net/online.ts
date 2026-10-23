import type { SupabaseClient } from '@supabase/supabase-js';
import { dayDate } from '../logic/daily';
import { usernameFromEmail, usernameToEmail, type PendingResult, type ScoreCount } from '../logic/ranking';

/**
 * Optional online features (leaderboard, daily percentile). Everything here is best effort: when
 * Supabase isn't configured or reachable, the game keeps working offline.
 */
const env = import.meta.env as Record<string, string | undefined>;
const SUPABASE_URL = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = env.VITE_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const onlineConfigured = !!(SUPABASE_URL && SUPABASE_KEY);

export type Period = 'all' | '30d';

export interface Account {
  id: string;
  anonymous: boolean;
  /** Login name of a registered account, or null for a guest. */
  username: string | null;
}

export interface LeaderRow {
  rank: number;
  nickname: string;
  avg: number;
  wins: number;
  played: number;
  winRate: number;
  isMe: boolean;
  /** Consecutive winning Dailies ending today or yesterday. */
  streak: number;
}

export interface Standing {
  nickname: string | null;
  rank: number | null;
  rankedTotal: number;
  betterThan: number | null;
  avg: number | null;
  wins: number;
  played: number;
  winRate: number | null;
  winsNeeded: number;
  streak: number;
}

/**
 * "rejected" means the server refused the input for good (validation, duplicate nickname), so it must
 * not be retried. Everything else ("network": offline, timeouts, auth hiccups, missing setup) can be.
 */
export class OnlineError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'rejected' | 'config',
    readonly code = '',
  ) {
    super(message);
  }
}

let clientPromise: Promise<SupabaseClient> | null = null;

function client(): Promise<SupabaseClient> {
  if (!onlineConfigured) return Promise.reject(new OnlineError('The leaderboard is not configured', 'config'));
  clientPromise ??= import('@supabase/supabase-js')
    .then(({ createClient }) =>
      createClient(SUPABASE_URL!, SUPABASE_KEY!, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
      }),
    )
    .catch((e) => {
      clientPromise = null;
      throw new OnlineError(String(e?.message ?? e), 'network');
    });
  return clientPromise;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const sb = await client();
  let res;
  try {
    res = await sb.rpc(fn, args);
  } catch (e) {
    throw new OnlineError(String((e as Error)?.message ?? e), 'network');
  }
  if (res.error) {
    const code = res.error.code ?? '';
    // 22xxx = invalid input, 23xxx = constraint (for example a taken nickname): raised by our functions.
    throw new OnlineError(res.error.message || 'Request failed', /^(22|23)/.test(code) ? 'rejected' : 'network', code);
  }
  return res.data as T;
}

const isoDay = (day: number) => dayDate(day).toISOString().slice(0, 10);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Starts the client so a stored session is restored. */
export async function initOnline(): Promise<void> {
  if (!onlineConfigured) return;
  const sb = await client();
  await sb.auth.getSession();
}
export async function getAccount(): Promise<Account | null> {
  if (!onlineConfigured) return null;
  const sb = await client();
  const { data } = await sb.auth.getSession();
  const user = data.session?.user;
  if (!user) return null;
  const anonymous = !!user.is_anonymous;
  return { id: user.id, anonymous, username: anonymous ? null : usernameFromEmail(user.email) };
}

/** Makes sure there is a user, signing in anonymously the first time. */
async function ensureUser(): Promise<void> {
  const sb = await client();
  const { data } = await sb.auth.getSession();
  if (data.session) return;
  let error;
  try {
    ({ error } = await sb.auth.signInAnonymously());
  } catch (e) {
    throw new OnlineError(String((e as Error)?.message ?? e), 'network');
  }
  if (error?.code === 'anonymous_provider_disabled') throw new OnlineError('Create an account (below) to join the leaderboard.', 'config', error.code);
  if (error) throw new OnlineError(error.message, 'network', error.code ?? '');
}

export async function submitResult(r: PendingResult): Promise<void> {
  await ensureUser();
  await rpc('submit_daily_result', { p_day: isoDay(r.day), p_guesses: r.guesses, p_won: r.won, p_hints_used: r.hints });
}

export async function setNickname(nickname: string): Promise<string> {
  await ensureUser();
  return rpc<string>('set_nickname', { p_nickname: nickname });
}

export async function dailyDistribution(day: number): Promise<ScoreCount[]> {
  const rows = await rpc<{ score: number; players: number }[]>('daily_distribution', { p_day: isoDay(day) });
  return (rows ?? []).map((r) => ({ score: Number(r.score), players: Number(r.players) }));
}

export async function leaderboard(period: Period, limit = 50): Promise<LeaderRow[]> {
  const rows = await rpc<Record<string, unknown>[]>('leaderboard', { p_period: period, p_limit: limit });
  return (rows ?? []).map((r) => ({
    rank: Number(r.rank),
    nickname: String(r.nickname),
    avg: Number(r.avg_guesses),
    wins: Number(r.wins),
    played: Number(r.played),
    winRate: Number(r.win_rate),
    isMe: !!r.is_me,
    streak: Number(r.streak ?? 0),
  }));
}

/** The signed-in player's standing, or null when there's no session yet. */
export async function myStanding(period: Period): Promise<Standing | null> {
  if (!(await getAccount())) return null;
  const rows = await rpc<Record<string, unknown>[]>('my_standing', { p_period: period });
  const r = rows?.[0];
  if (!r) return null;
  return {
    nickname: (r.nickname as string | null) ?? null,
    rank: num(r.rank),
    rankedTotal: Number(r.ranked_total ?? 0),
    betterThan: num(r.better_than),
    avg: num(r.avg_guesses),
    wins: Number(r.wins ?? 0),
    played: Number(r.played ?? 0),
    winRate: num(r.win_rate),
    winsNeeded: Number(r.wins_needed ?? 0),
    streak: Number(r.streak ?? 0),
  };
}

const authError = (e: { message: string; code?: string; status?: number }, fallback: string) => {
  const code = e.code ?? '';
  if (/user_already_exists|email_exists|identity_already_exists/.test(code) || /already (been )?registered/i.test(e.message))
    return new OnlineError('That username is taken', 'rejected', code);
  if (code === 'invalid_credentials') return new OnlineError('Wrong username or password', 'rejected', code);
  if (code === 'weak_password') return new OnlineError('Pick a stronger password (at least 8 characters)', 'rejected', code);
  if (code === 'over_request_rate_limit' || e.status === 429) return new OnlineError('Too many attempts. Try again in a minute.', 'network', code);
  return new OnlineError(e.message || fallback, 'network', code);
};

/**
 * Creates a username + password account and signs in to it. A guest keeps their user id, so their
 * results and nickname carry over. The account is created by the register_account RPC (see the
 * migrations) because the made-up email would fail Supabase's own email checks.
 */
export async function createAccount(username: string, password: string): Promise<void> {
  const sb = await client();
  const { data: cur } = await sb.auth.getSession();
  if (cur.session && !cur.session.user.is_anonymous) throw new OnlineError('You are already signed in', 'rejected');
  await rpc('register_account', { p_username: username, p_password: password });
  await signInWithPassword(username, password);
}
/** Signs in to an existing account. This replaces the current guest session. */
export async function signInWithPassword(username: string, password: string): Promise<void> {
  const sb = await client();
  let res;
  try {
    res = await sb.auth.signInWithPassword({ email: usernameToEmail(username), password });
  } catch (e) {
    throw new OnlineError(String((e as Error)?.message ?? e), 'network');
  }
  if (res.error) throw authError(res.error, "Couldn't sign in");
}
export async function signOut(): Promise<void> {
  const sb = await client();
  await sb.auth.signOut();
}
