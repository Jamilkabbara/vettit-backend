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
- Do NOT use em-dashes (—) or double-dashes (--). Replace with a comma, period, or parenthetical.
- Do NOT use semicolons unless strictly necessary for separating list items containing commas.
- Write in clear, direct sentences. No throat-clearing.
- Avoid the phrases: "It's worth noting", "It's important to remember", "Furthermore", "Moreover", "It should be noted", "Of course".
- Lead with the finding, then the evidence. Don't preview structure ("Below I will...").
- Use plain words. Prefer "use" over "utilize", "help" over "facilitate", "show" over "demonstrate".`;

module.exports = { WRITING_STYLE };
