const { Resend } = require('resend');
const logger = require('../utils/logger');

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = `${process.env.FROM_NAME || 'Vettit'} <${process.env.FROM_EMAIL || 'hello@vettit.ai'}>`;

async function sendWelcomeEmail({ to, name }) {
  return resend.emails.send({
    from: FROM,
    to,
    subject: 'Welcome to Vettit — Your AI Research Team',
    html: `
      <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; background: #0B0C15; color: #fff; padding: 40px; border-radius: 12px;">
        <div style="margin-bottom: 32px;">
          <h1 style="color: #BEF264; font-size: 28px; margin: 0;">VETTIT</h1>
        </div>
        <h2 style="color: #fff; font-size: 22px;">Welcome, ${name || 'Researcher'}! 👋</h2>
        <p style="color: #aaa; line-height: 1.6;">Your AI research team is ready. Describe what you want to know — we'll handle the rest.</p>
        <div style="background: #1a1b2e; border-radius: 8px; padding: 24px; margin: 24px 0;">
          <p style="color: #BEF264; font-weight: 600; margin: 0 0 8px;">What you can do with Vettit:</p>
          <ul style="color: #aaa; line-height: 2; padding-left: 20px; margin: 0;">
            <li>Describe your research in one sentence</li>
            <li>AI builds a researcher-quality survey</li>
            <li>Real people answer — targeted to your exact audience</li>
            <li>Get AI insights, charts, and a full report</li>
          </ul>
        </div>
        <a href="${process.env.FRONTEND_URL}/setup" style="display: inline-block; background: #BEF264; color: #0B0C15; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; margin-top: 8px;">Launch Your First Mission →</a>
        <p style="color: #555; font-size: 12px; margin-top: 40px;">Vettit · Dubai, UAE · hello@vettit.ai</p>
      </div>
    `,
  });
}

async function sendMissionLaunchedEmail({ to, name, missionStatement, respondentCount, estimatedTime, missionId }) {
  return resend.emails.send({
    from: FROM,
    to,
    subject: `Your mission is live — results coming in ${estimatedTime}`,
    html: `
      <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; background: #0B0C15; color: #fff; padding: 40px; border-radius: 12px;">
        <h1 style="color: #BEF264; font-size: 24px; margin: 0 0 24px;">Mission Launched ⚡</h1>
        <p style="color: #aaa;">Hi ${name || 'there'},</p>
        <p style="color: #aaa; line-height: 1.6;">Your research is now live and collecting responses from real people.</p>
        <div style="background: #1a1b2e; border-radius: 8px; padding: 24px; margin: 24px 0;">
          <p style="color: #BEF264; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 8px;">Mission</p>
          <p style="color: #fff; font-size: 16px; margin: 0 0 16px;">${missionStatement}</p>
          <div style="display: flex; gap: 24px;">
            <div>
              <p style="color: #555; font-size: 12px; margin: 0;">RESPONDENTS</p>
              <p style="color: #fff; font-size: 20px; font-weight: 700; margin: 0;">${respondentCount}</p>
            </div>
            <div>
              <p style="color: #555; font-size: 12px; margin: 0;">ESTIMATED TIME</p>
              <p style="color: #BEF264; font-size: 20px; font-weight: 700; margin: 0;">${estimatedTime}</p>
            </div>
          </div>
        </div>
        <p style="color: #aaa;">We'll notify you the moment your results are ready.</p>
        <a href="${process.env.FRONTEND_URL}/mission/${missionId}" style="display: inline-block; background: #BEF264; color: #0B0C15; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; margin-top: 8px;">Track Your Mission →</a>
        <p style="color: #555; font-size: 12px; margin-top: 40px;">Vettit · Dubai, UAE · hello@vettit.ai</p>
      </div>
    `,
  });
}

