/**
 * VETT — Creative Attention PPTX export.
 * Dark-theme deck mirroring the live results page.
 *
 * Slide outline:
 *   1. Cover
 *   2. Executive snapshot (engagement gauge value + brand strength 4-card row)
 *   3. Attention arc + vs benchmark
 *   4. Emotion peaks
 *   5. Strengths
 *   6. Weaknesses
 *   7. Recommendations
 *   8. Platform fit
 *   9. Frame timeline summary (table; first ~12 frames + "..." if longer)
 */

const PptxGenJS = require('pptxgenjs');
const {
  BRAND, brandStrength, platformLabel, platformRationale, caExportFilename,
} = require('./shared');

const hex = (c) => (c || '').replace('#', '');
const SLIDE_W = 13.333;  // PptxGenJS LAYOUT_WIDE in inches
const SLIDE_H = 7.5;

function darkBg(slide) {
  slide.background = { color: hex(BRAND.bg) };
  slide.addShape('rect', {
    x: 0, y: 0, w: '100%', h: 0.06,
    fill: { color: hex(BRAND.lime) }, line: { color: hex(BRAND.lime) },
  });
  slide.addText('VETT  ·  Creative Attention', {
    x: 0.5, y: SLIDE_H - 0.35, w: SLIDE_W - 1, h: 0.3,
    fontSize: 9, color: hex(BRAND.text3), fontFace: 'Calibri',
    align: 'center',
  });
}

function header(slide, eyebrow, title) {
  slide.addText(eyebrow, {
    x: 0.5, y: 0.35, w: SLIDE_W - 1, h: 0.3,
    fontSize: 10, bold: true, color: hex(BRAND.lime),
    fontFace: 'Calibri', charSpacing: 80,
  });
  slide.addText(title, {
    x: 0.5, y: 0.65, w: SLIDE_W - 1, h: 0.6,
    fontSize: 26, bold: true, color: 'FFFFFF', fontFace: 'Calibri',
  });
  slide.addShape('rect', {
    x: 0.5, y: 1.30, w: SLIDE_W - 1, h: 0.03,
    fill: { color: hex(BRAND.lime) }, line: { color: hex(BRAND.lime) },
  });
}

function statCard(slide, x, y, w, h, label, value, tone = BRAND.lime) {
  slide.addShape('roundRect', {
    x, y, w, h, rectRadius: 0.1,
    fill: { color: hex(BRAND.bg2) }, line: { color: hex(BRAND.border) },
  });
  slide.addText(String(label || '').toUpperCase(), {
    x: x + 0.18, y: y + 0.12, w: w - 0.36, h: 0.28,
    fontSize: 9, color: hex(BRAND.text3), fontFace: 'Calibri', charSpacing: 60,
  });
  slide.addText(String(value ?? '—'), {
    x: x + 0.18, y: y + 0.42, w: w - 0.36, h: h - 0.55,
    fontSize: 32, bold: true, color: hex(tone), fontFace: 'Calibri',
  });
  slide.addText('/ 100', {
    x: x + 0.18, y: y + h - 0.32, w: w - 0.36, h: 0.22,
    fontSize: 9, color: hex(BRAND.text3), fontFace: 'Calibri',
  });
}

function bulletSlide(pptx, eyebrow, title, items) {
  const slide = pptx.addSlide();
  darkBg(slide);
  header(slide, eyebrow, title);
  const text = (items || []).map((t) => ({ text: String(t || ''), options: { bullet: true, breakLine: true } }));
  if (text.length === 0) text.push({ text: 'None reported.', options: { color: hex(BRAND.text3) } });
  slide.addText(text, {
    x: 0.7, y: 1.7, w: SLIDE_W - 1.4, h: SLIDE_H - 2.3,
    fontSize: 16, color: 'FFFFFF', fontFace: 'Calibri',
    paraSpaceAfter: 8, valign: 'top',
  });
}

function toneFor(score) {
  if (score >= 70) return BRAND.green;
  if (score >= 40) return BRAND.orange;
  return BRAND.red;
}

