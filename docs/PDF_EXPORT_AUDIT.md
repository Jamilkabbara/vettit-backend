# PDF Export Audit — Pass 25 Phase 0

**Date:** 2026-04-29
**Branch:** `pass-25-exports-and-brand-lift-v2`
**Author:** Claude (Opus 4.7) under Jamil's authorization

## TL;DR

The current PDF generator (`src/services/exports/pdf.js`, 334 lines, pdfkit-based) produces 18-page PDFs with **blank dark pages and overlapping fonts** on multi-question missions. The fixes attempted in Pass 23 (Bug 23.62 orphan-header guard) treated the symptom but missed the architectural root cause: **manual coordinate positioning + `fillPageBg` after every `addPage` + Helvetica-only fonts**.

Per Pass 25 spec, we are **rebuilding** with **Puppeteer + HTML/CSS templates** (Handlebars). pdfkit is being decommissioned for PDF; we keep the dependency only until the rebuild ships and is verified across 3 missions.

## Symptoms (verified live)

1. **Blank dark pages** between Executive Summary and Question 1.
2. **Font overlap** on rating-distribution rows — count text overprinting the bar fill.
3. **Orphan headers** still occur on questions 4–8 even after the 280pt threshold fix.
4. **Long verbatims** push the page off the bottom; PDFKit's autopaging adds another `fillPageBg`-painted page rather than letting the verbatim wrap cleanly.
5. **Star characters** required a path-primitive workaround (drawStar) because Helvetica lacks U+2605.

Reproduced on mission `a520d873-f0b0-4a8f-b083-5d39c1e83c4a` (the 18-page case).

## Root cause

`src/services/exports/pdf.js` mixes three patterns that compound on top of each other:

### Pattern 1 — `fillPageBg` after every `addPage`

```js
doc.addPage();
fillPageBg(doc);
```

`fillPageBg` paints a page-sized dark rectangle. When `pdfkit` autopages a section that *almost* fits but spills 8pt into the next page, that next page is born with a full dark BG and a single line of trailing text — rendering as a "blank dark page".

### Pattern 2 — manual coordinate positioning + `doc.y` mutation

```js
drawStar(doc, 50, rowY + 2, 12);
doc.fontSize(10).text(`${r}`, 68, rowY + 3, { width: 20, lineBreak: false });
doc.rect(barX, rowY + 6, barMaxW, 8).fill(BRAND.bg3);
doc.y = rowY + rowHeight;  // manually override cursor
```

Manual cursor override is fragile. When a row of distribution data overflows the page, `doc.y` gets reset to a value past `page.height`, then the next call to `text()` triggers an autopage *but* the manual-position rect calls don't — so the bar background paints on the *new* page at the *old* `rowY` coordinate, while the bar fill paints on the *old* page at the *correct* coordinate. The visible result: a bar split across pages with the count text overlapping the wrong bar.

### Pattern 3 — Helvetica only, no font embedding

```js
.font('Helvetica-Bold')
```

pdfkit ships with the 14 standard PostScript fonts, but Helvetica:
- lacks U+2605 (★) — required `drawStar` path workaround
- lacks U+2014 (em-dash) — currently substituting "·"
- doesn't match the VETT brand (Manrope display + Inter body)
- on some PDF viewers, ligatures and kerning render with subtle horizontal shift, making numeric tabular data look misaligned

### Pattern 4 — no CSS, no `page-break-inside: avoid`

The orphan-header guard (Bug 23.62) is a manual `if (doc.y > doc.page.height - 280) { doc.addPage(); }` check at the *start* of each question. It cannot guard against the *insight pullquote* falling on a different page from its question heading, or the *bar fill* falling on a different page from its bar track — those need declarative `page-break-inside: avoid` rules around each unit.

## Why we picked Puppeteer + Handlebars

| Option | Pros | Cons | Decision |
|---|---|---|---|
| Stay on pdfkit, fix incrementally | Smallest dep change | Doesn't fix root cause; still imperative cursor management | Reject — past 2 attempts already failed |
| **Puppeteer + Handlebars** | Real Chromium rendering; CSS `page-break-*`; embedded WOFF2 fonts; designer can iterate in browser | +170MB Chromium binary on Railway; 1–2s cold start | **Adopt** |
| `@react-pdf/renderer` | React-flavored declarative API; lighter than Chromium | New mental model; layout primitives differ from CSS | Reject — extra learning, no clear win over CSS |
| `pdfmake` | Declarative document tree; smaller than Puppeteer | Still imperative-ish; weaker CSS-like layout; weaker font embedding | Reject — partial improvement, not a rebuild |
| `wkhtmltopdf` | HTML/CSS pipeline, smaller than Chromium | Unmaintained since 2022; CSS support frozen at WebKit ~2018 | Reject — stagnant |

