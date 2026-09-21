/**
 * A customer's uploaded file is theirs, so its URL expires.
 *
 * The `vettit-uploads` bucket was marked public. A public bucket bypasses row
 * level security on read, so every file in it was readable by anyone with the
 * URL, including a file belonging to an account that is not the owner's. The
 * bucket already had correct per-user policies (select/insert/update/delete on
 * your own folder); the `public` flag was the whole of the hole. Proven on
 * 2026-09-21: an anonymous GET returned 200 and the bytes, while the private
 * bucket returned 400 for the same shape of request.
 *
 * This module is the one place that turns a stored object into something a
 * browser can load. It mints a SIGNED url with a short life instead of a
 * permanent public one, and it can do that from either a path or a URL that an
 * older row stored back when the bucket was public.
 *
 * The service role bypasses RLS, so the backend can sign for any object; the
 * browser signs through its own session and gets only its own folder.
 */
'use strict';

const logger = require('../../utils/logger');

/** An hour: long enough to open a report and read it, short enough to expire. */
const DEFAULT_TTL_SECONDS = 3600;

/**
 * Pull the bucket and object path out of a stored Supabase Storage URL.
 * Handles both shapes a row may carry:
 *   .../storage/v1/object/public/<bucket>/<path>
 *   .../storage/v1/object/sign/<bucket>/<path>?token=...
 * @returns {{bucket: string, path: string}|null}
 */
function parseStorageUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const m = url.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+?)(?:\?|$)/);
  if (!m) return null;
  try {
    return { bucket: m[1], path: decodeURIComponent(m[2]) };
  } catch {
    return { bucket: m[1], path: m[2] };
  }
}

/**
 * A signed URL for one object, or null if it cannot be signed.
 * Never throws: a missing thumbnail must not fail a report.
 */
async function signedUrlFor(supabase, bucket, path, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!supabase || !bucket || !path) return null;
  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, ttlSeconds);
    if (error || !data || !data.signedUrl) {
      logger.warn('could not sign a storage URL', { bucket, path, err: error && error.message });
      return null;
    }
    return data.signedUrl;
  } catch (err) {
    logger.warn('signing a storage URL threw', { bucket, path, err: err.message });
    return null;
  }
}

/**
 * A viewable URL for a stored asset, from whatever the row happens to hold.
 *
 * Rows written before this change carry a permanent public URL; rows written
 * after carry a path and no URL. Both resolve, so making the bucket private
 * does not break the five missions whose assets predate it.
 *
 * @param {object} supabase
 * @param {{path?: string, url?: string, bucket?: string}} asset
 * @param {object} [opts] { bucket, ttlSeconds }
 */
async function resolveAssetUrl(supabase, asset, opts = {}) {
  if (!asset) return null;
  const ttl = opts.ttlSeconds || DEFAULT_TTL_SECONDS;

  if (asset.path) {
    const bucket = asset.bucket || opts.bucket;
    const signed = await signedUrlFor(supabase, bucket, asset.path, ttl);
    if (signed) return signed;
  }
  const parsed = parseStorageUrl(asset.url);
  if (parsed) return signedUrlFor(supabase, parsed.bucket, parsed.path, ttl);

  // Not a Supabase object (an external URL a customer pasted): hand it back.
  return asset.url || null;
}

module.exports = { DEFAULT_TTL_SECONDS, parseStorageUrl, signedUrlFor, resolveAssetUrl };
