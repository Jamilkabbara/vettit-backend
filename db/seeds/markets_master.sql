-- Pass 27 — markets_master seed: 10 meta-markets + 87 countries.
-- Applied via apply_migration as pass_27_seed_markets_master.
-- Idempotent via ON CONFLICT (code) DO NOTHING.

INSERT INTO markets_master (code, display_name, region, is_meta_market, emoji_flag, currency_default, population_millions, display_order) VALUES
('GLOBAL',         'Global',          'GLOBAL',         TRUE, '🌍', 'USD', 8000, 1),
('MENA',           'MENA',            'MENA',           TRUE, '🌍', 'USD', 480,  2),
('NORTH_AMERICA',  'North America',   'NORTH_AMERICA',  TRUE, '🌎', 'USD', 500,  3),
('EUROPE',         'Europe',          'EUROPE',         TRUE, '🌍', 'EUR', 750,  4),
('LATAM',          'LATAM',           'LATAM',          TRUE, '🌎', 'USD', 660,  5),
('APAC',           'APAC',            'APAC',           TRUE, '🌏', 'USD', 4500, 6),
('AFRICA',         'Africa',          'AFRICA',         TRUE, '🌍', 'USD', 1400, 7),
('CIS',            'CIS',             'CIS',            TRUE, '🌍', 'USD', 250,  8),
('NORDICS',        'Nordics',         'NORDICS',        TRUE, '🌍', 'EUR', 27,   9),
('GCC',            'GCC',             'GCC',            TRUE, '🌍', 'USD', 60,   10)
ON CONFLICT (code) DO NOTHING;

-- Country rows are seeded via the apply_migration in production. See
-- migration name pass_27_seed_markets_master for the full list (87 countries).
-- Reproduced here for repo audit:
-- North America: US, CA, MX
-- LATAM: BR, AR, CO, CL, PE, VE, EC, UY
-- Europe: GB, DE, FR, IT, ES, NL, BE, PL, IE, AT, CH, PT, GR, CZ, RO, HU, UA
-- Nordics: SE, NO, DK, FI
-- MENA: SA, AE, KW, QA, BH, OM, EG, JO, LB, MA, TN, DZ, LY, IQ, SY, PS, YE, IL, TR
-- APAC: JP, KR, CN, IN, ID, TH, VN, PH, MY, SG, TW, HK, AU, NZ, BD, PK, LK, KH, MM
-- Africa: ZA, NG, KE, ET, GH, TZ, UG, RW, SN, CI
-- CIS: RU, BY, KZ, UZ, AM, GE, AZ
