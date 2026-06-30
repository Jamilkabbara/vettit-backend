/**
 * Pass 22 Bug 22.27 — VETT writing-style guardrails.
 *
 * Appended to every AI system prompt across the synthesis pipeline to keep
 * output consistent and to ban the AI tics that gave VETT's output its
 * "obviously machine-written" tell. Forensic from chat_messages.content
 * showed em-dashes everywhere, "Furthermore"/"Moreover" stacking, and
 * throat-clearing phrases ("It's worth noting...").
 *
 * Centralised so we update one constant when we want to tighten further.
 */

const WRITING_STYLE = `
WRITING STYLE:
- Use commas, periods, parentheses, and colons.
- Do NOT use em-dashes (—), en-dashes (–), or double-dashes (--) ANYWHERE in your output. Replace with a comma, period, parenthesis, or the word "and". For ranges and number spans use a plain hyphen ("SAR 31-40", "ages 25-44"), never an en-dash.
- Do NOT use semicolons unless strictly necessary for separating list items containing commas.
- Write in clear, direct sentences. No throat-clearing.
- Avoid the phrases: "It's worth noting", "It's important to remember", "Furthermore", "Moreover", "It should be noted", "Of course".
- Lead with the finding, then the evidence. Don't preview structure ("Below I will...").
- Use plain words. Prefer "use" over "utilize", "help" over "facilitate", "show" over "demonstrate".`;

module.exports = { WRITING_STYLE };
