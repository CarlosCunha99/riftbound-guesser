import type { Card } from '../types';

export interface SearchResult {
  card: Card;
  score: number;
  /** [start, end) of the matched substring in card.name, when contiguous. */
  match: [number, number] | null;
}

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function score(name: string, q: string): { score: number; match: [number, number] | null } | null {
  const n = fold(name);
  const idx = n.indexOf(q);
  const wordEnd = idx >= 0 && (idx + q.length === n.length || /[\s,'—-]/.test(n[idx + q.length])) ? 5 : 0;
  if (idx === 0) return { score: 100 + wordEnd - n.length / 100, match: [0, q.length] };
  if (idx > 0) {
    const wordStart = /[\s,'—-]/.test(n[idx - 1]);
    return { score: (wordStart ? 80 : 60) + wordEnd - idx / 100, match: [idx, idx + q.length] };
  }
  // subsequence fallback for typos like "vihot"
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  if (i === q.length && q.length >= 3) return { score: 20 - n.length / 100, match: null };
  return null;
}

export function searchCards(cards: Card[], query: string, exclude: Set<string>, limit = 8): SearchResult[] {
  const q = fold(query.trim());
  if (!q) return [];
  const results: SearchResult[] = [];
  for (const card of cards) {
    if (exclude.has(card.id)) continue;
    const s = score(card.name, q);
    if (s) results.push({ card, ...s });
  }
  return results.sort((a, b) => b.score - a.score || a.card.name.localeCompare(b.card.name)).slice(0, limit);
}

export function findExact(cards: Card[], query: string): Card | undefined {
  const q = fold(query.trim());
  return cards.find((c) => fold(c.name) === q);
}
