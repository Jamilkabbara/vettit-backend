'use strict';

/**
 * VETT — Creative Attention hotspot normalizer (single source of truth).
 *
 * `frame_analyses[].attention_hotspots` has TWO shapes in the wild:
 *
 *   LEGACY (every mission run before the spatial-schema ship, including the
 *   owner's proof mission 0cb85100): an array of plain STRINGS.
 *       ["Black structured briefcase centered in left frame", ...]
 *
 *   SPATIAL (missions run after the vision-prompt change): an array of
 *   OBJECTS carrying frame-relative geometry, so any surface can draw a
 *   heat overlay at any render size.
 *       [{ label, x, y, w, h, weight }]   x/y/w/h are 0-1 FRACTIONS of the
 *                                         frame's width/height (top-left
 *                                         origin); weight is 0-100 pull.
 *
 * Every consumer (PDF template view model, PPTX deck, web results page)
 * routes through normalizeHotspots() so the two shapes can never drift
 * apart per-surface. A malformed or partial object degrades to a
 * label-only entry rather than throwing or rendering NaN geometry.
 *
 * Exported shape (always an array, never null):
 *   { label: string, spatial: boolean, weight: number|null,
 *     x, y, w, h: number|null,                      // 0-1 fractions
 *     leftPct, topPct, widthPct, heightPct: number|null }  // 0-100, for CSS
 */

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function pct(n) {
  return Math.round(n * 1000) / 10;  // 1 decimal, avoids 33.33333% in CSS
}

/**
 * @param {unknown} raw  frame.attention_hotspots in EITHER shape
 * @returns {Array<object>} normalized entries (possibly empty)
 */
function normalizeHotspots(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];

  for (const h of raw) {
    // Legacy string shape.
    if (typeof h === 'string') {
      const label = h.trim();
      if (label) {
        out.push({
          label, spatial: false, weight: null,
          x: null, y: null, w: null, h: null,
          leftPct: null, topPct: null, widthPct: null, heightPct: null,
        });
      }
      continue;
    }
    if (!h || typeof h !== 'object') continue;

    const label = String(h.label ?? h.name ?? h.description ?? '').trim();
    let x = toNum(h.x);
    let y = toNum(h.y);
    let w = toNum(h.w ?? h.width);
    let hh = toNum(h.h ?? h.height);
    const weightRaw = toNum(h.weight ?? h.score);

    const hasGeometry = x !== null && y !== null && w !== null && hh !== null && w > 0 && hh > 0;

    if (!hasGeometry) {
      if (!label) continue;
      out.push({
        label, spatial: false,
        weight: weightRaw === null ? null : Math.round(clamp(weightRaw, 0, 100)),
        x: null, y: null, w: null, h: null,
        leftPct: null, topPct: null, widthPct: null, heightPct: null,
      });
      continue;
    }

    // Clamp into the frame. A model that returns x=0.9,w=0.4 must not paint
    // a box hanging off the right edge of the creative; x is capped at 0.99
    // first so there is always room for the 0.01 minimum box.
    x = round4(clamp(x, 0, 0.99));
    y = round4(clamp(y, 0, 0.99));
    w = round4(clamp(w, 0.01, 1 - x));
    hh = round4(clamp(hh, 0.01, 1 - y));

    out.push({
      label: label || 'Attention hotspot',
      spatial: true,
      weight: weightRaw === null ? 50 : Math.round(clamp(weightRaw, 0, 100)),
      x, y, w, h: hh,
      leftPct: pct(x), topPct: pct(y), widthPct: pct(w), heightPct: pct(hh),
    });
  }

  return out;
}

/** True when at least one entry carries real geometry. */
function hasSpatialHotspots(list) {
  return normalizeHotspots(list).some((h) => h.spatial);
}

/**
 * Writer-side shape for the AI pipeline: keep spatial hits as objects, and
 * degrade a geometry-less hit back to a plain STRING so the stored JSONB is
 * never a half-filled object. Storage therefore stays readable by any older
 * consumer that expects strings.
 */
function toStoredHotspots(raw) {
  return normalizeHotspots(raw).map((h) => (h.spatial
    ? { label: h.label, x: h.x, y: h.y, w: h.w, h: h.h, weight: h.weight }
    : h.label));
}

module.exports = { normalizeHotspots, hasSpatialHotspots, toStoredHotspots };
