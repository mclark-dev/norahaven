import { pgSelect, pgUpsert, pgUpdate, pgCount, pgInsert, pgDelete, audit } from "../lib/db.js";
import { applyAddressChange, getOrderStatus } from "../lib/shopify.js";
import { postInternalNote } from "../lib/gorgias.js";
import { authenticate, atLeast, canEditKnowledge, generatePasscode, hashPassword, verifyPassword, normalizeEmail, isEmail } from "../lib/auth.js";
import { queryAudit, auditRowsForUI } from "../lib/auditquery.js";

/**
 * Backend for the team console (console.html). Password-protected via the
 * CONSOLE_PASSWORD env var, sent as the x-console-key header.
 *
 * GET  -> full snapshot: settings, stats, activity feed, KB articles
 * POST -> actions: set_setting | flag | kb_save
 *
 * Settings the console may change are allowlisted below; the always-escalate
 * (money) categories are enforced in guardrails code and have no setting at all.
 */

const EDITABLE_SETTINGS = new Set([
  "agent_mode",
  "human_response_time",
  "ack_template",
  "ack_enabled",
  "daily_send_cap",
  "max_auto_replies_per_ticket",
  "channels_enabled",
  "cat_mode_order_status",
  "cat_mode_shipping_info",
  "cat_mode_product_question",
  "cat_mode_general_faq",
  "cat_mode_collection_schedule",
  "cat_mode_feedback_comment",
  "address_change_mode",
  "offers_enabled",
  "response_time_auto",
]);

const VALID_VALUES: Record<string, RegExp> = {
  agent_mode: /^(off|draft|auto)$/,
  address_change_mode: /^(off|propose|auto)$/,
  offers_enabled: /^(true|false)$/,
  response_time_auto: /^(true|false)$/,
  ack_enabled: /^(true|false)$/,
  daily_send_cap: /^\d{1,5}$/,
  max_auto_replies_per_ticket: /^\d{1,2}$/,
  channels_enabled: /^[a-z-]+(,[a-z-]+)*$/,
};

