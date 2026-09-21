import { env } from "./env.js";

const base = () => `https://${env.GORGIAS_DOMAIN}.gorgias.com/api`;

function authHeader(): string {
  const creds = Buffer.from(`${env.GORGIAS_USER_EMAIL}:${env.GORGIAS_API_KEY}`).toString("base64");
  return `Basic ${creds}`;
}

async function gorgiasFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gorgias ${init?.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.status === 204 ? null : res.json();
}

export interface GorgiasMessage {
  id: number;
  ticket_id: number;
  channel: string;
  via: string;
  from_agent: boolean;
  body_text: string | null;
  body_html: string | null;
  subject: string | null;
  sender: { id?: number; email?: string; name?: string } | null;
  created_datetime: string;
}

export interface GorgiasTicket {
  id: number;
  subject: string | null;
  status: string;
  channel: string;
  customer: { id: number; email: string | null; name: string | null } | null;
  tags: Array<{ id?: number; name: string }>;
  assignee_user: { id: number; email: string } | null;
}

export async function getTicket(ticketId: number): Promise<GorgiasTicket> {
  return gorgiasFetch(`/tickets/${ticketId}`);
}

/** List recent tickets (read-only), newest first. Used by the back-test bench. */
export async function listRecentTickets(limit = 30, cursor?: string): Promise<{ tickets: GorgiasTicket[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: String(Math.min(limit, 100)), order_by: "created_datetime:desc" });
  if (cursor) params.set("cursor", cursor);
  const data = await gorgiasFetch(`/tickets?${params.toString()}`);
  return { tickets: data?.data ?? [], nextCursor: data?.meta?.next_cursor ?? null };
}

export async function listMessages(ticketId: number): Promise<GorgiasMessage[]> {
  const data = await gorgiasFetch(`/tickets/${ticketId}/messages?limit=30&order_by=created_datetime:asc`);
  return data?.data ?? data ?? [];
}

/** Send a real email reply to the customer on this ticket. */
export async function sendReply(ticket: GorgiasTicket, bodyText: string): Promise<GorgiasMessage> {
  const to = ticket.customer?.email;
  if (!to) throw new Error("Ticket has no customer email; cannot send reply");
  return gorgiasFetch(`/tickets/${ticket.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      channel: "email",
      via: "api",
      from_agent: true,
      source: {
        type: "email",
        to: [{ address: to, name: ticket.customer?.name ?? undefined }],
        from: { address: env.GORGIAS_SENDER_EMAIL, name: "The Flower Letters" },
      },
      subject: ticket.subject ? (ticket.subject.startsWith("Re:") ? ticket.subject : `Re: ${ticket.subject}`) : "Re: your message to The Flower Letters",
      body_text: bodyText,
      body_html: bodyText
        .split(/\n{2,}/)
        .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
        .join("\n"),
    }),
  });
}

/** Post an internal note (not visible to the customer). Used for draft mode and escalations. */
export async function postInternalNote(ticketId: number, bodyText: string): Promise<GorgiasMessage> {
  return gorgiasFetch(`/tickets/${ticketId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      channel: "internal-note",
      via: "api",
      from_agent: true,
      body_text: bodyText,
    }),
  });
}

export async function addTags(ticketId: number, names: string[]): Promise<void> {
  await gorgiasFetch(`/tickets/${ticketId}/tags`, {
    method: "POST",
    body: JSON.stringify({ names }),
  });
}

export async function setTicketStatus(ticketId: number, status: "open" | "closed"): Promise<void> {
  await gorgiasFetch(`/tickets/${ticketId}`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
}
