import { describe, expect, it } from 'vitest';
import {
  averageScore,
  dailyStanding,
  fillDistribution,
  isProfane,
  isRanked,
  LOSS_SCORE,
  MIN_WINS,
  pendingResults,
  percentBetter,
  scoreOf,
  validateNickname,
} from './ranking';
import type { DailyHistory, DailyState } from './storage';

describe('average guesses', () => {
  it('scores wins by guesses and losses as 11', () => {
    expect(LOSS_SCORE).toBe(11);
    expect(scoreOf({ won: true, guesses: 4 })).toBe(4);
    expect(scoreOf({ won: false, guesses: 10 })).toBe(11);
  });
  it('averages every daily game, counting losses as 11', () => {
    expect(averageScore([])).toBeNull();
    expect(averageScore([{ won: true, guesses: 3 }, { won: true, guesses: 5 }])).toBe(4);
    expect(averageScore([{ won: true, guesses: 1 }, { won: false, guesses: 10 }])).toBe(6);
  });
  it('needs a minimum number of wins to be ranked', () => {
    expect(isRanked(MIN_WINS - 1)).toBe(false);
    expect(isRanked(MIN_WINS)).toBe(true);
  });
});

describe('percentile', () => {
  it('is the share of other players who did strictly worse', () => {
    expect(percentBetter(0, 1)).toBeNull(); // alone
    expect(percentBetter(9, 10)).toBe(100);
    expect(percentBetter(0, 10)).toBe(0);
    expect(percentBetter(3, 7)).toBe(50);
    expect(percentBetter(99, 10)).toBe(100); // clamped
  });
  it('builds a 1..11 distribution from score rows', () => {
    const d = fillDistribution([{ score: 2, players: 3 }, { score: 11, players: 1 }, { score: 2, players: 1 }, { score: 0, players: 9 }]);
    expect(d).toHaveLength(11);
    expect(d[1]).toBe(4);
    expect(d[10]).toBe(1);
    expect(d.reduce((a, b) => a + b)).toBe(5);
  });
  it('places a daily result in the day distribution (ties are not "better")', () => {
    // 1 player solved in 2, 2 players (incl. me) in 4, 3 in 6, 1 lost
    const d = fillDistribution([{ score: 2, players: 1 }, { score: 4, players: 2 }, { score: 6, players: 3 }, { score: 11, players: 1 }]);
    expect(dailyStanding(d, 4)).toEqual({ total: 7, worse: 4, better: 67 });
    expect(dailyStanding(d, 2)).toEqual({ total: 7, worse: 6, better: 100 });
    expect(dailyStanding(d, 11)).toEqual({ total: 7, worse: 0, better: 0 });
    expect(dailyStanding(fillDistribution([{ score: 3, players: 1 }]), 3).better).toBeNull();
  });
});

describe('nicknames', () => {
  it('trims, collapses spaces and enforces length and characters', () => {
    expect(validateNickname('  Rift   Walker ')).toEqual({ ok: true, value: 'Rift Walker' });
    expect(validateNickname('ab').ok).toBe(false);
    expect(validateNickname('x'.repeat(17)).ok).toBe(false);
    expect(validateNickname('Jinx<script>').ok).toBe(false);
    expect(validateNickname('Ahri_99-x').ok).toBe(true);
  });
  it('blocks profanity, including leetspeak, without false positives on common words', () => {
    expect(isProfane('Sh1tLord')).toBe(true);
    expect(isProfane('xX_FUCK_Xx')).toBe(true);
    expect(isProfane('big ass')).toBe(true);
    expect(isProfane('Assassin')).toBe(false);
    expect(isProfane('Peacock')).toBe(false);
    expect(isProfane('Classic Bass')).toBe(false);
    expect(validateNickname('b1tch').ok).toBe(false);
  });
});

describe('pending submissions', () => {
  const st = (day: number, over: Partial<DailyState> = {}): DailyState => ({
    day,
    guessIds: ['a', 'b', 'c'],
    hints: [0],
    startedAt: 1,
    finishedAt: 2,
    status: 'won',
    ...over,
  });
  it('queues finished daily games for today and yesterday only', () => {
    const h: DailyHistory = { 3: st(3), 8: st(8, { status: 'lost', guessIds: Array(10).fill('x'), hints: [] }), 9: st(9) };
    expect(pendingResults(h, {}, 9)).toEqual([
      { day: 8, guesses: 10, won: false, hints: 0 },
      { day: 9, guesses: 3, won: true, hints: 1 },
    ]);
  });
  it('skips games in progress, archive replays and days already sent', () => {
    const h: DailyHistory = { 8: st(8, { archive: true }), 9: st(9, { status: 'playing' }) };
    expect(pendingResults(h, {}, 9)).toEqual([]);
    expect(pendingResults({ 9: st(9) }, { 9: 'ok' }, 9)).toEqual([]);
    expect(pendingResults({ 9: st(9) }, { 9: 'rejected' }, 9)).toEqual([]);
  });
});
