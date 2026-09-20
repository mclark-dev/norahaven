// One chronicle's prose, fetched on demand once the reader is signed in.
const { authed } = require('./_auth.js');
const DATA = require('./_data.js');

module.exports = async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  const n = parseInt(req.query.n, 10);
  if (!Number.isInteger(n) || n < 1 || n > 72) return res.status(400).json({ error: 'bad chronicle' });

  for (const p of DATA.parts) {
    for (const c of p.chronicles) {
      if (c.n !== n) continue;
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({
        n: c.n, letterTitle: c.letterTitle, narrator: c.narrator,
        pieces: c.pieces.map(x => x.kind === 'webp'
          ? { kind: 'webp', title: x.title, pages: x.pages, id: x.id }
          : { kind: 'text', title: x.title, blocks: x.blocks }),
      });
    }
  }
  return res.status(404).json({ error: 'not found' });
};
