/**
 * VETT - the columns POST /api/missions must work out for itself.
 *
 * WHY THIS FILE EXISTS
 * Today the browser inserts the mission row directly with supabase-js
 * (MissionSetupPage.tsx and CreativeAttentionPage.tsx). The RLS INSERT policy
 * blocks status, paid_at, paid_amount_cents, promo_code and
 * ai_spend_usd_actual - and nothing else. So the client currently WRITES:
 *
 *   media_type              the $19-vs-$49 switch on Creative Attention
 *   tier                    the resolved ladder id stamped on every paid row
 *   price_estimated         the number the dashboard shows as the price
 *   mission_assets          the record of what was uploaded
 *   wave_config             a server-owned jsonb blob on brand_lift
 *   ai_spend_ceiling_usd    the hard cap on what a run may spend
 *   target_qualified_count  how many respondents the recruit loop chases
 *
 * Every one of those is in SERVER_OWNED_COLUMNS in src/db/missionSchema.js.
 * The route this module serves accepts the SAME payload the two pages send,
 * and then throws those seven values away and works them out again.
 *
 * THE RULE THIS MODULE ENCODES
 * A request body may say WHERE something is. It may not say WHAT it is.
 * `missionAssets[i].path` is a location and is read. `missionAssets[i].type`,
 * `.mimeType`, `.sizeBytes` and `.url` are claims about the file and are
 * dropped on the floor - the bytes in storage answer those.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * A second media-type derivation. src/services/media/creativeMediaType.js
 * already reads the first 64 bytes of the stored object and classifies them,
 * and it is the one create-checkout-session and free-launch call. This module
 * calls into it rather than re-deriving, so a fix to the magic table lands on
 * every path at once.
 */

'use strict';

const logger = require('../../utils/logger');
const {
  SNIFF_BYTES,
  classifyMagicBytes,
  classifyContentType,
  readObjectHead,
  deriveCreativeMediaType,
} = require('../media/creativeMediaType');

/**
 * The bucket MissionSetupPage uploads its mission assets to
 * (src/lib/missionAssetUpload.ts in the frontend repo). Distinct from
 * creativeMediaType's CREATIVE_BUCKET, which is where the Creative Attention
 * page puts the single creative under analysis.
 */
const MISSION_ASSET_BUCKET = 'vettit-uploads';

/**
 * The three questionnaire-framing modes WaveStructureSelector offers. Anything
 * else is not a wave mode, it is a client writing arbitrary JSON into a
 * server-owned jsonb column.
 */
const WAVE_MODES = Object.freeze(['single_wave', 'pre_post', 'continuous']);
const DEFAULT_WAVE_MODE = 'single_wave';

/** Cap on how many uploads one mission may carry. */
const MAX_MISSION_ASSETS = 10;

/**
 * Read a body field under either spelling, camelCase first.
 *
 * Same shape as the `namingCandidates ?? naming_candidates` pattern the route
 * already uses: `??` not `||`, so a legitimate `false`, `0` or `''` survives.
 */
function pick(body, camel, snake) {
  const b = body || {};
  return b[camel] ?? b[snake];
}

// ─── wave_config ────────────────────────────────────────────────────────────

/**
 * Derive missions.wave_config.
 *
 * WHAT IT IS DERIVED FROM: one enum choice, and the column's own shape.
 *
 * Be honest about what this can and cannot be. wave_config is not priced -
 * calculateBrandLiftMissionPrice takes marketCount and channelCount and
 * nothing else - and it has no reader in src/ at all; the only field of it
 * that reaches anything is `mode`, which MissionSetupPage forwards separately
 * in clarify_answers so the brand-lift prompt can append one `Wave Mode:`
 * line. There is therefore no upstream fact to recompute it from.
 *
 * So the derivation available here is a REAL one but a narrow one: the server
 * owns the column's SHAPE and its VOCABULARY. It emits `{ mode }` and nothing
 * else, the mode must be one of the three the selector offers, an unknown one
 * falls back to the default rather than being stored, and the column is
 * written for brand_lift only. A client cannot put a fourth key, a nested
 * object, or a 40 kB blob into a server-owned jsonb column through this route.
 *
 * @returns {{mode: string}|null} null when the goal has no wave config.
 */
function deriveWaveConfig({ goalType, body }) {
  if (goalType !== 'brand_lift') return null;

  const raw = pick(body, 'waveConfig', 'wave_config');
  const claimed = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw.mode
    : pick(body, 'waveMode', 'wave_mode');

  const mode = WAVE_MODES.includes(claimed) ? claimed : DEFAULT_WAVE_MODE;
  if (claimed !== undefined && claimed !== mode) {
    logger.warn('missions.create: unrecognised wave mode, falling back to the default', {
      claimed, using: mode,
    });
  }
  return { mode };
}

// ─── mission_assets ─────────────────────────────────────────────────────────

/**
 * The storage paths a request refers to, and nothing else it said about them.
 *
 * Accepts the array the Setup page already builds (`missionAssets`, objects
 * carrying `path`) and the bare-path form an API caller would reasonably send.
 * Everything except `path` is discarded here, before any of it can reach a
 * column.
 */
