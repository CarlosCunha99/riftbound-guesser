# RiftGuessr

A daily Wordle/Loldle-style game for the **Riftbound TCG**. Guess the mystery card in 10 tries using attribute clues: type, domain, cost, power, might and set.

- **Daily**: one card per day, the same for everyone (resets at 00:00 UTC). Progress, streaks and stats are saved in `localStorage`.
- **Practice**: unlimited rounds, with an optional set filter. Practice doesn't affect your streak.
- **Archive**: every past daily, with your result for each one. Answers stay hidden until you finish that day, and you can play any daily you missed (replays don't affect your streak). History is stored per day in `localStorage` (`rbg.history`).
- Clue tiles use colour, an icon (✓ / ±1 / ✕) and text, plus ↑/↓ for numbers. Numbers within ±1 count as "close".
- A "What you know" bar shows only the attributes a guess matched exactly (X/6 solved).
- Three progressive hints unlock after guesses 3, 6 and 8. They only reveal information the board never shows:
  **Traits** (rarity, extra labels like Champion/Signature, and tags, minus any that match the card's own name) →
  **Ability** (rules text with the card's name redacted as ▇▇▇) → **Art** (heavily blurred art plus the artist).
  If a card lacks the data for a hint, the next hint type is used instead, so no hint is ever empty. Hard mode turns hints off.
- The result screen has a Wordle-style share grid, guess distribution and a countdown to the next daily.
- **Leaderboard** (🏆, `#/leaderboard`): Daily players ranked by average guesses, plus "better than X% of players today" after each Daily. It's optional and backed by Supabase; see [Leaderboard](#leaderboard-supabase). Without it, the game works fully offline.
- Works from the keyboard: `/` focuses search, `↑`/`↓` move through results, `↵` guesses and `H` uses a hint. It also respects `prefers-reduced-motion` and has a high-contrast setting.

## Tech

A static site built with [Vite](https://vitejs.dev/) and vanilla TypeScript (no framework). Unit tests use [Vitest](https://vitest.dev/).

```
scripts/fetch_cards.py      # downloads + normalizes card data
public/data/cards.json      # generated card list (committed, loaded at runtime)
public/data/daily.json      # pinned daily schedule: day index -> card id (append-only)
src/logic/                  # pure game logic (compare, daily seed, knowledge, ranking, search, share, storage) + tests
src/net/online.ts           # optional Supabase client (leaderboard, auth), loaded lazily
src/ui/                     # DOM rendering and app controller
src/styles.css              # design tokens and layout
supabase/migrations/        # leaderboard schema, RLS and RPC functions
```

## Getting started

Requires Node.js 20+.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run build      # production build in dist/
npm run preview    # serve the production build locally
```

To try the leaderboard locally, copy `.env.example` to `.env.local` and fill in your Supabase project's URL and anon key (see below). Without them, the leaderboard page shows a "not configured" message.

## Card data

Cards come from the Hugging Face dataset [`Wysme/riftbound-cards`](https://huggingface.co/datasets/Wysme/riftbound-cards) (split `train`), loaded with the Python `datasets` library:

```bash
python -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt      # Windows: .venv\Scripts\pip
.venv/bin/python scripts/fetch_cards.py                # writes cards.json and extends daily.json
```

You can also normalize a local JSON export with `python scripts/fetch_cards.py --source cards.json`.

The script applies the game's data rules:

- Dedupe by full name + set, preferring a non-Showcase printing.
- Exclude Runes.
- Might is N/A (`null`, shown as "—") for Spell and Gear cards.
- Cards with the Champion label get the type "Champion".
- Names that exist in several sets get a "— Set" suffix.
- Hint-only fields are kept too: `rarity`, `labels` (type labels beyond the main type), `tags`, `ability` (`ability_effective`, falling back to `ability_original`), `artist` and `image`.

The **Refresh card data** GitHub Actions workflow (`.github/workflows/refresh-cards.yml`) runs the script every night at 22:00 UTC, before the daily rolls over, and you can also start it manually from the Actions tab. When `public/data` changes, it commits to `main` and redeploys production with the new data (see Deploy).

### Daily schedule

Daily answers are pinned in `public/data/daily.json` (`ids[n]` is the card for day `n`, counted from 2026-10-19 UTC). The script only ever appends to it, keeping it 7 days ahead with cards that haven't been used yet, so refreshing the card list never changes today's card or any Archive answer. If a scheduled card disappears from the dataset, its previous entry is kept in `cards.json`. If the schedule has no entry for a day (for example, if every refresh failed for a week), the app falls back to a fixed-seed shuffle of the card list.

## Deploy

`npm run build` outputs a fully static site in `dist/` with relative asset paths, so it can be hosted anywhere. GitHub Pages isn't available for private repos on the free plan, so use one of these instead:

| Host | Build command | Output directory |
|---|---|---|
| [Vercel](https://vercel.com/new) | `npm run build` | `dist` |
| [Netlify](https://app.netlify.com/start) | `npm run build` | `dist` |
| [Cloudflare Pages](https://pages.cloudflare.com/) | `npm run build` | `dist` |

Import the GitHub repo in the host's dashboard and use the settings above.

### Vercel: deploy on GitHub release

This repo is set up so that **publishing a GitHub release** deploys to production on Vercel:

- `vercel.json` turns off automatic deploys from `main`. Pull requests still get Vercel preview URLs.
- `.github/workflows/deploy-release.yml` runs when a release is published (pre-releases are skipped). It checks out that tag, takes `public/data` from `main`, runs the tests, then builds and deploys with the Vercel CLI. When started manually or by the nightly data refresh, it deploys the latest full release the same way.

One-time setup:

1. Import the repo in Vercel (framework preset **Vite**; it detects the settings above).
2. Create a token at [vercel.com/account/tokens](https://vercel.com/account/tokens).
3. Find your IDs: on your machine run `npx vercel link` in the repo, then open `.vercel/project.json` (it has `orgId` and `projectId`). You can also find them in the Vercel dashboard under Project → Settings → General and Account/Team → Settings.
4. In GitHub → repo **Settings → Secrets and variables → Actions**, add `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`.

To ship an update: merge to `main`, then on GitHub go to **Releases → Draft a new release**, create a tag (e.g. `v1.1.0`) and click **Publish release**.

> Code changes only go live when you publish a release. Card data and the daily schedule go live every night, on top of your latest release. At least one full (non pre-release) release must exist for anything to deploy.

## Leaderboard (Supabase)

The leaderboard uses a free [Supabase](https://supabase.com/) project (Postgres + Auth). It's optional: if `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` aren't set, or Supabase is unreachable, the game stays fully playable. Finished Daily results are queued in `localStorage` (`rbg.lb.sent` tracks what was sent) and retried on the next visit, when the browser comes back online and after the next Daily.

### How ranking works

- Only Daily games count. Practice rounds and Archive replays are never submitted.
- A player's score is their **average guesses** over all their Dailies in the period, where a **loss counts as 11**. Lower is better. Ties go to more wins.
- You need a nickname and at least **5 Daily wins** in the period to be ranked. Periods: **All time** and **Last 30 days**.
- After each Daily, the result screen shows "better than X% of players today": the share of *other* players who finished today with a worse score, plus today's distribution chart.
- A 🔥 next to a nickname shows the player's current Daily win streak (consecutive wins ending today or yesterday).
- The leaderboard page shows your rank and the share of other ranked players with a worse average.

### Identity

Players start as **guests** (anonymous Supabase users, created the first time they finish a Daily or pick a nickname). To keep their history on other devices they can **create an account with just a username and password**, which turns the guest into a registered user with the *same* user id. Supabase Auth needs an email, so the username is mapped to a made-up address (`<username>@riftguessr.app`); nobody is emailed, and that also means **there is no password reset**. Accounts are created by the `register_account` database function (already confirmed, so Supabase never validates or mails the address); signing in uses the normal Supabase password login. No external providers (Google, GitHub) are used.

### Setup

1. Create a project at [supabase.com](https://supabase.com/dashboard) (the free tier is enough).
2. Run the migration in `supabase/migrations/` — paste it into **SQL Editor → New query → Run**, or use the CLI: `supabase link --project-ref <ref>` then `supabase db push`.
3. **Authentication → Sign In / Providers**:
   - Turn on **Allow anonymous sign-ins**.
   - Keep the **Email** provider enabled (password sign-in uses it). "Confirm email" doesn't matter, because accounts are created already confirmed.
4. Recommended: enable **Attack Protection → CAPTCHA** or keep the default rate limits for anonymous sign-ins.
5. Copy **Project Settings → API → Project URL** and the **anon public** key, then set them as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`:
   - in Vercel → Project → Settings → **Environment Variables** (Production and Preview), and redeploy (publish a release for production);
   - (Vercel's Supabase integration's `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` are also accepted, so no extra variables are needed if you use it);
   - locally in `.env.local` (git-ignored).

The anon key is meant to be public. All writes go through `security definer` functions, and Row Level Security blocks direct inserts, updates and deletes.

### Database

- `profiles(id, nickname, created_at, updated_at)`: one row per player. Nicknames are 3–16 characters (letters, numbers, spaces, `-`, `_`), unique (case-insensitive) and pass a profanity filter.
- `daily_results(user_id, day, guesses, won, hints_used, created_at)`: primary key `(user_id, day)`, so one result per player per day. Results can't be changed.
- RPCs: `submit_daily_result`, `set_nickname`, `leaderboard(period, limit)`, `my_standing(period)`, `daily_distribution(day)`, `my_percentile(day)`.

### Anti-cheat (best effort)

The daily card is chosen on the client (from `daily.json`), so the server can't verify that a player really solved it, and a determined player could submit a fake result. The leaderboard is for fun, and these limits keep it reasonable:

- Results are only accepted through `submit_daily_result`, which checks 1–10 guesses (a loss must use all 10), 0–3 hints, and that the day is today's UTC day (yesterday is accepted for one hour after midnight).
- One result per player per day, and it can never be changed.
- Ranking requires 5+ wins, so a single lucky (or fake) game can't take first place.
- Nicknames are filtered for profanity on both client and server, and renames are rate-limited to one every 30 seconds.
- Supabase's built-in rate limits (and optional CAPTCHA) limit how fast new anonymous accounts can be created.

## Disclaimer

RiftGuessr is an **unofficial fan project**. It is not affiliated with, endorsed, sponsored or approved by Riot Games. Riftbound, card names and card art are trademarks or copyrights of Riot Games, Inc. Card images are loaded from Riot's public CDN.
