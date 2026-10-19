import { ATTRS, type Card, type Clue, type ClueStatus, type Direction } from '../types';

export function compareNumeric(guess: number | null, answer: number | null): { status: ClueStatus; dir: Direction } {
  if (guess === answer) return { status: 'hit', dir: null };
  if (guess === null || answer === null) return { status: 'miss', dir: null };
  const dir: Direction = answer > guess ? 'up' : 'down';
  return { status: Math.abs(answer - guess) <= 1 ? 'near' : 'miss', dir };
}

export function compareCards(guess: Card, answer: Card): Clue[] {
  return ATTRS.map(({ key, numeric }) => {
    if (numeric) {
      const g = guess[key] as number | null;
      const { status, dir } = compareNumeric(g, answer[key] as number | null);
      return { key, status, dir, value: g };
    }
    const g = guess[key] as string;
    return { key, status: g === answer[key] ? 'hit' : 'miss', dir: null, value: g };
  });
}

export function isSolved(clues: Clue[]): boolean {
  return clues.every((c) => c.status === 'hit');
}
