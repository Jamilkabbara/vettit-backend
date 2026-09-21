/**
 * A customer's uploaded file is not readable by anyone holding the link.
 *
 * `vettit-uploads` was marked public. A public bucket bypasses row level
 * security on read, so every file in it was served to anonymous requests -
 * proven on 2026-09-21 with a control: an anonymous GET of a file belonging to
 * a non-owner account returned HTTP 200 and 484,253 bytes, while the same
 * shape of request against the private bucket returned 400.
 *
 * The bucket already had correct per-user policies (read, write, update and
 * delete confined to your own folder). The `public` flag was the whole hole,
 * so the database half of this fix is one column, and the code half is to stop
 * minting URLs that never expire.
 */

const {
  parseStorageUrl, resolveAssetUrl, signedUrlFor, DEFAULT_TTL_SECONDS,
} = require('../src/services/media/storageUrls');

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

/** A storage client that signs, and records what it was asked to sign. */
function storage({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    storage: {
      from(bucket) {
        return {
          createSignedUrl: async (path, ttl) => {
            calls.push({ bucket, path, ttl });
            if (fail) return { data: null, error: { message: 'not found' } };
            return { data: { signedUrl: `https://storage.test/object/sign/${bucket}/${path}?token=t&exp=${ttl}` }, error: null };
          },
        };
      },
    },
  };
}

describe('reading a stored object', () => {
  test('a public URL from an older row still tells us where the file is', () => {
    expect(parseStorageUrl('https://x.supabase.co/storage/v1/object/public/vettit-uploads/user-1/2026/shot.png'))
      .toEqual({ bucket: 'vettit-uploads', path: 'user-1/2026/shot.png' });
  });

  test('a signed URL parses too, token and all', () => {
    expect(parseStorageUrl('https://x.supabase.co/storage/v1/object/sign/vett-creatives/u/ad.mp4?token=abc.def'))
      .toEqual({ bucket: 'vett-creatives', path: 'u/ad.mp4' });
  });

  test('an external link a customer pasted is not a storage object', () => {
    expect(parseStorageUrl('https://example.com/their-own-image.png')).toBeNull();
    expect(parseStorageUrl('')).toBeNull();
    expect(parseStorageUrl(null)).toBeNull();
  });
});

describe('minting a URL', () => {
  test('a path is signed, and the URL expires', async () => {
    const db = storage();
    const url = await resolveAssetUrl(db, { path: 'user-1/clip.mp4', bucket: 'vettit-uploads' });
    expect(url).toContain('/object/sign/');
    expect(db.calls[0]).toEqual({ bucket: 'vettit-uploads', path: 'user-1/clip.mp4', ttl: DEFAULT_TTL_SECONDS });
  });

  test('THE POINT: a row that stored a permanent public URL now resolves to a signed one', async () => {
    const db = storage();
    const url = await resolveAssetUrl(db, {
      url: 'https://x.supabase.co/storage/v1/object/public/vettit-uploads/user-1/old.png',
    });
    expect(url).toContain('/object/sign/');
    expect(url).not.toContain('/object/public/');
    expect(db.calls[0].path).toBe('user-1/old.png');
  });

  test('an external URL is handed back untouched, not signed', async () => {
    const db = storage();
    const url = await resolveAssetUrl(db, { url: 'https://example.com/theirs.png' });
    expect(url).toBe('https://example.com/theirs.png');
    expect(db.calls).toHaveLength(0);
  });

  test('a file that cannot be signed returns null rather than throwing', async () => {
    const db = storage({ fail: true });
    expect(await signedUrlFor(db, 'vettit-uploads', 'gone.png')).toBeNull();
    expect(await resolveAssetUrl(db, { path: 'gone.png', bucket: 'vettit-uploads' })).toBeNull();
  });
});

describe('no code path mints a URL that never expires', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('the upload route returns a signed URL and the path', () => {
    const src = read('src/routes/uploads.js');
    expect(src).toMatch(/signedUrlFor\(supabase, bucket, filename\)/);
    expect(src).not.toMatch(/getPublicUrl/);
    expect(src).toMatch(/res\.json\(\{ url, path: filename/);
  });

  test('a fresh URL can be asked for, and only for your own file', () => {
    const src = read('src/routes/uploads.js');
    expect(src).toMatch(/router\.get\('\/signed-url', authenticate/);
    expect(src).toMatch(/path\.startsWith\(req\.user\.id \+ '\/'\)/);
  });

  test('mission assets store a path and no permanent URL', () => {
    const src = read('src/services/missions/serverDerivedColumns.js');
    expect(src).not.toMatch(/getPublicUrl/);
    expect(src).toMatch(/url: null/);
  });
});