// Settings only an admin may touch: the live master switches.
const ADMIN_ONLY_SETTINGS = new Set(["agent_mode", "address_change_mode"]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = `console:${user.name}`;

  try {
    if (req.method === "GET") {
      // Single-purpose logins (inventory-only, ask-poppy-only) get their identity
      // and nothing else - no activity, settings, knowledge, or pending actions
      // ever leave the server for them.
      if (user.role === "inventory" || user.role === "askpoppy") {
        return res.status(200).json({ me: { name: user.name, email: user.email, role: user.role, inv: user.inv } });
      }
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const [settings, tickets, kb, sent, drafts, escalated, flagged, pendingActions, kbTopics] = await Promise.all([
        pgSelect("cs_settings", "select=key,value&order=key"),
        pgSelect(
          "cs_tickets",
          "select=id,gorgias_ticket_id,customer_email,customer_name,subject,channel,category,confidence,agent_status,escalation_reason,updated_at&order=updated_at.desc&limit=30"
        ),
        pgSelect("cs_kb_articles", "select=slug,title,tags,topic,content,active,updated_at&order=slug"),
        pgCount("cs_audit_log", `action=eq.reply_sent&created_at=gte.${encodeURIComponent(since)}`),
        pgCount("cs_audit_log", `action=eq.draft_created&created_at=gte.${encodeURIComponent(since)}`),
        pgCount("cs_audit_log", `action=eq.escalated&created_at=gte.${encodeURIComponent(since)}`),
        pgCount("cs_audit_log", `action=eq.flagged&created_at=gte.${encodeURIComponent(since)}`),
        pgSelect("cs_pending_actions", "select=id,gorgias_ticket_id,order_name,customer_email,old_address,new_address,status,created_at&status=eq.pending&order=created_at.desc&limit=20"),
        pgSelect("cs_kb_topics", "select=name,sort&order=sort,name").catch(() => []),
      ]);

      // Attach the agent's outbound text + flag state per ticket (bounded: 30 tickets)
      const ids = tickets.map((t: any) => t.id).join(",");
      const [outbound, flags] = ids
        ? await Promise.all([
            pgSelect("cs_messages", `select=ticket_id,direction,body_text,created_at&direction=eq.outbound_agent&ticket_id=in.(${ids})&order=created_at.desc`),
            pgSelect("cs_audit_log", `select=gorgias_ticket_id&action=eq.flagged&gorgias_ticket_id=in.(${tickets.map((t: any) => t.gorgias_ticket_id).join(",")})`),
          ])
        : [[], []];
      const outByTicket: Record<number, string> = {};
      for (const m of outbound as any[]) if (!(m.ticket_id in outByTicket)) outByTicket[m.ticket_id] = m.body_text;
      const flaggedSet = new Set((flags as any[]).map((f) => f.gorgias_ticket_id));

      return res.status(200).json({
        me: { name: user.name, email: user.email, role: user.role, inv: user.inv },
        settings: Object.fromEntries((settings as any[]).map((s) => [s.key, s.value])),
        stats: { sent, drafts, escalated, flagged },
        activity: (tickets as any[]).map((t) => ({
          ...t,
          agent_reply: outByTicket[t.id] ?? null,
          flagged: flaggedSet.has(t.gorgias_ticket_id),
        })),
        kb,
        kb_topics: (kbTopics as any[]).map((t) => t.name),
        pending_actions: pendingActions,
        gorgias_domain: process.env.GORGIAS_DOMAIN ?? null,
      });
    }

    if (req.method === "POST") {
      const { action } = req.body ?? {};

      // Anyone with a personal login may change their own password (even viewers).
      if (action === "change_password") {
        if (user.id === null) return res.status(400).json({ error: "the master password is changed in Vercel (CONSOLE_PASSWORD), not here" });
        const current = String(req.body.current ?? "");
        const next = String(req.body.next ?? "");
        if (next.length < 8) return res.status(400).json({ error: "new password must be at least 8 characters" });
        if (next.length > 200) return res.status(400).json({ error: "new password is too long" });
        const rows = await pgSelect("cs_users", `select=key_hash&id=eq.${user.id}&limit=1`);
        if (!rows[0] || !verifyPassword(current, rows[0].key_hash)) return res.status(400).json({ error: "current password isn't right" });
        await pgUpdate("cs_users", `id=eq.${user.id}`, { key_hash: hashPassword(next) });
        await audit({ actor, action: "password_changed", input: { id: user.id } });
        return res.status(200).json({ ok: true });
      }

      // Viewers see everything, change nothing.
      if (!atLeast(user, "team")) return res.status(403).json({ error: "your account is view-only" });

      // ---- audit log search (admin only; read-only) ----
      if (action === "audit_query") {
        if (!atLeast(user, "admin")) return res.status(403).json({ error: "only an admin can search the audit log" });
        const rows = await queryAudit({
          date_from: req.body.date_from ? String(req.body.date_from) : undefined,
          date_to: req.body.date_to ? String(req.body.date_to) : undefined,
          actor_contains: req.body.actor ? String(req.body.actor) : undefined,
          action_contains: req.body.act ? String(req.body.act) : undefined,
          ticket_id: req.body.ticket_id ? parseInt(String(req.body.ticket_id), 10) : undefined,
          limit: req.body.limit,
          offset: req.body.offset,
        });
        return res.status(200).json({ rows: auditRowsForUI(rows) });
      }

      // ---- user management (admin only) ----
      if (action === "users_list" || action === "user_create" || action === "user_update") {
        if (!atLeast(user, "admin")) return res.status(403).json({ error: "only an admin can manage users" });

        if (action === "users_list") {
          const users = await pgSelect("cs_users", "select=id,name,email,role,active,inv,created_at,last_seen&order=created_at");
          return res.status(200).json({ users });
        }
        if (action === "user_create") {
          const name = String(req.body.name ?? "").trim().slice(0, 60);
          const email = normalizeEmail(String(req.body.email ?? ""));
          const role = String(req.body.role ?? "team");
          const inv = String(req.body.inv ?? "none");
          if (!name) return res.status(400).json({ error: "name required" });
          if (!isEmail(email)) return res.status(400).json({ error: "a valid email is required - it's their username" });
          if (!/^(admin|team|viewer|inventory|askpoppy)$/.test(role)) return res.status(400).json({ error: "role must be admin, team, viewer, inventory, or askpoppy" });
          if (!/^(none|view|edit)$/.test(inv)) return res.status(400).json({ error: "inventory access must be none, view, or edit" });
          const passcode = generatePasscode();
          let row: any;
          try {
            row = await pgInsert("cs_users", { name, email, role, inv, key_hash: hashPassword(passcode), active: true });
          } catch (e: any) {
            if (e.isUniqueViolation) return res.status(400).json({ error: `${email} already has a login` });
            throw e;
          }
          await audit({ actor, action: "user_created", input: { id: row.id, name, email, role, inv } });
          // The temporary password is returned ONCE and never stored in plain text.
          return res.status(200).json({ ok: true, id: row.id, email, passcode });
        }
        // user_update: change role, active flag, name, email - or reset the password
        const id = parseInt(String(req.body.id ?? ""), 10);
        if (!id) return res.status(400).json({ error: "id required" });
        if (req.body.reset_password === true) {
          const passcode = generatePasscode();
          await pgUpdate("cs_users", `id=eq.${id}`, { key_hash: hashPassword(passcode) });
          await audit({ actor, action: "user_password_reset", input: { id } });
          return res.status(200).json({ ok: true, passcode });
        }
        const patch: Record<string, unknown> = {};
        if (req.body.role !== undefined) {
          if (!/^(admin|team|viewer|inventory|askpoppy)$/.test(String(req.body.role))) return res.status(400).json({ error: "bad role" });
          patch.role = String(req.body.role);
        }
        if (req.body.active !== undefined) patch.active = req.body.active === true;
        if (req.body.inv !== undefined) {
          if (!/^(none|view|edit)$/.test(String(req.body.inv))) return res.status(400).json({ error: "inventory access must be none, view, or edit" });
          patch.inv = String(req.body.inv);
        }
        if (req.body.name !== undefined) {
          const nm = String(req.body.name).trim().slice(0, 60);
          if (!nm) return res.status(400).json({ error: "name can't be empty" });
          patch.name = nm;
        }
        if (req.body.email !== undefined) {
          const em = normalizeEmail(String(req.body.email));
          if (!isEmail(em)) return res.status(400).json({ error: "bad email" });
          patch.email = em;
        }
        if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing to change" });
        await pgUpdate("cs_users", `id=eq.${id}`, patch);
        await audit({ actor, action: "user_updated", input: { id, ...patch } });
        return res.status(200).json({ ok: true });
      }

      if (action === "set_setting") {
        const key = String(req.body.key ?? "");
        const value = String(req.body.value ?? "");
        if (!EDITABLE_SETTINGS.has(key)) return res.status(400).json({ error: `setting ${key} is not editable` });
        if (ADMIN_ONLY_SETTINGS.has(key) && !atLeast(user, "admin")) return res.status(403).json({ error: "only an admin can change that switch" });
        if (key.startsWith("cat_mode_") && !/^(auto|draft|human)$/.test(value)) return res.status(400).json({ error: "bad value" });
        if (VALID_VALUES[key] && !VALID_VALUES[key].test(value)) return res.status(400).json({ error: "bad value" });
        if (value.length > 2000) return res.status(400).json({ error: "value too long" });
        await pgUpsert("cs_settings", { key, value, updated_at: new Date().toISOString() }, "key");
        await audit({ actor, action: "setting_changed", input: { key, value: value.slice(0, 200) } });
        return res.status(200).json({ ok: true });
      }

      if (action === "flag") {
        const gid = parseInt(String(req.body.gorgias_ticket_id ?? ""), 10);
        if (!gid) return res.status(400).json({ error: "gorgias_ticket_id required" });
        await audit({ gorgias_ticket_id: gid, actor, action: "flagged", input: { note: String(req.body.note ?? "").slice(0, 500) } });
        return res.status(200).json({ ok: true });
      }

      if (action === "resolve_action") {
        const id = parseInt(String(req.body.id ?? ""), 10);
        const approve = req.body.approve === true;
        if (!id) return res.status(400).json({ error: "id required" });
        const rows = await pgSelect("cs_pending_actions", `select=*&id=eq.${id}&status=eq.pending&limit=1`);
        const pa = rows[0];
        if (!pa) return res.status(400).json({ error: "not found or already resolved" });

        if (!approve) {
          await pgUpdate("cs_pending_actions", `id=eq.${id}`, { status: "rejected", resolved_at: new Date().toISOString() });
          await audit({ gorgias_ticket_id: pa.gorgias_ticket_id, actor, action: "address_change_rejected", input: { id } });
          return res.status(200).json({ ok: true });
        }
        try {
          // Re-check right before applying: the order may have shipped since staging.
          const cur = await getOrderStatus(pa.order_gid);
          if ((cur.fulfillmentStatus ?? "").toUpperCase() !== "UNFULFILLED") {
            await pgUpdate("cs_pending_actions", `id=eq.${id}`, { status: "failed", error: `order is now ${cur.fulfillmentStatus}`, resolved_at: new Date().toISOString() });
            return res.status(200).json({ ok: false, error: `Order is now ${cur.fulfillmentStatus} - handle manually` });
          }
          await applyAddressChange(
            { gid: pa.order_gid, name: pa.order_name, fulfillmentStatus: cur.fulfillmentStatus, note: cur.note, shippingAddress: pa.old_address ?? null },
            pa.new_address
          );
          await pgUpdate("cs_pending_actions", `id=eq.${id}`, { status: "applied", resolved_at: new Date().toISOString() });
          await audit({ gorgias_ticket_id: pa.gorgias_ticket_id, actor, action: "address_change_applied", input: { id, order: pa.order_name } });
          try {
            if (pa.gorgias_ticket_id) {
              await postInternalNote(pa.gorgias_ticket_id, `✅ Address change approved in Poppy's console and applied to ${pa.order_name}. Order note + "Poppy Address Change" tag added in Shopify.`);
            }
          } catch { /* note is best-effort */ }
          return res.status(200).json({ ok: true });
        } catch (e: any) {
          await pgUpdate("cs_pending_actions", `id=eq.${id}`, { status: "failed", error: (e.message ?? "").slice(0, 300), resolved_at: new Date().toISOString() });
          await audit({ gorgias_ticket_id: pa.gorgias_ticket_id, actor, action: "address_change_failed", input: { id }, output: { error: (e.message ?? "").slice(0, 300) }, ok: false });
          return res.status(200).json({ ok: false, error: (e.message ?? "apply failed").slice(0, 200) });
        }
      }

      // ---- knowledge (admin only: add / edit / delete articles and topics) ----
      if (action === "kb_save" || action === "kb_delete" || action === "kb_topic_create" || action === "kb_topic_delete") {
        if (!canEditKnowledge(user)) return res.status(403).json({ error: "only an admin can change the knowledge base" });

        if (action === "kb_save") {
          const slug = String(req.body.slug ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80);
          const title = String(req.body.title ?? "").slice(0, 200);
          const content = String(req.body.content ?? "").slice(0, 10000);
          const topic = String(req.body.topic ?? "Unsorted").slice(0, 80) || "Unsorted";
          const active = req.body.active !== false;
          if (!slug || !title || !content) return res.status(400).json({ error: "slug, title, content required" });
          await pgUpsert("cs_kb_articles", { slug, title, content, topic, active, updated_at: new Date().toISOString() }, "slug");
          await audit({ actor, action: "kb_saved", input: { slug, title, topic, active, chars: content.length } });
          return res.status(200).json({ ok: true });
        }

        if (action === "kb_delete") {
          const slug = String(req.body.slug ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80);
          if (!slug) return res.status(400).json({ error: "slug required" });
          const existing = await pgSelect("cs_kb_articles", `select=slug,title,topic&slug=eq.${encodeURIComponent(slug)}&limit=1`);
          if (!existing[0]) return res.status(400).json({ error: "no such article" });
          await pgDelete("cs_kb_articles", `slug=eq.${encodeURIComponent(slug)}`);
          await audit({ actor, action: "kb_deleted", input: { slug, title: (existing[0] as any).title, topic: (existing[0] as any).topic } });
          return res.status(200).json({ ok: true });
        }

        if (action === "kb_topic_create") {
          const name = String(req.body.name ?? "").trim().slice(0, 80);
          if (!name) return res.status(400).json({ error: "topic name required" });
          if (name.toLowerCase() === "unsorted") return res.status(400).json({ error: "Unsorted already exists" });
          await pgUpsert("cs_kb_topics", { name, sort: 500, created_by: actor }, "name");
          await audit({ actor, action: "kb_topic_created", input: { name } });
          return res.status(200).json({ ok: true });
        }

        // kb_topic_delete: the topic disappears, its articles fall back to Unsorted
        const name = String(req.body.name ?? "").trim().slice(0, 80);
        if (!name) return res.status(400).json({ error: "topic name required" });
        if (name === "Unsorted") return res.status(400).json({ error: "Unsorted can't be removed" });
        await pgUpdate("cs_kb_articles", `topic=eq.${encodeURIComponent(name)}`, { topic: "Unsorted" });
        await pgDelete("cs_kb_topics", `name=eq.${encodeURIComponent(name)}`);
        await audit({ actor, action: "kb_topic_deleted", input: { name } });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: "unknown action" });
    }

    return res.status(405).json({ error: "GET or POST" });
  } catch (e: any) {
    console.error("console-data error", e);
    return res.status(500).json({ error: (e.message ?? "server error").slice(0, 300) });
  }
}
