import { env } from "../lib/env.js";
import { audit, claimEvent, getSetting, pgUpsert, pgUpdate, pgInsert, pgCount, pgSelect } from "../lib/db.js";
import { getTicket, listMessages, sendReply, postInternalNote, addTags, setTicketStatus } from "../lib/gorgias.js";
import { triage, runReplyAgent, composeFirstTouch, handoffNote } from "../lib/agent.js";
import type { HandoffCard } from "../lib/agent.js";
import { stageAddressChangeIfPossible } from "../lib/actions.js";
import { decideDisposition, TRIAGE_FIRST_CATEGORIES } from "../lib/guardrails.js";

export const config = { maxDuration: 300 };

function extractTicketId(body: any): number | null {
  const candidates = [body?.ticket_id, body?.ticket?.id, body?.id, body?.object?.id];
  for (const c of candidates) {
    const n = typeof c === "string" ? parseInt(c, 10) : c;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Category tag written onto every ticket Poppy touches, alongside the state tag
 * (ai-escalated / ai-answered / ai-draft / ai-action-staged). The pair lets the
 * team filter a Gorgias view by WHAT the ticket is, not just that a human is
 * needed - e.g. a "Resends" view on ai-resend.
 */
const CATEGORY_TAGS: Record<string, string> = {
  resend: "ai-resend",
  missing_letter: "ai-resend",
  damaged_or_missing: "ai-damaged",
  refund_or_cancel: "ai-refund",
  cancellation: "ai-refund",
  payment_issue: "ai-payment",
  address_change: "ai-address-change",
  gifting: "ai-gifting",
  gift_recipient: "ai-gifting",
  upset_customer: "ai-upset",
  legal_or_press: "ai-upset",
  order_status: "ai-order-status",
  shipping_info: "ai-shipping",
  product_question: "ai-product",
  general_faq: "ai-faq",
  collection_schedule: "ai-schedule",
  feedback_comment: "ai-feedback",
};

function categoryTag(category: string): string | null {
  return CATEGORY_TAGS[category] ?? (category ? `ai-${String(category).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}` : null);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Shared-secret check (custom header or ?secret= query param)
  const provided = (req.headers["x-webhook-secret"] as string) ?? (req.query.secret as string) ?? "";
  if (provided !== env.GORGIAS_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "bad secret" });
  }

  const ticketId = extractTicketId(req.body);
  if (!ticketId) return res.status(400).json({ error: "no ticket id in payload" });

  try {
    const mode = await getSetting("agent_mode", "draft");
    if (mode === "off") return res.status(200).json({ skipped: "agent_mode=off" });

    // Source of truth: fetch fresh from Gorgias rather than trusting the webhook payload
    const ticket = await getTicket(ticketId);
    const messages = await listMessages(ticketId);

    // Channel filter: the agent only touches channels enabled in the console (default: email only).
    const channelsEnabled = (await getSetting("channels_enabled", "email")).split(",").map((c) => c.trim());
    if (!channelsEnabled.includes(ticket.channel)) {
      await audit({ gorgias_ticket_id: ticketId, action: "skip_channel", input: { channel: ticket.channel } });
      return res.status(200).json({ skipped: `channel ${ticket.channel} not enabled` });
    }

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) return res.status(200).json({ skipped: "no messages" });
    if (lastMsg.from_agent || lastMsg.channel === "internal-note") {
      return res.status(200).json({ skipped: "last message not from customer" });
    }

    // Idempotency: one processing run per (ticket, latest customer message)
    const eventKey = `t${ticketId}-m${lastMsg.id}`;
    if (!(await claimEvent(eventKey))) {
      return res.status(200).json({ skipped: "already processed" });
    }

    // Never reply on top of a human agent actively working the ticket
    if (ticket.assignee_user && ticket.assignee_user.email !== env.GORGIAS_USER_EMAIL) {
      await audit({ gorgias_ticket_id: ticketId, action: "skip_assigned_to_human", input: { assignee: ticket.assignee_user.email } });
      return res.status(200).json({ skipped: "assigned to a human" });
    }

    // Upsert ticket + inbound message rows
    const tRow = await pgUpsert<{ id: number }>(
      "cs_tickets",
      {
        gorgias_ticket_id: ticketId,
        customer_email: ticket.customer?.email ?? null,
        customer_name: ticket.customer?.name ?? null,
        subject: ticket.subject,
        channel: ticket.channel,
        updated_at: new Date().toISOString(),
      },
      "gorgias_ticket_id"
    );
    const dbTicketId = tRow.id;

    await pgUpsert(
      "cs_messages",
      {
        ticket_id: dbTicketId,
        gorgias_message_id: lastMsg.id,
        direction: "inbound",
        body_text: lastMsg.body_text,
        meta: { channel: lastMsg.channel, via: lastMsg.via },
      },
      "gorgias_message_id"
    );

    // ---- Triage ----
    // If Poppy was mid-triage (waiting on the customer), the request keeps its type:
    // "yes, letter 4" on a resend thread is still a resend, not a new question.
    const prev = (await pgSelect<{ category: string | null; agent_status: string | null }>("cs_tickets", `select=category,agent_status&id=eq.${dbTicketId}&limit=1`).catch(() => []))[0];
    const rawTri = await triage(ticket.subject ?? "", lastMsg.body_text ?? "");
    const sticky = prev?.agent_status === "gathering" && prev.category && TRIAGE_FIRST_CATEGORIES.has(prev.category) && rawTri.category !== "spam";
    const tri = sticky ? { ...rawTri, category: prev!.category as string, summary: `${rawTri.summary} (follow-up on ${prev!.category})` } : rawTri;
    await audit({ ticket_id: dbTicketId, gorgias_ticket_id: ticketId, action: "triage", input: { subject: ticket.subject }, output: tri });
    await pgUpdate("cs_tickets", `id=eq.${dbTicketId}`, { category: tri.category, confidence: tri.confidence });

    // Type tag goes on immediately - before any disposition - so the team can
    // filter by kind even for tickets Poppy ends up answering herself.
    const catTag = categoryTag(tri.category);
    if (catTag && tri.category !== "spam") {
      try { await addTags(ticketId, [catTag]); } catch { /* tagging must never block a reply */ }
    }

    if (tri.category === "spam") {
      await addTags(ticketId, ["ai-spam"]);
      await pgUpdate("cs_tickets", `id=eq.${dbTicketId}`, { agent_status: "skipped" });
      await audit({ ticket_id: dbTicketId, gorgias_ticket_id: ticketId, action: "skip_spam" });
      return res.status(200).json({ skipped: "spam" });
    }

    // ---- Guardrail disposition ----
    const autoReplies = await pgCount("cs_audit_log", `gorgias_ticket_id=eq.${ticketId}&action=eq.reply_sent`);
    const decision = await decideDisposition({
      category: tri.category,
      confidence: tri.confidence,
      ticketAutoReplyCount: autoReplies,
    });
    await audit({ ticket_id: dbTicketId, gorgias_ticket_id: ticketId, action: "disposition", output: decision });

    if (decision.disposition === "skip") {
      await pgUpdate("cs_tickets", `id=eq.${dbTicketId}`, { agent_status: "skipped" });
      return res.status(200).json({ skipped: decision.reason });
    }

    // Personal first-touch when a human will answer: Poppy composes a specific,
    // warm acknowledgment (never promising outcomes) so every customer hears from
    // us within minutes. At most once per ticket, never for spam, and never for
    // system notifications/auto-replies (the composer returns null for those).
    // Falls back to the static ack_template if composition fails.
    const sendAckIfNeeded = async (contextNote?: string) => {
      if ((await getSetting("ack_enabled", "true")) !== "true") return;
      const alreadyTouched = await pgCount("cs_audit_log", `gorgias_ticket_id=eq.${ticketId}&action=in.(ack_sent,reply_sent,info_requested,handoff_sent)`);
      if (alreadyTouched > 0) return;
      const responseTime = await getSetting("human_response_time", "1-2 business days");

      let ackText = await composeFirstTouch({ ticket, messages, triageResult: tri, responseTime, contextNote });
      let mode: string = "personal";
      if (ackText === "NO_REPLY") {
        // Poppy judged this isn't a real customer (system notification, auto-reply).
        await audit({ ticket_id: dbTicketId, gorgias_ticket_id: ticketId, action: "ack_skipped_system" });
        return;
      }
      if (ackText === null) {
        // Composition failed — the customer still gets a first touch via the static template.
        const template = await getSetting(
          "ack_template",
          "Thank you for your message! We're reviewing your request and a member of our team will be in touch with an answer. Our current response time is {response_time}.\n\nThe Flower Letters team"
        );
        ackText = template.split("{response_time}").join(responseTime);
        mode = "template_fallback";
      }
      const finalAck = env.AGENT_FOOTER ? `${ackText}\n\n${env.AGENT_FOOTER}` : ackText;
      await sendReply(ticket, finalAck);
      await audit({ ticket_id: dbTicketId, gorgias_ticket_id: ticketId, action: "ack_sent", output: { response_time: responseTime, mode } });
    };

    const escalateTicket = async (reason: string, summary: string) => {
      await postInternalNote(ticketId, `🤖 CS Agent: escalating to a human.\nCategory: ${tri.category}\nReason: ${reason}\nSummary: ${summary}`);
      await addTags(ticketId, ["ai-escalated"]);
      await setTicketStatus(ticketId, "open");
      await pgUpdate("cs_tickets", `id=eq.${dbTicketId}`, { agent_status: "escalated", escalation_reason: reason });
      await audit({ ticket_id: dbTicketId, gorgias_ticket_id: ticketId, action: "escalated", output: { reason } });
    };

    if (decision.disposition === "escalate") {
      // Guarded action: for address changes, Poppy may stage (or in auto mode,
      // apply) the change on an UNFULFILLED order before the team sees it.
      let actionSummary = "";
      if (tri.category === "address_change") {
        try {
          const staged = await stageAddressChangeIfPossible({ ticket, messages, triageResult: tri, dbTicketId });
          actionSummary = staged.summary;
        } catch (e: any) {
          actionSummary = `Address-change staging errored: ${(e.message ?? "").slice(0, 150)}`;
        }
      }
      await sendAckIfNeeded(actionSummary || undefined);
      await escalateTicket(decision.reason + (actionSummary ? `\nPoppy: ${actionSummary}` : ""), tri.summary);
      return res.status(200).json({ escalated: decision.reason });
    }

    // ---- Run the reply agent (normal, or triage for requests that end with a person) ----
    const triageMode = decision.disposition === "triage";
    const gatherRoundsUsed = await pgCount("cs_audit_log", `gorgias_ticket_id=eq.${ticketId}&action=eq.info_requested`);
    const outcome = await runReplyAgent({ ticket, messages, triageResult: tri, dbTicketId, mode: triageMode ? "triage" : "normal", gatherRoundsUsed });

    const sendToCustomer = async (text: string, meta: Record<string, unknown>) => {
      const finalText = env.AGENT_FOOTER ? `${text}\n\n${env.AGENT_FOOTER}` : text;
      const sent = await sendReply(ticket, finalText);
      await pgInsert("cs_messages", {
        ticket_id: dbTicketId, gorgias_message_id: sent?.id ?? null, direction: "outbound_agent", body_text: text,
        meta: { category: tri.category, confidence: tri.confidence, ...meta },
      });
      return sent;
    };

    if (outcome.action === "escalate") {
      await sendAckIfNeeded();
      await escalateTicket(outcome.escalationReason ?? "agent escalated", tri.summary);
      return res.status(200).json({ escalated: outcome.escalationReason });
    }

    // Poppy needs something from the customer before she can answer or hand off.
    // Sent in draft AND auto mode (like the acknowledgment): it answers nothing and
    // promises nothing - it asks. The ticket waits; their reply re-triggers her.
    if (outcome.action === "ask") {
      const sent = await sendToCustomer(outcome.askText ?? "", { kind: "info_request" });
      await addTags(ticketId, ["ai-gathering"]);
      await setTicketStatus(ticketId, "closed"); // their reply reopens it and brings Poppy back
      await pgUpdate("cs_tickets", `id=eq.${dbTicketId}`, { agent_status: "gathering", escalation_reason: `Waiting on customer: ${(outcome.askMissing ?? []).join("; ")}` });
      await audit({ ticket_id: dbTicketId, gorgias_ticket_id: ticketId, action: "info_requested", output: { missing: outcome.askMissing ?? [], gorgias_message_id: sent?.id ?? null, round: gatherRoundsUsed + 1 } });
      return res.status(200).json({ gathering: outcome.askMissing ?? [] });
    }

    // Triaged and complete: the team gets a full card, the customer hears it's in hand.
    if (outcome.action === "handoff" && outcome.handoff) {
      const card: HandoffCard = outcome.handoff;
      let actionSummary = "";
      if (card.kind === "address_change" || tri.category === "address_change") {
        try {
          const staged = await stageAddressChangeIfPossible({ ticket, messages, triageResult: tri, dbTicketId });
          actionSummary = staged.summary;
        } catch (e: any) {
          actionSummary = `Address-change staging errored: ${(e.message ?? "").slice(0, 150)}`;
        }
      }
      const sent = await sendToCustomer(card.customerMessage, { kind: "handoff", handoff_kind: card.kind });
      const note = handoffNote(card, { name: ticket.customer?.name ?? null, email: ticket.customer?.email ?? null }, tri.category)
        + (actionSummary ? `\nAddress change: ${actionSummary}` : "");
      await postInternalNote(ticketId, note);
      await addTags(ticketId, ["ai-escalated", `ai-${card.kind.replace(/_/g, "-")}`]);
      await setTicketStatus(ticketId, "open");
      await pgUpdate("cs_tickets", `id=eq.${dbTicketId}`, { agent_status: "escalated", escalation_reason: note.slice(0, 1800) });
      await audit({ ticket_id: dbTicketId, gorgias_ticket_id: ticketId, action: "handoff_sent", output: { kind: card.kind, request: card.request, orders: card.orders.map((o) => o.name), gorgias_message_id: sent?.id ?? null } });
      return res.status(200).json({ handed_off: card.kind });
    }

    const replyText = outcome.replyText ?? "";

    // In triage mode Poppy may only answer when nothing needs doing yet - and that
    // answer is always drafted for a person to review, never auto-sent.
    if (decision.disposition === "draft" || triageMode) {
      await sendAckIfNeeded();
      await postInternalNote(
        ticketId,
        `🤖 CS Agent, PROPOSED REPLY (${tri.category}, confidence ${tri.confidence}):\n\n${replyText}\n\n(Review, copy into a reply, and send. Not auto-sent because: ${triageMode ? `${tri.category} requests are reviewed by a person before any answer goes out` : decision.reason})`
      );
      await addTags(ticketId, ["ai-draft"]);
      await pgUpdate("cs_tickets", `id=eq.${dbTicketId}`, { agent_status: "replied" });
      await audit({ ticket_id: dbTicketId, gorgias_ticket_id: ticketId, action: "draft_created", output: { chars: replyText.length } });
      return res.status(200).json({ drafted: true });
    }

    // ---- auto_send ----
    const finalText = env.AGENT_FOOTER ? `${replyText}\n\n${env.AGENT_FOOTER}` : replyText;
    const sent = await sendReply(ticket, finalText);
    await pgInsert("cs_messages", {
      ticket_id: dbTicketId,
      gorgias_message_id: sent?.id ?? null,
      direction: "outbound_agent",
      body_text: replyText,
      meta: { category: tri.category, confidence: tri.confidence },
    });
    await addTags(ticketId, ["ai-answered"]);
    await setTicketStatus(ticketId, "closed"); // a customer reply reopens the ticket and re-triggers us
    await pgUpdate("cs_tickets", `id=eq.${dbTicketId}`, { agent_status: "replied" });
    await audit({ ticket_id: dbTicketId, gorgias_ticket_id: ticketId, action: "reply_sent", output: { gorgias_message_id: sent?.id ?? null, chars: replyText.length } });
    return res.status(200).json({ sent: true });
  } catch (e: any) {
    console.error("webhook error", e);
    await audit({ gorgias_ticket_id: ticketId, action: "error", output: { message: (e.message ?? "").slice(0, 500) }, ok: false });
    // 200 so Gorgias doesn't hammer retries; the audit log is the alarm
    return res.status(200).json({ error: (e.message ?? "").slice(0, 200) });
  }
}
