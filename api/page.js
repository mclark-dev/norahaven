// Serves one page of a WebP enclosure.
//
// The Supabase bucket stays private. This runs server-side on Vercel, looks up
// the storage path for (file, page), asks Supabase for a short-lived signed URL
// at display width, and redirects the browser to it. The service key never
// reaches the client, and Vercel's Password Protection covers this route too.
//
// Env vars required on the Vercel project:
//   SUPABASE_URL                e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   service role key (server-side only)

const BUCKET = 'story-pages-new';
const WIDTH = 1600;          // Garden display width; originals are 2400px
const SIGN_TTL = 3600;       // seconds
const BROWSER_CACHE = 1500;  // comfortably inside SIGN_TTL

function toUuid(hex) {
  return hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

// Keep the slashes, escape everything else (paths contain spaces and dashes).
function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

module.exports = async function handler(req, res) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) {
    return res.status(500).json({ error: 'Supabase env vars not set on this project' });
  }

  const f = String(req.query.f || '');
  const p = parseInt(req.query.p, 10);
  if (!/^[0-9a-f]{32}$/.test(f)) return res.status(400).json({ error: 'bad file id' });
  if (!Number.isInteger(p) || p < 1 || p > 100) return res.status(400).json({ error: 'bad page' });

  const auth = { apikey: key, Authorization: 'Bearer ' + key };

  try {
    // 1. storage path for this page
    const q = new URL(base.replace(/\/$/, '') + '/rest/v1/pages');
    q.searchParams.set('file_id', 'eq.' + toUuid(f));
    q.searchParams.set('page_number', 'eq.' + p);
    q.searchParams.set('select', 'storage_path');
    q.searchParams.set('limit', '1');

    const lookup = await fetch(q, { headers: auth });
    if (!lookup.ok) return res.status(502).json({ error: 'lookup failed', status: lookup.status });
    const rows = await lookup.json();
    if (!rows.length) return res.status(404).json({ error: 'page not found' });
    const path = rows[0].storage_path;

    // 2. short-lived signed URL, resized for the reader
    const signUrl = base.replace(/\/$/, '') + '/storage/v1/object/sign/' + BUCKET + '/' + encodePath(path);
    const signed = await fetch(signUrl, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expiresIn: SIGN_TTL,
        transform: { width: WIDTH, resize: 'contain' },
      }),
    });
    if (!signed.ok) return res.status(502).json({ error: 'sign failed', status: signed.status });
    const { signedURL } = await signed.json();
    if (!signedURL) return res.status(502).json({ error: 'no signed url returned' });

    // 3. hand the browser the real image
    res.setHeader('Cache-Control', 'private, max-age=' + BROWSER_CACHE);
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.redirect(302, base.replace(/\/$/, '') + '/storage/v1' + signedURL);
  } catch (err) {
    return res.status(500).json({ error: 'unexpected', detail: String(err && err.message || err) });
  }
};
