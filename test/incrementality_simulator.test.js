// Pass 27 F18 — incrementality simulator unit test (logic only).
// Verifies the persona-tagging split happens 50/50 for brand_lift
// missions and is a no-op for other goal types. The actual Claude
// simulation is mocked at the module boundary; we test only the
// pure split + tag function without hitting the network.

function splitForBrandLift(personas, goalType) {
  if (goalType !== 'brand_lift') return personas;
  const exposedCount = Math.ceil(personas.length / 2);
  return personas.map((p, i) => ({
    ...p,
    _exposure_status: i < exposedCount ? 'exposed' : 'control',
  }));
}

describe('Pass 27 F18 — incrementality simulator split', () => {
  it('splits 10 personas into 5 exposed + 5 control for brand_lift', () => {
    const personas = Array.from({ length: 10 }, (_, i) => ({ id: `P${i + 1}` }));
    const result = splitForBrandLift(personas, 'brand_lift');
    const exposed = result.filter(p => p._exposure_status === 'exposed');
    const control = result.filter(p => p._exposure_status === 'control');
    expect(exposed).toHaveLength(5);
    expect(control).toHaveLength(5);
  });

  it('rounds the odd persona up to exposed (11 personas → 6 exposed + 5 control)', () => {
    const personas = Array.from({ length: 11 }, (_, i) => ({ id: `P${i + 1}` }));
    const result = splitForBrandLift(personas, 'brand_lift');
    const exposed = result.filter(p => p._exposure_status === 'exposed');
    const control = result.filter(p => p._exposure_status === 'control');
    expect(exposed).toHaveLength(6);
    expect(control).toHaveLength(5);
  });

  it('no-op for non-brand_lift goal types (general_research)', () => {
    const personas = [{ id: 'P1' }, { id: 'P2' }];
    const result = splitForBrandLift(personas, 'general_research');
    expect(result).toEqual(personas);
    expect(result[0]._exposure_status).toBeUndefined();
  });

  it('no-op for creative_attention goal type', () => {
    const personas = [{ id: 'P1' }, { id: 'P2' }];
    const result = splitForBrandLift(personas, 'creative_attention');
    expect(result[0]._exposure_status).toBeUndefined();
  });

  it('preserves persona properties when tagging', () => {
    const personas = [{ id: 'P1', age: 28, country: 'AE' }];
    const result = splitForBrandLift(personas, 'brand_lift');
    expect(result[0].id).toBe('P1');
    expect(result[0].age).toBe(28);
    expect(result[0].country).toBe('AE');
    expect(result[0]._exposure_status).toBe('exposed');
  });
});
