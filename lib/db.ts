import { env } from "./env.js";

/**
 * Minimal Supabase PostgREST client via fetch — no npm dependency.
 * Uses the service-role key; server-side only.
 */

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

const rest = () => `${env.SUPABASE_URL}/rest/v1`;

/** GET rows. `query` is a PostgREST query string, e.g. "select=id,title&active=eq.true&limit=4" */
export async function pgSelect<T = any>(table: string, query: string): Promise<T[]> {
  const res = await fetch(`${rest()}/${table}?${query}`, { headers: headers() });
  if (!res.ok) throw new Error(`pgSelect ${table} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Exact count of rows matching `query` (filters only). */
export async function pgCount(table: string, query: string): Promise<number> {
  const res = await fetch(`${rest()}/${table}?select=*&${query}`, {
    method: "HEAD",
    headers: headers({ Prefer: "count=exact" }),
  });
  if (!res.ok) throw new Error(`pgCount ${table} ${res.status}`);
  const range = res.headers.get("content-range") ?? "/0";
  return parseInt(range.split("/")[1] ?? "0", 10) || 0;
}

/** INSERT one row; returns the inserted row. */
export async function pgInsert<T = any>(table: string, row: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${rest()}/${table}`, {
    method: "POST",
    headers: headers({ Prefer: "return=representation" }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const body = await res.text();
    const err: any = new Error(`pgInsert ${table} ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    err.isUniqueViolation = res.status === 409;
    throw err;
  }
  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

/** UPSERT one row on a conflict column; returns the row. */
export async function pgUpsert<T = any>(table: string, row: Record<string, unknown>, onConflict: string): Promise<T> {
  const res = await fetch(`${rest()}/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: headers({ Prefer: "return=representation,resolution=merge-duplicates" }),
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`pgUpsert ${table} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

/** DELETE rows matching filter query. */
export async function pgDelete(table: string, filterQuery: string): Promise<void> {
  const res = await fetch(`${rest()}/${table}?${filterQuery}`, { method: "DELETE", headers: headers() });
  if (!res.ok) throw new Error(`pgDelete ${table} ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** UPDATE rows matching filter query. */
export async function pgUpdate(table: string, filterQuery: string, patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${rest()}/${table}?${filterQuery}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`pgUpdate ${table} ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// ---------- domain helpers ----------

export async function getSetting(key: string, fallback: string): Promise<string> {
  try {
    const rows = await pgSelect<{ value: string }>("cs_settings", `select=value&key=eq.${encodeURIComponent(key)}&limit=1`);
    return rows[0]?.value ?? fallback;
  } catch {
    return fallback;
  }
}

export async function audit(entry: {
  ticket_id?: number | null;
  gorgias_ticket_id?: number | null;
  actor?: string;
  action: string;
  input?: unknown;
  output?: unknown;
  ok?: boolean;
}): Promise<void> {
  try {
    await pgInsert("cs_audit_log", {
      ticket_id: entry.ticket_id ?? null,
      gorgias_ticket_id: entry.gorgias_ticket_id ?? null,
      actor: entry.actor ?? "agent",
      action: entry.action,
      input: entry.input ?? null,
      output: entry.output ?? null,
      ok: entry.ok ?? true,
    });
  } catch (e: any) {
    console.error("audit insert failed:", e.message);
  }
}

/** Returns true the first time this event key is seen; false if already processed. */
export async function claimEvent(eventKey: string): Promise<boolean> {
  try {
    await pgInsert("cs_processed_events", { event_key: eventKey });
    return true;
  } catch (e: any) {
    if (e.isUniqueViolation) return false;
    throw e;
  }
}
