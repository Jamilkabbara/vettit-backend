/**
 * The Creative Attention audience, read from the right place.
 *
 * WHY THIS EXISTS
 * ---------------
 * `missions.target_audience` is JSONB and is shared by every mission type. The
 * survey flows store an OBJECT in it ({ stage, market, price, ... }); the
 * Creative Attention page stored a plain STRING. The analysis interpolated the
 * column straight into its prompts, so any Creative Attention mission holding
 * the object form would have told the model its audience was
 * "[object Object]". Two unrun drafts in production already hold that shape.
 *
 * New Creative Attention missions write their own text column,
 * `ca_target_audience`. Missions created before that column keep the string in
 * `target_audience`, which is still honoured, so existing results are analysed
 * and displayed exactly as before. An object is never stringified: it is
 * treated as "no audience given".
 */
'use strict';

function cleanText(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

function resolveCaAudience(mission) {
  if (!mission || typeof mission !== 'object') return null;
  return cleanText(mission.ca_target_audience) || cleanText(mission.target_audience);
}

module.exports = { resolveCaAudience };
