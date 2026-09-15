'use strict';
// Market notes are never cut mid-sentence. The old 280-character cut ended 3
// of 18 real notes with an ellipsis part-way through a clause.
const { sanitizeMarketContext } = require('../src/services/creativeAttention/marketContext');

const real = 'UAE TikTok audiences frequently engage with aspirational and luxury-adjacent content, which means the premium CGI aesthetic is well-placed, but the payoff moment where the brand reveals itself must land clearly or the creative simply feeds the format\'s entertainment culture without a return.';

describe('market note length', () => {
  test('a real 290-character note survives whole, with no ellipsis', () => {
    expect(real.length).toBeGreaterThan(280);
    const out = sanitizeMarketContext({ cultural_fit: [real], localisation_risks: [], placement_notes: [] });
    expect(out.cultural_fit).toEqual([real]);
    expect(JSON.stringify(out)).not.toContain('…');
  });

  test('a runaway item is trimmed back to its last complete sentence', () => {
    const long = 'First sentence is fine. ' + 'word '.repeat(200) + 'end.';
    const out = sanitizeMarketContext({ cultural_fit: [long], localisation_risks: [], placement_notes: [] });
    expect(out.cultural_fit).toEqual(['First sentence is fine.']);
  });

  test('a runaway item with no sentence end is dropped, not cut', () => {
    const out = sanitizeMarketContext({ cultural_fit: ['word '.repeat(200), 'Short and whole.'], localisation_risks: [], placement_notes: [] });
    expect(out.cultural_fit).toEqual(['Short and whole.']);
  });
});
