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
- Works from the keyboard: `/` focuses search, `↑`/`↓` move through results, `↵` guesses and `H` uses a hint. It also respects `prefers-reduced-motion` and has a high-contrast setting.

## Tech

A static site built with [Vite](https://vitejs.dev/) and vanilla TypeScript (no framework). Unit tests use [Vitest](https://vitest.dev/).

```
scripts/fetch_cards.py      # downloads + normalizes card data
public/data/cards.json      # generated card list (committed, loaded at runtime)
src/logic/                  # pure game logic (compare, daily seed, knowledge, search, share, storage) + tests
src/ui/                     # DOM rendering and app controller
src/styles.css              # design tokens and layout
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

## Card data

Cards come from the Hugging Face dataset [`Wysme/riftbound-cards`](https://huggingface.co/datasets/Wysme/riftbound-cards) (split `train`), loaded with the Python `datasets` library:

```bash
python -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt      # Windows: .venv\Scripts\pip
.venv/bin/python scripts/fetch_cards.py                # writes public/data/cards.json
```

You can also normalize a local JSON export with `python scripts/fetch_cards.py --source cards.json`.

The script applies the game's data rules:

- Dedupe by full name + set, preferring a non-Showcase printing.
- Exclude Runes.
- Might is N/A (`null`, shown as "—") for Spell and Gear cards.
- Cards with the Champion label get the type "Champion".
- Names that exist in several sets get a "— Set" suffix.
- Hint-only fields are kept too: `rarity`, `labels` (type labels beyond the main type), `tags`, `ability` (`ability_effective`, falling back to `ability_original`), `artist` and `image`.

The **Refresh card data** GitHub Actions workflow (`.github/workflows/refresh-cards.yml`) runs the script every Monday at 06:00 UTC, and you can also start it manually from the Actions tab. It commits `public/data/cards.json` when the data changes.

> The daily card is picked from the card list sorted by id and shuffled with a fixed seed, so adding new cards can change which card is chosen on future days.

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
- `.github/workflows/deploy-release.yml` runs when a release is published (pre-releases are skipped). It runs the tests, then builds and deploys that tag with the Vercel CLI. You can also run it manually from the Actions tab.

One-time setup:

1. Import the repo in Vercel (framework preset **Vite**; it detects the settings above).
2. Create a token at [vercel.com/account/tokens](https://vercel.com/account/tokens).
3. Find your IDs: on your machine run `npx vercel link` in the repo, then open `.vercel/project.json` (it has `orgId` and `projectId`). You can also find them in the Vercel dashboard under Project → Settings → General and Account/Team → Settings.
4. In GitHub → repo **Settings → Secrets and variables → Actions**, add `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`.

To ship an update: merge to `main`, then on GitHub go to **Releases → Draft a new release**, create a tag (e.g. `v1.1.0`) and click **Publish release**.

> The weekly card-data refresh commits to `main`, so new cards go live with your next release.

## Disclaimer

RiftGuessr is an **unofficial fan project**. It is not affiliated with, endorsed, sponsored or approved by Riot Games. Riftbound, card names and card art are trademarks or copyrights of Riot Games, Inc. Card images are loaded from Riot's public CDN.
