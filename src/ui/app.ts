import { ATTRS, MAX_GUESSES, type Card, type Clue } from '../types';
import { compareCards, isSolved } from '../logic/compare';
import { dailyCard, dailyNumber, dayDate, dayIndex, formatCountdown, msUntilNextDaily } from '../logic/daily';
import { buildKnowledge, type Knowledge } from '../logic/knowledge';
import { hintLadder, redactAbility, REDACTED, traits, type HintKind } from '../logic/hints';
import { findExact, searchCards, type SearchResult } from '../logic/search';
import { shareText } from '../logic/share';
import { recordDaily, Storage, type Settings } from '../logic/storage';
import { dailyStanding, fillDistribution, formatAverage, MIN_WINS, pendingResults, scoreOf, validateNickname, validatePassword, validateUsername } from '../logic/ranking';
import {
  dailyDistribution,
  getAccount,
  initOnline,
  leaderboard,
  myStanding,
  OnlineError,
  onlineConfigured,
  setNickname,
  createAccount,
  signInWithPassword,
  signOut,
  submitResult,
  type Account,
  type LeaderRow,
  type Period,
  type Standing,
} from '../net/online';
import { artHtml, cellHtml, clueLabel, dot, esc, formatTime, show } from './render';

type Mode = 'daily' | 'practice' | 'archive';
type Page = 'play' | 'archive' | 'leaderboard';
type Tab = Mode | 'leaderboard';

const LB_HASH = '#/leaderboard';
const LB_LIMIT = 50;

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

interface Game {
  mode: Mode;
  day: number;
  target: Card;
  guesses: Card[]; // oldest first
  clues: Clue[][];
  hints: number[];
  startedAt: number | null;
  finishedAt: number | null;
  status: 'playing' | 'won' | 'lost';
}

const HINT_ICON: Record<HintKind, string> = { traits: '🏷️', ability: '📜', art: '🖼️', letter: '🔤' };

/** Renders a revealed hint. Only shows information the board never shows. */
function hintBody(kind: HintKind, c: Card): string {
  switch (kind) {
    case 'traits':
      return `<span class="chips">${traits(c).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</span>`;
    case 'ability': {
      const html = esc(redactAbility(c))
        .replace(/\[([^\]\n]{1,24})\]/g, (_, k: string) => `<span class="kw${k.length <= 2 ? ' sym' : ''}">${k}</span>`)
        .replace(/\n/g, '<br>');
      return `<blockquote class="ability">${html}</blockquote>`;
    }
    case 'art':
      return `<span class="hint-art"><img src="${esc(c.image)}" alt="Heavily blurred card art"></span>${c.artist ? `<small class="artist">Illustrated by ${esc(c.artist)}</small>` : ''}`;
    case 'letter':
      return `Starts with “${esc(c.title.charAt(0).toUpperCase())}”`;
  }
}

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;

/** One fixed slot in the "What you know" bar: the solved value in green, otherwise a muted "?". */
function knowSlot(k: Knowledge, glow: boolean): string {
  const v = k.solved ? show(k.value) : '';
  const body = k.solved ? `${k.key === 'domain' && v !== '—' ? dot(v) : ''}${esc(v)}` : '?';
  const aria = k.solved ? `${k.label}: ${v === '—' ? 'not applicable' : v}` : `${k.label}: unknown`;
  return `<div class="k${k.solved ? ' solved' : ''}${glow ? ' glow' : ''}" role="group" aria-label="${esc(aria)}"><span aria-hidden="true">${k.label}</span><strong aria-hidden="true" title="${esc(v)}">${body}</strong></div>`;
}

export class App {
  private settings: Settings;
  private daily!: Game;
  private practice: Game | null = null;
  /** A past daily opened from the archive. */
  private past: Game | null = null;
  /** Which page is shown: the board, the archive list or the leaderboard. */
  private page: Page = 'play';
  private lbPeriod: Period = 'all';
  private lbToken = 0;
  private syncing: Promise<void> | null = null;
  private game!: Game;
  private results: SearchResult[] = [];
  private active = -1;
  private knowledge: Knowledge[] = [];
  private toastTimer = 0;
  private dialogCleanup: (() => void) | null = null;
  private byId: Map<string, Card>;
  private sets: string[];

  constructor(
    private root: HTMLElement,
    private cards: Card[],
    /** Pinned daily answers by day index (public/data/daily.json). */
    private schedule: readonly string[] = [],
    private store = new Storage(),
  ) {
    this.byId = new Map(cards.map((c) => [c.id, c]));
    this.sets = [...new Set(cards.map((c) => c.set))].sort();
    this.settings = store.settings;
    if (this.settings.practiceSet && !this.sets.includes(this.settings.practiceSet)) this.settings.practiceSet = '';
    this.applySettings();
    this.loadDaily();
    this.game = this.daily;
    this.renderShell();
    this.bind();
    this.renderAll();
    if (location.hash === LB_HASH) {
      this.showLeaderboard(false);
    } else if (!store.seenHelp) {
      store.markHelpSeen();
      this.openHelp();
    } else if (this.game.status !== 'playing') {
      this.openResult();
    } else if (matchMedia('(min-width: 768px)').matches) {
      this.input.focus();
    }
    window.addEventListener('hashchange', () => {
      if (location.hash === LB_HASH) {
        if (this.page !== 'leaderboard') this.showLeaderboard(false);
      } else if (this.page === 'leaderboard') this.setMode(this.game.mode, false);
    });
    if (onlineConfigured) {
      window.addEventListener('online', () => void this.syncResults().catch(() => {}));
      initOnline()
        .then(() => {
          if (this.page === 'leaderboard') this.renderLeaderboard();
          return this.syncResults();
        })
        .catch((e) => console.warn('Leaderboard unavailable:', e));
    }
  }

  // ---------- state ----------
  private loadDaily() {
    this.daily = this.loadDay(dayIndex(), 'daily');
  }

  private loadDay(day: number, mode: 'daily' | 'archive'): Game {
    const saved = this.store.daily(day);
    const target = dailyCard(this.cards, this.schedule, day, this.byId);
    const guesses = saved.guessIds.map((id) => this.byId.get(id)).filter((c): c is Card => !!c);
    return {
      mode,
      day,
      target,
      guesses,
      clues: guesses.map((g) => compareCards(g, target)),
      hints: saved.hints ?? [],
      startedAt: saved.startedAt,
      finishedAt: saved.finishedAt,
      status: saved.status,
    };
  }

