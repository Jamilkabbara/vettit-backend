-- Pass 25 Phase 1B — channels_master seed.
-- MENA-first granular channel inventory for Brand Lift Study v2.
-- Idempotent via ON CONFLICT (id) DO NOTHING. Applied via
-- pass_25_phase_1_seed_channels_master migration.
--
-- Convention: snake_case ids. is_mena_specific TRUE for MENA-targeted rows.
-- display_order ascending within category groups MENA-first.

-- ─── TV (Linear) ──────────────────────────────────────────────────────
INSERT INTO channels_master (id, display_name, category, is_mena_specific, display_order) VALUES
('mbc_1', 'MBC 1', 'tv', TRUE, 10),
('mbc_2', 'MBC 2', 'tv', TRUE, 11),
('mbc_3', 'MBC 3', 'tv', TRUE, 12),
('mbc_4', 'MBC 4', 'tv', TRUE, 13),
('mbc_action', 'MBC Action', 'tv', TRUE, 14),
('mbc_bollywood', 'MBC Bollywood', 'tv', TRUE, 15),
('mbc_drama', 'MBC Drama', 'tv', TRUE, 16),
('mbc_max', 'MBC Max', 'tv', TRUE, 17),
('mbc_persia', 'MBC Persia', 'tv', TRUE, 18),
('mbc_masr', 'MBC Masr', 'tv', TRUE, 19),
('mbc_masr_2', 'MBC Masr 2', 'tv', TRUE, 20),
('rotana_cinema', 'Rotana Cinema', 'tv', TRUE, 30),
('rotana_aflam', 'Rotana Aflam', 'tv', TRUE, 31),
('rotana_drama', 'Rotana Drama', 'tv', TRUE, 32),
('rotana_khalijia', 'Rotana Khalijia', 'tv', TRUE, 33),
('rotana_classic', 'Rotana Classic', 'tv', TRUE, 34),
('rotana_music', 'Rotana Music', 'tv', TRUE, 35),
('rotana_comedy', 'Rotana Comedy', 'tv', TRUE, 36),
('dubai_tv', 'Dubai TV', 'tv', TRUE, 50),
('sama_dubai', 'Sama Dubai', 'tv', TRUE, 51),
('dubai_one', 'Dubai One', 'tv', TRUE, 52),
('dubai_sports', 'Dubai Sports', 'tv', TRUE, 53),
('abu_dhabi_tv', 'Abu Dhabi TV', 'tv', TRUE, 54),
('abu_dhabi_drama', 'Abu Dhabi Drama', 'tv', TRUE, 55),
('abu_dhabi_sports', 'Abu Dhabi Sports', 'tv', TRUE, 56),
('sharjah_tv', 'Sharjah TV', 'tv', TRUE, 57),
('saudi_1', 'Saudi 1 (Al Saudia)', 'tv', TRUE, 70),
('saudi_2', 'Saudi 2 (KSA Sports)', 'tv', TRUE, 71),
('al_arabiya', 'Al Arabiya', 'tv', TRUE, 80),
('al_hadath', 'Al Hadath', 'tv', TRUE, 81),
('al_jazeera_arabic', 'Al Jazeera Arabic', 'tv', TRUE, 82),
('al_jazeera_english', 'Al Jazeera English', 'tv', TRUE, 83),
('al_jazeera_documentary', 'Al Jazeera Documentary', 'tv', TRUE, 84),
('al_jazeera_mubasher', 'Al Jazeera Mubasher', 'tv', TRUE, 85),
('sky_news_arabia', 'Sky News Arabia', 'tv', TRUE, 86),
('bbc_arabic', 'BBC Arabic', 'tv', TRUE, 87),
('lbci', 'LBCI', 'tv', TRUE, 100),
('mtv_lebanon', 'MTV Lebanon', 'tv', TRUE, 101),
('al_jadeed', 'Al Jadeed', 'tv', TRUE, 102),
('otv_lebanon', 'OTV', 'tv', TRUE, 103),
('al_manar', 'Al Manar', 'tv', TRUE, 104),
('nbn', 'NBN', 'tv', TRUE, 105),
('tele_liban', 'Tele Liban', 'tv', TRUE, 106),
('on_e', 'ON E', 'tv', TRUE, 120),
('on_sport', 'ON Sport', 'tv', TRUE, 121),
('dmc', 'DMC', 'tv', TRUE, 122),
('dmc_drama', 'DMC Drama', 'tv', TRUE, 123),
('al_hayat', 'Al Hayat', 'tv', TRUE, 124),
('cbc', 'CBC', 'tv', TRUE, 125),
('cbc_drama', 'CBC Drama', 'tv', TRUE, 126),
('cbc_sofra', 'CBC Sofra', 'tv', TRUE, 127),
('etc', 'ETC', 'tv', TRUE, 128),
('al_nahar', 'Al Nahar', 'tv', TRUE, 129),
('al_iraqiya', 'Al Iraqiya', 'tv', TRUE, 140),
('al_sumaria', 'Al Sumaria', 'tv', TRUE, 141),
('al_sharqiya', 'Al Sharqiya', 'tv', TRUE, 142),
('roya_tv', 'Roya TV', 'tv', TRUE, 150),
('jordan_tv', 'Jordan TV', 'tv', TRUE, 151),
('bbc_one', 'BBC One', 'tv', FALSE, 200),
('bbc_two', 'BBC Two', 'tv', FALSE, 201),
('itv', 'ITV', 'tv', FALSE, 202),
('channel_4', 'Channel 4', 'tv', FALSE, 203),
('cbs', 'CBS', 'tv', FALSE, 210),
('nbc', 'NBC', 'tv', FALSE, 211),
('abc', 'ABC', 'tv', FALSE, 212),
('fox', 'Fox', 'tv', FALSE, 213),
('espn', 'ESPN', 'tv', FALSE, 214),
('cnn', 'CNN', 'tv', FALSE, 215),
('tf1', 'TF1', 'tv', FALSE, 220),
('france_2', 'France 2', 'tv', FALSE, 221),
('m6', 'M6', 'tv', FALSE, 222),
('canal_plus', 'Canal+', 'tv', FALSE, 223)
ON CONFLICT (id) DO NOTHING;

