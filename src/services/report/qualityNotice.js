/**
 * A study produced before the quality fixes of 20 September says so, in the
 * same words everywhere it appears.
 *
 * Four defects were live at various points before that date. Each flag on a
 * mission was decided from that study's OWN stored data, never from its date
 * (scripts/flag-pre-fix-studies.js), so a flag is a statement about that
 * study, not a blanket disclaimer.
 *
 * A flagged study is still delivered, still readable and never rewritten: the
 * customer paid for it and it is the record of what they received. What
 * changes is that it says what is wrong with it, and that it is kept out of
 * anything public, any case study and any benchmark.
 */
'use strict';

const QUALITY_NOTICE = 'Produced before quality fixes of 20 September; figures not reliable.';

/** What each flag means, in the customer's words. */
const FLAG_REASONS = {
  wrong_country: 'some respondents were outside the markets this study targeted',
  duplicate_people: 'the panel repeated the same respondents',
  undeclinable_q: 'a multi-select question offered no way to answer "none of these"',
  misfiled_answers: 'some answers were recorded against the wrong question',
};

const flagsOf = (mission) => (Array.isArray(mission && mission.quality_flags) ? mission.quality_flags : []);

const isFlagged = (mission) => flagsOf(mission).length > 0;

/**
 * The block a report, an export or an admin row shows. Null when the study is
 * clean, so a caller can spread it without thinking about the empty case.
 */
function qualityNotice(mission) {
  const flags = flagsOf(mission);
  if (!flags.length) return null;
  return {
    notice: QUALITY_NOTICE,
    flags,
    reasons: flags.map((f) => FLAG_REASONS[f]).filter(Boolean),
    flagged_at: (mission && mission.quality_flagged_at) || null,
    excluded_from_public: true,
  };
}

module.exports = { QUALITY_NOTICE, FLAG_REASONS, flagsOf, isFlagged, qualityNotice };
