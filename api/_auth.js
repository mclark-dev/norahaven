// Shared session helpers. A session is a signed, HttpOnly cookie — the password
// itself is never stored in the browser, and the cookie can't be forged without
// the secret. Rotating ACCESS_PASSWORD changes the secret, which signs everyone
// out automatically.
const crypto = require('crypto');

const COOKIE = 'na_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function secret() {
  const pw = process.env.ACCESS_PASSWORD || '';
  return crypto.createHash('sha256').update('na-v1:' + pw).digest();
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function issue() {
  const value = String(Date.now());
  return value + '.' + sign(value);
}

function valid(token) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return false;
  const i = token.lastIndexOf('.');
  const value = token.slice(0, i);
  const mac = token.slice(i + 1);
  const expected = sign(value);
  if (mac.length !== expected.length) return false;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  } catch (e) { return false; }
  const issued = Number(value);
  if (!Number.isFinite(issued)) return false;
  return (Date.now() - issued) < MAX_AGE * 1000;
}

function readCookie(req) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

// Every protected endpoint calls this first.
function authed(req) {
  if (!process.env.ACCESS_PASSWORD) return false; // fail closed if unconfigured
  return valid(readCookie(req));
}

function setCookie(res, token) {
  res.setHeader('Set-Cookie',
    COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + MAX_AGE);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}

module.exports = { COOKIE, MAX_AGE, issue, authed, setCookie, clearCookie };
