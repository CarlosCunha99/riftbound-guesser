import './styles.css';
import { App } from './ui/app';
import type { Card } from './types';

async function start() {
  const root = document.getElementById('app')!;
  try {
    const [res, schedule] = await Promise.all([fetch(`${import.meta.env.BASE_URL}data/cards.json`), loadSchedule()]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cards = (await res.json()) as Card[];
    if (!cards.length) throw new Error('empty card list');
    new App(root, cards, schedule);
  } catch (err) {
    console.error(err);
    root.innerHTML = '<p class="fatal">Could not load the card list. Please refresh the page.</p>';
  }
}

/** The pinned daily schedule. If it's missing, the app falls back to the shuffled order. */
async function loadSchedule(): Promise<string[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/daily.json`);
    if (!res.ok) return [];
    const data = (await res.json()) as { ids?: unknown };
    return Array.isArray(data.ids) ? data.ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

start();