async function buildCAPPTX(pack, res) {
  const { mission, analysis } = pack;
  const summary = analysis.summary || {};
  const frames = analysis.frame_analyses || [];

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = mission.title || 'VETT Creative Attention Report';
  pptx.author = 'VETT';
  pptx.company = 'VETT';

  // ── Slide 1: Cover ──────────────────────────────────────────
  const cover = pptx.addSlide();
  cover.background = { color: hex(BRAND.bg) };
  cover.addShape('rect', {
    x: 0, y: 0, w: '100%', h: 0.06,
    fill: { color: hex(BRAND.lime) }, line: { color: hex(BRAND.lime) },
  });
  cover.addText('VETT', {
    x: 0.6, y: 0.6, w: 4, h: 0.7,
    fontSize: 44, bold: true, color: hex(BRAND.lime), fontFace: 'Calibri',
  });
  cover.addText('CREATIVE ATTENTION ANALYSIS', {
    x: 0.6, y: 1.3, w: 8, h: 0.4,
    fontSize: 11, bold: true, color: hex(BRAND.text2), fontFace: 'Calibri',
    charSpacing: 80,
  });
  cover.addText(mission.title || 'Creative Analysis', {
    x: 0.6, y: 2.6, w: SLIDE_W - 1.2, h: 1.5,
    fontSize: 38, bold: true, color: 'FFFFFF', fontFace: 'Calibri',
  });
  cover.addText(mission.brief || mission.mission_statement || '', {
    x: 0.6, y: 4.3, w: SLIDE_W - 1.2, h: 1.6,
    fontSize: 14, color: hex(BRAND.text2), fontFace: 'Calibri',
    paraSpaceAfter: 6, valign: 'top',
  });
  const meta = [
    `Mission ID: ${mission.id}`,
    `Media: ${mission.media_type || (analysis.is_video ? 'video' : 'image')}`,
    `Frames analyzed: ${analysis.total_frames || frames.length}`,
    `Generated: ${analysis.generated_at || ''}`,
  ].join('   ·   ');
  cover.addText(meta, {
    x: 0.6, y: SLIDE_H - 0.7, w: SLIDE_W - 1.2, h: 0.3,
    fontSize: 10, color: hex(BRAND.text3), fontFace: 'Calibri',
  });

  // ── Slide 2: Executive snapshot ─────────────────────────────
  const snap = pptx.addSlide();
  darkBg(snap);
  header(snap, 'EXECUTIVE SNAPSHOT', 'Brand Strength Scorecard');
  const bs = brandStrength(analysis);
  const cardW = (SLIDE_W - 1 - 0.3 * 3) / 4;
  const cardY = 2;
  const cardH = 1.7;
  const cards = [
    ['Engagement', summary.overall_engagement_score ?? bs.engagement],
    ['Resonance', bs.resonance],
    ['Clarity', bs.clarity],
    ['Memory', bs.memory],
  ];
  cards.forEach(([label, value], i) => {
    const x = 0.5 + i * (cardW + 0.3);
    statCard(snap, x, cardY, cardW, cardH, label, value, toneFor(value));
  });
  if (summary.attention_arc) {
    snap.addText([
      { text: 'ATTENTION ARC\n', options: { fontSize: 10, bold: true, color: hex(BRAND.lime), charSpacing: 60 } },
      { text: summary.attention_arc, options: { fontSize: 13, color: 'FFFFFF' } },
    ], {
      x: 0.5, y: cardY + cardH + 0.4, w: SLIDE_W - 1, h: 2.0,
      fontFace: 'Calibri', valign: 'top', paraSpaceAfter: 4,
    });
  }

  // ── Slide 3: vs Benchmark + Emotion peaks intro ─────────────
  if (summary.vs_benchmark) {
    const vsSlide = pptx.addSlide();
    darkBg(vsSlide);
    header(vsSlide, 'BENCHMARK CONTEXT', 'vs Industry Norms');
    vsSlide.addShape('roundRect', {
      x: 0.5, y: 1.7, w: SLIDE_W - 1, h: 2.0, rectRadius: 0.15,
      fill: { color: hex(BRAND.bg2) }, line: { color: hex(BRAND.lime) + '33' },
    });
    vsSlide.addText(summary.vs_benchmark, {
      x: 0.85, y: 1.85, w: SLIDE_W - 1.7, h: 1.7,
      fontSize: 16, color: 'FFFFFF', fontFace: 'Calibri',
      paraSpaceAfter: 6, valign: 'top',
    });
  }

  // ── Slide 4: Emotion peaks ──────────────────────────────────
  const peakSlide = pptx.addSlide();
  darkBg(peakSlide);
  header(peakSlide, 'EMOTIONAL ARC', 'Peak Moments');
  const peakRows = [
    [
      { text: 'Emotion', options: { bold: true, color: hex(BRAND.lime) } },
      { text: 'Peak (s)', options: { bold: true, color: hex(BRAND.lime) } },
      { text: 'Value', options: { bold: true, color: hex(BRAND.lime) } },
      { text: 'Interpretation', options: { bold: true, color: hex(BRAND.lime) } },
    ],
  ];
  for (const p of summary.emotion_peaks || []) {
    peakRows.push([
      { text: String(p.emotion || ''), options: { color: 'FFFFFF' } },
      { text: String(p.peak_timestamp ?? ''), options: { color: 'FFFFFF' } },
      { text: String(p.peak_value ?? ''), options: { color: 'FFFFFF' } },
      { text: String(p.interpretation || ''), options: { color: hex(BRAND.text2) } },
    ]);
  }
  if (peakRows.length === 1) {
    peakRows.push([{ text: 'No peaks reported.', options: { colspan: 4, color: hex(BRAND.text3) } }]);
  }
  peakSlide.addTable(peakRows, {
    x: 0.5, y: 1.7, w: SLIDE_W - 1,
    colW: [1.6, 1.2, 1.2, SLIDE_W - 1 - 4.0],
    fontFace: 'Calibri', fontSize: 12, valign: 'top',
    border: { type: 'solid', pt: 0.5, color: hex(BRAND.border) },
    fill: { color: hex(BRAND.bg2) },
  });

  // ── Slides 5/6/7: Strengths/Weaknesses/Recommendations ──────
  bulletSlide(pptx, 'WHAT WORKS', 'Strengths', summary.strengths);
  bulletSlide(pptx, 'WHAT TO WATCH', 'Weaknesses', summary.weaknesses);
  bulletSlide(pptx, 'NEXT MOVES', 'Recommendations', summary.recommendations);

  // ── Slide 8: Platform Fit ───────────────────────────────────
  const platSlide = pptx.addSlide();
  darkBg(platSlide);
  header(platSlide, 'WHERE TO RUN IT', 'Best Platform Fit');
  const fits = (summary.best_platform_fit || []).map((p) => ({
    name: platformLabel(p), why: platformRationale(p),
  })).filter((p) => p.name);
  if (fits.length === 0) {
    platSlide.addText('No platform recommendations available.', {
      x: 0.7, y: 2, w: SLIDE_W - 1.4, h: 0.5,
      fontSize: 14, color: hex(BRAND.text3), fontFace: 'Calibri',
    });
  } else {
    fits.forEach((p, i) => {
      const y = 1.7 + i * 0.85;
      platSlide.addShape('roundRect', {
        x: 0.5, y, w: SLIDE_W - 1, h: 0.75, rectRadius: 0.08,
        fill: { color: hex(BRAND.bg2) }, line: { color: hex(BRAND.purple) + '55' },
      });
      platSlide.addText(p.name, {
        x: 0.7, y: y + 0.08, w: 3, h: 0.6,
        fontSize: 14, bold: true, color: hex(BRAND.purple), fontFace: 'Calibri', valign: 'middle',
      });
      platSlide.addText(p.why || '', {
        x: 3.6, y: y + 0.08, w: SLIDE_W - 4.1, h: 0.6,
        fontSize: 12, color: 'FFFFFF', fontFace: 'Calibri', valign: 'middle',
      });
    });
  }

  // ── Slide 9: Frame timeline summary ─────────────────────────
  if (frames.length > 0) {
    const frameSlide = pptx.addSlide();
    darkBg(frameSlide);
    header(frameSlide, 'FRAME-BY-FRAME', `Timeline (${frames.length} frame${frames.length === 1 ? '' : 's'} analyzed)`);
    const cap = 12;
    const rows = [[
      { text: 'Time (s)', options: { bold: true, color: hex(BRAND.lime) } },
      { text: 'Engagement', options: { bold: true, color: hex(BRAND.lime) } },
      { text: 'Resonance', options: { bold: true, color: hex(BRAND.lime) } },
      { text: 'Clarity', options: { bold: true, color: hex(BRAND.lime) } },
      { text: 'Description', options: { bold: true, color: hex(BRAND.lime) } },
    ]];
    frames.slice(0, cap).forEach((f) => {
      rows.push([
        { text: String(f.timestamp ?? ''), options: { color: 'FFFFFF' } },
        { text: String(f.engagement_score ?? ''), options: { color: hex(toneFor(f.engagement_score)) } },
        { text: String(f.audience_resonance ?? ''), options: { color: 'FFFFFF' } },
        { text: String(f.message_clarity ?? ''), options: { color: 'FFFFFF' } },
        { text: String(f.brief_description || ''), options: { color: hex(BRAND.text2) } },
      ]);
    });
    if (frames.length > cap) {
      rows.push([{
        text: `... ${frames.length - cap} more frame${frames.length - cap === 1 ? '' : 's'} in XLSX export`,
        options: { colspan: 5, color: hex(BRAND.text3), italic: true },
      }]);
    }
    frameSlide.addTable(rows, {
      x: 0.5, y: 1.7, w: SLIDE_W - 1,
      colW: [1.0, 1.2, 1.2, 1.0, SLIDE_W - 1 - 4.4],
      fontFace: 'Calibri', fontSize: 11, valign: 'top',
      border: { type: 'solid', pt: 0.5, color: hex(BRAND.border) },
      fill: { color: hex(BRAND.bg2) },
    });
  }

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${caExportFilename(mission, 'pptx')}"`,
  );

  // pptx 3.x supports stream() but the public API across 3/4 differs.
  // write/writeFile/stream all accept an output mode. nodeBuffer keeps
  // it simple — buffer in memory then send. Files are well under 1MB.
  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  res.send(buffer);
}

module.exports = { buildCAPPTX };
