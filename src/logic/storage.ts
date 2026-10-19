import { MAX_GUESSES } from '../types';

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
}

const KEYS = {
  settings: 'rbg.settings',
  stats: 'rbg.stats',
  daily: 'rbg.daily',
  seenHelp: 'rbg.seenHelp',
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
  daily(day: number): DailyState {
    const saved = this.read<DailyState | null>(KEYS.daily, null);
    if (saved && saved.day === day) return saved;
    return { day, guessIds: [], hints: [], startedAt: null, finishedAt: null, status: 'playing' };
  }
  saveDaily(v: DailyState) {
    this.write(KEYS.daily, v);
  }
  get seenHelp(): boolean {
    return this.kv.getItem(KEYS.seenHelp) === '1';
  }
  markHelpSeen() {
    this.write(KEYS.seenHelp, 1);
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
