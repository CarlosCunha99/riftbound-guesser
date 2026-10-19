"""Download Riftbound cards from Hugging Face and write the normalized game data.

Usage:
    pip install -r scripts/requirements.txt
    python scripts/fetch_cards.py                       # fetch "Wysme/riftbound-cards" (split "train")
    python scripts/fetch_cards.py --source cards.json   # normalize a local JSON export instead

Rules (kept from the original prototype):
  * dedupe by full_name + set, preferring a non-Showcase printing
  * exclude Runes
  * Might is N/A (null) for Spell and Gear cards
  * type is "Champion" when the card carries the Champion label
  * hint-only fields: extra type labels, tags, ability text (ability_effective, else
    ability_original) and artist

It also maintains public/data/daily.json, the pinned daily schedule (day index -> card id).
Existing entries never change, so refreshing the card list can't change today's or any
past answer. The schedule is extended LOOKAHEAD days ahead with cards not used yet.
Scheduled cards that disappear from the dataset are carried over from the previous
cards.json so old answers stay playable.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

DATASET = "Wysme/riftbound-cards"
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "public" / "data" / "cards.json"
DEFAULT_SCHEDULE = ROOT / "public" / "data" / "daily.json"
DAILY_EPOCH = date(2026, 10, 19)  # must match DAILY_EPOCH in src/logic/daily.ts
LOOKAHEAD = 7

SET_CODES = {
    "Origins": "OGN",
    "Spiritforged": "SFD",
    "Unleashed": "UNL",
    "Radiance": "RAD",
    "Vendetta": "VEN",
    "Proving Grounds": "PG",
}


def parse_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value]
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return []
    return [str(v) for v in parsed] if isinstance(parsed, list) else []


def numeric(value: Any) -> int | float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:  # NaN
        return None
    return int(number) if number.is_integer() else number


def normalize(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[tuple[str, str], dict[str, Any]] = {}
    for card in rows:
        title = card.get("full_name") or card.get("name") or ""
        key = (title, card.get("card_set") or "")
        existing = unique.get(key)
        if existing is None or (existing.get("rarity") == "Showcase" and card.get("rarity") != "Showcase"):
            unique[key] = card

    canonical = [c for c in unique.values() if c.get("card_type") != "Rune"]

    sets_by_title: dict[str, set[str]] = {}
    for card in canonical:
        title = card.get("full_name") or card.get("name") or ""
        sets_by_title.setdefault(title, set()).add(card.get("card_set") or "")

    out: list[dict[str, Any]] = []
    for card in canonical:
        title = card.get("full_name") or card.get("name") or ""
        card_set = card.get("card_set") or "Unknown set"
        labels = parse_list(card.get("card_type_labels"))
        domains = parse_list(card.get("domains"))
        card_type = "Champion" if "Champion" in labels else (card.get("card_type") or "Unknown")
        might = None if card.get("card_type") in ("Spell", "Gear") else numeric(card.get("might"))
        power = numeric(card.get("power"))
        display = f"{title} — {card_set}" if len(sets_by_title.get(title, set())) > 1 else title
        out.append(
            {
                "id": card.get("card_code"),
                "name": display,
                "title": title,
                "type": card_type,
                "domain": card.get("domain") or "/".join(domains) or "—",
                "cost": numeric(card.get("energy")),
                "power": power if power is not None else 0,
                "might": might,
                "set": card_set,
                "setCode": SET_CODES.get(card_set, (card.get("set_code") or "?").upper()),
                "rarity": card.get("rarity"),
                "image": card.get("image_url"),
                "labels": [label for label in labels if label != card.get("card_type")],
                "tags": parse_list(card.get("tags")),
                "ability": (card.get("ability_effective") or card.get("ability_original") or "").strip() or None,
                "artist": card.get("artist") or None,
            }
        )

    out.sort(key=lambda c: c["id"] or "")
    return out


def day_index(today: date) -> int:
    return (today - DAILY_EPOCH).days


def extend_schedule(ids: list[str], pool: list[str], until: int) -> list[str]:
    """Append picks until the schedule covers day `until`. Existing entries are kept as-is."""
    ids = list(ids)
    unique_pool = sorted(set(pool))
    if not unique_pool:
        return ids
    while len(ids) <= until:
        day = len(ids)
        used = set(ids)
        candidates = [c for c in unique_pool if c not in used]
        if not candidates:  # whole pool used: allow repeats, but not recent ones
            recent = set(ids[-(len(unique_pool) // 2) :]) if len(unique_pool) > 1 else set()
            candidates = [c for c in unique_pool if c not in recent] or unique_pool
        ids.append(random.Random(f"riftguessr:{day}").choice(candidates))
    return ids


def update_schedule(cards: list[dict[str, Any]], out: Path, schedule_path: Path, today: date) -> list[dict[str, Any]]:
    """Extend the schedule and keep every scheduled card present in the card list."""
    ids: list[str] = []
    if schedule_path.exists():
        ids = json.loads(schedule_path.read_text(encoding="utf-8")).get("ids", [])

    current = {c["id"] for c in cards}
    if out.exists():
        previous = {c["id"]: c for c in json.loads(out.read_text(encoding="utf-8"))}
        for card_id in dict.fromkeys(ids):
            if card_id not in current and card_id in previous:
                cards.append(previous[card_id])
                current.add(card_id)
                print(f"Kept scheduled card {card_id}, which is no longer in the dataset")
        cards.sort(key=lambda c: c["id"] or "")

    ids = extend_schedule(ids, [c["id"] for c in cards if c["id"]], day_index(today) + LOOKAHEAD)
    schedule_path.parent.mkdir(parents=True, exist_ok=True)
    schedule_path.write_text(
        json.dumps({"epoch": DAILY_EPOCH.isoformat(), "ids": ids}, indent=1) + "\n", encoding="utf-8"
    )
    print(f"Daily schedule covers days 0-{len(ids) - 1} ({schedule_path})")
    return cards


def load_rows(source: str | None) -> list[dict[str, Any]]:
    if source:
        with open(source, encoding="utf-8") as fh:
            return json.load(fh)
    from datasets import load_dataset  # imported lazily so --source works without it

    ds = load_dataset(DATASET, split="train")
    return [dict(row) for row in ds]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", help="Normalize a local JSON array instead of downloading the dataset")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Output path (default: public/data/cards.json)")
    parser.add_argument("--schedule", default=str(DEFAULT_SCHEDULE), help="Daily schedule path")
    parser.add_argument("--today", type=date.fromisoformat, help="Override today's UTC date (YYYY-MM-DD)")
    args = parser.parse_args(argv)

    rows = load_rows(args.source)
    cards = normalize(rows)
    if not cards:
        print("No cards produced; refusing to overwrite output.", file=sys.stderr)
        return 1

    out = Path(args.out)
    today = args.today or datetime.now(timezone.utc).date()
    cards = update_schedule(cards, out, Path(args.schedule), today)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(cards, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {len(cards)} cards (from {len(rows)} rows) to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
