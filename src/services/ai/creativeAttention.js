/**
 * VETT — Creative Attention Analysis.
 *
 * Analyzes a video or image creative by:
 *   1. Downloading the file from Supabase Storage
 *   2. Extracting frames (for video) or using the image directly
 *   3. Calling Claude Sonnet vision on each frame for emotion/attention scoring
 *   4. Synthesizing per-frame data into an executive insight report
 *
 * Claude vision is called directly (not via callClaude) because it requires
 * multimodal message content (image blocks). Cost is logged manually.
 * The synthesis step uses callClaude normally.
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const supabase  = require('../../db/supabase');
const { callClaude, extractJSON } = require('./anthropic');
// Pass 23 — em-dash sanitizer shared with insights.js. Applied to every
// creative_analysis JSONB write so CA reports have the same prose
// hygiene as the survey insights.
const { sanitizeAIOutputDeep } = require('./insights');
const { WRITING_STYLE } = require('./writingStyle');
const logger    = require('../../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Model for per-frame vision calls
const VISION_MODEL = 'claude-sonnet-4-6';
const VISION_INPUT_PRICE  = 3.00;  // $ per 1M tokens
const VISION_OUTPUT_PRICE = 15.00;

// ── System prompt for synthesis (cached) ───────────────────────────────────

const CREATIVE_SYNTH_SYSTEM = `You are a senior creative strategist specialising in advertising effectiveness and consumer psychology.
You receive per-frame emotional and attention data from a marketing creative and synthesize it into an executive report.
Your report must be grounded in the data. Do not fabricate scores not present in the input.
Always return ONLY valid JSON with no markdown fences.
${WRITING_STYLE}`;

// ── Frame extraction ────────────────────────────────────────────────────────

/**
 * Pass 23 Bug 23.79 — detect image MIME from magic bytes.
 *
 * Anthropic Vision API requires media_type to match the actual image
 * format (image/jpeg, image/png, image/gif, image/webp). The previous
 * code hardcoded 'image/jpeg' for every frame, which hard-failed on
 * WebP uploads (Nike Air Jordan mission dcbc3b6f, $19 lost). File
 * extensions and Content-Type headers can lie; magic bytes don't.
 *
 * Returns one of: 'image/jpeg', 'image/png', 'image/gif', 'image/webp'.
 * Throws an explicit error for unsupported formats so the runMission
 * catch path can auto-refund (Bug 23.80) instead of letting the
 * Anthropic 400 propagate as an opaque failure.
 */
function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) {
    throw new Error('Unsupported image: file too small to identify');
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  // GIF: GIF87a or GIF89a → "GIF8" (47 49 46 38)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif';
  }
  // WebP: RIFF....WEBP — bytes [0..3]='RIFF' (52 49 46 46), [8..11]='WEBP' (57 45 42 50)
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  throw new Error('Unsupported image format. Anthropic Vision accepts JPG, PNG, WebP, GIF.');
}

async function extractVideoFrames(buffer, { intervalSec = 1, maxFrames = 30 } = {}) {
  const ffmpeg     = require('fluent-ffmpeg');
  const { path: ffmpegPath } = require('@ffmpeg-installer/ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegPath);

  const fs   = require('fs');
  const path = require('path');
  const os   = require('os');

  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'vett-creative-'));
  const inputPath = path.join(tmpDir, 'input.mp4');
  fs.writeFileSync(inputPath, buffer);

  return new Promise((resolve, reject) => {
    const outputPattern = path.join(tmpDir, 'frame-%04d.jpg');

    ffmpeg(inputPath)
      .outputOptions([
        `-vf fps=1/${intervalSec}`,
        `-frames:v ${maxFrames}`,
        '-q:v 3',
      ])
      .output(outputPattern)
      .on('end', () => {
        const frames = [];
        const files  = fs.readdirSync(tmpDir)
          .filter((f) => f.startsWith('frame-'))
          .sort();

        for (let i = 0; i < files.length; i++) {
          const fp = path.join(tmpDir, files[i]);
          const fb = fs.readFileSync(fp);
          frames.push({
            base64:    fb.toString('base64'),
            timestamp: i * intervalSec,
          });
        }

        fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve(frames);
      })
      .on('error', (err) => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        reject(err);
      })
      .run();
  });
}

// ── Per-frame vision analysis ───────────────────────────────────────────────

