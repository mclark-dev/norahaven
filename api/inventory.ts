import { authenticate, canSeeInventory, canEditInventory } from "../lib/auth.js";
import { audit } from "../lib/db.js";
import {
  buildForecast, buildOrder, orderCSV, setStock, recordDelivery, setBatchOverride, pullSheetCounts,
  parseMailingRef, lastCompletedMailing, mailingLabel, loadConfig,
} from "../lib/inventory.js";
import { getSetting, pgUpsert } from "../lib/db.js";

export const config = { maxDuration: 120 };

/**
 * Inventory forecast & PZ orders.
 *
 *   GET  /api/inventory                 -> full forecast (per-piece stock, runway, red flags)
 *   GET  /api/inventory?order=6         -> PZ order list for the next 6 mailings (JSON)
 *   GET  /api/inventory?order=6&csv=1   -> same as CSV download
 *
 *   POST { action: "set_stock", code, our?, pz?, as_of? }   (team+)
 *   POST { action: "delivery", code, qty, note? }           (team+)
 *   POST { action: "set_dailies", story, dailies }          (admin)
 *
 * Counts are "as of after <mailing>"; every mailing since is drawn down
 * automatically from the live batch counts. as_of accepts "2026-09 M1" or
 * "Sep 2026 Mailing 1"; default is the last completed mailing.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  // Inventory is opt-in per person: admins always, others only when their login
  // has been granted View or Edit on the Team tab.
  if (!canSeeInventory(user)) return res.status(403).json({ error: "inventory access hasn't been granted to your login - an admin can turn it on in the Team tab" });
  const actor = `console:${user.name}`;

  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
      const action = String(body.action ?? "");

      if (!canEditInventory(user)) return res.status(403).json({ error: "your inventory access is view-only - an admin can change it to Edit in the Team tab" });

      if (action === "set_stock") {
        const code = String(body.code ?? "").trim().toUpperCase();
        if (!code) return res.status(400).json({ error: "code required" });
        const our = body.our == null || body.our === "" ? undefined : Math.round(Number(body.our));
        const pz = body.pz == null || body.pz === "" ? undefined : Math.round(Number(body.pz));
        if (our === undefined && pz === undefined) return res.status(400).json({ error: "give our and/or pz" });
        if ((our !== undefined && !Number.isFinite(our)) || (pz !== undefined && !Number.isFinite(pz))) {
          return res.status(400).json({ error: "counts must be numbers" });
        }
        let asOf: number | undefined;
        if (body.as_of != null && body.as_of !== "") {
          const parsed = parseMailingRef(String(body.as_of));
          if (parsed == null) return res.status(400).json({ error: 'as_of must look like "2026-09 M1"' });
          asOf = parsed;
        }
        await setStock(code, { our, pz, as_of: asOf }, actor);
        await audit({ actor, action: "inventory_stock_set", input: { code, our, pz, as_of: asOf ? mailingLabel(asOf) : mailingLabel(lastCompletedMailing()) } });
        return res.status(200).json({ ok: true, updated_at: new Date().toISOString(), by: user.name });
      }

      if (action === "delivery") {
        const code = String(body.code ?? "").trim().toUpperCase();
        const qty = Math.round(Number(body.qty));
        if (!code || !Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: "code and a positive qty required" });
        await recordDelivery(code, qty, actor, body.note ? String(body.note).slice(0, 200) : undefined);
        await audit({ actor, action: "inventory_delivery", input: { code, qty, note: body.note ?? null } });
        return res.status(200).json({ ok: true, updated_at: new Date().toISOString(), by: user.name });
      }

      if (action === "sheet_pull") {
        // Overwrite counts from the inventory workbook: Our shelf from the
        // MAILING COUNTER tab ("ALL UP TOTAL" / AK), PZ from the PZ's Count
        // tab ("PZ Count" / AZ). Pieces missing from a tab are untouched.
        const parseAsOf = (v: unknown) => {
          if (v == null || v === "") return undefined;
          const p = parseMailingRef(String(v));
          if (p == null) throw Object.assign(new Error('as-of must look like "2026-09 M1"'), { bad_as_of: true });
          return p;
        };
        let shelfAsOf: number | undefined, pzAsOf: number | undefined;
        try { shelfAsOf = parseAsOf(body.shelf_as_of); pzAsOf = parseAsOf(body.pz_as_of); }
        catch (e: any) { if (e.bad_as_of) return res.status(400).json({ error: e.message }); throw e; }
        const r = await pullSheetCounts(actor, { shelf_as_of: shelfAsOf, pz_as_of: pzAsOf });
        await audit({
          actor, action: "inventory_sheet_pull",
          input: { shelf_as_of: mailingLabel(shelfAsOf ?? lastCompletedMailing()), pz_as_of: mailingLabel(pzAsOf ?? lastCompletedMailing()) },
          output: r,
        });
        return res.status(200).json({ ok: true, ...r, updated_at: new Date().toISOString(), by: user.name });
      }

      if (action === "set_batch") {
        // Manual batch-count override (or clear with active=null/""). Wins over
        // the Drive count until cleared; marked in the UI.
        const story = String(body.story ?? "").trim().toUpperCase();
        const batch = parseInt(String(body.batch ?? ""), 10);
        if (!story || !batch) return res.status(400).json({ error: "story and batch required" });
        let active: number | null = null;
        if (body.active != null && body.active !== "") {
          active = Math.round(Number(body.active));
          if (!Number.isFinite(active) || active < 0) return res.status(400).json({ error: "active must be a number (or blank to clear the override)" });
        }
        await setBatchOverride(story, batch, active, actor);
        await audit({ actor, action: "inventory_batch_override", input: { story, batch, active } });
        return res.status(200).json({ ok: true, updated_at: new Date().toISOString(), by: user.name });
      }

      if (action === "set_dailies") {
        if (user.role !== "admin") return res.status(403).json({ error: "admin only" });
        const story = String(body.story ?? "").trim().toUpperCase();
        const dailies = Math.round(Number(body.dailies));
        if (!story || !Number.isFinite(dailies) || dailies < 0) return res.status(400).json({ error: "story and dailies required" });
        const cfg = await loadConfig();
        const sc = cfg.stories.find((s) => s.batch === story);
        if (!sc) return res.status(400).json({ error: `unknown story ${story}` });
        sc.dailies = dailies;
        // persist only overridable parts
        const raw = await getSetting("inventory_config", "");
        let saved: any = {};
        try { saved = raw ? JSON.parse(raw) : {}; } catch { saved = {}; }
        saved.stories = cfg.stories;
        await pgUpsert("cs_settings", { key: "inventory_config", value: JSON.stringify(saved) }, "key");
        await audit({ actor, action: "inventory_config_set", input: { story, dailies } });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: `unknown action "${action}"` });
    }

    // GET
    const orderH = parseInt(String(req.query?.order ?? ""), 10);
    if (orderH) {
      const o = await buildOrder(orderH);
      await audit({ actor, action: "inventory_order_generated", input: { horizon: o.horizon }, output: { lines: o.lines.length } });
      if (String(req.query?.csv ?? "") === "1") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="pz-order-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.status(200).send(orderCSV(o));
      }
      return res.status(200).json({ order: o });
    }

    const forecast = await buildForecast();
    return res.status(200).json({ forecast });
  } catch (e: any) {
    const msg = String(e?.message ?? "inventory failed");
    const code = msg.startsWith("no_batch_report") ? 409 : 500;
    return res.status(code).json({ error: msg.slice(0, 300) });
  }
}