-- ─── CTV / Streaming ─────────────────────────────────────────────────
INSERT INTO channels_master (id, display_name, category, is_mena_specific, display_order) VALUES
('shahid', 'Shahid (MBC)', 'ctv', TRUE, 10),
('shahid_vip', 'Shahid VIP', 'ctv', TRUE, 11),
('starzplay', 'Starzplay', 'ctv', TRUE, 12),
('osn_plus', 'OSN+', 'ctv', TRUE, 13),
('anghami_video', 'Anghami', 'ctv', TRUE, 14),
('watch_it', 'Watch It (Egypt)', 'ctv', TRUE, 15),
('tod_bein', 'TOD (beIN)', 'ctv', TRUE, 16),
('rotana_plus', 'Rotana+ (Tamasha)', 'ctv', TRUE, 17),
('weyyak', 'Weyyak', 'ctv', TRUE, 18),
('netflix', 'Netflix', 'ctv', FALSE, 100),
('amazon_prime_video', 'Amazon Prime Video', 'ctv', FALSE, 101),
('disney_plus', 'Disney+', 'ctv', FALSE, 102),
('apple_tv_plus', 'Apple TV+', 'ctv', FALSE, 103),
('hbo_max', 'HBO Max', 'ctv', FALSE, 104),
('hulu', 'Hulu', 'ctv', FALSE, 105),
('youtube_tv', 'YouTube TV', 'ctv', FALSE, 106),
('paramount_plus', 'Paramount+', 'ctv', FALSE, 107),
('peacock', 'Peacock', 'ctv', FALSE, 108)
ON CONFLICT (id) DO NOTHING;

