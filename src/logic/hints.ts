import type { Card } from '../types';

export type HintKind = 'traits' | 'ability' | 'art' | 'letter';

export interface HintDef {
  kind: HintKind;
  title: string;
  /** Number of guesses needed before this hint unlocks. */
  after: number;
}

/** Guess counts that unlock hint 1, 2 and 3. */
export const HINT_AFTER = [3, 6, 8];

const TITLES: Record<HintKind, string> = { traits: 'Traits', ability: 'Ability', art: 'Art', letter: 'First letter' };
const STOPWORDS = new Set(['the', 'and', 'for', 'from', 'with', 'into', 'your', 'our', 'its', 'are', 'all', 'one']);
export const REDACTED = '▇▇▇';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Case-insensitive whole-word matcher (works with apostrophes, hyphens and accents in names). */
const wordRe = (term: string, flags = 'i') => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, `${flags}u`);

/** The card's names: its full name, each comma part (for example "Ahri" in "Ahri, Confident") and its words. */
export function nameTerms(card: Pick<Card, 'title'>): string[] {
  const parts = card.title.split(',').map((p) => p.trim()).filter(Boolean);
  const tokens = parts.flatMap((p) => p.split(/\s+/)).filter((t) => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()));
  return [...new Set([card.title, ...parts, ...tokens])].sort((a, b) => b.length - a.length);
}

/** Tags without any that would give the answer away because they appear in the card's own name. */
export function filterTags(card: Pick<Card, 'title' | 'tags'>): string[] {
  return (card.tags ?? []).filter((tag) => !wordRe(tag).test(card.title));
}

/** Rarity, extra type labels (for example Champion or Signature) and the name-safe tags. */
export function traits(card: Card): string[] {
  const out = [card.rarity, ...(card.labels ?? []), ...filterTags(card)].filter((v): v is string => !!v);
  return [...new Set(out)];
}

/** Ability text with every form of the card's name replaced by ▇▇▇. */
export function redactAbility(card: Card): string {
  let text = card.ability ?? '';
  for (const term of nameTerms(card)) text = text.replace(wordRe(term, 'gi'), REDACTED);
  return text.trim();
}

/** The three hints for a card. A hint type with no data is skipped, so no hint is ever empty. */
export function hintLadder(card: Card): HintDef[] {
  const kinds: HintKind[] = [];
  if (traits(card).length) kinds.push('traits');
  if (/[\p{L}\p{N}]/u.test(redactAbility(card).replaceAll(REDACTED, ''))) kinds.push('ability');
  if (card.image) kinds.push('art');
  kinds.push('letter');
  return kinds.slice(0, HINT_AFTER.length).map((kind, i) => ({ kind, title: TITLES[kind], after: HINT_AFTER[i] }));
}
