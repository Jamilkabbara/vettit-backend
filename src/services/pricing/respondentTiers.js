/*
 * WO §D3 + §D4 — respondent tiers + type-aware respondent model.
 *
 * THE single server-side source of truth for "how many respondents and what it
 * costs". The client proposes an n; the server prices it from THIS map and never
 * trusts a client-sent price (§D3). Prices are FINAL (owner-approved).
 *
 * §D4 — pricing is ALWAYS by TOTAL simulated respondents; the range + allocation
 * differ by mission STRUCTURE:
 *   - single-cell (most types): full ladder 50→1,000, Recommended 300, plus the
 *     $9 "quick pulse" (~25, directional) on-ramp.
 *   - control-cell / lift (brand_lift always; creative_attention when lift_mode):
 *     respondents split 50/50 exposed + control. RAISE THE FLOOR — disable
 *     $9/50/100; start 200 (100/cell, directional), Recommended 500 (250/cell),
 *     1,000 (500/cell, significance-grade). Priced by TOTAL (no separate ladder),
 *     so a lift 500 is the same $179 tier as a general 500. Significance gates
 *     read PER-CELL n (= total / 2).
 *
 * Above 1,000 → Enterprise / custom (contact form, no self-serve).
 */

// FINAL ladder (owner-approved). pulse is the $9 on-ramp; recommended flags the default.
const PULSE = { n: 25, price: 9, label: 'Quick pulse', pulse: true, directional: true };
const TIERS = [
  { n: 50, price: 29 },
  { n: 100, price: 49 },
  { n: 200, price: 89 },
  { n: 300, price: 119, recommended: true },
  { n: 500, price: 179 },
  { n: 1000, price: 299 },
];
const ENTERPRISE_MIN = 1001; // 2,000+ in copy; anything past the top tier is custom

// Control-cell (lift) structure: brand_lift always; creative_attention only in lift mode.
const CONTROL_CELL_FLOOR = 200; // total; 100/cell
const CONTROL_CELL_RECOMMENDED = 500;

function isControlCell(goalType, { liftMode = false } = {}) {
  if (goalType === 'brand_lift') return true;
  if (goalType === 'creative_attention' && liftMode) return true;
  return false;
}

/**
 * The selectable stops for a mission, given its structure.
 * @returns {{ stops: Array<{n,price,recommended?,pulse?,directional?}>, floor:number,
 *            recommended:number, controlCell:boolean, enterpriseMin:number }}
 */
function tiersFor(goalType, opts = {}) {
  const controlCell = isControlCell(goalType, opts);
  if (controlCell) {
    // §D4 — no pulse / 50 / 100; floor 200; recommended 500.
    const stops = TIERS.filter((t) => t.n >= CONTROL_CELL_FLOOR)
      .map((t) => ({ ...t, recommended: t.n === CONTROL_CELL_RECOMMENDED }));
    return { stops, floor: CONTROL_CELL_FLOOR, recommended: CONTROL_CELL_RECOMMENDED, controlCell: true, enterpriseMin: ENTERPRISE_MIN };
  }
  // single-cell — full ladder + pulse on-ramp, recommended 300.
  return { stops: [PULSE, ...TIERS], floor: PULSE.n, recommended: 300, controlCell: false, enterpriseMin: ENTERPRISE_MIN };
}

/** Snap an arbitrary n to the nearest valid stop for the mission structure (never below floor). */
function snapN(goalType, n, opts = {}) {
  const { stops, floor } = tiersFor(goalType, opts);
  const valid = stops.map((s) => s.n);
  const num = Number(n);
  if (!Number.isFinite(num) || num <= floor) return floor;
  // exact match wins; else nearest valid stop at or below, capped at the top tier.
  if (valid.includes(num)) return num;
  const atOrBelow = valid.filter((v) => v <= num);
  return atOrBelow.length ? Math.max(...atOrBelow) : floor;
}

/**
 * SERVER-SIDE price authority. Given a goal_type + requested n (+ structure
 * opts), returns the authoritative price (never trust a client price).
 * @returns {{ n:number, price:number|null, enterprise:boolean, controlCell:boolean,
 *            split:{exposed:number,control:number}|null }}
 */
function priceFor(goalType, n, opts = {}) {
  const controlCell = isControlCell(goalType, opts);
  const num = Number(n);
  if (Number.isFinite(num) && num >= ENTERPRISE_MIN) {
    return { n: num, price: null, enterprise: true, controlCell, split: controlCell ? splitFor(num) : null };
  }
  const snapped = snapN(goalType, num, opts);
  const { stops } = tiersFor(goalType, opts);
  const tier = stops.find((s) => s.n === snapped);
  return {
    n: snapped,
    price: tier ? tier.price : null,
    enterprise: false,
    controlCell,
    split: controlCell ? splitFor(snapped) : null,
  };
}

/** 50/50 exposed/control split of a total (exposed takes the odd one). */
function splitFor(total) {
  const t = Math.max(0, Math.floor(Number(total) || 0));
  const control = Math.floor(t / 2);
  return { exposed: t - control, control };
}

module.exports = {
  TIERS, PULSE, ENTERPRISE_MIN, CONTROL_CELL_FLOOR, CONTROL_CELL_RECOMMENDED,
  isControlCell, tiersFor, snapN, priceFor, splitFor,
};