The user explicitly mandated Puppeteer + HTML/CSS template per Pass 25 master spec. The Railway cost (~170MB binary, +1–2s cold start) is acceptable; PDF export is not a hot path.

## Rebuild plan

```
vettit-backend/
  src/services/exports/
    pdf.js            ← old (pdfkit) — kept until verified, then deleted
    pdf-v2/
      engine.js       ← Puppeteer wrapper: browser pool + waitForFunction(fonts.ready)
      templates/
        _base.css     ← brand vars + page-break rules + @font-face
        _base.hbs     ← layout scaffold (header / footer / cover / page wrap)
        general_research.hbs  ← per-question results template
        creative_attention.hbs  ← Bug 24.01 results (deferred to phase 0.5)
      fonts/
        Manrope-Black.woff2
        Manrope-Bold.woff2
        Inter-Regular.woff2
        Inter-Bold.woff2
      index.js        ← buildPDF(pack, res) entry — same signature as old
  src/routes/results.js  ← swap require('../services/exports/pdf') for ('./pdf-v2')
```

### Key CSS rules (the architectural fix)

```css
/* Every "logical unit" stays together — this is the core fix */
.question-section,
.kpi-card,
.bar-row,
.insight-callout,
.verbatim-block { page-break-inside: avoid; }

/* Headers never orphan */
h1, h2, h3 { page-break-after: avoid; }

/* Render fonts BEFORE Puppeteer takes the snapshot */
@font-face {
  font-family: 'Manrope';
  src: url('../fonts/Manrope-Black.woff2') format('woff2');
  font-weight: 900;
  font-display: block;  /* block so Puppeteer waits for load */
}
```

Combined with `await page.evaluateHandle('document.fonts.ready')` in the engine, fonts are guaranteed to be embedded before the print snapshot — eliminating the entire class of font-substitution bugs.

### Key engine rules

```js
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage();
await page.setContent(html, { waitUntil: ['load', 'networkidle0'] });
await page.evaluateHandle('document.fonts.ready');
const buf = await page.pdf({
  format: 'A4',
  printBackground: true,           // critical — without this, dark BG drops out
  margin: { top: '20mm', bottom: '24mm', left: '16mm', right: '16mm' },
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',  // empty — header is in the body
  footerTemplate: footerHTML,     // page X / Y in lime
});
await browser.close();
```

`--no-sandbox` is required on Railway (containerized, no setuid). `--disable-dev-shm-usage` avoids the `/dev/shm` 64MB cap that crashes Chromium on memory-tight platforms.

## Verification plan

After deploy:

1. Export PDF on mission `a520d873-f0b0-4a8f-b083-5d39c1e83c4a` — must be ≤ N pages where N is the question count + 3 (cover + summary + recommendations); no blank pages.
2. Export PDF on a completed CA mission — fonts should render Manrope/Inter (not Helvetica).
3. Export PDF on a completed Validate mission — every bar row stays on a single page.
4. Diff page count: old PDF 18 pages → new PDF target ≤ 11 pages for the same data.
5. Open in Adobe Reader, Preview.app, Chrome PDF viewer — text must be selectable in all three.

## Decisions made autonomously

Per Jamil's authorization ("Make reasonable decisions without asking. Document them in the PR."):

- **Puppeteer over playwright** — both work, but Puppeteer is one-Chromium and well-trodden on Railway.
- **Handlebars over EJS / Mustache** — partials + helpers, no JSX; minimal mental load.
- **Ship pdf-v2 as a sibling to pdf.js, swap at the route** — old code stays callable for one deploy in case rollback is needed; deleted in the next merge.
- **Embed WOFF2 fonts in repo, not from Google CDN** — guarantees offline rendering, deterministic builds, no network race during PDF generation.
- **Single template (`general_research.hbs`) for all non-CA mission types in Phase 0** — Validate/Refine/Concept/etc all currently render the same way. CA gets its own template in 0.5.

## Cost / risk note

- **Railway disk:** Puppeteer + Chromium adds ~170MB to the deploy slug. Current slug is ~250MB; new total ~420MB. Within Railway's 1GB free-tier limit.
- **Cold start:** First export after a deploy may take 4–6s instead of 1s. Subsequent exports reuse the Chromium process via the engine's browser pool.
- **Memory:** Puppeteer renders one PDF at a time per worker. Memory floor stays under 512MB for the missions tested. No queue needed at current volume.

## Out of scope (Pass 25 Phase 0)

- Per-mission-type templates beyond `general_research.hbs` (Phase 0.5).
- Email-attached PDF auto-delivery (already handled separately).
- Internationalization (RTL Arabic) — deferred to Phase 1+ Brand Lift.
- Watermarking by tier — deferred until billing tiers ship.
