/**
 * Creative Attention is priced per CREATIVE, not per respondent.
 *
 * The retired ladder charged 10/$19, 25/$39, 50/$69, 100/$129, 250+/$299. It
 * was wrong in a way no reprice could fix, because it priced by a quantity the
 * product does not have: the analysis never reads respondent_count (zero
 * references in services/ai/creativeAttention.js) and the results page never
 * mentions respondents. A customer paying $299 for "250 respondents" received
 * byte-identical work to one paying $19 for "10".
 *
 * Measured cost, which drives per creative and is BOUNDED:
 *
 *   image   3 vision calls          $0.028 - $0.063   six completed missions
 *   video   30 frames + synthesis    $0.476            mission cff8a2ec
 *
 * Video costs 7.5x an image because the extractor samples one frame per second
 * and stops at 30 - so a 35-second and a ten-minute video cost the same, and
 * there is no long-video tail to price against.
 */
const {
  calculateMissionPrice,
  validateMissionPricing,
  CREATIVE_ATTENTION_TIERS,
  CA_MIN_RESPONDENTS,
} = require('../src/utils/pricingEngine');

const price = (mediaType, respondentCount = 10) => calculateMissionPrice({
  goalType: 'creative_attention', mediaType, respondentCount,
  questionCount: 0, targeting: {}, countries: [],
}).total;

describe('the price is the media type', () => {
  test('an image creative is $19', () => expect(price('image')).toBe(19));
  test('a video creative is $49', () => expect(price('video')).toBe(49));

  test.each(['bundle', 'series'])('%s analyses as stills, so it is charged as an image', (mt) => {
    expect(price(mt)).toBe(19);
  });

  test('media type is case-insensitive', () => {
    expect(price('VIDEO')).toBe(49);
    expect(price('Image')).toBe(19);
  });
});

describe('the respondent count no longer moves the price', () => {
  test.each([10, 25, 50, 100, 250, 1000, 1250])('image at n=%i is still $19', (n) => {
    expect(price('image', n)).toBe(19);
  });

  test.each([10, 250, 1250])('video at n=%i is still $49', (n) => {
    expect(price('video', n)).toBe(49);
  });

  test('the retired tier prices are gone', () => {
    // $39, $69, $129 and $299 were the old respondent brackets. No count
    // should produce any of them any more.
    const retired = new Set([39, 69, 129, 299]);
    for (const n of [10, 25, 50, 100, 250, 500, 1000]) {
      for (const mt of ['image', 'video']) {
        expect(retired.has(price(mt, n))).toBe(false);
      }
    }
  });
});

describe('the ladder shape', () => {
  test('two tiers, keyed by media type, with no per-respondent rate', () => {
    expect(CREATIVE_ATTENTION_TIERS.map((t) => t.id)).toEqual(['image', 'video']);
    for (const t of CREATIVE_ATTENTION_TIERS) {
      expect(t.ratePerResp).toBeNull();
      expect(t.anchorCount).toBe(CA_MIN_RESPONDENTS);
    }
  });

  test('the tier resolved is the media type, not a bracket', () => {
    expect(calculateMissionPrice({ goalType: 'creative_attention', mediaType: 'video', respondentCount: 1000, questionCount: 0 }).volumeTier.id).toBe('video');
    expect(calculateMissionPrice({ goalType: 'creative_attention', mediaType: 'image', respondentCount: 1000, questionCount: 0 }).volumeTier.id).toBe('image');
  });
});

describe('the database CHECK floor still holds', () => {
  // respondent_count is no longer a customer input, but a NOT VALID CHECK
  // constraint on missions requires >= 10 for this goal type, and Postgres
  // re-checks a NOT VALID constraint on ANY update to the row - including one
  // touching unrelated columns. A row written below the floor becomes
  // unwritable, so the engine must keep refusing it.
  test.each([0, 1, 5, CA_MIN_RESPONDENTS - 1])('n=%i is refused, not priced', (n) => {
    expect(() => price('image', n)).toThrow(/at least 10 respondents/);
    expect(validateMissionPricing({ goalType: 'creative_attention', respondentCount: n, mediaType: 'image' }).valid).toBe(false);
  });

  test(`n=${CA_MIN_RESPONDENTS} is accepted`, () => {
    expect(validateMissionPricing({ goalType: 'creative_attention', respondentCount: CA_MIN_RESPONDENTS, mediaType: 'image' }).valid).toBe(true);
  });

  test('a missing media type is still refused', () => {
    expect(validateMissionPricing({ goalType: 'creative_attention', respondentCount: 10 }).valid).toBe(false);
  });
});

describe('margin, stated rather than assumed', () => {
  test('both prices clear the 70% floor against measured worst-case cost', () => {
    // Worst observed: $0.063 an image, $0.476 a video.
    expect((19 - 0.063) / 19).toBeGreaterThan(0.7);
    expect((49 - 0.476) / 49).toBeGreaterThan(0.7);
  });
});
