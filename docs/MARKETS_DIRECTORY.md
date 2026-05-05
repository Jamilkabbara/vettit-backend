# Markets Directory

**Last updated:** 2026-05-05 (Pass 27)
**Total:** 97 rows (10 meta-markets + 87 countries)

## Schema

```sql
CREATE TABLE markets_master (
  code TEXT PRIMARY KEY,           -- ISO 3166-1 alpha-2 for countries; ALL_CAPS_SNAKE for meta
  display_name TEXT NOT NULL,
  region TEXT NOT NULL,
  is_meta_market BOOLEAN DEFAULT FALSE,
  emoji_flag TEXT,
  timezone_default TEXT,
  currency_default TEXT,
  population_millions NUMERIC,
  display_order INTEGER DEFAULT 100
);
```

RLS: public read.

## Meta-markets

GLOBAL, MENA, NORTH_AMERICA, EUROPE, LATAM, APAC, AFRICA, CIS,
NORDICS, GCC. Each meta-market expands to its constituent countries
in the MarketPicker UI when selected.

## Region groupings

| Region | Countries |
|---|---|
| NORTH_AMERICA | US, CA, MX |
| LATAM | BR, AR, CO, CL, PE, VE, EC, UY |
| EUROPE | GB, DE, FR, IT, ES, NL, BE, PL, IE, AT, CH, PT, GR, CZ, RO, HU, UA |
| NORDICS | SE, NO, DK, FI |
| MENA | SA, AE, KW, QA, BH, OM, EG, JO, LB, MA, TN, DZ, LY, IQ, SY, PS, YE, IL, TR |
| APAC | JP, KR, CN, IN, ID, TH, VN, PH, MY, SG, TW, HK, AU, NZ, BD, PK, LK, KH, MM |
| AFRICA | ZA, NG, KE, ET, GH, TZ, UG, RW, SN, CI |
| CIS | RU, BY, KZ, UZ, AM, GE, AZ |

## Adding a market

1. Find the right region.
2. Use the country's ISO 3166-1 alpha-2 code.
3. Add an entry to `db/seeds/markets_master.sql`.
4. Insert via `apply_migration` so production picks up the row.

## Source of truth

- Schema: `migrations/pass-27/02_markets_and_channels_schema.sql`
- Seed: `db/seeds/markets_master.sql`
- UI: `src/components/brand-lift/MarketPicker.tsx`
