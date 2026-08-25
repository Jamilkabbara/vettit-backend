/**
 * §A0 — AUTHORITATIVE server-side gate for not-yet-live research types.
 *
 * This is the SINGLE SOURCE OF TRUTH for which goal_types are built but not
 * yet purchasable/runnable. The mission-create route and the Stripe-checkout
 * route both reject these BEFORE any DB insert or payment session is opened,
 * so a stale frontend bundle, a pre-hydration deep-link, or a direct API/
 * checkout call can never create or CHARGE a deferred type — only a clean
 * `not_available`.
 *
 * The frontend mirrors this list in src/data/missionGoals.ts (`comingSoon:
 * true`) for UX; that mirror is kept honest by a sync test on each side, but
 * THIS list is the one that actually blocks money. If the two ever drift, the
 * backend wins and no bad charge can occur.
 *
 * To un-gate a type (after it passes live e2e — never on fixture data):
 * remove it here AND flip the frontend `comingSoon` flag. One edit per side,
 * each guarded by its sync test.
 */
const COMING_SOON_GOAL_TYPES = Object.freeze([
]);

/** True when a goal_type is gated (not yet live). Tolerant of null/whitespace. */
function isComingSoon(goalType) {
  return COMING_SOON_GOAL_TYPES.includes(String(goalType == null ? '' : goalType).trim());
}

/** Standard 403 body for a gated type — clean, no charge, machine-readable. */
function notAvailableError(goalType) {
  return {
    error: 'not_available',
    message: `This research type is not available yet. Pick another methodology for now.`,
    goal_type: String(goalType == null ? '' : goalType).trim() || null,
  };
}

module.exports = { COMING_SOON_GOAL_TYPES, isComingSoon, notAvailableError };