function assetPathsFromBody(body) {
  const raw = pick(body, 'missionAssets', 'mission_assets')
           ?? pick(body, 'assetPaths', 'asset_paths');
  if (!Array.isArray(raw)) return [];
  const paths = [];
  for (const entry of raw) {
    const p = typeof entry === 'string' ? entry : (entry && entry.path);
    if (typeof p === 'string' && p.trim()) paths.push(p.trim());
  }
  return paths.slice(0, MAX_MISSION_ASSETS);
}

/** The file name as STORAGE has it, not as the uploader described it. */
function basename(path) {
  const tail = String(path).split('/').pop() || '';
  return tail || String(path);
}

/**
 * Build one mission_assets record by asking storage what the object is.
 *
 * Order of trust is creativeMediaType's, because it is the same question:
 *   1. the first bytes of the object (magic number)
 *   2. the content type storage recorded at upload
 * A file we cannot classify is recorded with `type: null` rather than guessed.
 * Consumers that branch on `type` see an honest "unknown" instead of a coin
 * flip dressed as a fact.
 */
async function deriveOneAsset(supabase, path) {
  let type = null;
  let source = 'unverifiable';
  let mimeType = null;
  let sizeBytes = null;

  try {
    const head = await readObjectHead(supabase, MISSION_ASSET_BUCKET, path, SNIFF_BYTES);
    const hit = classifyMagicBytes(head);
    if (hit) {
      type = hit.mediaType;
      source = 'magic_bytes';
      mimeType = hit.format;
    }
  } catch (err) {
    logger.warn('missions.create: could not read a mission asset head', { path, err: err.message });
  }

  try {
    const { data, error } = await supabase.storage.from(MISSION_ASSET_BUCKET).info(path);
    if (!error && data) {
      if (Number.isFinite(Number(data.size))) sizeBytes = Number(data.size);
      if (data.contentType) {
        // The recorded content type is the better mimeType string when we have
        // it; it is also the fallback CLASSIFIER when the bytes said nothing.
        mimeType = data.contentType;
        if (!type) {
          const hit = classifyContentType(data.contentType);
          if (hit) { type = hit.mediaType; source = 'storage_content_type'; }
        }
      }
    }
  } catch (err) {
    logger.warn('missions.create: could not stat a mission asset', { path, err: err.message });
  }

  const { data: pub } = supabase.storage.from(MISSION_ASSET_BUCKET).getPublicUrl(path);

  return {
    url: (pub && pub.publicUrl) || null,
    path,
    type,
    filename: basename(path),
    mimeType,
    sizeBytes,
    uploadedAt: new Date().toISOString(),
    derivedFrom: source,
  };
}

/**
 * Derive missions.mission_assets.
 *
 * WHAT IT IS DERIVED FROM: the stored objects the request pointed at.
 *
 * The client supplies paths. The server supplies the public URL (it composes
 * it from the bucket, so a client cannot point the dashboard's <img> at
 * somewhere else), the media type (bytes, then recorded content type), the
 * size and content type from the Storage API, the file name from the storage
 * path, and the timestamp from its own clock.
 *
 * @returns {Promise<Array>} empty array when nothing was uploaded. An empty
 *          array, not null: that is what the client insert writes today and
 *          what normaliseMissionAssets expects.
 */
async function deriveMissionAssets(supabase, { body }) {
  const paths = assetPathsFromBody(body);
  if (!paths.length) return [];
  const out = [];
  for (const p of paths) out.push(await deriveOneAsset(supabase, p));
  return out;
}

// ─── media_type ─────────────────────────────────────────────────────────────

/**
 * Derive missions.media_type for a mission that does not exist yet.
 *
 * WHAT IT IS DERIVED FROM: the first bytes of the stored creative.
 *
 * deriveCreativeMediaType takes a mission-shaped object and reads
 * brief_attachment.path off it, so a create request is handed to it as the row
 * it is about to become. The module is unchanged and unforked; this is the
 * same call create-checkout-session and free-launch make, one step earlier.
 *
 * A request body's own `mediaType` is never consulted, not even as a fallback.
 * An object we cannot read leaves the column NULL, which is exactly the state
 * create-checkout-session already knows how to repair
 * (`media_type: mission.media_type || pricedMediaType`). Filling it in from
 * the client instead would put the $19-vs-$49 switch back in the browser,
 * which is the whole thing this phase removes.
 *
 * @returns {Promise<{mediaType: string|null, checked: boolean, source: string}>}
 */
async function deriveMediaType(supabase, { goalType, briefAttachment }) {
  if (goalType !== 'creative_attention') {
    return { mediaType: null, checked: false, source: 'not_applicable' };
  }
  const d = await deriveCreativeMediaType(supabase, {
    id: null,
    goal_type: 'creative_attention',
    brief_attachment: briefAttachment || null,
  });
  if (!d.checked) {
    logger.warn('missions.create: creative media type could not be derived; leaving media_type NULL', {
      source: d.source, error: d.error,
    });
  }
  return { mediaType: d.checked ? d.derived : null, checked: d.checked, source: d.source };
}

module.exports = {
  MISSION_ASSET_BUCKET,
  WAVE_MODES,
  DEFAULT_WAVE_MODE,
  MAX_MISSION_ASSETS,
  pick,
  deriveWaveConfig,
  assetPathsFromBody,
  deriveMissionAssets,
  deriveMediaType,
};
