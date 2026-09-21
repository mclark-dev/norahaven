import { pgSelect } from "./db.js";

/**
 * Audit-log queries for the console's Audit tab and Ask Poppy's audit_log
 * tool (both admin-only). Read-only: filters + paging over cs_audit_log,
 * never any way to edit or delete history.
 */

export interface AuditFilters {
  date_from?: string; // YYYY-MM-DD (inclusive) or full ISO
  date_to?: string; // YYYY-MM-DD (inclusive) or full ISO
  actor_contains?: string; // e.g. "sarah" matches console:Sarah
  action_contains?: string; // e.g. "address" matches address_change_applied
  ticket_id?: number; // gorgias ticket id
  limit?: number; // default 100, max 500
  offset?: number;
}

export interface AuditRow {
  id: number;
  created_at: string;
  actor: string;
  action: string;
  gorgias_ticket_id: number | null;
  input: unknown;
  output: unknown;
  ok: boolean;
}

/** Strip characters that would break a PostgREST ilike pattern. */
function likeSafe(s: string): string {
  return String(s).replace(/[*%,()&]/g, "").trim().slice(0, 80);
}

function dayBound(v: string, end: boolean): string {
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return end ? `${s}T23:59:59Z` : `${s}T00:00:00Z`;
  return s;
}

export async function queryAudit(f: AuditFilters): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(parseInt(String(f.limit ?? 100), 10) || 100, 1), 500);
  const offset = Math.max(parseInt(String(f.offset ?? 0), 10) || 0, 0);
  const parts = [
    "select=id,created_at,actor,action,gorgias_ticket_id,input,output,ok",
    "order=created_at.desc",
    `limit=${limit}`,
  ];
  if (offset) parts.push(`offset=${offset}`);
  if (f.date_from) parts.push(`created_at=gte.${encodeURIComponent(dayBound(f.date_from, false))}`);
  if (f.date_to) parts.push(`created_at=lte.${encodeURIComponent(dayBound(f.date_to, true))}`);
  if (f.actor_contains) {
    const v = likeSafe(f.actor_contains);
    if (v) parts.push(`actor=ilike.${encodeURIComponent(`*${v}*`)}`);
  }
  if (f.action_contains) {
    const v = likeSafe(f.action_contains);
    if (v) parts.push(`action=ilike.${encodeURIComponent(`*${v}*`)}`);
  }
  const tid = parseInt(String(f.ticket_id ?? ""), 10);
  if (tid) parts.push(`gorgias_ticket_id=eq.${tid}`);
  return pgSelect<AuditRow>("cs_audit_log", parts.join("&"));
}

function short(v: unknown, cap: number): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

/** Compact per-row JSON for the console UI (details capped, never megabytes). */
export function auditRowsForUI(rows: AuditRow[]): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    actor: r.actor,
    action: r.action,
    gorgias_ticket_id: r.gorgias_ticket_id,
    ok: r.ok,
    input: short(r.input, 1200),
    output: short(r.output, 1200),
  }));
}

/** One line per entry for Ask Poppy's audit_log tool result. */
export function auditRowsAsText(rows: AuditRow[]): string {
  if (!rows.length) return "No audit entries match those filters.";
  return rows
    .map((r) => {
      const t = r.created_at.slice(0, 16).replace("T", " ");
      const tk = r.gorgias_ticket_id ? ` ticket#${r.gorgias_ticket_id}` : "";
      const okFlag = r.ok ? "" : " FAILED";
      const inp = short(r.input, 220);
      const outp = short(r.output, 160);
      return `${t} | ${r.actor} | ${r.action}${tk}${okFlag}${inp ? ` | in: ${inp}` : ""}${outp ? ` | out: ${outp}` : ""}`;
    })
    .join("\n");
}
