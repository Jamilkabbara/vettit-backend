/**
 * The targeting a mission actually runs with.
 *
 * WHY
 * ---
 * The setup page never writes `missions.targeting`. It stores the AI's
 * suggestion in `target_audience.aiTargeting`, and the dashboard DISPLAYS
 * that suggestion as the mission's targeting (with an "AI Suggested" badge),
 * falling back to a country preset from the clarify market answer. The
 * dashboard also tries to save what it displays, fire-and-forget, only if the
 * customer opens it, and ignoring errors.
 *
 * Persona generation read `mission.targeting` alone. When it was empty the
 * prompt said "Countries: Global", "Age ranges: 18-65", so a customer could
 * see UAE on their dashboard while their respondents were generated anywhere.
 * On 2026-09-18, 74 of 100 missions had no saved targeting; 13 paid missions
 * ran with countries only in the AI suggestion, and several came back from
 * the wrong country (a UAE compare study: 239 of 240 respondents in the US; a
 * Saudi brand-lift study: Canada; a Lebanon/UAE/Saudi study: Syria).
 *
 * RULE (mirrors DashboardPage.tsx, in the same order)
 * ----
 *   1. saved targeting with countries          -> used as saved
 *   2. target_audience.aiTargeting with countries -> built the way the dashboard
 *                                                    builds its panel from it
 *   3. clarify market answer with a preset      -> saved targeting + preset countries
 *   4. none of the above                        -> saved targeting as is (may be empty)
 *
 * Pricing does not use this: it keeps extractCountriesFromMission, so no price
 * moves with this change.
 */
'use strict';

// Must match MARKET_COUNTRY_PRESETS in vett-platform src/pages/DashboardPage.tsx.
const MARKET_COUNTRY_PRESETS = Object.freeze({
  uae_gulf: ['AE', 'SA', 'KW', 'QA', 'BH', 'OM'],
  mena: ['EG', 'JO', 'LB', 'AE', 'SA', 'MA'],
  north_america: ['US', 'CA'],
  europe: ['GB', 'DE', 'FR', 'IT', 'ES'],
  us_europe: ['US', 'CA', 'GB', 'DE', 'FR', 'IT', 'ES'],
  global: [],
  other: [],
});

const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

function savedCountries(t) {
  if (!t || typeof t !== 'object') return [];
  const nested = strArr(t.geography && t.geography.countries);
  return nested.length ? nested : strArr(t.countries);
}

/** Targeting built from the AI suggestion, the way the dashboard builds it. */
function fromAiSuggestion(ai) {
  return {
    geography: { countries: strArr(ai.countries), cities: strArr(ai.cities), cityEnabled: false },
    demographics: {
      ageRanges: strArr(ai.ageRanges),
      genders: strArr(ai.genders),
      education: strArr(ai.education),
      marital: strArr(ai.marital),
      parental: strArr(ai.parental),
      employment: strArr(ai.employment),
    },
    professional: {
      industries: strArr(ai.industries),
      roles: strArr(ai.roles),
      companySizes: strArr(ai.companySizes),
    },
    financials: { incomeRanges: strArr(ai.incomeRanges) },
    behaviors: strArr(ai.behaviors),
    technographics: { devices: strArr(ai.devices) },
  };
}

/**
 * @param {object} mission  a missions row
 * @returns {{ targeting: object, source: 'saved'|'ai_suggested'|'market_preset'|'none', countries: string[] }}
 */
function resolveEffectiveTargeting(mission) {
  const saved = (mission && mission.targeting && typeof mission.targeting === 'object') ? mission.targeting : {};
  const fromSaved = savedCountries(saved);
  if (fromSaved.length) return { targeting: saved, source: 'saved', countries: fromSaved };

  const ta = (mission && mission.target_audience && typeof mission.target_audience === 'object') ? mission.target_audience : {};
  const ai = ta.aiTargeting && typeof ta.aiTargeting === 'object' ? ta.aiTargeting : null;
  if (ai && strArr(ai.countries).length) {
    const t = fromAiSuggestion(ai);
    return { targeting: t, source: 'ai_suggested', countries: t.geography.countries };
  }

  const preset = typeof ta.market === 'string' ? (MARKET_COUNTRY_PRESETS[ta.market] || []) : [];
  if (preset.length) {
    const geography = { ...(saved.geography || {}), countries: [...preset] };
    return { targeting: { ...saved, geography }, source: 'market_preset', countries: [...preset] };
  }

  return { targeting: saved, source: 'none', countries: [] };
}

module.exports = { resolveEffectiveTargeting, MARKET_COUNTRY_PRESETS };
