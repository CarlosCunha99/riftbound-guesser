import type { SupabaseClient } from '@supabase/supabase-js';
import { dayDate } from '../logic/daily';
import type { PendingResult, ScoreCount } from '../logic/ranking';

/**
 * Optional online features (leaderboard, daily percentile). Everything here is best effort: when
 * Supabase isn't configured or reachable, the game keeps working offline.
 */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const onlineConfigured = !!(SUPABASE_URL && SUPABASE_KEY);

export type Period = 'all' | '30d';
export type Provider = 'github' | 'google';

export interface Account {
  id: string;
  anonymous: boolean;
  /** Linked OAuth providers, for example ["github"]. */
  providers: Provider[];
}

export interface LeaderRow {
  rank: number;
  nickname: string;
  avg: number;
  wins: number;
  played: number;
  winRate: number;
  isMe: boolean;
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

const RETURN_KEY = 'rbg.lb.return';
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

/** Starts the client so OAuth redirects complete and a stored session is restored. */
export async function initOnline(): Promise<{ returnToLeaderboard: boolean; authError: string | null }> {
  if (!onlineConfigured) return { returnToLeaderboard: false, authError: null };
  const sb = await client();
  await sb.auth.getSession();
  const url = new URL(location.href);
  const params = new URLSearchParams([...url.searchParams, ...new URLSearchParams(url.hash.replace(/^#/, ''))]);
  const authError = params.get('error_description');
  if (url.searchParams.has('code') || authError) {
    ['code', 'error', 'error_code', 'error_description', 'state'].forEach((k) => url.searchParams.delete(k));
    if (authError) url.hash = '';
    history.replaceState(history.state, '', url.toString());
  }
  const provider = sessionStorage.getItem(RETURN_KEY) as Provider | null;
  sessionStorage.removeItem(RETURN_KEY);
  // Linking failed because that GitHub/Google account already has its own player: sign in to it instead.
  if (authError && provider && /already|exists|linked/i.test(`${params.get('error_code') ?? ''} ${authError}`)) {
    sessionStorage.setItem(RETURN_KEY, provider);
    const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo: `${location.origin}${location.pathname}` } });
    if (!error) return { returnToLeaderboard: false, authError: null };
    sessionStorage.removeItem(RETURN_KEY);
  }
  return { returnToLeaderboard: !!provider, authError };
}

export async function getAccount(): Promise<Account | null> {
  if (!onlineConfigured) return null;
  const sb = await client();
  const { data } = await sb.auth.getSession();
  const user = data.session?.user;
  if (!user) return null;
  const providers = (user.identities ?? []).map((i) => i.provider).filter((p): p is Provider => p === 'github' || p === 'google');
  return { id: user.id, anonymous: !!user.is_anonymous, providers };
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
  };
}

/**
 * Keeps the player's history across devices. A guest links the provider to the same user id. If that
 * provider account already belongs to another player, it signs in to that account instead.
 */
export async function signInWith(provider: Provider): Promise<void> {
  const sb = await client();
  const redirectTo = `${location.origin}${location.pathname}`;
  sessionStorage.setItem(RETURN_KEY, provider);
  const fail = (error: { message: string; code?: string }) => {
    sessionStorage.removeItem(RETURN_KEY);
    return new OnlineError(error.message, 'network', error.code ?? '');
  };
  const { data } = await sb.auth.getSession();
  if (data.session?.user.is_anonymous) {
    const { error } = await sb.auth.linkIdentity({ provider, options: { redirectTo } });
    if (!error) return;
    if (!/already|exists/i.test(`${error.code ?? ''} ${error.message}`)) throw fail(error);
  }
  const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo } });
  if (error) throw fail(error);
}

export async function signOut(): Promise<void> {
  const sb = await client();
  await sb.auth.signOut();
}