async function sendMissionCompletedEmail({ to, name, missionStatement, totalResponses, missionId }) {
  return resend.emails.send({
    from: FROM,
    to,
    subject: `Results are in — your research is complete`,
    html: `
      <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; background: #0B0C15; color: #fff; padding: 40px; border-radius: 12px;">
        <h1 style="color: #BEF264; font-size: 24px; margin: 0 0 24px;">Your Results Are Ready 🎯</h1>
        <p style="color: #aaa;">Hi ${name || 'there'},</p>
        <p style="color: #aaa; line-height: 1.6;">Your research mission is complete. <strong style="color: #fff;">${totalResponses} real people</strong> have shared their insights.</p>
        <div style="background: #1a1b2e; border-radius: 8px; padding: 24px; margin: 24px 0;">
          <p style="color: #555; font-size: 12px; margin: 0;">MISSION</p>
          <p style="color: #fff; margin: 4px 0 0;">${missionStatement}</p>
        </div>
        <p style="color: #aaa;">Your AI report includes:<br>
        ✦ Charts and data visualizations<br>
        ✦ AI-generated insights for every question<br>
        ✦ Executive summary<br>
        ✦ 2 recommended follow-up surveys<br>
        ✦ Downloadable PDF and PowerPoint</p>
        <a href="${process.env.FRONTEND_URL}/results?missionId=${missionId}" style="display: inline-block; background: #BEF264; color: #0B0C15; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; margin-top: 8px;">View My Results →</a>
        <p style="color: #555; font-size: 12px; margin-top: 40px;">Vettit · Dubai, UAE · hello@vettit.ai</p>
      </div>
    `,
  });
}

async function sendInvoiceEmail({ to, name, invoiceData }) {
  return resend.emails.send({
    from: FROM,
    to,
    subject: `Invoice from Vettit — Mission #${invoiceData.missionId}`,
    html: `
      <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; background: #0B0C15; color: #fff; padding: 40px; border-radius: 12px;">
        <h1 style="color: #BEF264; font-size: 24px; margin: 0 0 24px;">Invoice</h1>
        <p style="color: #aaa;">Hi ${name || 'there'}, here is your invoice for the following mission.</p>
        <div style="background: #1a1b2e; border-radius: 8px; padding: 24px; margin: 24px 0;">
          <p style="color: #555; font-size: 12px; margin: 0;">MISSION</p>
          <p style="color: #fff; margin: 4px 0 16px;">${invoiceData.missionStatement}</p>
          <table style="width: 100%; color: #aaa; font-size: 14px;">
            <tr><td>Base cost (${invoiceData.respondentCount} respondents)</td><td style="text-align:right;">$${invoiceData.baseCost}</td></tr>
            ${invoiceData.questionSurcharge > 0 ? `<tr><td>Question surcharge</td><td style="text-align:right;">$${invoiceData.questionSurcharge}</td></tr>` : ''}
            ${invoiceData.targetingSurcharge > 0 ? `<tr><td>Targeting</td><td style="text-align:right;">$${invoiceData.targetingSurcharge}</td></tr>` : ''}
            ${invoiceData.screeningSurcharge > 0 ? `<tr><td>Screening</td><td style="text-align:right;">$${invoiceData.screeningSurcharge}</td></tr>` : ''}
            <tr style="border-top: 1px solid #333;"><td style="color:#fff; font-weight:700; padding-top:12px;">Total</td><td style="text-align:right; color:#BEF264; font-weight:700; padding-top:12px;">$${invoiceData.total} USD</td></tr>
          </table>
        </div>
        <p style="color: #555; font-size: 12px; margin-top: 40px;">Vettit FZ-LLC · Dubai, UAE · hello@vettit.ai<br>Trade License: ${invoiceData.tradeLicense || 'Available on request'}</p>
      </div>
    `,
  });
}

module.exports = { sendWelcomeEmail, sendMissionLaunchedEmail, sendMissionCompletedEmail, sendInvoiceEmail };
