/**
 * D7 — canonical "no dashes" sanitizer for user-facing text.
 *
 * Strips the em/en-dash "AI tell" from EVERY rendered string regardless of
 * source (LLM narration, deterministic code, or analysis data). The product
 * rule is blanket: no em-dashes or en-dashes anywhere in user-facing generated
 * text (web report, exports, chatbot).
 *   em-dash  (—, U+2014) → ", "  (comma + space; surrounding spaces collapsed)
 *   en-dash  (–, U+2013) → "-"   (hyphen; price/number ranges read "SAR 31-40")
 * Plus cleanup of the artifacts that produces. Idempotent + null-safe.
 *
 * The LLM does not reliably obey a prompt instruction to avoid dashes, so this
 * post-process scrub is the guarantee (the prompt rule in WRITING_STYLE just
 * reduces how much it has to fix).
 */
function sanitizeDashesString(s) {
  if (typeof s !== 'string') return s;
  if (s.indexOf('—') === -1 && s.indexOf('–') === -1) return s; // fast path: nothing to do
  return s
    .replace(/\s*—\s*/g, ', ') // em-dash (with any surrounding spaces) → ", "
    .replace(/–/g, '-')         // en-dash → hyphen
    .replace(/\s+([,.;:!?])/g, '$1') // drop a stray space before punctuation
    .replace(/\.\s*,\s*/g, '. ')     // ". , " artifact → ". "
    .replace(/,\s*,/g, ',')          // ",," / ", ," → ","
    .replace(/[ \t]{2,}/g, ' ')
    // An em-dash at the very start/end (or a string that WAS just a dash) leaves
    // an orphan comma after substitution ("the result —" → "the result,"). Drop
    // those edge commas so a trailing dash doesn't read as a trailing comma and a
    // lone "—" placeholder collapses to "" instead of ",".
    .replace(/^\s*,\s*|\s*,\s*$/g, '')
    .trim();
}

/** Recursively sanitize every string leaf in a value; returns a fresh copy. */
function sanitizeDashesDeep(value) {
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeDashesString(value);
  if (Array.isArray(value)) return value.map(sanitizeDashesDeep);
  if (typeof value === 'object') {
    const out = {};
    // Scrub KEYS too — distribution maps are keyed by option labels
    // ({ "SAR 31–40": 24 }), so a dash in a key would otherwise survive.
    for (const [k, v] of Object.entries(value)) out[sanitizeDashesString(k)] = sanitizeDashesDeep(v);
    return out;
  }
  return value;
}

module.exports = { sanitizeDashesString, sanitizeDashesDeep };
