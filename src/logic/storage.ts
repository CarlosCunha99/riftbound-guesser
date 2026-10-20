import { MAX_GUESSES } from '../types';
import type { SentLog } from './ranking';

export interface Settings {
  highContrast: boolean;
  reducedMotion: boolean;
  hardMode: boolean;
  practiceSet: string; // '' = all sets
}

export interface Stats {
  played: number;
  wins: number;
  currentStreak: number;
  bestStreak: number;
  lastDay: number | null;
  /** dist[i] = wins in i+1 guesses */
  dist: number[];
}

export interface DailyState {
  day: number;
  guessIds: string[];
  /** Indexes of hints that were revealed. */
  hints: number[];
  startedAt: number | null;
  finishedAt: number | null;
  status: 'playing' | 'won' | 'lost';
  /** True when played from the archive after its day had passed (doesn't count for stats). */
  archive?: boolean;
}

/** Every daily the player has started, keyed by day index. */
export type DailyHistory = Record<number, DailyState>;

const KEYS = {
  settings: 'rbg.settings',
  stats: 'rbg.stats',
  daily: 'rbg.daily',
  history: 'rbg.history',
  seenHelp: 'rbg.seenHelp',
  sent: 'rbg.lb.sent',
  joinSkipped: 'rbg.lb.joinSkipped',
};

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function memoryStore(): KV {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

function defaultStore(): KV {
  try {
    const ls = globalThis.localStorage;
    ls.setItem('rbg.probe', '1');
    return ls;
  } catch {
    return memoryStore();
  }
}

export const defaultSettings = (): Settings => ({ highContrast: false, reducedMotion: false, hardMode: false, practiceSet: '' });
export const emptyStats = (): Stats => ({
  played: 0,
  wins: 0,
  currentStreak: 0,
  bestStreak: 0,
  lastDay: null,
  dist: Array(MAX_GUESSES).fill(0),
});

export class Storage {
  constructor(private kv: KV = defaultStore()) {}

  private read<T>(key: string, fallback: T): T {
    try {
      const raw = this.kv.getItem(key);
      return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    } catch {
      return fallback;
    }
  }
  private write(key: string, value: unknown) {
    try {
      this.kv.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or blocked: play continues in memory */
    }
  }

  get settings(): Settings {
    return this.read(KEYS.settings, defaultSettings());
  }
  set settings(v: Settings) {
    this.write(KEYS.settings, v);
  }
  get stats(): Stats {
    return this.read(KEYS.stats, emptyStats());
  }
  set stats(v: Stats) {
    this.write(KEYS.stats, v);
  }
  /** All saved dailies. Also migrates the older single-day `rbg.daily` record. */
  history(): DailyHistory {
    const h = this.read<DailyHistory>(KEYS.history, {});
    const legacy = this.read<DailyState | null>(KEYS.daily, null);
    if (legacy && typeof legacy.day === 'number' && !h[legacy.day]) h[legacy.day] = legacy;
    return h;
  }
  daily(day: number): DailyState {
    return this.history()[day] ?? { day, guessIds: [], hints: [], startedAt: null, finishedAt: null, status: 'playing' };
  }
  saveDaily(v: DailyState) {
    const h = this.history();
    h[v.day] = v;
    this.write(KEYS.history, h);
    this.write(KEYS.daily, v);
  }
  get seenHelp(): boolean {
    return this.kv.getItem(KEYS.seenHelp) === '1';
  }
  markHelpSeen() {
    this.write(KEYS.seenHelp, 1);
  }
  /** Leaderboard submissions that are done (sent or refused), keyed by day index. */
  get sent(): SentLog {
    return this.read<SentLog>(KEYS.sent, {});
  }
  markSent(day: number, outcome: 'ok' | 'rejected') {
    this.write(KEYS.sent, { ...this.sent, [day]: outcome });
  }
  /** True once the player dismissed the "Join the leaderboard" prompt. */
  get joinSkipped(): boolean {
    return this.kv.getItem(KEYS.joinSkipped) === '1';
  }
  skipJoin() {
    this.write(KEYS.joinSkipped, 1);
  }
}

/** Applies a finished daily game to the stats. Streaks only continue across consecutive days. */
export function recordDaily(stats: Stats, day: number, won: boolean, guesses: number): Stats {
  if (stats.lastDay === day) return stats;
  const next: Stats = { ...stats, dist: [...stats.dist], played: stats.played + 1, lastDay: day };
  if (won) {
    next.wins += 1;
    next.currentStreak = stats.lastDay === day - 1 ? stats.currentStreak + 1 : 1;
    next.bestStreak = Math.max(next.bestStreak, next.currentStreak);
    next.dist[guesses - 1] = (next.dist[guesses - 1] ?? 0) + 1;
  } else {
    next.currentStreak = 0;
  }
  return next;
}