async function analyzeFrame({ frame, mission, mediaType = 'image/jpeg' }) {
  // Pass 24 Bug 24.01 — 24-emotion taxonomy (Plutchik 8 + 16 nuanced
  // DAIVID-style). Old missions had 8 emotions; v2 expands the model's
  // expressive range without changing the call shape.
  const prompt = `You are analyzing frame at ${frame.timestamp}s of a marketing creative.

Brand: ${mission.brand_name || 'unknown'}
Target audience: ${mission.target_audience || 'general consumers'}
Desired emotions: ${(mission.desired_emotions || []).join(', ') || 'not specified'}
Key message/CTA: ${mission.key_message || 'not specified'}

Analyze this frame and return ONLY JSON:
{
  "timestamp": ${frame.timestamp},
  "emotions": {
    "joy": 0, "trust": 0, "fear": 0, "surprise": 0,
    "sadness": 0, "disgust": 0, "anger": 0, "anticipation": 0,
    "amusement": 0, "awe": 0, "contentment": 0, "pride": 0,
    "curiosity": 0, "nostalgia": 0, "romance": 0, "hope": 0,
    "calm": 0, "confusion": 0, "boredom": 0, "disappointment": 0,
    "contempt": 0, "embarrassment": 0, "guilt": 0, "irritation": 0
  },
  "attention_hotspots": ["where eyes naturally focus, be specific"],
  "message_clarity": 0,
  "audience_resonance": 0,
  "engagement_score": 0,
  "brief_description": "One sentence of what is happening in this frame"
}

All numeric scores: 0 to 100 integers. Score every emotion (most will be 0-20; only score >50 when the emotion is a clear primary read). Scores must reflect what is actually visible. Do not guess.`;

  const start = Date.now();

  const response = await anthropic.messages.create({
    model: VISION_MODEL,
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type:       'base64',
              media_type: mediaType,
              data:        frame.base64,
            },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const inputTokens  = response.usage?.input_tokens  || 0;
  const outputTokens = response.usage?.output_tokens || 0;
  const costUsd = (inputTokens / 1_000_000) * VISION_INPUT_PRICE
                + (outputTokens / 1_000_000) * VISION_OUTPUT_PRICE;
  const latencyMs = Date.now() - start;

  // Log cost (non-blocking)
  supabase.from('ai_calls').insert({
    mission_id:   mission.id,
    user_id:      mission.user_id,
    call_type:    'creative_attention_frame',
    model:        VISION_MODEL,
    input_tokens:  inputTokens,
    output_tokens: outputTokens,
    cost_usd:      costUsd,
    latency_ms:    latencyMs,
    success:       true,
  }).then(() => {}).catch((e) => logger.warn('ai_calls insert failed', e));

  try {
    const text    = response.content[0]?.text || '';
    const cleaned = text.replace(/```json\n?|```/g, '').trim();
    return sanitizeAIOutputDeep(JSON.parse(cleaned));
  } catch (parseErr) {
    logger.warn('[CreativeAttention] frame parse error', { ts: frame.timestamp, err: parseErr.message });
    return null;
  }
}

// ── Synthesis ───────────────────────────────────────────────────────────────

async function synthesizeCreativeInsights({ frameAnalyses, mission }) {
  // Truncate frame data to stay within token limits
  const framesSummary = frameAnalyses
    .filter(Boolean)
    .map((f) => ({
      t: f.timestamp,
      eng: f.engagement_score,
      emotions: f.emotions,
      clarity: f.message_clarity,
      resonance: f.audience_resonance,
      desc: f.brief_description,
    }));

  // Pass 24 Bug 24.01 — synthesis now includes attention prediction,
  // cross-channel benchmarks, and Creative Effectiveness Score in
  // addition to the v1 summary fields. Channel norms are baked into
  // the prompt as published reference points (DAIVID/Amplified) so the
  // model isn't inventing benchmarks. Composite score is post-
  // processed deterministically (see computeEffectivenessScore below).
  const isVideoMission = framesSummary.length > 1;
  const durationHint = isVideoMission
    ? `Video duration ≈ ${Math.max(...framesSummary.map((f) => f.t || 0))}s`
    : 'Static image (single frame)';

  const prompt = `Synthesize these frame-by-frame analyses of a marketing creative.

Brand: ${mission.brand_name || 'unknown'}
Target audience: ${mission.target_audience || 'general'}
Desired emotions: ${(mission.desired_emotions || []).join(', ') || 'not specified'}
Key message: ${mission.key_message || 'not specified'}
Total frames analyzed: ${framesSummary.length}
${durationHint}

Frame data:
${JSON.stringify(framesSummary, null, 2).slice(0, 8000)}

PUBLISHED CHANNEL ATTENTION NORMS (DAIVID/Amplified — use these as the
ground truth for category_avg_attention_seconds in channel_benchmarks
AND for platform_norm_active_attention_seconds in best_platform_fit):
  Instagram Feed:        1.2s active attention
  TikTok Feed:           1.4s
  YouTube Pre-roll:      1.8s
  Pinterest:             1.5s
  Snapchat:              0.9s
  Meta Reels / Stories:  1.0s
  Programmatic Display:  0.4s
  OOH (digital billboard): 0.8s active, 4-6s passive
  CTV (15s):             4.5s
  CTV (30s):             8.0s
  TV (30s spot):         12.0s
  Print (luxury magazine): 2.5s
  Audio (Spotify/podcast): N/A (no visual attention)

Return ONLY JSON (no prose, no markdown fences):
{
  "overall_engagement_score": 0,
  "emotion_peaks": [
    { "emotion": "joy", "peak_timestamp": 0, "peak_value": 0, "interpretation": "What drove the peak" }
  ],
  "attention_arc": "2 sentences describing how attention and emotion shift across the creative",
  "strengths": ["Strength 1", "Strength 2", "Strength 3"],
  "weaknesses": ["Weakness 1", "Weakness 2"],
  "recommendations": [
    "Specific actionable recommendation 1",
    "Specific actionable recommendation 2",
    "Specific actionable recommendation 3"
  ],
  "vs_benchmark": "One sentence: how this creative compares to category benchmarks",
  "best_platform_fit": [
    {
      "platform": "Platform/medium name",
      "rationale": "1-2 sentence rationale tied to this creative's specific strengths",
      "platform_norm_active_attention_seconds": 1.2,
      "predicted_creative_attention_seconds": 1.6,
      "delta_vs_norm_pct": 33,
      "fit_score": 87
    }
  ],
  "attention": {
    "predicted_active_attention_seconds": 0.0,
    "predicted_passive_attention_seconds": 0.0,
    "active_attention_pct": 0,
    "passive_attention_pct": 0,
    "non_attention_pct": 0,
    "distinctive_brand_asset_score": 0,
    "dba_read_seconds": 0.0,
    "attention_decay_curve": [
      { "second": 0, "active_pct": 0 }
    ]
  },
  "channel_benchmarks": [
    {
      "channel": "TV (30s spot)",
      "category_avg_attention_seconds": 12.0,
      "predicted_for_this_creative": null,
      "fit_assessment": "Static image — TV requires motion. For a 30s adaptation, the [specific element] would suit second-screen capable contexts."
    },
    {
      "channel": "Social Feed (paid)",
      "category_avg_attention_seconds": 1.2,
      "predicted_for_this_creative": 1.6,
      "fit_assessment": "Strong fit. +33% vs norm because [specific reason]."
    },
    {
      "channel": "OOH (billboard)",
      "category_avg_attention_seconds": 0.8,
      "predicted_for_this_creative": 0.9,
      "fit_assessment": "Adequate. Brand identifiable at distance. [Caveat about fidelity]."
    },
    {
      "channel": "CTV (15s)",
      "category_avg_attention_seconds": 4.5,
      "predicted_for_this_creative": null,
      "fit_assessment": "Static image — CTV requires motion. Recommend developing 15s motion extension."
    },
    {
      "channel": "Programmatic Display",
      "category_avg_attention_seconds": 0.4,
      "predicted_for_this_creative": 0.6,
      "fit_assessment": "Above category norm. [Specific reason]."
    }
  ],
  "creative_effectiveness": {
    "components": {
      "attention": 0,
      "emotion_intensity": 0,
      "brand_clarity": 0,
      "audience_resonance": 0,
      "platform_fit": 0
    },
    "band_explanation": "1-2 sentence narrative anchored in the strongest and weakest sub-component."
  }
}

CRITICAL — attention block:
- Predict active vs passive attention based on visual hierarchy, brand
  prominence, motion, contrast, and production craft. For static images,
  base the prediction on the 3-second first-contact window. For video,
  predict the per-second decay over the duration.
- active_attention_pct + passive_attention_pct + non_attention_pct must
  sum to 100.
- distinctive_brand_asset_score: 0-100 read of how immediately the brand
  is identifiable (the "1.5 second rule"). dba_read_seconds is the
  estimated seconds to brand identification (0.5-3.0 typical range).
- attention_decay_curve:
    Static image: ONE entry at second=0 (the first-contact value).
    Video: bucketed every 1s up to mission duration (cap 30 entries).

CRITICAL — channel_benchmarks:
- Always include all 5 channels above. Use the published norms verbatim
  for category_avg_attention_seconds.
- predicted_for_this_creative: null when the creative format doesn't fit
  the channel (e.g. static image for TV/CTV — those require motion).
  Otherwise predict a number that is plausible relative to the norm.
- fit_assessment: 1-2 sentences, specific to THIS creative's strengths
  and limitations.

CRITICAL — creative_effectiveness.components:
- All five 0-100. attention reflects the dwell-time prediction quality;
  emotion_intensity is the strongest emotion peak; brand_clarity tracks
  message_clarity; audience_resonance from frame averages; platform_fit
  from the average fit_score across best_platform_fit.
- Do NOT compute the composite score yourself — backend post-processes
  using fixed weights (attention 0.25, emotion 0.25, clarity 0.20,
  resonance 0.15, platform 0.15) for determinism.

CRITICAL FOR best_platform_fit:
Recommend 3-5 best platform/medium fits for THIS creative across the FULL
media mix. Do NOT default to social-only ("Instagram, TikTok"). Consider:
  PAID SOCIAL: Meta (Feed, Reels, Stories), TikTok, Snapchat, Pinterest, X
  PROGRAMMATIC DISPLAY: Google Display, Taboola, Outbrain, native placements
  SEARCH: Google Ads, Bing
  VIDEO: YouTube pre-roll, CTV (Roku, Samsung TV+), traditional TV
  OUT-OF-HOME: billboards, transit, mall displays, airports, digital screens
  AUDIO: Spotify ads, podcast pre-roll, radio
  RETAIL MEDIA: Amazon Ads, Noon Ads, regional retail networks
  EMAIL/CRM: newsletters, lifecycle automation
  INFLUENCER PARTNERSHIPS: creator content, branded posts
  PRINT: magazines, luxury contexts
  DIRECT MAIL: DTC brands, premium experiences
For EACH recommendation:
  - Tie the rationale to THIS creative's specific strengths.
  - platform_norm_active_attention_seconds: pull from the norms above.
  - predicted_creative_attention_seconds: realistic prediction.
  - delta_vs_norm_pct: ((predicted / norm) - 1) * 100, integer.
  - fit_score: 0-100, how well this creative fits the platform.
Diversify across paid social + at least 2 non-social channels.`;

  const result = await callClaude({
    callType:         'creative_attention_synthesis',
    systemPrompt:     CREATIVE_SYNTH_SYSTEM,
    messages:         [{ role: 'user', content: prompt }],
    missionId:        mission.id,
    userId:           mission.user_id,
    maxTokens:        4000,  // Bug 24.01 — output is ~2x larger now
    enablePromptCache: true,
  });

  const parsed = sanitizeAIOutputDeep(extractJSON(result.text));
  return computeEffectivenessScore(parsed);
}

// ── Composite Effectiveness Score (deterministic post-processing) ───────────

const EFFECTIVENESS_WEIGHTS = {
  attention:         0.25,
  emotion_intensity: 0.25,
  brand_clarity:     0.20,
  audience_resonance: 0.15,
  platform_fit:      0.15,
};

/**
 * Pass 24 Bug 24.01 B3 — recompute composite from the AI-supplied
 * components using fixed weights. The model can drift on its own
 * composite (we've seen ±15% variance run-to-run); the components
 * themselves are the AI's read, but the math is deterministic.
 *
 * Mutates `summary.creative_effectiveness` to add `score`, `weights`,
 * and `band` fields. Falls back gracefully if components are missing
 * (legacy parse path or model omission).
 */
function computeEffectivenessScore(summary) {
  if (!summary || typeof summary !== 'object') return summary;
  const eff = summary.creative_effectiveness;
  if (!eff || typeof eff !== 'object' || !eff.components) return summary;

  const c = eff.components;
  const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));
  const w = EFFECTIVENESS_WEIGHTS;
  const composite =
    clamp(c.attention)         * w.attention +
    clamp(c.emotion_intensity) * w.emotion_intensity +
    clamp(c.brand_clarity)     * w.brand_clarity +
    clamp(c.audience_resonance) * w.audience_resonance +
    clamp(c.platform_fit)      * w.platform_fit;
  const score = Math.round(composite);

  let band;
  if (score >= 85)      band = 'elite';
  else if (score >= 70) band = 'strong';
  else if (score >= 50) band = 'average';
  else if (score >= 30) band = 'weak';
  else                  band = 'poor';

  summary.creative_effectiveness = {
    ...eff,
    score,
    weights: w,
    band,
  };
  return summary;
}

