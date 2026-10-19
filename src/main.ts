import './styles.css';
import { App } from './ui/app';
import type { Card } from './types';

async function start() {
  const root = document.getElementById('app')!;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/cards.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cards = (await res.json()) as Card[];
    if (!cards.length) throw new Error('empty card list');
    new App(root, cards);
  } catch (err) {
    console.error(err);
    root.innerHTML = '<p class="fatal">Could not load the card list. Please refresh the page.</p>';
  }
}

start();
