# Channels Master List

**Last updated:** 2026-05-05 (Pass 27.5 E)
**Total rows:** ~590 (MENA-first, then global + per-market expansion)

## Schema

```sql
CREATE TABLE channels_master (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  region TEXT[] DEFAULT ARRAY[]::TEXT[],
  description TEXT,
  is_mena_specific BOOLEAN DEFAULT FALSE,
  default_formats TEXT[] DEFAULT ARRAY[]::TEXT[],
  display_order INTEGER DEFAULT 100,
  is_global BOOLEAN DEFAULT FALSE,           -- Pass 27 B
  markets TEXT[] DEFAULT ARRAY[]::TEXT[]     -- Pass 27 B
);
CREATE INDEX channels_master_markets_gin ON channels_master USING GIN (markets);
```

RLS: read by anon + authenticated; writes through service role only.

## Categories (14)

`tv`, `ctv`, `cinema`, `digital_video`, `social`, `display`, `audio`,
`radio`, `ooh`, `dooh`, `influencer`, `press`, `retail_media`, `in_game`.
Category names match `CATEGORY_LABELS` in
`src/components/brand-lift/ChannelPicker.tsx`.

## Pass 27.5 coverage

Pre-Pass-27.5 the table held ~440 rows skewed toward MENA. Pass 27.5 E
added ~150 rows targeting the remaining priority gaps:

- US press regional dailies, US cable lifestyle, niche streaming
  (Acorn, BritBox, MUBI, Criterion, Discovery+)
- UK extras (BBC News Channel, GB News, Daily Express, i Newspaper,
  Now TV); DE ARD members + DAZN + Magenta TV + regional press
- FR DTT thematic + Ouest-France + Salto/Molotov; IT NOW Sky + TimVision
- ES Atresplayer + Mitele; IN press + niche streaming + retail
- BR / JP press + streaming
- LinkedIn Lead Gen / Conversation / Message Ads (separate inventory)
- TikTok Branded Hashtag + Effects; Snapchat Public Profile Ads
- BeReal / Quora / Substack / Discord Quests
- Audio: Audacy / Wondery (US); BBC Sounds / Global Player (UK);
  ARD Audiothek (DE)
- Retail media: eBay / Etsy / Wayfair / Home Depot (US);
  Asda / M&S / JL / Nectar360 (UK)
- Sports networks: Sky Sports / BT Sport (UK); FOX/NBC/CBS Sports (US)

Final state: 590 rows, 0 with empty `markets[]`, 0 duplicate ids.

Long tail 590 → 800+ remains deferred — incremental adds, no schema
change required.

## Conventions

- IDs are snake_case (`mbc_1`, `vox_cinemas`, `nyt_post_press`).
- `is_mena_specific = TRUE` for any MENA-targeted entry.
- `is_global = TRUE` for entries that should always appear regardless
  of selected markets (used for global digital platforms + the safety
  net for legacy rows whose `markets[]` could not be backfilled).
- `markets[]` carries ISO-style codes (`US`, `UK`, `DE`, `FR`, etc.)
  matching `markets_master.code`.
- `display_order` ascending: MENA-first (10-99), global rows after
  (100+), per-market expansion (200+).

## Adding a channel

1. Pick the right category (existing 14 above).
2. Pick a unique snake_case id.
3. Decide `is_mena_specific` and `is_global`.
4. Set `markets[]` to the list of country codes the channel reaches
   (or leave empty + set `is_global = TRUE` for borderless platforms).
5. Set `display_order` to slot next to logical neighbours (group
   families together — e.g. all MBC channels stay adjacent).
6. Insert via `apply_migration` so production picks it up.

## Adding a channel for a new market

When a new country joins `markets_master` (Pass 27+ taxonomy expansion)
the picker needs at least one channel per category before it surfaces:

1. Confirm the market code exists in `markets_master`. If not, add it
   there first (see `MARKETS_DIRECTORY.md`).
2. Add baseline channels covering the 14 categories — at minimum
   `tv`, `social`, `display`, `audio` so `ChannelPicker` is not empty.
3. For each insert, set `markets = ARRAY['<NEW_CODE>']` (or extend the
   existing array if the channel reaches multiple markets).
4. The GIN index on `markets` keeps the picker filter under 50ms even
   at 800+ rows.
5. Smoke-test: select only the new market in `MarketPicker` and verify
   the channel categories all populate.

## Adding a category

1. Add the category to `CATEGORY_LABELS` in `ChannelPicker.tsx`.
2. Seed at least one channel under it.
3. If the category needs format-specific defaults, populate
   `default_formats` (text[]) on each row.

## Source of truth

- Schema: `migrations/pass-25/01_brand_lift_v2_schema.sql`
  + Pass 27 B (`is_global`, `markets[]`, GIN index)
- Seeds: `db/seeds/channels_master.sql`,
  `db/seeds/channels_master_expansion_pass27.sql`,
  `db/seeds/channels_master_long_tail_pass27_5.sql`
- UI consumer: `src/components/brand-lift/ChannelPicker.tsx`
