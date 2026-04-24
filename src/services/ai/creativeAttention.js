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
const logger    = require('../../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Model for per-frame vision calls
const VISION_MODEL = 'claude-sonnet-4-6';
const VISION_INPUT_PRICE  = 3.00;  // $ per 1M tokens
const VISION_OUTPUT_PRICE = 15.00;

// ── System prompt for synthesis (cached) ───────────────────────────────────

const CREATIVE_SYNTH_SYSTEM = `You are a senior creative strategist specialising in advertising effectiveness and consumer psychology.
You receive per-frame emotional and attention data from a marketing creative and synthesize it into an executive report.
Your report must be grounded in the data — do not fabricate scores not present in the input.
Always return ONLY valid JSON with no markdown fences.`;

// ── Frame extraction ────────────────────────────────────────────────────────

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

async function analyzeFrame({ frame, mission }) {
  const prompt = `You are analyzing frame at ${frame.timestamp}s of a marketing creative.

Brand: ${mission.brand_name || 'unknown'}
Target audience: ${mission.target_audience || 'general consumers'}
Desired emotions: ${(mission.desired_emotions || []).join(', ') || 'not specified'}
Key message/CTA: ${mission.key_message || 'not specified'}

Analyze this frame and return ONLY JSON:
{
  "timestamp": ${frame.timestamp},
  "emotions": {
    "joy": 0, "trust": 0, "surprise": 0, "anticipation": 0,
    "fear": 0, "sadness": 0, "disgust": 0, "anger": 0
  },
  "attention_hotspots": ["where eyes naturally focus — be specific"],
  "message_clarity": 0,
  "audience_resonance": 0,
  "engagement_score": 0,
  "brief_description": "One sentence of what is happening in this frame"
}

All numeric scores: 0–100 integers. Scores must reflect what is actually visible — do not guess.`;

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
              media_type: 'image/jpeg',
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
    return JSON.parse(cleaned);
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

  const prompt = `Synthesize these frame-by-frame analyses of a marketing creative.

Brand: ${mission.brand_name || 'unknown'}
Target audience: ${mission.target_audience || 'general'}
Desired emotions: ${(mission.desired_emotions || []).join(', ') || 'not specified'}
Key message: ${mission.key_message || 'not specified'}
Total frames analyzed: ${framesSummary.length}

Frame data:
${JSON.stringify(framesSummary, null, 2).slice(0, 8000)}

Return ONLY JSON:
{
  "overall_engagement_score": 0,
  "emotion_peaks": [
    {
      "emotion": "joy",
      "peak_timestamp": 0,
      "peak_value": 0,
      "interpretation": "What drove the peak"
    }
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
  "best_platform_fit": ["Platform 1", "Platform 2"]
}`;

  const result = await callClaude({
    callType:         'creative_attention_synthesis',
    systemPrompt:     CREATIVE_SYNTH_SYSTEM,
    messages:         [{ role: 'user', content: prompt }],
    missionId:        mission.id,
    userId:           mission.user_id,
    maxTokens:        2000,
    enablePromptCache: true,
  });

  return extractJSON(result.text);
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

  // 2. Extract frames
  let frames = [];
  if (isVideo) {
    logger.info('[CreativeAttention] extracting video frames', { missionId: mission.id });
    frames = await extractVideoFrames(buffer, { intervalSec: 1, maxFrames: 30 });
  } else {
    // Single image — analyze as one frame
    frames = [{ base64: buffer.toString('base64'), timestamp: 0 }];
  }

  logger.info('[CreativeAttention] frames ready', { missionId: mission.id, count: frames.length });

  // 3. Analyze each frame with Claude vision
  const frameAnalyses = [];
  for (const frame of frames) {
    const result = await analyzeFrame({ frame, mission });
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
  const { error: saveErr } = await supabase.from('missions').update({
    creative_analysis: {
      frame_analyses: frameAnalyses,
      summary,
      total_frames: frames.length,
      is_video:     isVideo,
      generated_at: new Date().toISOString(),
    },
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