// ── Main entry point ────────────────────────────────────────────────────────

async function analyzeCreative({ mission }) {
  const attachment = mission.brief_attachment;
  if (!attachment?.path) {
    throw new Error('No creative file attached to this mission');
  }

  logger.info('[CreativeAttention] starting', {
    missionId: mission.id,
    path:      attachment.path,
    mimeType:  attachment.mimeType,
  });

  // 1. Download from Supabase Storage
  const bucket = 'vett-creatives';
  const { data: fileData, error: dlErr } = await supabase.storage
    .from(bucket)
    .download(attachment.path);

  if (dlErr) {
    throw new Error(`Storage download failed: ${dlErr.message}`);
  }

  const buffer  = Buffer.from(await fileData.arrayBuffer());
  const isVideo = (attachment.mimeType || '').startsWith('video/');

  // 2. Extract frames + resolve the media_type the Anthropic Vision API
  //    expects. Pass 23 Bug 23.79 — detect from magic bytes so WebP /
  //    PNG / GIF uploads don't hard-fail with the old hardcoded
  //    image/jpeg. Video frames come out of ffmpeg as JPEG so the video
  //    branch always uses image/jpeg.
  let frames = [];
  let frameMediaType = 'image/jpeg';
  if (isVideo) {
    logger.info('[CreativeAttention] extracting video frames', { missionId: mission.id });
    frames = await extractVideoFrames(buffer, { intervalSec: 1, maxFrames: 30 });
    // ffmpeg output → image/jpeg
  } else {
    // Single image — detect MIME from magic bytes (extension/Content-Type
    // can lie; buffer header doesn't). Throws on unsupported format so
    // runMission's catch block can auto-refund per Bug 23.80.
    frameMediaType = detectImageMime(buffer);
    frames = [{ base64: buffer.toString('base64'), timestamp: 0 }];
  }

  logger.info('[CreativeAttention] frames ready', {
    missionId: mission.id, count: frames.length, mediaType: frameMediaType,
  });

  // 3. Analyze each frame with Claude vision
  const frameAnalyses = [];
  for (const frame of frames) {
    const result = await analyzeFrame({ frame, mission, mediaType: frameMediaType });
    if (result) frameAnalyses.push(result);

    // Small delay to avoid rate limiting on long videos
    if (frames.length > 5) await new Promise((r) => setTimeout(r, 200));
  }

  logger.info('[CreativeAttention] frame analyses done', {
    missionId: mission.id,
    analyzed:  frameAnalyses.length,
    of:        frames.length,
  });

  // 4. Synthesize into summary report
  const summary = await synthesizeCreativeInsights({ frameAnalyses, mission });

  // 5. Persist to mission
  // Pass 24 Bug 24.01 — lift v2 fields (attention, channel_benchmarks,
  // creative_effectiveness) to TOP-LEVEL on the creative_analysis JSONB
  // so the frontend types map cleanly. The synthesis prompt returns
  // them inside `summary` for prompt-template clarity; we promote them
  // here. Old fields stay on `summary` for backwards-compat.
  const { attention, channel_benchmarks, creative_effectiveness, ...summaryRest } = summary || {};

  const creative_analysis_v2 = {
    schema_version: 'v2',
    frame_analyses: frameAnalyses,
    summary:        summaryRest,
    total_frames:   frames.length,
    is_video:       isVideo,
    generated_at:   new Date().toISOString(),
    // V2 additions — only included when the AI returned them. Frontend
    // tolerates absence (Bug 24.01 backwards-compat fallback).
    ...(attention            ? { attention }            : {}),
    ...(channel_benchmarks   ? { channel_benchmarks }   : {}),
    ...(creative_effectiveness ? { creative_effectiveness } : {}),
  };

  const { error: saveErr } = await supabase.from('missions').update({
    creative_analysis: creative_analysis_v2,
    status:       'completed',
    completed_at: new Date().toISOString(),
  }).eq('id', mission.id);

  if (saveErr) {
    logger.error('[CreativeAttention] save failed', { missionId: mission.id, err: saveErr.message });
    throw saveErr;
  }

  logger.info('[CreativeAttention] complete', { missionId: mission.id });
  return { frameAnalyses, summary };
}

module.exports = { analyzeCreative };
