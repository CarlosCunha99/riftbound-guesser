import { MAX_GUESSES } from '../types';
import type { DailyHistory } from './storage';

/**
 * Leaderboard rules. These must match supabase/migrations (score expression, MIN_WINS and the
 * nickname rules), because the server computes the real ranking.
 */
export const LOSS_SCORE = MAX_GUESSES + 1;
export const MIN_WINS = 5;
export const NICK_MIN = 3;
export const NICK_MAX = 16;

export interface DailyOutcome {
  won: boolean;
  guesses: number;
}

/** A won game scores its guess count. A loss scores LOSS_SCORE (11). Lower is better. */
export function scoreOf(r: DailyOutcome): number {
  return r.won ? r.guesses : LOSS_SCORE;
}

/** Average score over all Daily games, or null when there are none. */
export function averageScore(results: DailyOutcome[]): number | null {
  if (!results.length) return null;
  return results.reduce((sum, r) => sum + scoreOf(r), 0) / results.length;
}

export function isRanked(wins: number): boolean {
  return wins >= MIN_WINS;
}

/**
 * Share of the *other* players that did strictly worse, as a whole percent.
 * `total` includes the player. Returns null when nobody else is in the pool.
 */
export function percentBetter(worse: number, total: number): number | null {
  if (total <= 1) return null;
  return Math.round((100 * Math.max(0, Math.min(worse, total - 1))) / (total - 1));
}

export interface ScoreCount {
  score: number;
  players: number;
}

/** Turns score rows into counts for scores 1..LOSS_SCORE (index = score - 1). */
export function fillDistribution(rows: ScoreCount[]): number[] {
  const out = Array<number>(LOSS_SCORE).fill(0);
  for (const r of rows) if (r.score >= 1 && r.score <= LOSS_SCORE) out[r.score - 1] += r.players;
  return out;
}

/** Where a score sits in a day's distribution. The distribution must already include this player. */
export function dailyStanding(dist: number[], score: number): { total: number; worse: number; better: number | null } {
  const total = dist.reduce((a, b) => a + b, 0);
  const worse = dist.slice(score).reduce((a, b) => a + b, 0);
  return { total, worse, better: percentBetter(worse, total) };
}

export function formatAverage(avg: number | null): string {
  return avg === null ? '—' : avg.toFixed(2);
}

// ---------- nicknames ----------

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '|': 'i', '8': 'b' };
/** Blocked anywhere in the name, even inside other words. */
const BLOCK_ANYWHERE = ['fuck', 'shit', 'cunt', 'nigg', 'fagg', 'bitch', 'whore', 'slut', 'retard', 'pussy', 'penis', 'vagina', 'hitler', 'twat', 'wank', 'porn', 'dildo', 'jizz', 'nazi', 'rapist', 'molest'];
/** Blocked only as a whole word, so names like "Assassin" or "Peacock" stay allowed. */
const BLOCK_WORD = ['fag', 'rape', 'cock', 'dick', 'cum', 'tits', 'ass', 'anal', 'kike', 'spic', 'chink', 'sex'];

/** Best-effort profanity check (the database runs the same check). */
export function isProfane(name: string): boolean {
  const s = [...name.toLowerCase()].map((ch) => LEET[ch] ?? ch).join('');
  const letters = s.replace(/[^a-z]/g, '');
  if (BLOCK_ANYWHERE.some((w) => letters.includes(w))) return true;
  return s.split(/[^a-z]+/).some((w) => BLOCK_WORD.includes(w));
}

export type NicknameCheck = { ok: true; value: string } | { ok: false; error: string };

export function validateNickname(raw: string): NicknameCheck {
  const value = raw.trim().replace(/\s+/g, ' ');
  if (value.length < NICK_MIN) return { ok: false, error: `Use at least ${NICK_MIN} characters.` };
  if (value.length > NICK_MAX) return { ok: false, error: `Use at most ${NICK_MAX} characters.` };
  if (!/^[A-Za-z0-9_ -]+$/.test(value)) return { ok: false, error: 'Use letters, numbers, spaces, - or _ only.' };
  if (isProfane(value)) return { ok: false, error: 'Please pick a different nickname.' };
  return { ok: true, value };
}

// ---------- accounts ----------

export const PASSWORD_MIN = 8;
const EMAIL_DOMAIN = 'riftguessr.app';

export type UsernameCheck = { ok: true; value: string } | { ok: false; error: string };

/** Login names are 3-16 letters, numbers, "_" or "-". They are case-insensitive. */
export function validateUsername(raw: string): UsernameCheck {
  const value = raw.trim().toLowerCase();
  if (value.length < NICK_MIN) return { ok: false, error: `Use at least ${NICK_MIN} characters.` };
  if (value.length > NICK_MAX) return { ok: false, error: `Use at most ${NICK_MAX} characters.` };
  if (!/^[a-z0-9_-]+$/.test(value)) return { ok: false, error: 'Use letters, numbers, - or _ only (no spaces).' };
  if (isProfane(value)) return { ok: false, error: 'Please pick a different username.' };
  return { ok: true, value };
}

export function validatePassword(pw: string): string | null {
  return pw.length >= PASSWORD_MIN ? null : `Use at least ${PASSWORD_MIN} characters.`;
}

/** Supabase logins need an email, so the username is mapped to a made-up one. Nobody is emailed. */
export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${EMAIL_DOMAIN}`;
}

export function usernameFromEmail(email: string | undefined | null): string | null {
  const suffix = `@${EMAIL_DOMAIN}`;
  return email && email.endsWith(suffix) ? email.slice(0, -suffix.length) : null;
}

// ---------- submissions ----------

export interface PendingResult {
  day: number;
  guesses: number;
  won: boolean;
  hints: number;
}

/** Days already sent to the server ('ok') or refused by it ('rejected'), so they're never retried. */
export type SentLog = Record<number, 'ok' | 'rejected'>;

/**
 * Finished Daily games that still need submitting. Only today and yesterday are considered (the
 * server accepts yesterday for a short grace period after midnight). Archive replays never count.
 */
export function pendingResults(history: DailyHistory, sent: SentLog, today: number): PendingResult[] {
  const out: PendingResult[] = [];
  for (const day of [today - 1, today]) {
    const s = history[day];
    if (!s || s.status === 'playing' || s.archive || sent[day] || !s.guessIds.length) continue;
    out.push({ day, guesses: s.guessIds.length, won: s.status === 'won', hints: s.hints?.length ?? 0 });
  }
  return out;
}
