/**
 * VETT — PDF rendering engine (Puppeteer + headless Chromium).
 * Pass 25 Phase 0: replaces pdfkit. See docs/PDF_EXPORT_AUDIT.md.
 *
 * Architecture:
 *   - Single shared browser instance, lazy-launched on first call.
 *     Subsequent calls reuse it. We never close the browser — Puppeteer
 *     reaps the Chromium child process on Node exit.
 *   - Each PDF gets a fresh `page` (incognito-equivalent, isolated cookies).
 *   - Fonts are read from disk once at startup, embedded as data URIs in
 *     the @font-face block of the rendered HTML. Guarantees deterministic
 *     output regardless of network state.
 *   - `await page.evaluateHandle('document.fonts.ready')` blocks the print
 *     snapshot until every glyph is loaded. Eliminates font-fallback bugs.
 *   - `printBackground: true` is required — without it, the dark BG drops out.
 *
 * Railway compatibility:
 *   - --no-sandbox                : container has no setuid sandbox
 *   - --disable-setuid-sandbox    : ditto
 *   - --disable-dev-shm-usage     : Railway's /dev/shm is 64MB; Chromium
 *                                   needs more for any non-trivial page,
 *                                   so we redirect to /tmp (slower but works)
 *
 * Memory: peaks ~250MB during render, drops back to ~80MB while idle.
 * Cold start: ~3s for first export after deploy, ~700ms thereafter.
 */

const fs   = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const logger = require('../../../utils/logger');

let _browser = null;
let _browserPromise = null;
let _fontFaceCss = null;

/**
 * Read a font file and return a data: URI suitable for @font-face src.
 */
function loadFontDataUri(absPath) {
  const buf = fs.readFileSync(absPath);
  return `data:font/woff2;charset=utf-8;base64,${buf.toString('base64')}`;
}

/**
 * Build the @font-face CSS block once at startup. Embeds the WOFF2 binaries
 * inline so Puppeteer never has to fetch from a CDN — that's both faster
 * and avoids the failure mode where a slow network leaves font-display
 * fallbacks frozen into the PDF.
 */
function buildFontFaceCss() {
  if (_fontFaceCss) return _fontFaceCss;

  const fontsourceRoot = path.resolve(__dirname, '../../../../node_modules/@fontsource');
  const manropeFiles   = path.join(fontsourceRoot, 'manrope/files');
  const interFiles     = path.join(fontsourceRoot, 'inter/files');

  // Manrope: body — 400 (regular), 700 (bold), 800 (extra-bold)
  // Inter:   display — 700 (bold), 800 (extra-bold), 900 (black)
  const faces = [
    {
      family: 'Manrope', weight: 400,
      file: path.join(manropeFiles, 'manrope-latin-400-normal.woff2'),
    },
    {
      family: 'Manrope', weight: 700,
      file: path.join(manropeFiles, 'manrope-latin-700-normal.woff2'),
    },
    {
      family: 'Manrope', weight: 800,
      file: path.join(manropeFiles, 'manrope-latin-800-normal.woff2'),
    },
    {
      family: 'Inter', weight: 700,
      file: path.join(interFiles, 'inter-latin-700-normal.woff2'),
    },
    {
      family: 'Inter', weight: 800,
      file: path.join(interFiles, 'inter-latin-800-normal.woff2'),
    },
    {
      family: 'Inter', weight: 900,
      file: path.join(interFiles, 'inter-latin-900-normal.woff2'),
    },
  ];

  const blocks = faces.map(f => {
    if (!fs.existsSync(f.file)) {
      logger.warn?.(`PDF font file missing: ${f.file}`);
      return '';
    }
    const uri = loadFontDataUri(f.file);
    return `
@font-face {
  font-family: '${f.family}';
  font-weight: ${f.weight};
  font-style: normal;
  font-display: block;
  src: url('${uri}') format('woff2');
}`;
  });

  _fontFaceCss = blocks.join('\n');
  return _fontFaceCss;
}

/**
 * Launch (or reuse) the shared browser. Returns the same instance for the
 * lifetime of the process. Concurrent calls during the first launch share
 * a single promise so we never start two browsers.
 */
async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  if (_browserPromise) return _browserPromise;

  _browserPromise = puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--font-render-hinting=none',
    ],
  }).then(b => {
    _browser = b;
    _browserPromise = null;
    // If the browser dies (OOM, crash), forget it so the next call relaunches.
    b.on('disconnected', () => {
      logger.warn?.('puppeteer browser disconnected — will relaunch on next render');
      _browser = null;
    });
    return b;
  }).catch(err => {
    _browserPromise = null;
    throw err;
  });

  return _browserPromise;
}

/**
 * Render the given HTML to a PDF Buffer.
 *
 * Important — the caller passes COMPLETE HTML (already containing the
 * @font-face data URIs and the rendered Handlebars template). The engine
 * only handles the Chromium <→ PDF transformation.
 */
async function renderPdfFromHtml(html, opts = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.emulateMediaType('print');
    // setContent() with data URIs has no network activity, so networkidle0
    // would hang. domcontentloaded is enough — fonts.ready below blocks
    // until the embedded WOFF2 has finished decoding.
    await page.setContent(html, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    // Block until every @font-face has loaded — eliminates font-fallback bugs.
    await page.evaluate(() => document.fonts.ready);

    const buf = await page.pdf({
      format: opts.format || 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: opts.margin || { top: 0, right: 0, bottom: 0, left: 0 },
      displayHeaderFooter: false,
      timeout: 30_000,
    });
    return buf;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Get the loaded font CSS — exported so callers can inject it into their
 * Handlebars view model (we keep template-knowledge out of the engine).
 */
function getFontFaceCss() {
  return buildFontFaceCss();
}

module.exports = {
  renderPdfFromHtml,
  getFontFaceCss,
  // Exposed for tests / graceful shutdown:
  _shutdown: async () => {
    if (_browser) {
      await _browser.close().catch(() => {});
      _browser = null;
    }
  },
};