-- ─── Cinema ──────────────────────────────────────────────────────────
INSERT INTO channels_master (id, display_name, category, is_mena_specific, display_order) VALUES
('vox_cinemas', 'VOX Cinemas', 'cinema', TRUE, 10),
('reel_cinemas_uae', 'Reel Cinemas (UAE)', 'cinema', TRUE, 11),
('cinemacity', 'Cinemacity', 'cinema', TRUE, 12),
('novo_cinemas', 'Novo Cinemas', 'cinema', TRUE, 13),
('empire_cinemas_lb', 'Empire Cinemas (Lebanon)', 'cinema', TRUE, 14),
('amc_theatres', 'AMC', 'cinema', FALSE, 100),
('regal_cinemas', 'Regal', 'cinema', FALSE, 101),
('cinemark', 'Cinemark', 'cinema', FALSE, 102),
('cineworld', 'Cineworld', 'cinema', FALSE, 103),
('vue', 'Vue', 'cinema', FALSE, 104),
('odeon', 'ODEON', 'cinema', FALSE, 105),
('pathe', 'Pathé', 'cinema', FALSE, 106),
('gaumont', 'Gaumont', 'cinema', FALSE, 107),
('ugc', 'UGC', 'cinema', FALSE, 108)
ON CONFLICT (id) DO NOTHING;

-- ─── Digital Video ───────────────────────────────────────────────────
INSERT INTO channels_master (id, display_name, category, display_order) VALUES
('youtube_pre_roll', 'YouTube (pre-roll)', 'digital_video', 10),
('youtube_mid_roll', 'YouTube (mid-roll)', 'digital_video', 11),
('youtube_bumper', 'YouTube (bumper)', 'digital_video', 12),
('youtube_shorts', 'YouTube Shorts', 'digital_video', 13),
('tiktok_in_feed', 'TikTok In-Feed', 'digital_video', 20),
('tiktok_topview', 'TikTok TopView', 'digital_video', 21),
('tiktok_spark_ads', 'TikTok Spark Ads', 'digital_video', 22),
('instagram_reels', 'Instagram Reels', 'digital_video', 30),
('facebook_watch', 'Facebook Watch', 'digital_video', 31),
('facebook_reels', 'Facebook Reels', 'digital_video', 32),
('snapchat_snap_ads', 'Snapchat Snap Ads', 'digital_video', 40),
('snapchat_ar_lens', 'Snapchat AR Lens', 'digital_video', 41),
('twitch', 'Twitch', 'digital_video', 50),
('twitter_x_video', 'Twitter/X video', 'digital_video', 51),
('linkedin_video', 'LinkedIn video', 'digital_video', 52),
('pinterest_video_pins', 'Pinterest video pins', 'digital_video', 53)
ON CONFLICT (id) DO NOTHING;

-- ─── Social Ads ──────────────────────────────────────────────────────
INSERT INTO channels_master (id, display_name, category, display_order) VALUES
('facebook_feed', 'Facebook Feed', 'social', 10),
('instagram_feed', 'Instagram Feed', 'social', 11),
('instagram_stories', 'Instagram Stories', 'social', 12),
('snapchat_stories', 'Snapchat Stories', 'social', 13),
('tiktok_carousel', 'TikTok Carousel', 'social', 14),
('linkedin_sponsored', 'LinkedIn Sponsored Content', 'social', 15),
('twitter_x_promoted', 'Twitter/X Promoted', 'social', 16),
('pinterest_pins', 'Pinterest Pins', 'social', 17),
('reddit_promoted', 'Reddit Promoted', 'social', 18),
('threads_ads', 'Threads Ads', 'social', 19)
ON CONFLICT (id) DO NOTHING;

-- ─── Display ─────────────────────────────────────────────────────────
INSERT INTO channels_master (id, display_name, category, display_order) VALUES
('google_display_network', 'Google Display Network', 'display', 10),
('programmatic_open_web', 'Programmatic Open Web', 'display', 11),
('outbrain_native', 'Outbrain Native', 'display', 12),
('taboola_native', 'Taboola Native', 'display', 13),
('retargeting_display', 'Retargeting Display', 'display', 14),
('dv360_inventory', 'DV360 Inventory', 'display', 15),
('the_trade_desk_inventory', 'The Trade Desk Inventory', 'display', 16)
ON CONFLICT (id) DO NOTHING;

