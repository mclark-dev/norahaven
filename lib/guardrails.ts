import { getSetting, pgCount } from "./db.js";

/**
 * Guardrails live in CODE, not prompts. The model cannot reason its way past these.
 */

/** Categories the agent may auto-send in `auto` mode. Everything else drafts or escalates. */
export const AUTO_SEND_CATEGORIES = new Set([
  "order_status",
  "shipping_info",
  "product_question",
  "general_faq",
  "collection_schedule",
  "feedback_comment",
  "gift_recipient",
]);

/** Categories that ALWAYS escalate to a human. The agent never answers these, even in auto mode. */
export const ALWAYS_ESCALATE_CATEGORIES = new Set([
  "refund_request",
  "cancellation",
  "payment_issue",
  "address_change",
  "damaged_or_missing",
  "legal_or_press",
  "complaint_serious",
  "other",
]);

/**
 * Of the always-a-person categories, these are TRIAGED first: Poppy may confirm
 * what the customer wants and gather what the team needs (ask_customer), then
 * hands off a complete card. She still never takes the action or promises an
 * outcome - the final step is always a person's.
 */
export const TRIAGE_FIRST_CATEGORIES = new Set([
  "refund_request",
  "cancellation",
  "payment_issue",
  "address_change",
  "damaged_or_missing",
  "other",
]);

/** Straight to a person, no questions: legal, press, serious complaints. */
export const IMMEDIATE_ESCALATE_CATEGORIES = new Set(["legal_or_press", "complaint_serious"]);

export const MIN_AUTO_CONFIDENCE = 0.8;

export type Disposition = "auto_send" | "draft" | "triage" | "escalate" | "skip";

export async function decideDisposition(opts: {
  category: string;
  confidence: number;
  ticketAutoReplyCount: number;
}): Promise<{ disposition: Disposition; reason: string }> {
  const mode = await getSetting("agent_mode", "draft"); // off | draft | auto

  if (mode === "off") return { disposition: "skip", reason: "agent_mode=off" };

  if (IMMEDIATE_ESCALATE_CATEGORIES.has(opts.category)) {
    return { disposition: "escalate", reason: `category ${opts.category} goes straight to a person` };
  }
  if (TRIAGE_FIRST_CATEGORIES.has(opts.category)) {
    // Kill switch: triage_enabled=false restores the old behavior (acknowledge + escalate at once).
    if ((await getSetting("triage_enabled", "true")) !== "true") {
      return { disposition: "escalate", reason: `category ${opts.category} always escalates` };
    }
    return { disposition: "triage", reason: `category ${opts.category}: triage, then hand off to a person` };
  }
  if (ALWAYS_ESCALATE_CATEGORIES.has(opts.category)) {
    return { disposition: "escalate", reason: `category ${opts.category} always escalates` };
  }

  const maxPerTicket = parseInt(await getSetting("max_auto_replies_per_ticket", "3"), 10);
  if (opts.ticketAutoReplyCount >= maxPerTicket) {
    return { disposition: "escalate", reason: `hit per-ticket auto-reply cap (${maxPerTicket})` };
  }

  // Per-category setting from the console: auto | draft | human.
  // Only non-money categories are configurable; ALWAYS_ESCALATE above is checked first and cannot be overridden.
  const catMode = await getSetting(`cat_mode_${opts.category}`, "auto");
  if (catMode === "human") {
    return { disposition: "escalate", reason: `category ${opts.category} set to human-only in console` };
  }

  if (mode === "draft") return { disposition: "draft", reason: "agent_mode=draft" };
  if (catMode === "draft") return { disposition: "draft", reason: `category ${opts.category} set to draft in console` };

  // auto mode from here on
  const cap = parseInt(await getSetting("daily_send_cap", "200"), 10);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const sentLast24h = await pgCount("cs_audit_log", `action=eq.reply_sent&created_at=gte.${encodeURIComponent(since)}`);
  if (sentLast24h >= cap) {
    return { disposition: "draft", reason: `daily send cap (${cap}) reached, falling back to draft` };
  }

  if (!AUTO_SEND_CATEGORIES.has(opts.category)) {
    return { disposition: "draft", reason: `category ${opts.category} not on auto-send allowlist` };
  }
  if (opts.confidence < MIN_AUTO_CONFIDENCE) {
    return { disposition: "draft", reason: `confidence ${opts.confidence} below ${MIN_AUTO_CONFIDENCE}` };
  }
  return { disposition: "auto_send", reason: "auto mode, allowlisted category, confident" };
}
