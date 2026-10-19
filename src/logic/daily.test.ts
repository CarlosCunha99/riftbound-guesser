import { describe, expect, it } from 'vitest';
import { dailyNumber, dayIndex, formatCountdown, msUntilNextDaily, pickDaily } from './daily';
import { recordDaily, emptyStats, Storage } from './storage';
import type { Card } from '../types';

const pool: Card[] = Array.from({ length: 50 }, (_, i) => ({
  id: `c-${String(i).padStart(3, '0')}`,
  name: `Card ${i}`,
  title: `Card ${i}`,
  type: 'Unit',
  domain: 'Fury',
  cost: 1,
  power: 0,
  might: 1,
  set: 'Origins',
  setCode: 'OGN',
  rarity: 'Common',
  image: null,
}));

describe('daily seed', () => {
  it('numbers days from the UTC epoch', () => {
    expect(dayIndex(new Date('2026-10-19T00:00:00Z'))).toBe(0);
    expect(dayIndex(new Date('2026-10-19T23:59:59Z'))).toBe(0);
    expect(dailyNumber(new Date('2026-10-20T00:00:01Z'))).toBe(2);
  });
  it('is deterministic and independent of input order', () => {
    const shuffled = [...pool].reverse();
    for (let d = 0; d < 20; d++) expect(pickDaily(shuffled, d).id).toBe(pickDaily(pool, d).id);
  });
  it('does not repeat a card until the pool is exhausted', () => {
    const ids = new Set(Array.from({ length: pool.length }, (_, d) => pickDaily(pool, d).id));
    expect(ids.size).toBe(pool.length);
  });
  it('handles negative days and wraps around', () => {
    expect(pickDaily(pool, -1).id).toBe(pickDaily(pool, pool.length - 1).id);
    expect(pickDaily(pool, pool.length).id).toBe(pickDaily(pool, 0).id);
  });
  it('counts down to UTC midnight', () => {
    expect(msUntilNextDaily(new Date('2026-10-19T23:00:00Z'))).toBe(3_600_000);
    expect(formatCountdown(5 * 3600_000 + 17 * 60_000 + 42_000)).toBe('05:17:42');
  });
});

describe('stats', () => {
  it('builds streaks across consecutive daily wins and resets on loss', () => {
    let s = recordDaily(emptyStats(), 5, true, 3);
    s = recordDaily(s, 6, true, 4);
    expect(s).toMatchObject({ played: 2, wins: 2, currentStreak: 2, bestStreak: 2 });
    expect(s.dist[2]).toBe(1);
    expect(recordDaily(s, 6, true, 1)).toBe(s); // same day is ignored
    s = recordDaily(s, 8, true, 2); // skipped a day
    expect(s.currentStreak).toBe(1);
    s = recordDaily(s, 9, false, 10);
    expect(s).toMatchObject({ played: 4, wins: 3, currentStreak: 0, bestStreak: 2 });
  });
  it('persists daily progress per day', () => {
    const m = new Map<string, string>();
    const st = new Storage({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) });
    const d = st.daily(3);
    st.saveDaily({ ...d, guessIds: ['a'] });
    expect(st.daily(3).guessIds).toEqual(['a']);
    expect(st.daily(4).guessIds).toEqual([]);
  });
});