-- ─── Digital Audio ───────────────────────────────────────────────────
INSERT INTO channels_master (id, display_name, category, is_mena_specific, display_order) VALUES
('anghami_audio', 'Anghami', 'audio', TRUE, 10),
('spotify_audio', 'Spotify Audio', 'audio', FALSE, 100),
('spotify_video', 'Spotify Video', 'audio', FALSE, 101),
('apple_music', 'Apple Music', 'audio', FALSE, 102),
('amazon_music', 'Amazon Music', 'audio', FALSE, 103),
('pandora', 'Pandora', 'audio', FALSE, 104),
('iheartradio', 'iHeartRadio', 'audio', FALSE, 105),
('podcasts_general', 'Podcasts (general)', 'audio', FALSE, 106),
('soundcloud', 'SoundCloud', 'audio', FALSE, 107),
('deezer', 'Deezer', 'audio', FALSE, 108),
('youtube_music', 'YouTube Music', 'audio', FALSE, 109)
ON CONFLICT (id) DO NOTHING;

-- ─── Radio ───────────────────────────────────────────────────────────
INSERT INTO channels_master (id, display_name, category, is_mena_specific, display_order) VALUES
('virgin_radio_uae', 'Virgin Radio (UAE)', 'radio', TRUE, 10),
('virgin_radio_lb', 'Virgin Radio (Lebanon)', 'radio', TRUE, 11),
('mbc_fm', 'MBC FM', 'radio', TRUE, 12),
('rotana_fm', 'Rotana FM', 'radio', TRUE, 13),
('radio_1_dubai', 'Radio 1 (Dubai)', 'radio', TRUE, 14),
('pulse_95_sharjah', 'Pulse 95 (Sharjah)', 'radio', TRUE, 15),
('sawt_lubnan', 'Sawt Lubnan', 'radio', TRUE, 16),
('mix_fm_lb', 'Mix FM (Lebanon)', 'radio', TRUE, 17),
('nrj_lb', 'NRJ Lebanon', 'radio', TRUE, 18)
ON CONFLICT (id) DO NOTHING;

-- ─── OOH ─────────────────────────────────────────────────────────────
INSERT INTO channels_master (id, display_name, category, display_order) VALUES
('static_billboards', 'Static Billboards', 'ooh', 10),
('highway_ooh', 'Highway OOH', 'ooh', 11),
('bus_shelters', 'Bus Shelters', 'ooh', 12),
('airport_ooh', 'Airport OOH', 'ooh', 13),
('mall_ooh', 'Mall OOH', 'ooh', 14),
('stadium_ooh', 'Stadium OOH', 'ooh', 15)
ON CONFLICT (id) DO NOTHING;

-- ─── DOOH ────────────────────────────────────────────────────────────
INSERT INTO channels_master (id, display_name, category, is_mena_specific, display_order) VALUES
('backlite_media_uae', 'BackLite Media (UAE)', 'dooh', TRUE, 10),
('elevision_uae', 'Elevision (UAE elevators)', 'dooh', TRUE, 11),
('hypermedia_regional', 'Hypermedia (regional)', 'dooh', TRUE, 12),
('dubai_mall_dooh', 'Dubai Mall DOOH', 'dooh', TRUE, 13),
('mall_of_the_emirates_dooh', 'Mall of the Emirates DOOH', 'dooh', TRUE, 14),
('yas_mall_dooh', 'Yas Mall DOOH', 'dooh', TRUE, 15),
('city_centre_dooh', 'City Centre DOOH', 'dooh', TRUE, 16),
('sheikh_zayed_road_dooh', 'Sheikh Zayed Road DOOH', 'dooh', TRUE, 17),
('emirates_road_dooh', 'Emirates Road DOOH', 'dooh', TRUE, 18),
('dubai_metro_dooh', 'Dubai Metro DOOH', 'dooh', TRUE, 19),
('riyadh_metro_dooh', 'Riyadh Metro DOOH', 'dooh', TRUE, 20),
('dxb_airport_dooh', 'DXB Airport DOOH', 'dooh', TRUE, 21),
('auh_airport_dooh', 'AUH Airport DOOH', 'dooh', TRUE, 22),
('ruh_airport_dooh', 'RUH Airport DOOH', 'dooh', TRUE, 23),
('times_square_premium', 'Times Square Premium', 'dooh', FALSE, 100),
('programmatic_dooh_vistar', 'Programmatic DOOH (Vistar)', 'dooh', FALSE, 101),
('programmatic_dooh_hivestack', 'Programmatic DOOH (Hivestack)', 'dooh', FALSE, 102)
ON CONFLICT (id) DO NOTHING;

