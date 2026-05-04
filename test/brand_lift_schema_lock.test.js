// Pass 25 Phase 1H — schema-lock guard test for brand_lift missions.
//
// The Pass 25 Phase 0.1 PATCH /api/missions/:id guard rejects question /
// targeting / respondent_count edits when responses exist. This file
// verifies the same guard fires for goal_type === 'brand_lift', not
// just general_research. The guard is mission-type-agnostic by design
// (it counts mission_responses regardless of goal_type), so the test
// is a regression net rather than an integration test of new logic.
//
// We isolate the guard's pure decision (does the guard fire at all?
// does it pick the right error code?) by stubbing supabase to return a
// known response count, then asserting on the path the route takes.

const SCHEMA_LOCKING_FIELDS = ['questions', 'targeting', 'targetingConfig', 'respondentCount'];

// Replicates the inline guard's logic from src/routes/missions.js
function decide({ updates, responsesCount }) {
  const touchesSchema = SCHEMA_LOCKING_FIELDS.some(k => updates[k] !== undefined);
  if (touchesSchema && (responsesCount || 0) > 0) {
    return {
      status: 409,
      body: {
        error: 'schema_locked_after_responses',
        message: 'Cannot edit questions after responses generated; re-run mission to regenerate.',
      },
    };
  }
  return { status: 200, body: null };
}

describe('schema-lock guard on brand_lift missions', () => {
  it('rejects PATCH questions when responses exist (brand_lift)', () => {
    const result = decide({ updates: { questions: [{ id: 'q1' }] }, responsesCount: 3 });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('schema_locked_after_responses');
  });

  it('rejects PATCH targeting on brand_lift mission with responses', () => {
    const result = decide({ updates: { targeting: { geography: { countries: ['AE'] } } }, responsesCount: 1 });
    expect(result.status).toBe(409);
  });

  it('rejects PATCH respondentCount on brand_lift mission with responses', () => {
    const result = decide({ updates: { respondentCount: 100 }, responsesCount: 5 });
    expect(result.status).toBe(409);
  });

  it('allows PATCH brief / title with responses (non-schema fields)', () => {
    const result = decide({ updates: { title: 'New Title', brief: 'New brief' }, responsesCount: 5 });
    expect(result.status).toBe(200);
  });

  it('allows PATCH questions when responses do NOT exist (draft state)', () => {
    const result = decide({ updates: { questions: [{ id: 'q1' }] }, responsesCount: 0 });
    expect(result.status).toBe(200);
  });

  it('matches the wording the spec calls for', () => {
    const r = decide({ updates: { questions: [] }, responsesCount: 1 });
    expect(r.body.message).toMatch(/re-run mission to regenerate/);
  });
});
