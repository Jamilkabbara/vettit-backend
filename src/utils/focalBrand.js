/*
 * WO §2.3 — focal-brand resolution. A competitor study must never surface the
 * literal placeholder "Our Brand" in any user-facing output. New competitor
 * missions capture the focal brand at setup (and the create route now requires
 * it), so this is the safety net for legacy missions and edge cases: use the
 * captured brand; if genuinely absent, derive a real name from the brief;
 * otherwise fall back to a neutral label — never "Our Brand".
 */

// Generic / placeholder labels that must never be shown as a real focal brand.
const GENERIC = new Set([
  'our brand', 'your brand', 'the brand', 'brand', 'my brand',
  'our company', 'your company', 'the company', 'company', 'us', 'we',
]);

const NEUTRAL_FALLBACK = 'the brand';

function clean(s) { return String(s == null ? '' : s).trim(); }
function isGeneric(s) { return GENERIC.has(clean(s).toLowerCase()); }

/**
 * Best-effort extraction of a proper-noun brand from a free-text brief.
 * High-precision only (quoted names, "for X" / "brand: X"); returns null when
 * unsure rather than risk a wrong token.
 */
function fromBrief(brief) {
  const text = clean(brief);
  if (!text) return null;
  // 1. Quoted brand: "Acme" / 'Acme Co' / “Acme”
  const q = text.match(/["“'’]([A-Z][\w&.\- ]{1,40}?)["”'’]/);
  if (q && clean(q[1]) && !isGeneric(q[1])) return clean(q[1]);
  // 2. "for Acme" / "by Acme" / "brand: Acme" (1–3 capitalized tokens)
  const m = text.match(/\b(?:for|by|brand[:]?|called|named)\s+([A-Z][A-Za-z0-9&.\-]+(?:\s+[A-Z][A-Za-z0-9&.\-]+){0,2})/);
  if (m && clean(m[1]) && !isGeneric(m[1])) return clean(m[1]);
  return null;
}

/**
 * @param {string|null|undefined} brandName  the captured focal brand
 * @param {string|null|undefined} brief       mission brief / statement (fallback source)
 * @returns {string} a non-placeholder focal label (never "Our Brand")
 */
function deriveFocalBrand(brandName, brief) {
  const bn = clean(brandName);
  if (bn && !isGeneric(bn)) return bn;
  return fromBrief(brief) || NEUTRAL_FALLBACK;
}

module.exports = { deriveFocalBrand, isGeneric, NEUTRAL_FALLBACK };
