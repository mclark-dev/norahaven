import { pgSelect } from "./db.js";

export interface KbHit {
  slug: string;
  title: string;
  content: string;
}

/** Full-text search over the curated KB (PostgREST websearch fts, ilike fallback). */
export async function searchKb(query: string, limit = 4): Promise<KbHit[]> {
  const q = query.replace(/[^\w\s'-]/g, " ").trim();
  if (!q) return [];
  try {
    const hits = await pgSelect<KbHit>(
      "cs_kb_articles",
      `select=slug,title,content&active=eq.true&fts=wfts(english).${encodeURIComponent(q)}&limit=${limit}`
    );
    if (hits.length > 0) return hits;
  } catch {
    // fall through to ilike
  }
  const words = q.split(/\s+/).filter((w) => w.length > 3).slice(0, 3);
  if (words.length === 0) return [];
  const or = words.map((w) => `title.ilike.*${w}*,content.ilike.*${w}*`).join(",");
  try {
    return await pgSelect<KbHit>(
      "cs_kb_articles",
      `select=slug,title,content&active=eq.true&or=(${encodeURIComponent(or)})&limit=${limit}`
    );
  } catch {
    return [];
  }
}

export async function listKbTitles(): Promise<Array<{ slug: string; title: string }>> {
  try {
    return await pgSelect("cs_kb_articles", "select=slug,title&active=eq.true&order=slug");
  } catch {
    return [];
  }
}
