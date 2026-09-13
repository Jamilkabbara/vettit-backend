/**
 * Creative Attention placements - the ONLY placements a customer may choose,
 * because they are the only ones we hold a published attention norm for.
 *
 * WHY A CLOSED LIST
 * -----------------
 * A placement is useful because it decides which norm the creative is judged
 * against: "1.6s predicted active attention, 14% above the TikTok Feed norm of
 * 1.4s". That sentence is only honest when the norm is real. channels_master
 * holds 572 channels (Shahid, MBC, Anghami...) and none of them carries an
 * attention figure, so offering them here would put a benchmark we do not have
 * in front of a paying customer. The list below is exactly the norms table the
 * synthesis prompt has always used, and the prompt is now rendered FROM this
 * list, so what a customer can pick and what the model is told can never drift.
 *
 * Twelve entries, not ten. The table has twelve placements with a figure;
 * Audio is listed in the prompt with no visual norm and is deliberately not
 * selectable.
 *
 * `formats` is which uploads a placement can honestly be scored for. TV and
 * CTV require motion (the prompt already refuses to predict a static image
 * there), YouTube pre-roll is video, and print is static.
 *
 * Adding or changing a placement here also needs the database CHECK constraint
 * updated (migrations/pass-56); test/ca_placements.test.js fails until both
 * agree.
 */
'use strict';

const HEADER = [
  'PUBLISHED CHANNEL ATTENTION NORMS (DAIVID/Amplified — use these as the',
  'ground truth for category_avg_attention_seconds in channel_benchmarks',
  'AND for platform_norm_active_attention_seconds in best_platform_fit):',
];

const CA_PLACEMENTS = Object.freeze([
  { id: 'instagram_feed',        label: 'Instagram Feed',          normActiveSeconds: 1.2,  formats: ['image', 'video'], promptLine: '  Instagram Feed:        1.2s active attention' },
  { id: 'tiktok_feed',           label: 'TikTok Feed',             normActiveSeconds: 1.4,  formats: ['image', 'video'], promptLine: '  TikTok Feed:           1.4s' },
  { id: 'youtube_preroll',       label: 'YouTube Pre-roll',        normActiveSeconds: 1.8,  formats: ['video'],          promptLine: '  YouTube Pre-roll:      1.8s' },
  { id: 'pinterest',             label: 'Pinterest',               normActiveSeconds: 1.5,  formats: ['image', 'video'], promptLine: '  Pinterest:             1.5s' },
  { id: 'snapchat',              label: 'Snapchat',                normActiveSeconds: 0.9,  formats: ['image', 'video'], promptLine: '  Snapchat:              0.9s' },
  { id: 'meta_reels_stories',    label: 'Meta Reels / Stories',    normActiveSeconds: 1.0,  formats: ['image', 'video'], promptLine: '  Meta Reels / Stories:  1.0s' },
  { id: 'programmatic_display',  label: 'Programmatic Display',    normActiveSeconds: 0.4,  formats: ['image', 'video'], promptLine: '  Programmatic Display:  0.4s' },
  { id: 'ooh_digital_billboard', label: 'OOH (digital billboard)', normActiveSeconds: 0.8,  formats: ['image', 'video'], promptLine: '  OOH (digital billboard): 0.8s active, 4-6s passive' },
  { id: 'ctv_15s',               label: 'CTV (15s)',               normActiveSeconds: 4.5,  formats: ['video'],          promptLine: '  CTV (15s):             4.5s' },
  { id: 'ctv_30s',               label: 'CTV (30s)',               normActiveSeconds: 8.0,  formats: ['video'],          promptLine: '  CTV (30s):             8.0s' },
  { id: 'tv_30s',                label: 'TV (30s spot)',           normActiveSeconds: 12.0, formats: ['video'],          promptLine: '  TV (30s spot):         12.0s' },
  { id: 'print_luxury_magazine', label: 'Print (luxury magazine)', normActiveSeconds: 2.5,  formats: ['image'],          promptLine: '  Print (luxury magazine): 2.5s' },
].map((p) => Object.freeze({ ...p, formats: Object.freeze([...p.formats]) })));

// Listed for the model, never selectable: there is no visual attention norm.
const AUDIO_LINE = '  Audio (Spotify/podcast): N/A (no visual attention)';

const BY_ID = new Map(CA_PLACEMENTS.map((p) => [p.id, p]));

/** The norms block exactly as the synthesis prompt has always shown it. */
function renderNormsTable() {
  return [...HEADER, ...CA_PLACEMENTS.map((p) => p.promptLine), AUDIO_LINE].join('\n');
}

function placementById(id) {
  return (typeof id === 'string' && BY_ID.get(id)) || null;
}

/**
 * The media kind a placement list is filtered by. The page only ever creates
 * image or video missions; any other stored media_type is treated as a video
 * (bundle and series are sequences) so nothing is silently over-offered.
 */
function mediaKind(mediaType) {
  return mediaType === 'image' ? 'image' : 'video';
}

function placementsForMedia(mediaType) {
  const kind = mediaKind(mediaType);
  return CA_PLACEMENTS.filter((p) => p.formats.includes(kind));
}

/** The placement, or null when it is unknown or cannot be scored for this upload. */
function resolvePlacement(id, mediaType) {
  const p = placementById(id);
  if (!p) return null;
  return p.formats.includes(mediaKind(mediaType)) ? p : null;
}

/**
 * The headline comparison, computed here rather than by the model so it is
 * deterministic: the same prediction against the same placement always gives
 * the same delta. Takes NO market argument on purpose - market is qualitative
 * only and must not be able to reach a number.
 *
 * Returns null when there is no chosen placement. When there is a placement
 * but the model returned no usable prediction, the placement and its norm are
 * still recorded and the comparison is withheld, never guessed.
 */
function computePlacementBenchmark({ placement, attention }) {
  if (!placement) return null;
  const predicted = Number(attention && attention.predicted_active_attention_seconds);
  const hasPrediction = Number.isFinite(predicted) && predicted > 0;
  return {
    placement_id:              placement.id,
    placement_label:           placement.label,
    norm_active_seconds:       placement.normActiveSeconds,
    predicted_active_seconds:  hasPrediction ? Math.round(predicted * 10) / 10 : null,
    delta_vs_norm_pct:         hasPrediction
      ? Math.round(((predicted / placement.normActiveSeconds) - 1) * 100)
      : null,
  };
}

/** The shape the public placements endpoint returns. */
function publicPlacementList() {
  return CA_PLACEMENTS.map(({ id, label, normActiveSeconds, formats }) => ({
    id, label, norm_active_seconds: normActiveSeconds, formats: [...formats],
  }));
}

module.exports = {
  CA_PLACEMENTS,
  renderNormsTable,
  placementById,
  placementsForMedia,
  resolvePlacement,
  computePlacementBenchmark,
  publicPlacementList,
};
