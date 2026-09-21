import { env } from "../lib/env.js";
import { getSetting } from "../lib/db.js";
import { createMessage } from "../lib/anthropic.js";
import { getOrdersForEmail, getShippingProfiles } from "../lib/shopify.js";
import { driveConfigured, searchDrive } from "../lib/gdrive.js";
import { authenticate } from "../lib/auth.js";

/**
 * Connection self-test: checks each external service with a harmless read.
 * Protected by the console password (x-console-key header), same as the console.
 * GET /api/selftest -> { supabase, anthropic, gorgias, shopify } each { ok, detail }
 */

async function check(fn: () => Promise<string>): Promise<{ ok: boolean; detail: string }> {
  try {
    return { ok: true, detail: await fn() };
  } catch (e: any) {
    return { ok: false, detail: (e.message ?? "failed").slice(0, 300) };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!(await authenticate(req))) return res.status(401).json({ error: "unauthorized" });

  const [supabase, anthropic, gorgias, shopify, drive, shipping] = await Promise.all([
    check(async () => {
      const mode = await getSetting("agent_mode", "MISSING");
      if (mode === "MISSING") throw new Error("connected, but agent_mode setting not found");
      return `connected; agent_mode=${mode}`;
    }),
    check(async () => {
      const r = await createMessage({
        model: env.MODEL_TRIAGE,
        max_tokens: 5,
        messages: [{ role: "user", content: "Say OK" }],
      });
      const text = r.content.find((b) => b.type === "text")?.text ?? "";
      return `connected; model ${env.MODEL_TRIAGE} replied "${text.slice(0, 20)}"`;
    }),
    check(async () => {
      const r = await fetch(`https://${env.GORGIAS_DOMAIN}.gorgias.com/api/users/0`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${env.GORGIAS_USER_EMAIL}:${env.GORGIAS_API_KEY}`).toString("base64")}`,
        },
      });
      // 404 = reached Gorgias and authenticated (user 0 just doesn't exist). 401/403 = bad credentials.
      if (r.status === 401 || r.status === 403) throw new Error(`credentials rejected (${r.status}) — check GORGIAS_USER_EMAIL / GORGIAS_API_KEY`);
      if (r.status >= 500) throw new Error(`Gorgias server error ${r.status}`);
      return `connected to ${env.GORGIAS_DOMAIN}.gorgias.com; auth accepted`;
    }),
    check(async () => {
      const orders = await getOrdersForEmail("selftest-nonexistent@example.com", 1);
      return `connected to ${env.SHOPIFY_STORE_DOMAIN}; auth accepted (${orders.length} orders for test address, as expected)`;
    }),
    check(async () => {
      if (!driveConfigured()) return "not configured (optional) - set GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY to connect Drive";
      const asWho = env.GOOGLE_IMPERSONATE_EMAIL ? ` acting as ${env.GOOGLE_IMPERSONATE_EMAIL}` : "";
      const files = await searchDrive({ limit: 3 });
      return files.length
        ? `connected${asWho}; ${files.length}+ file(s) visible, e.g. "${files[0].name}"`
        : `connected and authenticated${asWho}, but NO files are visible - share the folders with ${env.GOOGLE_IMPERSONATE_EMAIL || "the service account email"}`;
    }),
    check(async () => {
      const rows = await getShippingProfiles(true);
      const profiles = new Set(rows.map((r) => r.profile)).size;
      return `shipping profiles readable: ${profiles} profiles, ${rows.length} active checkout rates`;
    }),
  ]);

  // Drive is optional: "not configured" doesn't fail the overall check.
  const allOk = [supabase, anthropic, gorgias, shopify, drive, shipping].every((c) => c.ok);
  return res.status(200).json({ allOk, supabase, anthropic, gorgias, shopify, drive, shipping });
}
