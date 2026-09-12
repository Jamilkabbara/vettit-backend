/**
 * VETT - what media type is the creative REALLY?
 *
 * Creative Attention is priced per creative: $19 for an image, $49 for a
 * video. The column that picks between them, missions.media_type, is written
 * by the browser at mission INSERT and has never been checked against the file
 * the customer actually uploaded.
 *
 * WHY THAT IS A PRICE AND NOT METADATA
 * The analysis pipeline does not read media_type at all. analyzeCreative
 * branches on brief_attachment.mimeType, another client-written string, and
 * then does whatever the bytes require: a video gets downloaded, cut into up
 * to 30 frames and sent through 30 serial vision calls plus a synthesis call.
 * So a mission row that says "image" while the stored object is an mp4 buys
 * the full video analysis for the image price. Nothing anywhere re-derived the
 * value from the object. src/routes/payments.js appeared to re-stamp it at
 * checkout, but it wrote `mission.media_type || null` - the row's own value
 * copied back onto the row, which verifies nothing.
 *
 * WHAT THIS MODULE TRUSTS
 * In descending order of how hard it is for a client to lie:
 *
 *   1. THE FIRST BYTES OF THE STORED OBJECT. Signed-URL Range request, 64
 *      bytes, classified by magic number. A client cannot make an mp4 open
 *      with an 0xFFD8FF JPEG header and still have it decode as video, so
 *      this is the one signal that is the file rather than a claim about it.
 *      Verified against production storage: the API answers 206 with exactly
 *      the requested 64 bytes, so this costs a few hundred bytes, not 2.6MB.
 *   2. THE STORAGE OBJECT'S RECORDED CONTENT TYPE (storage .info()). Weaker:
 *      the Storage API records whatever Content-Type the uploader sent. It is
 *      still a SEPARATE write from the mission row, so it catches the row
 *      being set to "image" without the upload being dressed to match, and it
 *      is the fallback when the byte read is unavailable.
 *
 * Deliberately NOT trusted: brief_attachment.mimeType and
 * brief_attachment.originalName. Both are fields of a JSONB blob the client
 * writes on the same INSERT that writes media_type, so agreeing with them
 * proves only that the client was internally consistent.
 *
 * WHAT IT CANNOT DECIDE
 * Anything with no stored object to read, and any format not in the magic
 * table. Both come back as "not checked" rather than as a verdict. Callers
 * must not read absence of a mismatch as proof of a match - see `checked`.
 */

'use strict';

const logger = require('../../utils/logger');

/**
 * The bucket analyzeCreative downloads from. Hardcoded there too; kept as a
 * named constant here so the two can be grepped together.
 */
const CREATIVE_BUCKET = 'vett-creatives';

/** Enough for every signature below, including ISO-BMFF's brand at 8..11. */
const SNIFF_BYTES = 64;

/** Seconds a signed URL stays valid. Used once, immediately. */
const SIGNED_URL_TTL_SECONDS = 60;

/**
 * ISO base media file format (the `....ftyp` family) covers BOTH mp4 video and
 * the HEIF still-image formats. The brand at bytes 8..11 is what separates
 * them, so these are the brands that mean "this is a picture" - everything
 * else carrying an ftyp box is treated as video.
 */
const ISO_BMFF_IMAGE_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx',
  'mif1', 'msf1', 'avif', 'avis',
]);

const ascii = (buf, from, to) => buf.slice(from, to).toString('latin1');

/**
 * Classify the first bytes of a file as 'image' or 'video'.
 *
 * @returns {{mediaType: 'image'|'video', format: string}|null} null when the
 *          signature is not one we recognise. Never a guess.
 */
function classifyMagicBytes(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const b = buffer;

  // ── Images ────────────────────────────────────────────────────────────────
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mediaType: 'image', format: 'jpeg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mediaType: 'image', format: 'png' };
  if (ascii(b, 0, 4) === 'GIF8') return { mediaType: 'image', format: 'gif' };
  if (b[0] === 0x42 && b[1] === 0x4d) return { mediaType: 'image', format: 'bmp' };
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) {
    return { mediaType: 'image', format: 'tiff' };
  }

  // ── RIFF containers - WEBP is a still, AVI is video ───────────────────────
  if (ascii(b, 0, 4) === 'RIFF') {
    const kind = ascii(b, 8, 12);
    if (kind === 'WEBP') return { mediaType: 'image', format: 'webp' };
    if (kind === 'AVI ') return { mediaType: 'video', format: 'avi' };
    return null;
  }

  // ── ISO base media (mp4 / mov / 3gp / heic / avif) ────────────────────────
  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12).toLowerCase();
    if (ISO_BMFF_IMAGE_BRANDS.has(brand)) return { mediaType: 'image', format: brand };
    return { mediaType: 'video', format: `iso-bmff:${brand.trim() || 'unknown'}` };
  }

  // ── Other video containers ────────────────────────────────────────────────
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mediaType: 'video', format: 'matroska/webm' };
  if (ascii(b, 0, 3) === 'FLV') return { mediaType: 'video', format: 'flv' };
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return { mediaType: 'video', format: 'asf/wmv' };
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && (b[3] === 0xba || b[3] === 0xb3)) {
    return { mediaType: 'video', format: 'mpeg-ps' };
  }

  return null;
}

/**
 * Classify a MIME string. Used only for the storage-recorded content type,
 * never for anything the client wrote onto the mission row.
 */
function classifyContentType(contentType) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (!ct) return null;
  if (ct === 'image/heic' || ct === 'image/heif' || ct === 'image/avif') return { mediaType: 'image', format: ct };
  if (ct.startsWith('image/')) return { mediaType: 'image', format: ct };
  if (ct.startsWith('video/')) return { mediaType: 'video', format: ct };
  return null;
}

