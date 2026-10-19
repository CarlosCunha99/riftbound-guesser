import type { Card } from '../types';

/** UTC date of day #1. Everyone worldwide gets the same card on the same UTC day. */
export const DAILY_EPOCH = Date.UTC(2026, 9, 19);
const DAY_MS = 86_400_000;
const SHUFFLE_SEED = 0x52_42_47; // "RBG"

export function dayIndex(now: Date = new Date()): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - DAILY_EPOCH) / DAY_MS);
}

export function dailyNumber(now: Date = new Date()): number {
  return dayIndex(now) + 1;
}

export function msUntilNextDaily(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next - now.getTime();
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Picks the daily card. Cards are sorted by id and shuffled with a fixed seed, then the
 * day index walks through that order, so no card repeats until the whole pool is used.
 */
export function pickDaily(cards: Card[], day: number): Card {
  if (!cards.length) throw new Error('No cards available');
  const sorted = [...cards].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rand = mulberry32(SHUFFLE_SEED);
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
  }
  const n = sorted.length;
  return sorted[((day % n) + n) % n];
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}
