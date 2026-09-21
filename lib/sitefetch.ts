/**
 * Live reads of The Flower Letters' OWN website — nothing else.
 *
 * This is deliberately not "internet access": the only host Poppy can fetch
 * is theflowerletters.com (and www.), read-only GETs, HTML stripped to plain
 * text and capped. It lets her check current site content (pricing, FAQ,
 * story pages, policies) when the Knowledge tab doesn't cover something,
 * without ever pulling from the open web.
 */

const ALLOWED_HOSTS = new Set(["theflowerletters.com", "www.theflowerletters.com"]);
const cache = new Map<string, { text: string; at: number }>();
const CACHE_MS = 10 * 60 * 1000; // pages barely change within a webhook's lifetime

export function normalizeSiteUrl(input: string): string | null {
  let raw = String(input ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("/")) raw = `https://theflowerletters.com${raw}`;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null;
    u.protocol = "https:";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchSitePage(input: string, maxChars = 9000): Promise<{ url: string; text: string } | { error: string }> {
  const url = normalizeSiteUrl(input);
  if (!url) return { error: "Only pages on theflowerletters.com can be read." };

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return { url, text: hit.text.slice(0, maxChars) };

  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": "Poppy/1.0 (The Flower Letters support agent)", Accept: "text/html" }, redirect: "follow" });
  } catch (e: any) {
    return { error: `Could not reach the page: ${(e.message ?? "network error").slice(0, 120)}` };
  }
  // A redirect may leave our site (e.g. a link shortener) — re-check the final host.
  try {
    if (!ALLOWED_HOSTS.has(new URL(res.url).hostname.toLowerCase())) return { error: "That page redirected off theflowerletters.com." };
  } catch { /* keep original url check */ }
  if (!res.ok) return { error: `The page returned ${res.status}. It may not exist - check the address.` };

  const html = (await res.text()).slice(0, 600000);
  const text = htmlToText(html);
  if (!text) return { error: "The page had no readable text." };
  cache.set(url, { text, at: Date.now() });
  return { url, text: text.slice(0, maxChars) };
}
