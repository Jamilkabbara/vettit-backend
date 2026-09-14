/**
 * Creative Attention setup options.
 *
 * GET /api/creative-attention/options
 *   { placements: [{ id, label, norm_active_seconds, formats }], markets: [{ code, name, is_meta_market }] }
 *
 * The page renders its placement and market pickers from this, so the
 * choices a customer sees are the SAME list the analysis validates against:
 * placements from the closed norms list, markets from markets_master. Public
 * and read-only - nothing here is customer data - and cached briefly because
 * neither list changes between deploys.
 */
'use strict';

const express = require('express');
const supabase = require('../db/supabase');
const logger = require('../utils/logger');
const { publicPlacementList } = require('../services/creativeAttention/placements');

const router = express.Router();

router.get('/options', async (req, res) => {
  const placements = publicPlacementList();
  const { data, error } = await supabase
    .from('markets_master')
    .select('code, display_name, is_meta_market, display_order')
    .order('display_order', { ascending: true });

  if (error) {
    // Placements do not depend on the database; markets do. Say which half
    // failed rather than returning an empty market list that looks real.
    logger.warn('[creative-attention/options] markets_master read failed', { err: error.message });
    return res.status(503).json({ placements, markets: null, error: 'markets_unavailable' });
  }

  res.set('Cache-Control', 'public, max-age=300');
  return res.json({
    placements,
    markets: (data || []).map((m) => ({ code: m.code, name: m.display_name, is_meta_market: !!m.is_meta_market })),
  });
});

module.exports = router;
