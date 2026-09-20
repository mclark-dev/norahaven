const { clearCookie } = require('./_auth.js');
module.exports = async function handler(req, res) {
  clearCookie(res);
  return res.status(200).json({ ok: true });
};
