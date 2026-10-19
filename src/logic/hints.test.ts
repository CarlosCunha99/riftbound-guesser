import { describe, expect, it } from 'vitest';
import data from '../../public/data/cards.json';
import type { Card } from '../types';
import { filterTags, hintLadder, redactAbility, REDACTED, traits } from './hints';

const card = (o: Partial<Card>): Card => ({
  id: 'x', name: 'X', title: 'X', type: 'Unit', domain: 'Fury', cost: 1, power: 0, might: 1, set: 'Origins', setCode: 'OGN', rarity: 'Common', image: 'x.png', ...o,
});

describe('filterTags', () => {
  it("removes tags that match the card's own name", () => {
    expect(filterTags(card({ title: 'Ahri, Confident', tags: ['Ahri', 'Ionia'] }))).toEqual(['Ionia']);
    expect(filterTags(card({ title: 'Final Spark, Lux', tags: ['lux'] }))).toEqual([]);
    expect(filterTags(card({ title: "Kha'Zix, Evolving Hunter", tags: ["Kha'Zix", 'The Void'] }))).toEqual(['The Void']);
    expect(filterTags(card({ title: 'Dragon\'s Rage, Lee Sin', tags: ['Lee Sin'] }))).toEqual([]);
  });
  it('keeps tags that only partly overlap a word', () => {
    expect(filterTags(card({ title: 'Zedd Shadow', tags: ['Zed'] }))).toEqual(['Zed']);
    expect(filterTags(card({ title: 'Master of Shadows', tags: ['Zed'] }))).toEqual(['Zed']);
  });
});

describe('traits', () => {
  it('combines rarity, extra labels and name-safe tags', () => {
    expect(traits(card({ title: 'Jinx, Rebel', rarity: 'Epic', labels: ['Champion'], tags: ['Jinx', 'Zaun'] }))).toEqual(['Epic', 'Champion', 'Zaun']);
  });
});

describe('redactAbility', () => {
  it('redacts the full name, its parts and its words, case-insensitively', () => {
    const c = card({ title: 'Jinx, Demolitionist', ability: 'When JINX attacks, the demolitionist laughs. Jinx, Demolitionist wins. Jinxed stays.' });
    expect(redactAbility(c)).toBe(`When ${REDACTED} attacks, the ${REDACTED} laughs. ${REDACTED} wins. Jinxed stays.`);
  });
  it('does not redact short or common words from the name', () => {
    expect(redactAbility(card({ title: 'Master of the Shadows', ability: 'Play the top card of your deck. Shadows fall.' }))).toBe(`Play the top card of your deck. ${REDACTED} fall.`);
  });
});

describe('hintLadder', () => {
  it('uses Traits, Ability, Art after guesses 3, 6, 8', () => {
    const h = hintLadder(card({ ability: 'Draw 1.', artist: 'Someone' }));
    expect(h.map((x) => [x.kind, x.title, x.after])).toEqual([['traits', 'Traits', 3], ['ability', 'Ability', 6], ['art', 'Art', 8]]);
  });
  it('skips hint types with no data', () => {
    expect(hintLadder(card({ ability: null })).map((x) => x.kind)).toEqual(['traits', 'art', 'letter']);
    expect(hintLadder(card({ ability: 'Ahri', title: 'Ahri', rarity: null, image: null })).map((x) => x.kind)).toEqual(['letter']);
  });
  it('gives every card in the data three non-empty hints', () => {
    const cards = data as Card[];
    for (const c of cards) expect(hintLadder(c), c.title).toHaveLength(3);
  });
});