  private newPractice() {
    const set = this.settings.practiceSet;
    const pool = set ? this.cards.filter((c) => c.set === set) : this.cards;
    let target = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1) while (this.practice && target.id === this.practice.target.id) target = pool[Math.floor(Math.random() * pool.length)];
    this.practice = { mode: 'practice', day: -1, target, guesses: [], clues: [], hints: [], startedAt: null, finishedAt: null, status: 'playing' };
  }

  private saveDaily(g = this.game) {
    if (g.mode === 'practice') return;
    const prev = this.store.daily(g.day);
    this.store.saveDaily({
      day: g.day,
      guessIds: g.guesses.map((c) => c.id),
      hints: g.hints,
      startedAt: g.startedAt,
      finishedAt: g.finishedAt,
      status: g.status,
      archive: prev.archive || (g.mode === 'archive' && !prev.guessIds.length) || undefined,
    });
  }

  private get pool(): Card[] {
    const set = this.settings.practiceSet;
    return this.game.mode === 'practice' && set ? this.cards.filter((c) => c.set === set) : this.cards;
  }

  private get reduced(): boolean {
    return this.settings.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private get revealMs(): number {
    return this.reduced ? 250 : 80 * 5 + 500;
  }

  private gameLabel(g = this.game): string {
    return g.mode === 'practice' ? 'Practice' : `#${g.day + 1}`;
  }

  private get tab(): Tab {
    return this.page === 'play' ? this.game.mode : this.page;
  }

  /** Leaves the leaderboard URL without triggering hashchange. */
  private clearLbHash() {
    if (location.hash === LB_HASH) history.pushState(history.state, '', `${location.pathname}${location.search}`);
  }

  private showLeaderboard(push: boolean) {
    this.closeDialog();
    if (push && location.hash !== LB_HASH) history.pushState(history.state, '', LB_HASH);
    this.page = 'leaderboard';
    this.clearSearch();
    this.renderAll();
    window.scrollTo({ top: 0 });
  }

  private setMode(mode: Mode, updateUrl = true) {
    this.closeDialog();
    if (updateUrl) this.clearLbHash();
    this.page = mode === 'archive' ? 'archive' : 'play';
    if (mode === 'daily') {
      if (this.daily.day !== dayIndex()) this.loadDaily();
      this.game = this.daily;
    } else if (mode === 'practice') {
      if (!this.practice || this.practice.status !== 'playing') this.newPractice();
      this.game = this.practice!;
    }
    this.clearSearch();
    this.knowledge = [];
    this.renderAll();
  }

  private openDay(day: number) {
    if (this.daily.day !== dayIndex()) this.loadDaily();
    if (day === this.daily.day) return this.setMode('daily');
    this.clearLbHash();
    this.past = this.loadDay(day, 'archive');
    this.page = 'play';
    this.game = this.past;
    this.clearSearch();
    this.knowledge = [];
    this.renderAll();
    window.scrollTo({ top: 0 });
    if (this.game.status !== 'playing') this.openResult();
    else if (matchMedia('(min-width: 768px)').matches) this.input.focus();
  }

  private startPractice() {
    this.newPractice();
    this.clearLbHash();
    this.page = 'play';
    this.game = this.practice!;
    this.closeDialog();
    this.clearSearch();
    this.knowledge = [];
    this.renderAll();
    this.input.focus();
  }

  // ---------- shell ----------
  private get input() {
    return $<HTMLInputElement>(this.root, '#guess');
  }

  private renderShell() {
    const head = ATTRS.map(
      (a) => `<div role="columnheader"><span class="long">${a.label}</span><span class="short" aria-hidden="true">${a.short}</span></div>`,
    ).join('');
    this.root.innerHTML = `
<header class="nav">
  <div class="logo"><img src="./icon.svg" alt="" width="24" height="24" /><span>RiftGuessr</span></div>
  <div class="seg" role="group" aria-label="Game mode">
    <button type="button" data-mode="daily">Daily <span class="num">#${dailyNumber()}</span></button>
    <button type="button" data-mode="practice">Practice</button>
    <button type="button" data-mode="archive">Archive</button>
  </div>
  <div class="icons">
    <button type="button" class="ib" data-open="leaderboard" aria-label="Leaderboard" title="Leaderboard">🏆</button>
    <button type="button" class="ib" data-open="stats" aria-label="Statistics" title="Stats">▥</button>
    <button type="button" class="ib" data-open="help" aria-label="How to play" title="How to play">?</button>
    <button type="button" class="ib" data-open="settings" aria-label="Settings" title="Settings">⚙</button>
  </div>
</header>
<main class="app">
  <section class="archive" id="archive" aria-labelledby="archive-h" hidden></section>
  <section class="lb-page" id="leaderboard" aria-labelledby="lb-h" hidden></section>
  <div id="play">
  <section class="status" id="status" aria-label="Game status"></section>
  <div class="search-dock">
    <div class="search">
      <div class="toast" id="toast" hidden></div>
      <div class="field" id="field">
        <span aria-hidden="true" style="color:var(--faint)">⌕</span>
        <input id="guess" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="results"
          aria-label="Search a card" placeholder="Search a card…" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go">
        <kbd aria-hidden="true">↵</kbd>
        <span class="left-badge" id="left-badge" aria-hidden="true"></span>
        <button type="button" class="btn" id="submit">Guess</button>
      </div>
      <ul class="drop" id="results" role="listbox" aria-label="Matching cards" hidden></ul>
    </div>
  </div>
  <section class="know-wrap" aria-labelledby="know-h">
    <div class="know-head"><h2 id="know-h">What you know</h2><span id="know-n" aria-label="attributes solved">0/6</span></div>
    <div class="know" id="know"></div>
  </section>
  <section class="board">
    <div role="table" aria-label="Your guesses, newest first" aria-describedby="legend">
      <div role="rowgroup"><div class="cols" role="row"><div role="columnheader">Card</div>${head}</div></div>
      <div role="rowgroup" id="rows"></div>
    </div>
    <div class="legend" id="legend">
      <span><i class="hit" aria-hidden="true">✓</i>Match</span>
      <span><i class="near" aria-hidden="true">±1</i>Off by one</span>
      <span><i class="miss" aria-hidden="true">✕</i>No match</span>
      <span>↑ ↓ Answer is higher / lower</span>
    </div>
  </section>
  <section id="hints" aria-label="Hints"></section>
  </div>
  <footer class="foot">Unofficial fan project · not affiliated with Riot Games · <button type="button" data-open="help">About &amp; how to play</button></footer>
</main>
<div id="live" class="sr-only" aria-live="polite" aria-atomic="true"></div>
<dialog id="dlg" aria-labelledby="dlg-title"></dialog>`;
  }

  private bind() {
    const input = this.input;
    input.addEventListener('input', () => this.updateResults());
    input.addEventListener('focus', () => this.updateResults());
    input.addEventListener('blur', () => setTimeout(() => this.hideResults(), 120));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!this.results.length) return;
        e.preventDefault();
        const n = this.results.length;
        this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        this.renderResults();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      } else if (e.key === 'Escape') {
        this.hideResults();
      }
    });
    $(this.root, '#submit').addEventListener('click', () => this.submit());

    const results = $(this.root, '#results');
    results.addEventListener('mousedown', (e) => e.preventDefault());
    results.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (li) this.guess(this.results[Number(li.dataset.i)].card);
    });

    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const mode = t.closest<HTMLElement>('[data-mode]');
      if (mode) return this.setMode(mode.dataset.mode as Mode);
      const open = t.closest<HTMLElement>('[data-open]');
      if (open) return this.open(open.dataset.open!);
      const hint = t.closest<HTMLElement>('[data-hint]');
      if (hint) return this.useHint(Number(hint.dataset.hint));
      const art = t.closest<HTMLElement>('[data-card]');
      if (art) return this.openPreview(this.byId.get(art.dataset.card!)!);
      const cell = t.closest<HTMLElement>('#rows .cell[data-tip]');
      if (cell) return this.toast(cell.dataset.tip!);
      if (t.closest('[data-action="result"]')) return this.openResult();
      if (t.closest('[data-action="practice"]')) return this.startPractice();
      const day = t.closest<HTMLElement>('[data-day]');
      if (day) return this.openDay(Number(day.dataset.day));
      const period = t.closest<HTMLElement>('[data-period]');
      if (period) {
        this.lbPeriod = period.dataset.period as Period;
        return this.renderLeaderboard();
      }
      if (t.closest('[data-action="lb-retry"]')) return this.renderLeaderboard();
      if (t.closest('[data-action="signout"]')) return this.doSignOut();
      if (t.closest('[data-action="skip-join"]')) {
        this.store.skipJoin();
        t.closest('#join')?.remove();
      }
    });
    this.root.addEventListener('submit', (e) => {
      const target = e.target as HTMLElement;
      const auth = target.closest<HTMLFormElement>('form.auth');
      if (auth) {
        e.preventDefault();
        void this.submitAuth(auth, (e as SubmitEvent).submitter as HTMLButtonElement | null);
        return;
      }
      const form = target.closest<HTMLFormElement>('form.nick');
      if (!form) return;
      e.preventDefault();
      void this.submitNick(form);
    });

    document.addEventListener('keydown', (e) => {
      if ($<HTMLDialogElement>(this.root, '#dlg').open || this.page !== 'play' || e.ctrlKey || e.metaKey || e.altKey) return;
      const typing = (e.target as HTMLElement).matches?.('input, textarea, select');
      if (e.key === '/' && !typing) {
        e.preventDefault();
        this.input.focus();
      } else if ((e.key === 'h' || e.key === 'H') && !typing) {
        const i = this.readyHints()[0];
        if (i !== undefined) this.useHint(i);
        else this.toast(this.settings.hardMode ? 'Hints are off in hard mode' : 'No hint ready yet');
      }
    });

    const dlg = $<HTMLDialogElement>(this.root, '#dlg');
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || (e.target as HTMLElement).closest('.close, [data-action="close"]')) this.closeDialog();
    });
    dlg.addEventListener('close', () => {
      this.dialogCleanup?.();
      this.dialogCleanup = null;
    });
  }

  // ---------- search ----------
  private guessedIds() {
    return new Set(this.game.guesses.map((c) => c.id));
  }

  private updateResults() {
    if (this.game.status !== 'playing') return this.hideResults();
    this.results = searchCards(this.pool, this.input.value, this.guessedIds());
    this.active = this.results.length ? 0 : -1;
    this.renderResults();
  }

  private renderResults() {
    const ul = $(this.root, '#results');
    const q = this.input.value.trim();
    if (!q) return this.hideResults();
    ul.innerHTML = this.results.length
      ? this.results
          .map(({ card, match }, i) => {
            const name = match
              ? `${esc(card.name.slice(0, match[0]))}<mark>${esc(card.name.slice(match[0], match[1]))}</mark>${esc(card.name.slice(match[1]))}`
              : esc(card.name);
            return `<li class="opt${i === this.active ? ' act' : ''}" id="opt-${i}" role="option" aria-selected="${i === this.active}" data-i="${i}">
              ${artHtml(card)}<div class="n">${name}<div class="m">${esc(card.type)} · ${esc(card.set)}</div></div>
              <div class="meta" title="${esc(card.domain)}">${dot(card.domain)}</div></li>`;
          })
          .join('')
      : `<li class="empty" role="option" aria-disabled="true" aria-selected="false">No matching card${this.game.mode === 'practice' && this.settings.practiceSet ? ` in ${esc(this.settings.practiceSet)}` : ''}</li>`;
    ul.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    if (this.active >= 0) {
      this.input.setAttribute('aria-activedescendant', `opt-${this.active}`);
      document.getElementById(`opt-${this.active}`)?.scrollIntoView({ block: 'nearest' });
    } else this.input.removeAttribute('aria-activedescendant');
  }

  private hideResults() {
    const ul = $(this.root, '#results');
    ul.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  private clearSearch() {
    this.input.value = '';
    this.results = [];
    this.active = -1;
    this.hideResults();
  }

  private submit() {
    if (this.game.status !== 'playing') return;
    const value = this.input.value;
    let card = this.active >= 0 ? this.results[this.active]?.card : undefined;
    card ??= findExact(this.pool, value);
    if (!card) return this.reject(value.trim() ? 'Pick a card from the list' : 'Type a card name first');
    this.guess(card);
  }

  private reject(msg: string) {
    const field = $(this.root, '#field');
    field.classList.remove('shake');
    void field.offsetWidth;
    field.classList.add('shake');
    setTimeout(() => field.classList.remove('shake'), 400);
    this.toast(msg);
    this.announce(msg);
  }

  // ---------- game flow ----------
  private guess(card: Card) {
    const g = this.game;
    if (g.status !== 'playing') return;
    if (this.guessedIds().has(card.id)) return this.reject('Already guessed');
    g.startedAt ??= Date.now();
    const clues = compareCards(card, g.target);
    g.guesses.push(card);
    g.clues.push(clues);
    if (isSolved(clues)) g.status = 'won';
    else if (g.guesses.length >= MAX_GUESSES) g.status = 'lost';
    const ended = g.status !== 'playing';
    if (ended) {
      g.finishedAt = Date.now();
      if (g.mode === 'daily') this.store.stats = recordDaily(this.store.stats, g.day, g.status === 'won', g.guesses.length);
    }
    this.saveDaily(g);
    if (ended && g.mode === 'daily') void this.syncResults().catch(() => {});

    this.clearSearch();
    const left = MAX_GUESSES - g.guesses.length;
    const summary = clues.map(clueLabel).join('. ');
    const outcome = g.status === 'won' ? `Solved in ${g.guesses.length}!` : g.status === 'lost' ? `Out of guesses. The card was ${g.target.name}.` : `${left} ${left === 1 ? 'guess' : 'guesses'} left.`;
    this.announce(`${card.name}. ${summary}. ${outcome}`);
    this.toast(g.status === 'won' ? 'Solved!' : g.status === 'lost' ? 'Out of guesses' : `Not quite — ${left} ${left === 1 ? 'guess' : 'guesses'} left`);

    this.renderStatus();
    this.renderBoard(true);
    this.renderHints();
    const game = g;
    setTimeout(() => {
      if (this.game !== game) return;
      this.renderKnowledge(true);
      if (ended) setTimeout(() => this.game === game && this.openResult(), 250);
    }, this.revealMs);
  }

  private readyHints(): number[] {
    const g = this.game;
    if (this.settings.hardMode || g.status !== 'playing') return [];
    return hintLadder(g.target).map((h, i) => (g.guesses.length >= h.after && !g.hints.includes(i) ? i : -1)).filter((i) => i >= 0);
  }

  private useHint(i: number) {
    if (!this.readyHints().includes(i)) return;
    this.game.hints.push(i);
    this.saveDaily();
    this.renderHints();
    const h = hintLadder(this.game.target)[i];
    const text =
      h.kind === 'art' ? `blurred card art${this.game.target.artist ? `, illustrated by ${this.game.target.artist}` : ''}` : h.kind === 'traits' ? traits(this.game.target).join(', ') : h.kind === 'ability' ? redactAbility(this.game.target).replaceAll(REDACTED, 'redacted') : `starts with ${this.game.target.title.charAt(0)}`;
    this.announce(`Hint ${i + 1}, ${h.title}: ${text}`);
  }

  // ---------- rendering ----------
  private renderAll() {
    const tab = this.tab;
    this.root.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => {
      if (!b.closest('.seg')) return;
      const on = b.dataset.mode === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const num = this.root.querySelector('.seg .num');
    if (num) num.textContent = `#${this.daily.day + 1}`;
    this.root.querySelector('[data-open="leaderboard"]')?.classList.toggle('on', tab === 'leaderboard');
    $(this.root, '#play').hidden = this.page !== 'play';
    $(this.root, '#archive').hidden = this.page !== 'archive';
    $(this.root, '#leaderboard').hidden = this.page !== 'leaderboard';
    if (this.page === 'archive') return this.renderArchive();
    if (this.page === 'leaderboard') return void this.renderLeaderboard();
    const playing = this.game.status === 'playing';
    this.input.disabled = !playing;
    ($(this.root, '#submit') as HTMLButtonElement).disabled = !playing;
    this.input.placeholder = playing
      ? matchMedia('(min-width: 768px)').matches
        ? 'Search a card…  (press / to focus)'
        : 'Search a card…'
      : this.game.mode === 'daily'
        ? 'Daily done — come back tomorrow or play practice'
        : this.game.mode === 'archive'
          ? 'Done — pick another day from the archive'
          : 'Round over — start a new practice round';
    this.renderStatus();
    this.renderKnowledge(false);
    this.renderBoard(false);
    this.renderHints();
  }

  private renderArchive() {
    if (this.daily.day !== dayIndex()) this.loadDaily();
    const history = this.store.history();
    const today = this.daily.day;
    let played = 0;
    let won = 0;
    const rows: string[] = [];
    for (let day = today; day >= 0; day--) {
      const s = history[day];
      const done = s && s.status !== 'playing';
      if (done) played++;
      if (s?.status === 'won') won++;
      const n = s?.guessIds.length ?? 0;
      const card = done ? dailyCard(this.cards, this.schedule, day, this.byId) : null;
      const chip = !s || (!n && s.status === 'playing')
        ? `<span class="chip none">Not played</span>`
        : s.status === 'won'
          ? `<span class="chip hit">✓ ${n}/${MAX_GUESSES}</span>`
          : s.status === 'lost'
            ? `<span class="chip miss">✕ X/${MAX_GUESSES}</span>`
            : `<span class="chip near">In progress · ${n}/${MAX_GUESSES}</span>`;
      const tags = [day === today ? '<span class="tag today">Today</span>' : '', s?.archive ? '<span class="tag">Replay</span>' : '', s?.hints?.length ? `<span class="tag">${s.hints.length} hint${s.hints.length > 1 ? 's' : ''}</span>` : ''].join('');
      const action = done ? 'View' : n ? 'Continue' : 'Play';
      rows.push(`<li><button type="button" class="arow" data-day="${day}" aria-label="Daily #${day + 1}, ${esc(dateFmt.format(dayDate(day)))}: ${done ? `${s.status}, ${esc(card!.name)}` : action}">
        <span class="anum"><b>#${day + 1}</b><small>${esc(dateFmt.format(dayDate(day)))}</small></span>
        <span class="acard">${card ? `${artHtml(card)}<span>${esc(card.name)}<small>${esc(card.type)} · ${dot(card.domain)} ${esc(card.domain)}</small></span>` : `<i class="qmark" aria-hidden="true">?</i><span class="mute">Mystery card</span>`}</span>
        <span class="astat">${tags}${chip}</span>
        <span class="ago" aria-hidden="true">${action} →</span>
      </button></li>`);
    }
    const total = today + 1;
    $(this.root, '#archive').innerHTML = `
      <div class="ahead">
        <div><h2 id="archive-h">Archive</h2><p class="sub">Every daily card since #1. Answers stay hidden until you finish a day. Replays don't affect your streak.</p></div>
        <div class="asum"><div><b>${played}</b><span>of ${total} played</span></div><div><b>${played ? Math.round((won / played) * 100) : 0}%</b><span>Win rate</span></div></div>
      </div>
      <ol class="alist">${rows.join('')}</ol>`;
  }

  // ---------- leaderboard ----------
  /** Sends finished Daily results that the server hasn't seen yet. Network failures stay queued. */
  private syncResults(): Promise<void> {
    if (!onlineConfigured) return Promise.resolve();
    if (this.syncing) return this.syncing;
    const run = (async () => {
      for (const r of pendingResults(this.store.history(), this.store.sent, dayIndex())) {
        try {
          await submitResult(r);
          this.store.markSent(r.day, 'ok');
        } catch (e) {
          if (e instanceof OnlineError && e.kind === 'rejected') this.store.markSent(r.day, 'rejected');
          else throw e;
        }
      }
    })();
    this.syncing = run.finally(() => {
      if (this.syncing === tracked) this.syncing = null;
    });
    const tracked = this.syncing;
    return tracked;
  }

  private lbHead(withTabs: boolean) {
    const tab = (p: Period, label: string) =>
      `<button type="button" data-period="${p}" class="${this.lbPeriod === p ? 'on' : ''}" aria-pressed="${this.lbPeriod === p}">${label}</button>`;
    return `<div class="ahead">
      <div><h2 id="lb-h">Leaderboard</h2><p class="sub">Daily players ranked by average guesses. Lower is better.</p></div>
      ${withTabs ? `<div class="seg" role="group" aria-label="Period">${tab('all', 'All time')}${tab('30d', 'Last 30 days')}</div>` : ''}
    </div>`;
  }

  private lbHow() {
    return `<details class="how">
      <summary>How ranking works</summary>
      <ul>
        <li>Only <b>Daily</b> games count. Practice rounds and archive replays are never submitted.</li>
        <li>Your score is the <b>average number of guesses</b> across your Dailies. A lost game counts as <b>11</b>. Lower is better.</li>
        <li>You need a nickname and at least <b>${MIN_WINS} Daily wins</b> in the period to be ranked, so one lucky game can't top the board.</li>
        <li>Ties go to the player with more wins. "Better than X%" is the share of other ranked players with a worse average.</li>
        <li>Each Daily result is submitted once, when you finish, and can't be changed.</li>
      </ul>
    </details>`;
  }

  private nickForm(where: 'lb' | 'result', current = '') {
    return `<form class="nick" data-where="${where}" novalidate>
      <label class="sr-only" for="nick-${where}">Nickname</label>
      <input id="nick-${where}" name="nick" type="text" maxlength="16" minlength="3" autocomplete="nickname" spellcheck="false"
        placeholder="Pick a nickname" value="${esc(current)}" required>
      <button type="submit" class="btn">${current ? 'Save' : 'Join'}</button>
      <p class="err" role="alert"></p>
    </form>`;
  }

  private async renderLeaderboard() {
    const el = $(this.root, '#leaderboard');
    const token = ++this.lbToken;
    if (!onlineConfigured) {
      el.innerHTML = `${this.lbHead(false)}
        <div class="lb-note"><b>Leaderboard not configured</b>
        <p>This build isn't connected to the leaderboard server (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are missing). The game works fully offline, and your results stay on this device.</p></div>
        ${this.lbHow()}`;
      return;
    }
    const period = this.lbPeriod;
    const busy = el.querySelector('.lb-table, .lb-me');
    if (busy) el.querySelector('.lb-body')?.setAttribute('aria-busy', 'true');
    else el.innerHTML = `${this.lbHead(true)}<div class="lb-body" aria-busy="true"><p class="lb-loading">Loading leaderboard…</p></div>${this.lbHow()}`;
    el.querySelectorAll<HTMLElement>('[data-period]').forEach((b) => {
      b.classList.toggle('on', b.dataset.period === period);
      b.setAttribute('aria-pressed', String(b.dataset.period === period));
    });
    try {
      await this.syncResults().catch(() => {});
      const [rows, me, account] = await Promise.all([leaderboard(period, LB_LIMIT), myStanding(period), getAccount()]);
      if (token !== this.lbToken || this.page !== 'leaderboard') return;
      el.innerHTML = `${this.lbHead(true)}<div class="lb-body">${this.meCard(me, account, period)}${this.lbTable(rows)}</div>${this.lbHow()}`;
    } catch (e) {
      if (token !== this.lbToken || this.page !== 'leaderboard') return;
      const offline = !navigator.onLine;
      el.innerHTML = `${this.lbHead(true)}<div class="lb-body"><div class="lb-note"><b>${offline ? "You're offline" : "Couldn't load the leaderboard"}</b>
        <p>${offline || (e instanceof OnlineError && e.kind === 'network') ? "The leaderboard server can't be reached right now. Your Daily results are saved on this device and will be submitted later." : esc((e as Error)?.message ?? 'Unknown error')}</p>
        <button type="button" class="btn ghost" data-action="lb-retry">Try again</button></div></div>${this.lbHow()}`;
    }
  }

  private meCard(me: Standing | null, account: Account | null, period: Period) {
    const pending = pendingResults(this.store.history(), this.store.sent, dayIndex()).length;
    const queued = pending ? `<p class="lb-queued">${pending} result${pending > 1 ? 's' : ''} waiting to be submitted.</p>` : '';
    const linked = account && !account.anonymous;
    const accountLine = linked
      ? `<p class="lb-acct">Signed in as <b>${esc(account.username ?? 'your account')}</b>. <button type="button" class="link" data-action="signout">Sign out</button></p>`
      : `<details class="lb-acct"><summary>${account ? 'Playing as a guest on this device.' : 'Not signed in.'} Log in or create an account to keep your history</summary>
          <form class="auth" novalidate>
            <input name="u" placeholder="Username" autocomplete="username" maxlength="16" autocapitalize="none" spellcheck="false" aria-label="Username" />
            <input name="p" type="password" placeholder="Password (8+ characters)" autocomplete="current-password" aria-label="Password" />
            <div class="auth-btns"><button type="submit" class="btn sm" value="signin">Sign in</button><button type="submit" class="btn ghost sm" value="create">Create account</button></div>
            <p class="err" role="alert"></p>
            <p class="sub">There is no password reset, so remember your password.</p>
          </form></details>`;
    if (!me?.nickname) {
      return `<div class="lb-me join">
        <h3>Join the leaderboard</h3>
        <p class="sub">Pick a nickname. Your finished Dailies count from then on (results already submitted count too).</p>
        ${this.nickForm('lb')}${queued}${accountLine}
      </div>`;
    }
    const scope = period === '30d' ? 'in the last 30 days' : 'all time';
    const headline =
      me.rank !== null
        ? `Rank <b>#${me.rank}</b> of ${me.rankedTotal}${me.betterThan !== null ? ` · better than <b>${Math.round(me.betterThan)}%</b> of ranked players` : ''}`
        : `Win <b>${me.winsNeeded}</b> more Dail${me.winsNeeded === 1 ? 'y' : 'ies'} to be ranked ${scope} (${me.wins}/${MIN_WINS})`;
    return `<div class="lb-me">
      <div class="lb-me-top">
        <div><small>You</small><h3>${esc(me.nickname)}</h3><p>${headline}</p></div>
        <details class="rename"><summary>Change nickname</summary>${this.nickForm('lb', me.nickname)}</details>
      </div>
      <div class="statgrid">
        <div><b>${formatAverage(me.avg)}</b><span>Avg guesses</span></div>
        <div><b>${me.wins}</b><span>Wins</span></div>
        <div><b>${me.played}</b><span>Played</span></div>
        <div><b>${me.winRate === null ? '—' : `${Math.round(me.winRate)}%`}</b><span>Win rate</span></div>
      </div>
      ${queued}${accountLine}
    </div>`;
  }

  private lbTable(rows: LeaderRow[]) {
    if (!rows.length) return `<div class="lb-note"><b>No ranked players yet</b><p>Win ${MIN_WINS} Dailies with a nickname set to claim the top spot.</p></div>`;
    const row = (r: LeaderRow) => `<tr class="${r.isMe ? 'me' : ''}"${r.isMe ? ' aria-current="true"' : ''}>
        <td class="rk">${r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</td>
        <td class="nm">${esc(r.nickname)}${r.isMe ? ' <span class="tag">You</span>' : ''}</td>
        <td class="av">${formatAverage(r.avg)}</td>
        <td>${r.wins}</td>
        <td class="wr">${Math.round(r.winRate)}%</td></tr>`;
    const top = rows.filter((r) => r.rank <= LB_LIMIT);
    const pinned = rows.filter((r) => r.rank > LB_LIMIT);
    return `<table class="lb-table">
      <caption class="sr-only">Leaderboard, ${this.lbPeriod === '30d' ? 'last 30 days' : 'all time'}</caption>
      <thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col">Avg</th><th scope="col">Wins</th><th scope="col" class="wr">Win %</th></tr></thead>
      <tbody>${top.map(row).join('')}</tbody>
      ${pinned.length ? `<tbody class="pinned"><tr class="gap" aria-hidden="true"><td colspan="5">⋯</td></tr>${pinned.map(row).join('')}</tbody>` : ''}
    </table>`;
  }

  private async submitNick(form: HTMLFormElement) {
    const input = form.querySelector('input')!;
    const err = form.querySelector('.err')!;
    const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const check = validateNickname(input.value);
    if (!check.ok) {
      err.textContent = check.error;
      input.focus();
      return;
    }
    btn.disabled = true;
    err.textContent = '';
    try {
      const name = await setNickname(check.value);
      await this.syncResults().catch(() => {});
      this.toast(`You're on the leaderboard as ${name}`);
      this.announce(`Nickname set to ${name}`);
      const join = form.closest('#join');
      if (join) join.innerHTML = `<p class="ok">✓ Playing as <b>${esc(name)}</b>. <button type="button" class="link" data-open="leaderboard">See the leaderboard →</button></p>`;
      else this.renderLeaderboard();
    } catch (e) {
      err.textContent =
        e instanceof OnlineError && e.kind === 'rejected'
          ? e.message
          : navigator.onLine
            ? "Couldn't save your nickname. Try again."
            : "You're offline. Try again when you're connected.";
      btn.disabled = false;
    }
  }

  private async submitAuth(form: HTMLFormElement, submitter: HTMLButtonElement | null) {
    const mode = submitter?.value === 'create' ? 'create' : 'signin';
    const err = form.querySelector('.err')!;
    const buttons = form.querySelectorAll<HTMLButtonElement>('button');
    const user = validateUsername(form.querySelector<HTMLInputElement>('[name="u"]')!.value);
    const pw = form.querySelector<HTMLInputElement>('[name="p"]')!.value;
    err.textContent = '';
    if (!user.ok) {
      err.textContent = user.error;
      return;
    }
    const pwErr = mode === 'create' ? validatePassword(pw) : pw ? null : 'Enter your password.';
    if (pwErr) {
      err.textContent = pwErr;
      return;
    }
    buttons.forEach((b) => (b.disabled = true));
    try {
      if (mode === 'create') {
        await createAccount(user.value, pw);
        const me = await myStanding('all').catch(() => null);
        if (!me?.nickname) await setNickname(user.value).catch(() => {});
      } else {
        await signInWithPassword(user.value, pw);
        this.store.clearSent();
      }
      await this.syncResults().catch(() => {});
      this.toast(mode === 'create' ? `Account created. Welcome, ${user.value}!` : `Signed in as ${user.value}`);
      this.renderLeaderboard();
    } catch (e) {
      buttons.forEach((b) => (b.disabled = false));
      err.textContent =
        e instanceof OnlineError
          ? e.message
          : navigator.onLine
            ? "Couldn't reach the server. Try again."
            : "You're offline. Try again when you're connected.";
    }
  }
  private async doSignOut() {
    try {
      await signOut();
      this.toast('Signed out. Your games on this device are kept.');
    } catch {
      this.toast("Couldn't sign out");
    }
    this.renderLeaderboard();
  }

  /** Fills the result dialog with today's global distribution and the player's percentile. */
  private async loadToday(dlg: HTMLElement, g: Game) {
    const box = dlg.querySelector<HTMLElement>('#today');
    if (!box || !onlineConfigured) return;
    try {
      await this.syncResults();
    } catch {
      /* offline: still try to show the distribution */
    }
    let rows;
    try {
      rows = await dailyDistribution(g.day);
    } catch {
      if (box.isConnected) box.querySelector('.today-note')!.textContent = navigator.onLine ? "Couldn't reach the leaderboard. Your result is saved and will be submitted later." : "You're offline. Your result is saved and will be submitted when you reconnect.";
      return;
    }
    if (!box.isConnected) return;
    const won = g.status === 'won';
    const score = scoreOf({ won, guesses: g.guesses.length });
    const dist = fillDistribution(rows);
    if (this.store.sent[g.day] !== 'ok') dist[score - 1]++;
    const { total, better } = dailyStanding(dist, score);
    const n = g.guesses.length;
    const lead = won ? `You solved it in <b>${n}</b> ${n === 1 ? 'guess' : 'guesses'}` : 'You ran out of guesses';
    const tail = better === null ? ` — you're the first to finish today!` : `, better than <b>${better}%</b> of players today.`;
    const max = Math.max(1, ...dist);
    const bars = dist
      .map((v, i) => `<div class="${i === score - 1 ? 'me' : ''}"><span>${i < MAX_GUESSES ? i + 1 : 'X'}</span><i style="width:${Math.max(6, (v / max) * 100)}%">${v}</i></div>`)
      .join('');
    box.innerHTML = `<p class="today-head">${lead}${tail}</p>
      <div class="dist" aria-label="Today's results from ${total} ${total === 1 ? 'player' : 'players'}">${bars}</div>
      <p class="today-note">${total} ${total === 1 ? 'player has' : 'players have'} finished today's Daily.</p>`;
    this.announce(`${won ? `Solved in ${n}` : 'Out of guesses'}${better === null ? '. First to finish today.' : `, better than ${better} percent of players today.`}`);

    if (this.store.joinSkipped) return;
    try {
      const me = await myStanding('all');
      if (me?.nickname || !dlg.isConnected) return;
      const join = dlg.querySelector<HTMLElement>('#join');
      if (!join) return;
      join.hidden = false;
      join.innerHTML = `<h4>Join the leaderboard</h4>
        <p class="sub">Pick a nickname to be ranked by average guesses. No sign-up needed.</p>
        ${this.nickForm('result')}
        <button type="button" class="link" data-action="skip-join">Not now</button>`;
    } catch {
      /* the join prompt is optional */
    }
  }

  private renderStatus() {
    const g = this.game;
    const n = g.guesses.length;
    const left = MAX_GUESSES - n;
    const label =
      g.mode === 'daily'
        ? `Daily ${this.gameLabel()}`
        : g.mode === 'archive'
          ? `Archive ${this.gameLabel()} · ${esc(dateFmt.format(dayDate(g.day)))}`
          : `Practice${this.settings.practiceSet ? ` · ${esc(this.settings.practiceSet)}` : ''}`;
    let title = `${left} ${left === 1 ? 'guess' : 'guesses'} left`;
    let extra = '';
    if (g.status === 'won') title = `Solved in ${n}!`;
    if (g.status === 'lost') title = 'Out of guesses';
    if (g.status !== 'playing') {
      extra = `<button type="button" class="link" data-action="result">View result</button>`;
      if (g.mode === 'practice') extra += `<button type="button" class="link" data-action="practice">New round</button>`;
    }
    if (g.mode === 'archive') extra += `<button type="button" class="link" data-mode="archive">← Archive</button>`;
    const pipCls = g.status === 'won' ? 'won' : left <= 1 && g.status === 'playing' ? 'danger' : left <= 3 && g.status === 'playing' ? 'warn' : '';
    const pips = Array.from({ length: MAX_GUESSES }, (_, i) =>
      `<i class="pip${i < n ? ' used' : i === n && g.status === 'playing' ? ' next' : ''}"></i>`,
    ).join('');
    $(this.root, '#status').innerHTML = `
      <div><small>${label} · Guess the mystery card</small><h2>${title}${extra}</h2></div>
      <div class="pips ${pipCls}" role="img" aria-label="${n} of ${MAX_GUESSES} guesses used">${pips}<span class="count">${n}/${MAX_GUESSES}</span></div>`;
    this.input.disabled = g.status !== 'playing';
    ($(this.root, '#submit') as HTMLButtonElement).disabled = g.status !== 'playing';
    const badge = $(this.root, '#left-badge');
    badge.textContent = g.status === 'playing' ? `${left} left` : '';
    badge.className = `left-badge ${g.status === 'playing' ? pipCls : ''}`;
  }

  private renderKnowledge(glow: boolean) {
    const prev = this.knowledge;
    const next = buildKnowledge(this.game.clues);
    this.knowledge = next;
    $(this.root, '#know').innerHTML = next
      .map((k, i) => knowSlot(k, glow && !!prev[i] && !prev[i].solved && k.solved))
      .join('');
    $(this.root, '#know-n').textContent = `${next.filter((k) => k.solved).length}/${next.length}`;
    if (glow) setTimeout(() => this.root.querySelectorAll('.k.glow').forEach((el) => el.classList.remove('glow')), 900);
  }

  private renderBoard(reveal: boolean) {
    const g = this.game;
    const rows = g.guesses
      .map((card, i) => {
        const clues = g.clues[i];
        const isNew = reveal && i === g.guesses.length - 1;
        const cells = clues.map((c, j) => cellHtml(c, card.setCode, j * 80)).join('');
        return `<div class="row${isNew ? ' reveal' : ''}" role="row">
          <div class="artcell" role="cell"><button type="button" class="art" data-card="${esc(card.id)}" aria-label="${esc(card.name)}, view card" title="${esc(card.name)}">${artHtml(card)}</button></div>
          <p class="rowname" aria-hidden="true">${esc(card.name)}</p>${cells}</div>`;
      })
      .reverse()
      .join('');
    const empty = g.guesses.length ? '' : '<p class="empty-board">Your guesses will appear here.</p>';
    $(this.root, '#rows').innerHTML = rows + empty;
  }

  private renderHints() {
    const g = this.game;
    const el = $(this.root, '#hints');
    if (this.settings.hardMode) {
      el.className = '';
      el.innerHTML = '<p class="hint-off">Hard mode is on, so hints are disabled.</p>';
      return;
    }
    el.className = 'hints';
    const ready = this.readyHints();
    el.innerHTML = hintLadder(g.target).map((h, i) => {
      const name = `<span aria-hidden="true">${HINT_ICON[h.kind]}</span> ${h.title}`;
      if (g.hints.includes(i)) return `<div class="hint used" data-kind="${h.kind}"><span>Hint ${i + 1} · ${h.title}</span><div class="hint-body">${hintBody(h.kind, g.target)}</div></div>`;
      if (ready.includes(i))
        return `<button type="button" class="hint ready" data-hint="${i}" aria-keyshortcuts="H"><span>Hint ${i + 1} · ready</span><p>Reveal ${name} →</p></button>`;
      const when = g.status === 'playing' ? `after guess ${h.after}` : 'not used';
      return `<div class="hint locked"><span>Hint ${i + 1} · ${when}</span><p><span aria-hidden="true">🔒</span> ${h.title}</p></div>`;
    }).join('');
  }

  // ---------- feedback ----------
  private toast(msg: string) {
    const t = $(this.root, '#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.hidden = true), 2200);
  }

  private announce(msg: string) {
    const live = $(this.root, '#live');
    live.textContent = '';
    requestAnimationFrame(() => (live.textContent = msg));
  }

  // ---------- dialogs ----------
  private open(name: string) {
    if (name === 'leaderboard') this.showLeaderboard(true);
    else if (name === 'stats') this.openStats();
    else if (name === 'help') this.openHelp();
    else if (name === 'settings') this.openSettings();
  }

  private showDialog(html: string, cleanup?: () => void) {
    const dlg = $<HTMLDialogElement>(this.root, '#dlg');
    if (dlg.open) dlg.close();
    dlg.innerHTML = `<div class="dlg"><button type="button" class="close" aria-label="Close">✕</button>${html}</div>`;
    this.dialogCleanup = cleanup ?? null;
    this.hideResults();
    dlg.showModal();
    dlg.scrollTop = 0;
    return dlg;
  }

  private closeDialog() {
    const dlg = $<HTMLDialogElement>(this.root, '#dlg');
    if (dlg.open) dlg.close();
  }

  private distHtml(highlight: number | null) {
    const { dist } = this.store.stats;
    const max = Math.max(1, ...dist);
    return `<div class="dist" aria-label="Guess distribution">${dist
      .map(
        (v, i) =>
          `<div class="${highlight === i + 1 ? 'me' : ''}"><span>${i + 1}</span><i style="width:${Math.max(6, (v / max) * 100)}%">${v}</i></div>`,
      )
      .join('')}</div>`;
  }

  private openResult() {
    const g = this.game;
    if (g.status === 'playing') return;
    const won = g.status === 'won';
    const t = g.target;
    const stats = this.store.stats;
    const time = g.startedAt && g.finishedAt ? formatTime(g.finishedAt - g.startedAt) : '—';
    const label = this.gameLabel(g);
    const text = shareText({ label: g.mode === 'archive' ? `${label} (archive)` : label, rows: g.clues, won, hints: g.hints.length });
    const grid = text.split('\n').slice(1).join('\n');
    const confetti =
      won && !this.reduced
        ? `<div class="confetti" aria-hidden="true">${Array.from({ length: 48 }, (_, i) => {
            const c = ['#c9a45c', '#2fb07a', '#4f8fe2', '#e2554f'][i % 4];
            return `<i style="--l:${Math.random() * 100}%;--w:${Math.random() * 0.6}s;--t:${2 + Math.random() * 1.4}s;--x:${(Math.random() - 0.5) * 160}px;--c:${c}"></i>`;
          }).join('')}</div>`
        : '';
    const daily = g.mode === 'daily';
    const past = g.mode === 'archive';
    const dlg = this.showDialog(`
      ${confetti}
      <div class="end${won ? '' : ' lost'}">
        ${t.image ? `<img class="cardimg" src="${esc(t.image)}" alt="${esc(t.name)}">` : ''}
        <div>
          <div class="badge${won ? '' : ' lost'}">${won ? '✦ Solved' : '◈ Out of guesses'} · ${daily ? `Daily ${label}` : past ? `Archive ${label}` : 'Practice'}</div>
          <h3 id="dlg-title">${esc(t.name)}</h3>
          <div style="color:var(--muted)">${esc(t.type)} · ${dot(t.domain)} ${esc(t.domain)} · ${esc(t.set)}</div>
          <div class="stats">
            <div><b>${won ? g.guesses.length : 'X'}</b><span>Guesses</span></div>
            <div><b>${time}</b><span>Time</span></div>
            <div><b>${daily ? stats.currentStreak : '—'}</b><span>Streak</span></div>
            <div><b>${g.hints.length}</b><span>Hints</span></div>
          </div>
          <pre class="share" aria-label="Share grid">${esc(grid)}</pre>
          <div class="actions">
            <button type="button" class="btn" id="share">Share result</button>
            ${past ? '<button type="button" class="btn ghost" data-mode="archive">Back to archive</button>' : `<button type="button" class="btn ghost" data-action="practice">${daily ? 'Play practice' : 'New practice round'}</button>`}
          </div>
          ${
            daily
              ? onlineConfigured
                ? `<div class="today" id="today" aria-live="polite">${this.distHtml(won ? g.guesses.length : null)}<p class="today-note">Comparing with other players…</p></div><div class="join" id="join" hidden></div>`
                : this.distHtml(won ? g.guesses.length : null)
              : ''
          }
          <div class="countdown" id="cd"></div>
        </div>
      </div>`);
    const cd = $(dlg, '#cd');
    const tick = () => {
      const ms = msUntilNextDaily();
      cd.textContent = dayIndex() !== this.daily.day ? 'A new daily card is ready!' : `Next daily card in ${formatCountdown(ms)}`;
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    this.dialogCleanup = () => clearInterval(timer);
    $(dlg, '#share').addEventListener('click', () => this.share(text));
    $<HTMLButtonElement>(dlg, '#share').focus();
    this.announce(won ? `Solved! The card was ${t.name}.` : `Out of guesses. The card was ${t.name}.`);
    if (daily) void this.loadToday(dlg, g);
  }

  private async share(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast('Copied to clipboard');
      this.announce('Result copied to clipboard');
    } catch {
      if (navigator.share) {
        try {
          await navigator.share({ text });
          return;
        } catch {
          /* cancelled */
        }
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      this.toast(ok ? 'Copied to clipboard' : 'Could not copy');
    }
  }

  private openStats() {
    const s = this.store.stats;
    const pct = s.played ? Math.round((s.wins / s.played) * 100) : 0;
    this.showDialog(`
      <h2 id="dlg-title">Statistics</h2>
      <p class="sub">Daily games only. Practice rounds don't affect your streak.</p>
      <div class="statgrid">
        <div><b>${s.played}</b><span>Played</span></div>
        <div><b>${pct}</b><span>Win %</span></div>
        <div><b>${s.currentStreak}</b><span>Current streak</span></div>
        <div><b>${s.bestStreak}</b><span>Best streak</span></div>
      </div>
      <h3 style="font-size:13px;margin:0;color:var(--muted)">Guess distribution</h3>
      ${this.distHtml(this.daily.status === 'won' ? this.daily.guesses.length : null)}`);
  }

  private openHelp() {
    const ex = (k: Clue['key'], status: Clue['status'], value: string | number | null, dir: Clue['dir'] = null) =>
      cellHtml({ key: k, status, value, dir }, k === 'set' ? 'OGN' : '');
    const exampleRow = [
      ex('type', 'hit', 'Unit'),
      ex('domain', 'miss', 'Calm'),
      ex('cost', 'near', 3, 'up'),
      ex('power', 'hit', 0),
      ex('might', 'miss', 6, 'down'),
      ex('set', 'miss', 'Origins'),
    ].join('');
    const chips = `<div class="know" style="max-width:460px">${ATTRS.map(({ key, label }) => {
      const value = ({ type: 'Unit', cost: 4, power: 0 } as Record<string, string | number>)[key];
      return knowSlot({ key, label, solved: value !== undefined, value: value ?? null }, false);
    }).join('')}</div>`;
    this.showDialog(`
      <h2 id="dlg-title">How to play</h2>
      <p class="sub">Find the mystery Riftbound card in ${MAX_GUESSES} guesses.</p>
      <ol class="steps">
        <li><h3>Guess any card</h3><p>Type a name and pick a card from the list. Press <kbd>/</kbd> to jump to the search, <kbd>↑</kbd> <kbd>↓</kbd> to move through results and <kbd>↵</kbd> to guess.</p></li>
        <li><h3>Read the clues</h3><p>Each attribute is compared with the mystery card. <b style="color:var(--hit)">✓ green</b> is a match, <b style="color:var(--near)">±1 amber</b> is off by one and <b style="color:var(--muted)">✕ grey</b> is no match. Arrows show whether the answer is higher ↑ or lower ↓. “—” means not applicable (for example, Might on Spells and Gear).</p>
          <div class="mini" role="table" aria-label="Example row"><div role="row" style="display:contents">${exampleRow}</div></div></li>
        <li><h3>Use what you know</h3><p>The summary bar shows every attribute one of your guesses matched exactly. Stuck? Hints unlock after guesses 3, 6 and 8 and only reveal things the board never shows: <b>Traits</b> (rarity, labels and tags), the card’s <b>Ability</b> text with its name blacked out, and its blurred <b>Art</b> with the artist. Press <kbd>H</kbd> to use one.</p>${chips}</li>
      </ol>
      <p class="sub" style="margin-top:18px"><b style="color:var(--text)">Daily</b>: one card per day, the same for everyone (resets at 00:00 UTC). <b style="color:var(--text)">Practice</b>: unlimited rounds, optionally filtered by set in Settings. <b style="color:var(--text)">Leaderboard</b> (🏆): finished Dailies are ranked by average guesses (a loss counts as 11), and after each Daily you see how you compare with everyone today.</p>
      <div class="actions"><button type="button" class="btn" data-action="close">Let’s play</button></div>
      <div class="about">RiftGuessr is an unofficial fan project. It is not affiliated with, endorsed or sponsored by Riot Games. Riftbound, card names and card art are trademarks or copyrights of Riot Games, Inc. Card data comes from the <a href="https://huggingface.co/datasets/Wysme/riftbound-cards" target="_blank" rel="noopener">Wysme/riftbound-cards</a> dataset.</div>`,
      () => {
        if (this.game.status === 'playing' && matchMedia('(min-width: 768px)').matches) setTimeout(() => this.input.focus(), 0);
      });
  }

  private openSettings() {
    const s = this.settings;
    const toggle = (key: keyof Settings, title: string, desc: string) =>
      `<label class="setting"><span><b>${title}</b><small>${desc}</small></span><input type="checkbox" data-setting="${key}"${s[key] ? ' checked' : ''}></label>`;
    const dlg = this.showDialog(`
      <h2 id="dlg-title">Settings</h2>
      <p class="sub">Saved on this device.</p>
      ${toggle('highContrast', 'High-contrast patterns', 'Adds patterns and always shows ✓ ±1 ✕ icons on tiles.')}
      ${toggle('reducedMotion', 'Reduced motion', 'Replaces flips and confetti with simple fades.')}
      ${toggle('hardMode', 'Hard mode', 'No hints.')}
      <label class="setting"><span><b>Practice set</b><small>Limit practice rounds to one set. Applies to the next round.</small></span>
        <select data-setting="practiceSet"><option value="">All sets</option>${this.sets
          .map((x) => `<option${x === s.practiceSet ? ' selected' : ''}>${esc(x)}</option>`)
          .join('')}</select></label>`);
    dlg.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]').forEach((el) =>
      el.addEventListener('change', () => {
        const key = el.dataset.setting as keyof Settings;
        this.settings = { ...this.settings, [key]: el instanceof HTMLInputElement ? el.checked : el.value };
        this.store.settings = this.settings;
        this.applySettings();
        this.renderHints();
        this.renderStatus();
      }),
    );
  }

  private openPreview(card: Card) {
    const row = (k: string, v: string) => `<dt>${k}</dt><dd>${v}</dd>`;
    this.showDialog(`
      <div class="preview">
        ${card.image ? `<img src="${esc(card.image)}" alt="${esc(card.name)}">` : ''}
        <div>
          <h2 id="dlg-title">${esc(card.title)}</h2>
          <dl>
            ${row('Type', esc(card.type))}
            ${row('Domain', `${dot(card.domain)} ${esc(card.domain)}`)}
            ${row('Cost', esc(show(card.cost)))}
            ${row('Power', esc(show(card.power)))}
            ${row('Might', esc(show(card.might)))}
            ${row('Set', `${esc(card.set)} (${esc(card.setCode)})`)}
            ${card.rarity ? row('Rarity', esc(card.rarity)) : ''}
          </dl>
        </div>
      </div>`);
  }

  private applySettings() {
    const html = document.documentElement;
    html.classList.toggle('hc', this.settings.highContrast);
    html.classList.toggle('rm', this.settings.reducedMotion);
  }
}
