import { ATTRS, type AttrKey, type Card, type Clue } from '../types';

const DOMAIN_VAR: Record<string, string> = {
  Fury: '--fury',
  Calm: '--calm',
  Mind: '--mind',
  Body: '--body',
  Chaos: '--chaos',
  Order: '--order',
  Colorless: '--colorless',
};

export const domColor = (domain: string) => `var(${DOMAIN_VAR[domain.split('/')[0]] ?? '--colorless'})`;
export const dot = (domain: string) => `<i class="dom" style="background:${domColor(domain)}" aria-hidden="true"></i>`;

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const show = (v: string | number | null) => (v === null || v === '' ? '—' : String(v));

const ICON = { hit: '✓', near: '±1', miss: '✕' } as const;
const WORD = { hit: 'match', near: 'close', miss: 'miss' } as const;
export const labelOf = (key: AttrKey) => ATTRS.find((a) => a.key === key)!.label;

export function clueLabel(clue: Clue): string {
  const dir = clue.dir ? `, answer is ${clue.dir === 'up' ? 'higher' : 'lower'}` : '';
  return `${labelOf(clue.key)} ${show(clue.value)}, ${WORD[clue.status]}${dir}`;
}

const TYPE_SHORT: Record<string, string> = { Champion: 'Champ', Battlefield: 'Field', Legend: 'Legend' };

export function cellHtml(clue: Clue, setCode = '', delayMs = 0): string {
  const label = clueLabel(clue);
  let body = esc(show(clue.value));
  if (clue.key === 'domain') body = `<span class="sub">${dot(String(clue.value))}</span>${body}`;
  if (clue.key === 'set') body = `<span class="full">${body}</span><span class="code">${esc(setCode || show(clue.value))}</span>`;
  if (clue.key === 'type' && TYPE_SHORT[String(clue.value)])
    body = `<span class="full">${body}</span><span class="code">${esc(TYPE_SHORT[String(clue.value)])}</span>`;
  const dir = clue.dir
    ? `<span class="sub" aria-hidden="true">${clue.dir === 'up' ? '↑' : '↓'} <span class="dirtxt">${clue.dir === 'up' ? 'higher' : 'lower'}</span></span>`
    : '';
  return `<div class="cell ${clue.status}" role="cell" aria-label="${esc(label)}" data-tip="${esc(label)}" style="--d:${delayMs}ms"><span class="i" aria-hidden="true">${ICON[clue.status]}</span><span aria-hidden="true" style="display:contents">${body}${dir}</span></div>`;
}

export function artHtml(card: Card, cls = ''): string {
  return card.image
    ? `<img class="${cls}" src="${esc(card.image)}" alt="" loading="lazy" decoding="async">`
    : `<div class="noimg ${cls}"></div>`;
}

export function formatTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}
