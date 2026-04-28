/**
 * VETT — Transactional email templates via Resend.
 * All templates share the dark-theme layout: bg #0B0C15, lime #BEF264.
 *
 * Sender: FROM_NAME <FROM_EMAIL>  (e.g. "VETT <hello@vettit.ai>")
 * Domain must be verified in Resend before these will deliver.
 */

const { Resend } = require('resend');
const logger = require('../utils/logger');

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = `${process.env.FROM_NAME || 'VETT'} <${process.env.FROM_EMAIL || 'hello@vettit.ai'}>`;
const APP_URL = process.env.FRONTEND_URL || 'https://www.vettit.ai';

// ─── Shared layout ────────────────────────────────────────
function shell({ preheader = '', body }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VETT</title></head>
<body style="margin:0;padding:0;background:#05060b;font-family:Inter,Manrope,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<span style="display:none;opacity:0;visibility:hidden;height:0;max-height:0;overflow:hidden;">${preheader}</span>
<div style="max-width:600px;margin:0 auto;background:#0B0C15;border-radius:16px;overflow:hidden;border:1px solid #1f2937;">
  <div style="background:linear-gradient(90deg,#BEF264 0%,#84cc16 100%);height:6px;"></div>
  <div style="padding:40px;color:#e5e7eb;">
    <div style="font-size:28px;font-weight:800;color:#BEF264;letter-spacing:.08em;">VETT</div>
    <div style="font-size:11px;color:#9ca3af;letter-spacing:.12em;margin-top:2px;">AI-POWERED MARKET RESEARCH</div>
    <div style="height:28px;"></div>
    ${body}
    <div style="height:40px;"></div>
    <div style="border-top:1px solid #1f2937;padding-top:20px;font-size:11px;color:#6b7280;line-height:1.7;">
      VETT · vettit.ai · Dubai, UAE<br>
      You're receiving this because you have an account on VETT.
    </div>
  </div>
</div>
</body></html>`;
}

const btn = (label, href, color = '#BEF264') =>
  `<a href="${href}" style="display:inline-block;background:${color};color:#0B0C15;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;">${label}</a>`;

const card = (inner) =>
  `<div style="background:#111827;border:1px solid #1f2937;border-radius:12px;padding:22px;margin:16px 0;">${inner}</div>`;

// ─── Welcome ──────────────────────────────────────────────
async function sendWelcomeEmail({ to, name }) {
  try {
    return await resend.emails.send({
      from: FROM,
      to,
      subject: 'Welcome to VETT — your AI research team is ready',
      html: shell({
        preheader: 'Describe your research in one sentence and get real insights back.',
        body: `
          <h1 style="color:#fff;font-size:24px;margin:0 0 12px;">Welcome${name ? ', ' + name : ''}.</h1>
          <p style="color:#9ca3af;line-height:1.7;">Your AI research team is assembled. Describe what you want to know — we'll design the survey, simulate the audience, and deliver an executive-ready report.</p>
          ${card(`
            <div style="color:#BEF264;font-weight:700;margin-bottom:8px;">What you can do</div>
            <ul style="color:#9ca3af;line-height:1.9;padding-left:18px;margin:0;">
              <li>Describe your research in one sentence</li>
              <li>AI builds a researcher-quality survey</li>
              <li>Targeted synthetic respondents answer in minutes</li>
              <li>Get charts, insights, and a downloadable report</li>
            </ul>
          `)}
          <div style="margin-top:24px;">${btn('Launch your first mission →', APP_URL + '/setup')}</div>
        `,
      }),
    });
  } catch (err) { logger.warn('sendWelcomeEmail failed', { err: err.message }); }
}

// ─── Mission launched ─────────────────────────────────────
async function sendMissionLaunchedEmail({ to, name, missionStatement, respondentCount, estimatedTime = '15 minutes', missionId }) {
  try {
    return await resend.emails.send({
      from: FROM,
      to,
      subject: `Your mission is live — results in ~${estimatedTime}`,
      html: shell({
        preheader: `${respondentCount} respondents are being simulated now.`,
        body: `
          <h1 style="color:#fff;font-size:22px;margin:0 0 12px;">Mission launched ⚡</h1>
          <p style="color:#9ca3af;">Hi ${name || 'there'},</p>
          <p style="color:#9ca3af;line-height:1.7;">Your research is running right now.</p>
          ${card(`
            <div style="color:#6b7280;font-size:11px;letter-spacing:.1em;">MISSION</div>
            <div style="color:#fff;font-size:15px;margin:6px 0 16px;">${missionStatement || ''}</div>
            <div style="display:flex;gap:24px;">
              <div><div style="color:#6b7280;font-size:10px;">RESPONDENTS</div><div style="color:#fff;font-size:20px;font-weight:700;">${respondentCount}</div></div>
              <div><div style="color:#6b7280;font-size:10px;">ETA</div><div style="color:#BEF264;font-size:20px;font-weight:700;">${estimatedTime}</div></div>
            </div>
          `)}
          <p style="color:#9ca3af;">We'll email you the moment your results are ready.</p>
          <div style="margin-top:8px;">${btn('Track progress →', `${APP_URL}/mission/${missionId}`)}</div>
        `,
      }),
    });
  } catch (err) { logger.warn('sendMissionLaunchedEmail failed', { err: err.message }); }
}

// ─── Mission completed ────────────────────────────────────
async function sendMissionCompletedEmail({ to, name, missionStatement, totalResponses, missionId, headline = '' }) {
  try {
    return await resend.emails.send({
      from: FROM,
      to,
      subject: `Your results are ready`,
      html: shell({
        preheader: headline || `${totalResponses} responses — AI report inside.`,
        body: `
          <h1 style="color:#fff;font-size:22px;margin:0 0 12px;">Your results are ready 🎯</h1>
          <p style="color:#9ca3af;">Hi ${name || 'there'},</p>
          <p style="color:#9ca3af;line-height:1.7;">Your mission is complete. <strong style="color:#fff;">${totalResponses} respondents</strong> have shared their view.</p>
          ${card(`
            <div style="color:#6b7280;font-size:11px;letter-spacing:.1em;">MISSION</div>
            <div style="color:#fff;font-size:15px;margin:4px 0 0;">${missionStatement || ''}</div>
            ${headline ? `<div style="color:#BEF264;font-size:13px;margin-top:14px;line-height:1.6;">${headline}</div>` : ''}
          `)}
          <p style="color:#9ca3af;">Your report includes:</p>
          <ul style="color:#9ca3af;line-height:1.9;padding-left:18px;margin:8px 0 0;">
            <li>Executive summary & headline KPIs</li>
            <li>AI insight for every question</li>
            <li>Concrete recommendations</li>
            <li>PDF, PowerPoint, and Excel downloads</li>
            <li>Chat with your results (30 messages free)</li>
          </ul>
          <div style="margin-top:24px;">${btn('View my results →', `${APP_URL}/results?missionId=${missionId}`)}</div>
        `,
      }),
    });
  } catch (err) { logger.warn('sendMissionCompletedEmail failed', { err: err.message }); }
}

// ─── Invoice ──────────────────────────────────────────────
async function sendInvoiceEmail({ to, name, invoiceData }) {
  const d = invoiceData || {};
  const row = (label, value) =>
    `<tr><td style="padding:8px 0;color:#9ca3af;">${label}</td><td style="padding:8px 0;text-align:right;color:#e5e7eb;">${value}</td></tr>`;
  try {
    return await resend.emails.send({
      from: FROM,
      to,
      subject: `VETT invoice — mission ${String(d.missionId || '').slice(0, 8)}`,
      html: shell({
        preheader: `Invoice for $${d.total || 0} USD.`,
        body: `
          <h1 style="color:#fff;font-size:22px;margin:0 0 12px;">Invoice</h1>
          <p style="color:#9ca3af;">Hi ${name || 'there'}, thank you for your purchase.</p>
          ${card(`
            <div style="color:#6b7280;font-size:11px;letter-spacing:.1em;">MISSION</div>
            <div style="color:#fff;margin:4px 0 16px;">${d.missionStatement || ''}</div>
            <table style="width:100%;font-size:13px;border-collapse:collapse;">
              ${row(`Base cost (${d.respondentCount || '—'} respondents)`, `$${(d.baseCost ?? 0).toFixed ? d.baseCost.toFixed(2) : d.baseCost}`)}
              ${d.targetingSurcharge > 0 ? row('Targeting', `$${d.targetingSurcharge}`) : ''}
              ${d.extraQuestionsCost > 0 ? row('Extra questions', `$${d.extraQuestionsCost}`) : ''}
              ${d.discount > 0 ? row(`Promo (${d.promoCode || 'applied'})`, `-$${d.discount}`) : ''}
              <tr><td style="padding:14px 0 0;color:#fff;font-weight:700;border-top:1px solid #1f2937;">Total</td>
                  <td style="padding:14px 0 0;text-align:right;color:#BEF264;font-weight:700;border-top:1px solid #1f2937;">$${d.total || 0} USD</td></tr>
            </table>
          `)}
          <p style="color:#6b7280;font-size:12px;">Paid via Stripe · ${new Date().toLocaleDateString()}</p>
        `,
      }),
    });
  } catch (err) { logger.warn('sendInvoiceEmail failed', { err: err.message }); }
}

// ─── Payment failed ───────────────────────────────────────
async function sendPaymentFailedEmail({ to, name, missionStatement, missionId, reason = '' }) {
  try {
    return await resend.emails.send({
      from: FROM,
      to,
      subject: 'Payment failed — your mission is on hold',
      html: shell({
        preheader: 'Your mission did not launch because the payment could not be processed.',
        body: `
          <h1 style="color:#fff;font-size:22px;margin:0 0 12px;">Payment didn't go through</h1>
          <p style="color:#9ca3af;">Hi ${name || 'there'},</p>
          <p style="color:#9ca3af;line-height:1.7;">We were unable to process the payment for your mission. No charge has been made.</p>
          ${card(`
            <div style="color:#6b7280;font-size:11px;letter-spacing:.1em;">MISSION</div>
            <div style="color:#fff;font-size:14px;margin:4px 0 0;">${missionStatement || ''}</div>
            ${reason ? `<div style="color:#f87171;font-size:12px;margin-top:10px;">Reason: ${reason}</div>` : ''}
          `)}
          <p style="color:#9ca3af;">Common reasons: insufficient funds, 3-D Secure challenge timed out, bank declined an international transaction.</p>
          <div style="margin-top:20px;">${btn('Retry payment →', `${APP_URL}/mission/${missionId}/checkout`)}</div>
          <p style="color:#6b7280;font-size:12px;margin-top:18px;">Still stuck? Reply to this email and we'll help.</p>
        `,
      }),
    });
  } catch (err) { logger.warn('sendPaymentFailedEmail failed', { err: err.message }); }
}

// ─── Retargeting refund notification ─────────────────────
async function sendRetargetingRefundEmail({ to, name, refundAmountUsd, missionCount = 1 }) {
  try {
    return await resend.emails.send({
      from: FROM,
      to,
      subject: 'Partial refund issued — VETT retargeting feature',
      html: shell({
        preheader: `We've issued a $${refundAmountUsd.toFixed(2)} refund. Here's why.`,
        body: `
          <h1 style="color:#fff;font-size:22px;margin:0 0 12px;">We owe you a refund.</h1>
          <p style="color:#9ca3af;line-height:1.7;">Hi ${name || 'there'},</p>
          <p style="color:#9ca3af;line-height:1.7;">
            We're writing to let you know we're issuing a partial refund of
            <strong style="color:#BEF264;">$${refundAmountUsd.toFixed(2)}</strong>
            on your recent VETT mission${missionCount > 1 ? 's' : ''}.
          </p>
          ${card(`
            <div style="color:#BEF264;font-weight:700;margin-bottom:8px;">What happened</div>
            <p style="color:#9ca3af;line-height:1.7;margin:0;">
              During a product review we identified that the "Retargeting Pixel" feature you opted into
              did not actually fire your pixel as described — this was a bug on our end, not yours.
              AI personas don't have browsers or ad-platform cookies, so the feature could never have worked
              as advertised. We should have caught this before charging for it.
            </p>
          `)}
          ${card(`
            <div style="color:#BEF264;font-weight:700;margin-bottom:8px;">What we've done</div>
            <p style="color:#9ca3af;line-height:1.7;margin:0;">
              We've removed the retargeting pixel feature from VETT entirely and refunded the surcharge
              automatically. The <strong style="color:#fff;">$${refundAmountUsd.toFixed(2)} refund</strong>
              will appear on your card in 5–10 business days.
            </p>
          `)}
          <p style="color:#9ca3af;line-height:1.7;">
            We're sorry for the mistake. Every dollar you spend on VETT should deliver what it promised.
          </p>
          <div style="margin-top:20px;">${btn('Back to VETT →', APP_URL)}</div>
        `,
      }),
    });
  } catch (err) { logger.warn('sendRetargetingRefundEmail failed', { err: err.message }); }
}

// ─── Partial delivery + auto-refund (Pass 23 Bug 23.25) ─────────────────
async function sendPartialDeliveryEmail({
  to,
  name,
  missionTitle,
  missionId,
  paidFor,
  qualified,
  refundAmountUsd,
  refundFailed = false,
}) {
  try {
    const gap = paidFor - qualified;
    const subject = refundFailed
      ? `Partial delivery on your VETT mission — we owe you a refund`
      : `Partial delivery on your VETT mission — $${refundAmountUsd.toFixed(2)} refunded`;
    return await resend.emails.send({
      from: FROM,
      to,
      subject,
      html: shell({
        preheader: refundFailed
          ? `We delivered ${qualified} of ${paidFor} qualified respondents. Refund failed; we'll process it manually.`
          : `We delivered ${qualified} of ${paidFor} qualified respondents. $${refundAmountUsd.toFixed(2)} refunded automatically.`,
        body: `
          <h1 style="color:#fff;font-size:22px;margin:0 0 12px;">We delivered ${qualified} of ${paidFor}.</h1>
          <p style="color:#9ca3af;line-height:1.7;">Hi ${name || 'there'},</p>
          <p style="color:#9ca3af;line-height:1.7;">
            Your mission &ldquo;<strong style="color:#fff;">${missionTitle || 'VETT mission'}</strong>&rdquo;
            completed, but the screener was tighter than the audience on this one. We over-recruited
            personas to try to hit your target; the screener kept dropping them, and we capped at
            5&times; to keep your AI cost in check.
          </p>
          ${card(`
            <div style="color:#BEF264;font-weight:700;margin-bottom:8px;">What you got</div>
            <p style="color:#9ca3af;line-height:1.7;margin:0;">
              <strong style="color:#fff;">${qualified} qualified respondents</strong> out of
              <strong style="color:#fff;">${paidFor}</strong> you paid for.
              The ${gap} we couldn&rsquo;t fill stayed inside the screener gate.
            </p>
          `)}
          ${refundFailed
            ? card(`
                <div style="color:#fbbf24;font-weight:700;margin-bottom:8px;">Refund pending</div>
                <p style="color:#9ca3af;line-height:1.7;margin:0;">
                  We tried to auto-refund <strong style="color:#fff;">$${refundAmountUsd.toFixed(2)}</strong>
                  for the ${gap} respondent gap, but the refund didn&rsquo;t land cleanly. Our team has
                  been alerted and will process it manually within one business day.
                </p>
              `)
            : card(`
                <div style="color:#BEF264;font-weight:700;margin-bottom:8px;">Refund issued</div>
                <p style="color:#9ca3af;line-height:1.7;margin:0;">
                  We&rsquo;ve refunded
                  <strong style="color:#fff;">$${refundAmountUsd.toFixed(2)}</strong>
                  proportionally for the ${gap} respondent gap. The refund will hit your card in
                  5&ndash;10 business days.
                </p>
              `)}
          ${card(`
            <div style="color:#BEF264;font-weight:700;margin-bottom:8px;">Tip for next time</div>
            <p style="color:#9ca3af;line-height:1.7;margin:0;">
              Loosen the screener criteria one notch and we'll likely fill the full target. The
              report is still real signal &mdash; only qualified respondents counted toward your insights.
            </p>
          `)}
          <div style="margin-top:20px;">
            ${btn('See the report →', `${APP_URL}/results/${missionId}`)}
          </div>
        `,
      }),
    });
  } catch (err) { logger.warn('sendPartialDeliveryEmail failed', { err: err.message }); }
}

