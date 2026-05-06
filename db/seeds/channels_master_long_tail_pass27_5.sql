-- Pass 27.5 E — channel inventory long tail (440 → 590).
-- Applied via apply_migration as pass_27_5_e_channels_long_tail.
-- Plus pass_27_5_e_backfill_mena_markets that caught 221 Pass 25 Phase 1B
-- seed rows whose `markets[]` was empty (region was never populated on
-- those, so the Pass 27 backfill `UPDATE markets = region` was a no-op).
--
-- Final state: 590 channels, 0 empty markets, 0 duplicates, 123 global.
-- (123 includes 101 safety-net rows that fell through the MENA backfill
-- because their is_mena_specific flag was FALSE/NULL — flagging them
-- is_global keeps them visible in the picker; the alternative was
-- having them disappear entirely.)

-- ~150 new channels covering the priority gaps from Pass 27.5 spec:
-- - US press regional dailies (NY Post, Newsday, Star Tribune, etc.)
-- - US cable lifestyle (Bravo, FXX, Hallmark, Discovery Family, OWN, ID)
-- - US streaming niche (Acorn, BritBox, MUBI, Criterion, Discovery+)
-- - UK extras (BBC News Channel, GB News, S4C, Daily Express, i Newspaper, Now TV)
-- - Germany ARD members + DAZN + Magenta TV + regional press
-- - France DTT (France Info TV, RMC Story, RMC Découverte) + Ouest-France
-- - Italy press + NOW Sky + TimVision
-- - Spain (Atresplayer, Mitele)
-- - India press (The Telegraph, Deccan Chronicle/Herald) + niche streaming
--   (Aha, Sun NXT, Hoichoi, ALT Balaji) + retail (Myntra, Snapdeal, Tata Cliq)
-- - Brazil press (Valor Econômico, Exame, Veja)
-- - Japan (Mainichi, Sankei, Paravi, TVer)
-- - LinkedIn Lead Gen / Conversation / Message ads (separate inventory)
-- - TikTok Branded Hashtag Challenges + Effects
-- - Snapchat Public Profile Ads
-- - BeReal / Quora / Substack / Discord Quests
-- - Audio: Audacy, Wondery, Audible Originals (US); BBC Sounds, Global
--   Player, Bauer (UK); ARD Audiothek (DE); Heart, Capital, Kiss radio
-- - Retail media: eBay, Etsy, Wayfair, Home Depot, Lowe's (US);
--   Asda, M&S, JL, Sainsburys/Nectar360 (UK)
-- - Sports networks: Sky Sports, BT Sport (UK), FOX/NBC/CBS Sports (US)

-- Idempotent ON CONFLICT (id) DO NOTHING.

-- (See full INSERT statements in apply_migration log
-- pass_27_5_e_channels_long_tail; this file is the repo audit copy.)

-- MENA backfill that fixed the empty markets[] gap from Pass 25 Phase 1B:
UPDATE channels_master
SET markets = ARRAY['MENA']
WHERE markets = ARRAY[]::TEXT[]
  AND is_mena_specific = TRUE;

UPDATE channels_master
SET markets = ARRAY['GLOBAL'], is_global = TRUE
WHERE markets = ARRAY[]::TEXT[];
