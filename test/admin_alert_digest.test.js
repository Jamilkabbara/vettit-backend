/**
 * Daily digest of unresolved admin alerts.
 *
 * alertAdmin() has always written to public.admin_alerts and stopped there.
 * When this shipped the table held 26 unresolved rows, the oldest four
 * months old, including a mission_stuck_processing from six days earlier.
 * The alerts were correct; nobody was reading them.
 *
 * The behaviour that matters most is the NEGATIVE one: no email when there
 * is nothing to report. A daily "nothing happened" trains you to ignore the
 * channel, which defeats the point of having one.
 */
process.env.NODE_ENV = 'test';

const mockSend = jest.fn(async () => ({ id: 'em_1' }));
jest.mock('resend', () => ({ Resend: class { constructor() { this.emails = { send: mockSend }; } } }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { sendAdminAlertDigest } = require('../src/services/email');

const alert = (over = {}) => ({
  id: 'a1', alert_type: 'mission_terminal_write_lost',
  mission_id: '91be5c7b-bbdd-40d0-8129-6435f1102c8c',
  payload: { action_required: 'Check the mission status and re-run or force-complete.' },
  created_at: new Date().toISOString(), ...over,
});

beforeEach(() => mockSend.mockClear());

describe('the digest is suppressed when there is nothing to say', () => {
  test('an empty array sends nothing', async () => {
    const r = await sendAdminAlertDigest({ to: 'x@y.z', alerts: [] });
    expect(r).toEqual({ sent: false, reason: 'empty' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a null/undefined list sends nothing rather than throwing', async () => {
    expect(await sendAdminAlertDigest({ to: 'x@y.z', alerts: null })).toEqual({ sent: false, reason: 'empty' });
    expect(await sendAdminAlertDigest({ to: 'x@y.z' })).toEqual({ sent: false, reason: 'empty' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('the digest sends when there is something in it', () => {
  test('one alert sends one email with a singular subject', async () => {
    const r = await sendAdminAlertDigest({ to: 'me@vettit.ai', alerts: [alert()] });
    expect(r).toEqual({ sent: true, count: 1 });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].subject).toBe('VETT admin: 1 unresolved alert');
  });

  test('several alerts pluralise and group by type', async () => {
    const alerts = [alert({ id: '1' }), alert({ id: '2' }), alert({ id: '3', alert_type: 'mission_stuck_processing' })];
    const r = await sendAdminAlertDigest({ to: 'me@vettit.ai', alerts });
    expect(r).toEqual({ sent: true, count: 3 });
    const html = mockSend.mock.calls[0][0].html;
    expect(mockSend.mock.calls[0][0].subject).toBe('VETT admin: 3 unresolved alerts');
    expect(html).toContain('mission_terminal_write_lost (2)');
    expect(html).toContain('mission_stuck_processing (1)');
  });

  test('it sends from hello@vettit.ai to the configured address', async () => {
    await sendAdminAlertDigest({ to: 'me@vettit.ai', alerts: [alert()] });
    expect(mockSend.mock.calls[0][0].from).toContain('vettit.ai');
    expect(mockSend.mock.calls[0][0].to).toBe('me@vettit.ai');
  });

  test('the action_required line is surfaced, not just the id', async () => {
    await sendAdminAlertDigest({ to: 'x@y.z', alerts: [alert()] });
    expect(mockSend.mock.calls[0][0].html).toContain('re-run or force-complete');
  });

  test('an alert with no mission_id does not render a broken link', async () => {
    await sendAdminAlertDigest({ to: 'x@y.z', alerts: [alert({ mission_id: null })] });
    const html = mockSend.mock.calls[0][0].html;
    expect(html).toContain('no mission');
    expect(html).not.toContain('/results/null');
  });

  test('long lists are truncated with a count rather than sending 200 rows', async () => {
    const many = Array.from({ length: 25 }, (_, i) => alert({ id: `a${i}` }));
    await sendAdminAlertDigest({ to: 'x@y.z', alerts: many });
    const html = mockSend.mock.calls[0][0].html;
    // Count the ACTUAL rendered items, not just the summary line. A first
    // version of this test asserted only the "and N more" text, which is
    // derived from rows.length and therefore survives removing the
    // truncation entirely. It passed on both sides of the mutation.
    expect((html.match(/<li /g) || []).length).toBe(10);
    expect(html).toContain('and 15 more');
  });

  test('payload text is HTML-escaped', async () => {
    await sendAdminAlertDigest({
      to: 'x@y.z',
      alerts: [alert({ payload: { action_required: '<script>alert(1)</script>' } })],
    });
    const html = mockSend.mock.calls[0][0].html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
