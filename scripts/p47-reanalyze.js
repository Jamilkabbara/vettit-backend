#!/usr/bin/env node
/*
 * Pass 47 Phase 3 — re-run synthesis for the missions whose narrator
 * failed, using the deployed code (scaled maxTokens + retry + computed
 * fallback). Verifies the fix against REAL data (Doctrine #22) AND
 * repairs the broken executive_summary fields for the visual sign-off.
 * Service-key only; no JWT. Mirrors runMission's persistence (runMission.js:530).
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { synthesizeInsights } = require('../src/services/ai/insights');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(url, key, { auth: { persistSession: false } });

const IDS = process.argv.slice(2);
if (IDS.length === 0) { console.error('usage: node scripts/p47-reanalyze.js <missionId...>'); process.exit(1); }

(async () => {
  for (const id of IDS) {
    try {
      const { data: mission, error } = await supabase.from('missions').select('*').eq('id', id).single();
      if (error || !mission) { console.log(`${id}: FETCH FAIL ${error?.message}`); continue; }
      const { data: responses } = await supabase
        .from('mission_responses')
        .select('persona_id, persona_profile, question_id, answer, exposure_status')
        .eq('mission_id', id).eq('screened_out', false);
      const insights = await synthesizeInsights(mission, responses || [], mission.analysis || null);
      await supabase.from('missions').update({
        executive_summary: insights?.executive_summary || null,
        insights: insights || null,
      }).eq('id', id);
      const ex = (insights?.executive_summary || '').slice(0, 80);
      const failed = insights?.narration_failed ? ' [computed-fallback]' : '';
      console.log(`${mission.goal_type}: ${ex}${failed}`);
    } catch (e) { console.log(`${id}: ERROR ${e.message}`); }
  }
  process.exit(0);
})();