-- ─── Influencer ──────────────────────────────────────────────────────
INSERT INTO channels_master (id, display_name, category, display_order) VALUES
('instagram_influencer_post', 'Instagram Influencer Post', 'influencer', 10),
('instagram_influencer_story', 'Instagram Influencer Story', 'influencer', 11),
('instagram_influencer_reel', 'Instagram Influencer Reel', 'influencer', 12),
('tiktok_creator', 'TikTok Creator', 'influencer', 13),
('youtube_creator', 'YouTube Creator', 'influencer', 14),
('snapchat_creator', 'Snapchat Creator', 'influencer', 15),
('twitter_x_kol', 'Twitter/X KOL', 'influencer', 16),
('podcast_host_read', 'Podcast Host-Read', 'influencer', 17)
ON CONFLICT (id) DO NOTHING;

-- ─── Press ───────────────────────────────────────────────────────────
INSERT INTO channels_master (id, display_name, category, is_mena_specific, display_order) VALUES
('asharq_al_awsat', 'Asharq Al-Awsat', 'press', TRUE, 10),
('gulf_news', 'Gulf News', 'press', TRUE, 11),
('khaleej_times', 'Khaleej Times', 'press', TRUE, 12),
('the_national', 'The National', 'press', TRUE, 13),
('al_bayan', 'Al Bayan', 'press', TRUE, 14),
('al_riyadh', 'Al Riyadh', 'press', TRUE, 15),
('al_watan_ksa', 'Al Watan', 'press', TRUE, 16),
('al_ahram', 'Al Ahram', 'press', TRUE, 17),
('al_akhbar_eg', 'Al Akhbar', 'press', TRUE, 18),
('lorient_le_jour', 'L''Orient-Le Jour', 'press', TRUE, 19),
('an_nahar', 'An-Nahar', 'press', TRUE, 20),
('vogue_arabia', 'Vogue Arabia', 'press', TRUE, 30),
('harpers_bazaar_arabia', 'Harper''s Bazaar Arabia', 'press', TRUE, 31),
('esquire_me', 'Esquire Middle East', 'press', TRUE, 32),
('gq_me', 'GQ Middle East', 'press', TRUE, 33),
('marie_claire_arabia', 'Marie Claire Arabia', 'press', TRUE, 34),
('hia_magazine', 'Hia Magazine', 'press', TRUE, 35),
('al_sayyidah', 'Al Sayyidah', 'press', TRUE, 36),
('forbes_me', 'Forbes Middle East', 'press', TRUE, 37)
ON CONFLICT (id) DO NOTHING;

-- ─── Retail Media ────────────────────────────────────────────────────
INSERT INTO channels_master (id, display_name, category, is_mena_specific, display_order) VALUES
('noon_ads', 'Noon Ads', 'retail_media', TRUE, 10),
('carrefour_maf_links', 'Carrefour MAF Links', 'retail_media', TRUE, 11),
('lulu_hypermarket', 'Lulu Hypermarket', 'retail_media', TRUE, 12),
('talabat_ads', 'Talabat Ads', 'retail_media', TRUE, 13),
('careem_ads', 'Careem Ads', 'retail_media', TRUE, 14),
('amazon_ads', 'Amazon Ads', 'retail_media', FALSE, 100),
('walmart_connect', 'Walmart Connect', 'retail_media', FALSE, 101),
('target_roundel', 'Target Roundel', 'retail_media', FALSE, 102)
ON CONFLICT (id) DO NOTHING;

-- ─── In-Game ─────────────────────────────────────────────────────────
INSERT INTO channels_master (id, display_name, category, display_order) VALUES
('roblox_ads', 'Roblox Ads', 'in_game', 10),
('unity_in_app', 'Unity In-App', 'in_game', 11),
('admob_in_app', 'AdMob In-App', 'in_game', 12),
('twitch_sponsorship', 'Twitch Sponsorship', 'in_game', 13),
('discord_sponsored', 'Discord Sponsored', 'in_game', 14),
('esports_tournament_sponsorship', 'Esports Tournament Sponsorship', 'in_game', 15)
ON CONFLICT (id) DO NOTHING;
