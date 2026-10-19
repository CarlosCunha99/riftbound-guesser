import { ATTRS, type AttrKey, type Clue } from '../types';

export interface Knowledge {
  key: AttrKey;
  label: string;
  solved: boolean;
  /** Known answer when solved (null means N/A). */
  value: string | number | null;
  /** Ruled-out values for categorical attributes. */
  excluded: string[];
  /** Inclusive numeric bounds, when known. */
  min: number | null;
  max: number | null;
}

/** Summarises everything learned so far from a list of clue rows. */
export function buildKnowledge(rows: Clue[][]): Knowledge[] {
  return ATTRS.map(({ key, label, numeric }) => {
    const k: Knowledge = { key, label, solved: false, value: null, excluded: [], min: null, max: null };
    const solve = (v: string | number | null) => {
      k.solved = true;
      k.value = v;
    };
    for (const row of rows) {
      const clue = row.find((c) => c.key === key);
      if (!clue || k.solved) continue;
      if (clue.status === 'hit') {
        solve(clue.value);
        continue;
      }
      if (!numeric) {
        const v = String(clue.value);
        if (!k.excluded.includes(v)) k.excluded.push(v);
        continue;
      }
      const g = clue.value as number | null;
      if (g === null) continue; // only tells us the answer is not N/A
      if (clue.dir === null) {
        solve(null); // a number vs N/A is the only way to miss without a direction
      } else if (clue.status === 'near') {
        solve(clue.dir === 'up' ? g + 1 : g - 1);
      } else if (clue.dir === 'up') {
        k.min = Math.max(k.min ?? -Infinity, g + 2);
      } else {
        k.max = Math.min(k.max ?? Infinity, g - 2);
      }
    }
    if (!k.solved && k.min !== null && k.min === k.max) solve(k.min);
    return k;
  });
}

export function describeRange(k: Knowledge): string {
  if (k.min !== null && k.max !== null) return `${k.min}–${k.max}`;
  if (k.min !== null) return `≥ ${k.min}`;
  if (k.max !== null) return `≤ ${k.max}`;
  return '?';
}
