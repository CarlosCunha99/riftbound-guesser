import { describe, expect, it } from 'vitest';
import { compareCards, compareNumeric, isSolved } from './compare';
import { buildKnowledge } from './knowledge';
import { shareText } from './share';
import { findExact, searchCards } from './search';
import type { Card } from '../types';

export const card = (over: Partial<Card>): Card => ({
  id: 'x',
  name: 'X',
  title: 'X',
  type: 'Unit',
  domain: 'Fury',
  cost: 4,
  power: 0,
  might: 4,
  set: 'Origins',
  setCode: 'OGN',
  rarity: 'Common',
  image: null,
  ...over,
});

describe('compareNumeric', () => {
  it('matches equal values including both N/A', () => {
    expect(compareNumeric(3, 3)).toEqual({ status: 'hit', dir: null });
    expect(compareNumeric(null, null)).toEqual({ status: 'hit', dir: null });
  });
  it('marks values within ±1 as close with a direction', () => {
    expect(compareNumeric(3, 4)).toEqual({ status: 'near', dir: 'up' });
    expect(compareNumeric(5, 4)).toEqual({ status: 'near', dir: 'down' });
  });
  it('marks larger gaps as miss but keeps the direction', () => {
    expect(compareNumeric(1, 6)).toEqual({ status: 'miss', dir: 'up' });
    expect(compareNumeric(8, 2)).toEqual({ status: 'miss', dir: 'down' });
  });
  it('treats number vs N/A as a miss without direction', () => {
    expect(compareNumeric(null, 3)).toEqual({ status: 'miss', dir: null });
    expect(compareNumeric(3, null)).toEqual({ status: 'miss', dir: null });
  });
});

describe('compareCards', () => {
  const answer = card({ id: 'a', type: 'Unit', domain: 'Fury', cost: 4, power: 1, might: 3, set: 'Unleashed' });
  it('produces six clues in column order', () => {
    const clues = compareCards(card({ id: 'g', type: 'Spell', domain: 'Body', cost: 4, power: 2, might: null, set: 'Radiance' }), answer);
    expect(clues.map((c) => [c.key, c.status, c.dir])).toEqual([
      ['type', 'miss', null],
      ['domain', 'miss', null],
      ['cost', 'hit', null],
      ['power', 'near', 'down'],
      ['might', 'miss', null],
      ['set', 'miss', null],
    ]);
    expect(isSolved(clues)).toBe(false);
  });
  it('is solved when every attribute matches', () => {
    expect(isSolved(compareCards(answer, answer))).toBe(true);
  });
});

describe('buildKnowledge', () => {
  const answer = card({ type: 'Unit', domain: 'Fury', cost: 5, power: 0, might: 6, set: 'Unleashed' });
  const rows = [
    card({ type: 'Unit', domain: 'Calm', cost: 2, power: 0, might: 2, set: 'Origins' }),
    card({ type: 'Spell', domain: 'Body', cost: 8, power: 0, might: null, set: 'Radiance' }),
  ].map((g) => compareCards(g, answer));
  const k = Object.fromEntries(buildKnowledge(rows).map((x) => [x.key, x]));

  it('solves exact matches', () => {
    expect(k.type).toMatchObject({ solved: true, value: 'Unit' });
    expect(k.power).toMatchObject({ solved: true, value: 0 });
  });
  it('leaves non-exact clues unsolved and exposes no exclusions or ranges', () => {
    for (const key of ['domain', 'set', 'cost', 'might']) expect(k[key]).toEqual({ key, label: k[key].label, solved: false, value: null });
  });
  it('never solves from meeting higher/lower bounds', () => {
    const kk = buildKnowledge([card({ cost: 2 }), card({ cost: 6 })].map((g) => compareCards(g, card({ cost: 4 }))));
    expect(kk.find((x) => x.key === 'cost')).toMatchObject({ solved: false, value: null });
  });
  it('never solves from near clues or number vs N/A misses', () => {
    const row = compareCards(card({ cost: 4, power: 1, might: 2 }), card({ cost: 5, power: 0, might: null }));
    expect(row.find((c) => c.key === 'cost')?.status).toBe('near');
    const kk = buildKnowledge([row]);
    for (const key of ['cost', 'power', 'might']) expect(kk.find((x) => x.key === key)).toMatchObject({ solved: false, value: null });
  });
  it('shows N/A when N/A was guessed exactly', () => {
    const kk = buildKnowledge([compareCards(card({ might: null }), card({ might: null }))]);
    expect(kk.find((x) => x.key === 'might')).toMatchObject({ solved: true, value: null });
  });
});

describe('share', () => {
  it('builds a Wordle-style grid', () => {
    const answer = card({});
    const rows = [compareCards(card({ cost: 5, set: 'Radiance' }), answer), compareCards(answer, answer)];
    expect(shareText({ label: '#3', rows, won: true, hints: 1 })).toBe(
      'RiftGuessr #3 2/10 · 1 hint\n🟩🟩🟨🟩🟩⬛\n🟩🟩🟩🟩🟩🟩',
    );
    expect(shareText({ label: 'Practice', rows: rows.slice(0, 1), won: false, hints: 0 }).split('\n')[0]).toBe(
      'RiftGuessr Practice X/10',
    );
  });
});

describe('search', () => {
  const cards = [card({ id: '1', name: 'Vi, Hotheaded' }), card({ id: '2', name: 'Raving Scholar' }), card({ id: '3', name: 'Viktor, Herald' }), card({ id: '4', name: 'Vilemaw' })];
  it('ranks whole-word prefix matches first and hides excluded cards', () => {
    expect(searchCards(cards, 'vi', new Set()).map((r) => r.card.id)).toEqual(['1', '4', '3', '2']);
    expect(searchCards(cards, 'vi', new Set(['1'])).map((r) => r.card.id)).toEqual(['4', '3', '2']);
  });
  it('finds exact names case-insensitively', () => {
    expect(findExact(cards, '  vi, hotheaded ')?.id).toBe('1');
  });
});
