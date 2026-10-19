import { MAX_GUESSES, type Clue } from '../types';

const EMOJI = { hit: '🟩', near: '🟨', miss: '⬛' } as const;

/** rows are in play order (oldest first). */
export function shareGrid(rows: Clue[][]): string {
  return rows.map((row) => row.map((c) => EMOJI[c.status]).join('')).join('\n');
}

export function shareText(opts: { label: string; rows: Clue[][]; won: boolean; hints: number }): string {
  const score = opts.won ? `${opts.rows.length}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
  const hints = opts.hints ? ` · ${opts.hints} hint${opts.hints > 1 ? 's' : ''}` : '';
  return `RiftGuessr ${opts.label} ${score}${hints}\n${shareGrid(opts.rows)}`;
}
