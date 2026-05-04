# Channels Master List

**Last updated:** 2026-05-04 (Pass 25 Phase 1B)
**Total rows:** 221 (MENA-first)

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
  display_order INTEGER DEFAULT 100
);
```

RLS: read by anon + authenticated; writes through service role only.

## Counts by category

| Category | Count |
|---|---|
| tv | 72 |
| press | 19 |
| ctv | 18 |
| dooh | 17 |
| digital_video | 16 |
| cinema | 14 |
| audio | 11 |
| social | 10 |
| radio | 9 |
| influencer | 8 |
| retail_media | 8 |
| display | 7 |
| in_game | 6 |
| ooh | 6 |
| **Total** | **221** |

## Conventions

- IDs are snake_case (`mbc_1`, `vox_cinemas`, `anghami_audio`).
- `is_mena_specific = TRUE` for any MENA-targeted entry.
- `display_order` ascending: MENA-first within each category (10-99),
  global rows after (100+).
- Category names match the values rendered in `ChannelPicker.tsx`
  (`CATEGORY_LABELS` map).

## Adding a channel

1. Pick the right category (existing 14 categories above).
2. Pick a unique snake_case id.
3. Decide `is_mena_specific`.
4. Set `display_order` to slot in next to logical neighbours
   (10-99 for MENA, 100+ for global; group families together
   like the MBC range 10-20).
5. Add to `db/seeds/channels_master.sql` so the channel rolls
   into fresh databases.
6. Insert via `apply_migration` so production picks it up.

## Adding a category

1. Add the category to `CATEGORY_LABELS` in `ChannelPicker.tsx`.
2. Seed at least one channel under it.
3. If the category needs format-specific defaults, populate
   `default_formats` (text[]) on each row.

## Source of truth

- Schema: `migrations/pass-25/01_brand_lift_v2_schema.sql`
- Seed: `db/seeds/channels_master.sql`
- UI consumer: `src/components/brand-lift/ChannelPicker.tsx`