// ─── Chat overage receipt ─────────────────────────────────
async function sendChatOverageEmail({ to, name, messagesGranted = 50, priceUsd = 5 }) {
  try {
    return await resend.emails.send({
      from: FROM,
      to,
      subject: `+${messagesGranted} VETT chat messages added`,
      html: shell({
        preheader: `Your chat quota has been topped up.`,
        body: `
          <h1 style="color:#fff;font-size:22px;margin:0 0 12px;">You're all topped up</h1>
          <p style="color:#9ca3af;">Hi ${name || 'there'},</p>
          <p style="color:#9ca3af;line-height:1.7;">We've added <strong style="color:#BEF264;">${messagesGranted} more messages</strong> to your VETT chat ($${priceUsd}). Keep interrogating your research.</p>
          <div style="margin-top:20px;">${btn('Back to VETT →', APP_URL)}</div>
        `,
      }),
    });
  } catch (err) { logger.warn('sendChatOverageEmail failed', { err: err.message }); }
}

module.exports = {
  sendWelcomeEmail,
  sendMissionLaunchedEmail,
  sendMissionCompletedEmail,
  sendInvoiceEmail,
  sendPaymentFailedEmail,
  sendChatOverageEmail,
  sendRetargetingRefundEmail,
  sendPartialDeliveryEmail, // Pass 23 Bug 23.25
};
