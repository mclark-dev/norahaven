// Structure only: titles, narrators, piece order, page counts. No prose.
const { authed } = require('./_auth.js');
const DATA = require('./_data.js');

module.exports = async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  const parts = DATA.parts.map(p => ({
    part: p.part,
    element: p.element,
    chronicles: p.chronicles.map(c => ({
      n: c.n, letterTitle: c.letterTitle, narrator: c.narrator,
      pieces: c.pieces.map(x => x.kind === 'webp'
        ? { kind: 'webp', title: x.title, pages: x.pages, id: x.id }
        : { kind: 'text', title: x.title }),
    })),
  }));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ parts });
};
