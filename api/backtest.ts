import { env } from "../lib/env.js";
import { listRecentTickets, getTicket, listMessages } from "../lib/gorgias.js";
import { triage, runReplyAgent, composeFirstTouch } from "../lib/agent.js";
import { ALWAYS_ESCALATE_CATEGORIES, AUTO_SEND_CATEGORIES, MIN_AUTO_CONFIDENCE } from "../lib/guardrails.js";
import { audit, getSetting } from "../lib/db.js";

export const config = { maxDuration: 300 };

/**
 * BACK-TEST BENCH — read-only replay of past tickets.
 *
 * Runs Poppy's full brain (triage + reply agent with real KB and Shopify
 * lookups) on a historical ticket and returns what she WOULD have done.
 * By construction this endpoint never calls sendReply, postInternalNote,
 * addTags, or setTicketStatus — nothing reaches customers or Gorgias.
 *
 * Protected by the console password (x-console-key).
 *
 * POST {"list": true, "limit": 25, "cursor": "..."}  -> recent ticket ids/subjects to pick from
 * POST {"ticket_id": 123}                             -> full dry run of that ticket
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const expected = process.env.CONSOLE_PASSWORD;
  if (!expected || ((req.headers["x-console-key"] as string) ?? "") !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    if (req.body?.list) {
      const limit = Math.min(parseInt(String(req.body.limit ?? "25"), 10) || 25, 100);
      const { tickets, nextCursor } = await listRecentTickets(limit, req.body.cursor ? String(req.body.cursor) : undefined);
      return res.status(200).json({
        tickets: tickets.map((t) => ({
          id: t.id,
          subject: t.subject,
          channel: t.channel,
          status: t.status,
          customer: t.customer?.email ?? null,
        })),
        nextCursor,
      });
    }

    const ticketId = parseInt(String(req.body?.ticket_id ?? ""), 10);
    if (!ticketId) return res.status(400).json({ error: "ticket_id or list required" });

    const ticket = await getTicket(ticketId);
    const messages = await listMessages(ticketId);
    const lastCustomerMsg = [...messages].reverse().find((m) => !m.from_agent && m.channel !== "internal-note");

    // Peek mode: return the ticket's channel and complete customer message(s),
    // no AI involved. Used to show the team exactly what the customer sent.
    if (req.body?.peek) {
      return res.status(200).json({
        ticket_id: ticketId,
        channel: ticket.channel,
        subject: ticket.subject,
        customer: ticket.customer?.email ?? null,
        full_message: lastCustomerMsg?.body_text ?? null,
      });
    }

    if (!lastCustomerMsg) return res.status(200).json({ ticket_id: ticketId, skipped: "no customer message on ticket" });

    const tri = await triage(ticket.subject ?? "", lastCustomerMsg.body_text ?? "");

    // What the guardrails WOULD decide (evaluated inline so nothing counts against caps)
    let wouldDo: string;
    if (tri.category === "spam") wouldDo = "skip (spam)";
    else if (ALWAYS_ESCALATE_CATEGORIES.has(tri.category)) wouldDo = "escalate to human (protected category)";
    else if (!AUTO_SEND_CATEGORIES.has(tri.category)) wouldDo = "draft for review (not on auto-send list)";
    else if (tri.confidence < MIN_AUTO_CONFIDENCE) wouldDo = `draft for review (confidence ${tri.confidence} below ${MIN_AUTO_CONFIDENCE})`;
    else wouldDo = "answer autonomously (in auto mode; drafts in draft mode)";

    // Run the full pipeline for every non-spam ticket:
    //  - if she'd answer, that reply (+ footer) is the outgoing email
    //  - if it goes to the team, her personal first-touch (+ footer) is the
    //    outgoing email — or nothing, when she judges it a system message
    let proposedReply: string | null = null;
    let escalationReason: string | null = null;
    let firstTouch: string | null = null;
    let outgoingEmail: string | null = null;
    if (tri.category !== "spam") {
      const responseTime = await getSetting("human_response_time", "1-2 business days");
      const wouldAnswer = !ALWAYS_ESCALATE_CATEGORIES.has(tri.category);
      if (wouldAnswer) {
        const outcome = await runReplyAgent({ ticket, messages, triageResult: tri, dbTicketId: 0 });
        proposedReply = outcome.action === "reply" ? (outcome.replyText ?? null) : null;
        escalationReason = outcome.action === "escalate" ? (outcome.escalationReason ?? null) : null;
      }
      if (proposedReply) {
        outgoingEmail = env.AGENT_FOOTER ? `${proposedReply}\n\n${env.AGENT_FOOTER}` : proposedReply;
      } else {
        // Going to the team (protected category, or the agent chose to escalate):
        // compose the personal first-touch the customer would receive right away.
        const ft = await composeFirstTouch({ ticket, messages, triageResult: tri, responseTime });
        if (ft === "NO_REPLY") firstTouch = "NO_REPLY";
        else if (ft) {
          firstTouch = ft;
          outgoingEmail = env.AGENT_FOOTER ? `${ft}\n\n${env.AGENT_FOOTER}` : ft;
        }
      }
    }

    await audit({ gorgias_ticket_id: ticketId, actor: "backtest", action: "backtest_run", output: { category: tri.category, wouldDo } });

    return res.status(200).json({
      ticket_id: ticketId,
      channel: ticket.channel,
      subject: ticket.subject,
      customer: ticket.customer?.email ?? null,
      customer_message: (lastCustomerMsg.body_text ?? "").slice(0, 6000),
      category: tri.category,
      confidence: tri.confidence,
      summary: tri.summary,
      would_do: wouldDo,
      proposed_reply: proposedReply,
      first_touch: firstTouch,
      escalation_reason: escalationReason,
      outgoing_email: outgoingEmail,
    });
  } catch (e: any) {
    return res.status(200).json({ error: (e.message ?? "backtest failed").slice(0, 400) });
  }
}
