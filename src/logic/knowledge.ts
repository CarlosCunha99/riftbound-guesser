import { ATTRS, type AttrKey, type Clue } from '../types';

export interface Knowledge {
  key: AttrKey;
  label: string;
  solved: boolean;
  /** The guessed value that was an exact hit (null means N/A). */
  value: string | number | null;
}

/** Lists the attributes a guess has matched exactly. Nothing is deduced from near or miss clues. */
export function buildKnowledge(rows: Clue[][]): Knowledge[] {
  return ATTRS.map(({ key, label }) => {
    const hit = rows.map((row) => row.find((c) => c.key === key)).find((c) => c?.status === 'hit');
    return { key, label, solved: !!hit, value: hit ? hit.value : null };
  });
}