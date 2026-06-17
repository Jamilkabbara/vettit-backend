/* WO §3.1 — creative_attention run-path guards turn opaque Anthropic 400s into
 * clear, refundable errors. */
const { detectImageMime, assertImageWithinVisionLimits } = require('../src/services/ai/creativeAttention');

const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('creative_attention run-path guards', () => {
  test('detectImageMime reads magic bytes', () => {
    expect(detectImageMime(jpeg())).toBe('image/jpeg');
    expect(detectImageMime(png())).toBe('image/png');
  });

  test('detectImageMime throws on unsupported / tiny buffers', () => {
    expect(() => detectImageMime(Buffer.from([1, 2, 3]))).toThrow(/too small/);
    expect(() => detectImageMime(Buffer.alloc(20))).toThrow(/Unsupported image format/);
  });

  test('assertImageWithinVisionLimits passes a normal image', () => {
    expect(() => assertImageWithinVisionLimits(Buffer.alloc(1 * 1024 * 1024))).not.toThrow();
  });

  test('assertImageWithinVisionLimits throws a clear error above ~3.75MB', () => {
    expect(() => assertImageWithinVisionLimits(Buffer.alloc(5 * 1024 * 1024)))
      .toThrow(/too large/i);
  });
});
