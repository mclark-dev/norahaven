// Exchanges the shared password for a session cookie.
const crypto = require('crypto');
const { issue, setCookie } = require('./_auth.js');

// Constant-time compare so the response time can't be used to guess the password.
function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) {
    crypto.timingSafeEqual(x, x); // keep the work roughly constant
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const expected = process.env.ACCESS_PASSWORD;
  if (!expected) return res.status(500).json({ error: 'ACCESS_PASSWORD not set on this project' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const given = (body && body.password) || '';

  // Slow every attempt down a little; this is a single shared password.
  await new Promise(r => setTimeout(r, 400));

  if (!same(given, expected)) return res.status(401).json({ error: 'Incorrect password' });

  setCookie(res, issue());
  return res.status(200).json({ ok: true });
};