/**
 * The price class a declared media_type falls into.
 *
 * validateMissionPricing accepts {image, video, bundle, series}, and
 * creativeAttentionPrice charges the image rate for bundle and series because
 * they "analyse as stills today". So the comparison that matters is not the
 * literal string, it is which of the two prices the row is asking for.
 * Otherwise a legitimate 'bundle' row would be refused for not literally
 * saying 'image'.
 */
function declaredPriceClass(mediaType) {
  const m = String(mediaType || '').toLowerCase().trim();
  if (!m) return null;
  return m === 'video' ? 'video' : 'image';
}

/**
 * Where the creative actually lives.
 *
 * brief_attachment.path is the only reference analyzeCreative uses and the
 * only one production rows carry - every creative_attention mission in the
 * database has a null creative_urls and an empty mission_assets, checked
 * read-only before this was written. Kept to that one field on purpose: a
 * second accepted location is a second thing to keep the price honest about.
 */
function creativeObjectPath(mission) {
  const path = mission && mission.brief_attachment && mission.brief_attachment.path;
  return typeof path === 'string' && path.trim() ? path.trim() : null;
}

/**
 * Read the first bytes of a stored object without downloading it.
 *
 * A signed URL plus a Range header. Supabase Storage answers 206 with exactly
 * the requested window; a server that ignored the Range and sent 200 with the
 * whole body still works, we just look at the front of it.
 */
async function readObjectHead(supabase, bucket, path, byteCount = SNIFF_BYTES) {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (error || !data || !data.signedUrl) {
    throw new Error(`could not sign creative URL: ${error ? error.message : 'no url returned'}`);
  }

  const res = await fetch(data.signedUrl, { headers: { Range: `bytes=0-${byteCount - 1}` } });
  if (!res.ok && res.status !== 206) {
    throw new Error(`creative head request failed: HTTP ${res.status}`);
  }
  const head = Buffer.from(await res.arrayBuffer());
  if (!head.length) throw new Error('creative head request returned no bytes');
  return head;
}

/**
 * Derive the media type of the mission's creative from the stored object.
 *
 * @returns {Promise<{checked: boolean, derived: 'image'|'video'|null,
 *                    source: string, format: string|null, path: string|null,
 *                    error: string|null}>}
 *
 * `checked: false` means "this module has no opinion" - not creative_attention,
 * nothing stored, storage unreachable, or a format outside the magic table.
 * It is never evidence that the row is honest.
 */
async function deriveCreativeMediaType(supabase, mission) {
  const base = { checked: false, derived: null, source: 'not_applicable', format: null, path: null, error: null };

  if (!mission || mission.goal_type !== 'creative_attention') return base;

  const path = creativeObjectPath(mission);
  if (!path) return { ...base, source: 'no_stored_object' };

  // 1. The bytes themselves.
  try {
    const head = await readObjectHead(supabase, CREATIVE_BUCKET, path);
    const hit = classifyMagicBytes(head);
    if (hit) {
      return { checked: true, derived: hit.mediaType, source: 'magic_bytes', format: hit.format, path, error: null };
    }
    logger.warn('creativeMediaType: stored object has an unrecognised signature', {
      missionId: mission.id, path, head: head.slice(0, 12).toString('hex'),
    });
  } catch (err) {
    logger.warn('creativeMediaType: could not read the stored object head', {
      missionId: mission.id, path, err: err.message,
    });
  }

  // 2. The content type the Storage API recorded at upload. Weaker - the
  //    uploader chose it - but it is a different write from the mission row.
  try {
    const { data, error } = await supabase.storage.from(CREATIVE_BUCKET).info(path);
    if (!error && data) {
      const hit = classifyContentType(data.contentType);
      if (hit) {
        return { checked: true, derived: hit.mediaType, source: 'storage_content_type', format: hit.format, path, error: null };
      }
    }
    return { ...base, path, source: 'unverifiable', error: error ? error.message : 'no usable signature' };
  } catch (err) {
    return { ...base, path, source: 'unverifiable', error: err.message };
  }
}

/**
 * Does the mission row's media_type agree with the stored object?
 *
 * @returns {Promise<{checked: boolean, ok: boolean, mismatch: boolean,
 *                    declared: string|null, declaredClass: string|null,
 *                    derived: 'image'|'video'|null, source: string,
 *                    format: string|null, path: string|null, error: string|null}>}
 *
 * `mismatch: true` is the only hard verdict this returns. Callers fail closed
 * on it. `checked: false` is an unanswered question and callers are documented
 * where they choose what to do with it.
 */
async function verifyCreativeMediaType(supabase, mission) {
  const d = await deriveCreativeMediaType(supabase, mission);
  const declared = mission ? mission.media_type || null : null;
  const declaredClass = declaredPriceClass(declared);

  if (!d.checked) {
    return { ...d, ok: true, mismatch: false, declared, declaredClass };
  }

  const mismatch = declaredClass !== null && declaredClass !== d.derived;
  if (mismatch) {
    logger.error('creativeMediaType: the row disagrees with the stored creative', {
      missionId: mission.id,
      declared, declaredClass, derived: d.derived,
      source: d.source, format: d.format, path: d.path,
    });
  }
  return { ...d, ok: !mismatch, mismatch, declared, declaredClass };
}

module.exports = {
  CREATIVE_BUCKET,
  SNIFF_BYTES,
  classifyMagicBytes,
  classifyContentType,
  declaredPriceClass,
  creativeObjectPath,
  readObjectHead,
  deriveCreativeMediaType,
  verifyCreativeMediaType,
};
