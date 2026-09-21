import { env } from "./env.js";

/**
 * Read-only Shopify Admin access. The credentials should carry ONLY read scopes
 * (read_orders, read_customers, read_fulfillments). The agent has no tool
 * that can mutate anything in Shopify — refunds/cancellations always escalate.
 *
 * Auth, two supported modes:
 *  - SHOPIFY_ADMIN_TOKEN set (legacy admin-created custom app): use it directly.
 *  - SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET set (new Dev Dashboard app,
 *    custom distribution, installed on the store): exchange them for a
 *    24-hour token via the client credentials grant, cached in memory and
 *    refreshed automatically before expiry.
 */
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (env.SHOPIFY_ADMIN_TOKEN) return env.SHOPIFY_ADMIN_TOKEN;
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const res = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Shopify token exchange ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (!json.access_token) throw new Error("Shopify token exchange returned no access_token");
  // Refresh 2 minutes before the 24h expiry.
  cachedToken = { token: json.access_token, expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 86399) - 120) * 1000 };
  return cachedToken.token;
}

async function adminGraphql(query: string, variables: Record<string, unknown>): Promise<any> {
  const doFetch = async (token: string) =>
    fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-07/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

  let res = await doFetch(await getAccessToken());
  if (res.status === 401 && !env.SHOPIFY_ADMIN_TOKEN) {
    // Cached token revoked or expired early — fetch a fresh one and retry once.
    cachedToken = null;
    res = await doFetch(await getAccessToken());
  }
  if (!res.ok) throw new Error(`Shopify Admin API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 500)}`);
  return json.data;
}

export interface OrderFulfillment {
  /** When the fulfillment was created in Shopify - NOT necessarily when a letter was mailed (see prompt rules). */
  createdAt: string;
  /** e.g. FULFILLED, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, ATTEMPTED_DELIVERY, FAILURE */
  status: string | null;
  inTransitAt: string | null;
  /** The CARRIER's estimated delivery date - only exists on tracked shipments. */
  estimatedDeliveryAt: string | null;
  deliveredAt: string | null;
  /** When the shipping label was created (LABEL_PURCHASED / LABEL_PRINTED event) - our MAIL DATE for First Class letters. */
  labelCreatedAt: string | null;
  tracking: Array<{ company: string | null; number: string | null; url: string | null }>;
}

/** The arrival window Poppy may state, with where it came from. Computed in code - never by the model. */
export interface ExpectedArrival {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  basis: string;
}

export interface OrderSummary {
  name: string;
  createdAt: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  totalPrice: string;
  /** Every tag on the order, verbatim (internal context - never recite raw tags to a customer). */
  tags: string[];
  /** Plain-language reading of the tags we understand (story, scheduled date, subscription, resend, mailing history...). */
  tagNotes: string[];
  /** The order note - INTERNAL, written by the team. Context only, never quoted to a customer. */
  internalNote: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** What the customer paid for shipping on this order. */
  shippingPaid: string | null;
  lineItems: Array<{ title: string; quantity: number; variant?: string | null; sku?: string | null; properties?: Record<string, string> }>;
  fulfillments: OrderFulfillment[];
  /** The date the letter was actually mailed: the earliest shipping-label date on the order (First Class has no tracking, so this is the mail date). */
  mailedAt: string | null;
  /** Expected arrival window for untracked mail, from the mail date (or chosen ship date) plus the First Class transit window. */
  expectedArrival: ExpectedArrival | null;
  /** One line to orient on the order quickly. */
  atAGlance: string;
  /** The exact checkout option this order used, matched from the store's shipping profiles (filled in by the agent layer). */
  checkoutOption?: CheckoutOption | null;
  tracking: Array<{ company: string | null; number: string | null; url: string | null }>;
  shippingAddressCity: string | null;
  /** The full ship-to address on the order, exactly as the store holds it. */
  shippingAddress: ShipTo | null;
  /** The same address as one readable line, ready to confirm back to the customer. */
  shippingAddressFormatted: string | null;
  /** The shipping option the customer chose at checkout, verbatim (e.g. "First Class Postage", "Tracked Shipping"). */
  shippingMethod: string | null;
  /** Whether that option carries tracking: "tracked" | "untracked" | "unclear" (an option we can't classify) | "none" (no shipping option on the order). */
  shippingKind: ShippingKind;
  /** The ship/delivery date the customer selected at checkout (YYYY-MM-DD), if any. */
  shipDate: string | null;
  /** The "Estimated delivery" window shown at checkout, if any (e.g. "September 22–30, 2026"). */
  estimatedDelivery: string | null;
}

export interface ShipTo {
  name: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  provinceCode: string | null;
  zip: string | null;
  country: string | null;
  countryCode: string | null;
}

/** One readable line: "Jane Doe, 12 Rose Ln, Apt 2, Boise, ID 83702, US". */
export function formatShipTo(a: ShipTo | null): string | null {
  if (!a) return null;
  const line = [
    a.name,
    a.address1,
    a.address2,
    [a.city, a.provinceCode].filter(Boolean).join(", "),
    a.zip,
    a.countryCode && a.countryCode !== "US" ? a.country ?? a.countryCode : null,
  ]
    .filter((x) => x && String(x).trim())
    .join(", ");
  return line || null;
}

// ---------- shipping option chosen at checkout ----------
// The store offers free untracked First Class alongside paid tracking upgrades,
// and a tin always ships tracked. Real option titles seen on live orders:
// "First Class Postage" (the untracked default), "Tracked Shipping",
// "First Letter Tracking", "Tracked First Letter" (paid upgrades),
// "US Tin Shipping", "Your Tin & First Letter" (tin orders, tracked by policy),
// and the generic "Shipping" / "Economy" / "free". Some orders (certain resends)
// carry no shipping line at all.
//
// We classify only what we can stand behind: a title naming tracking or a tin is
// "tracked", a First Class title is "untracked", and anything else is "unclear"
// so nobody promises or denies tracking on a guess. Whether a tracking NUMBER
// exists is always answered from the order's tracking array, not from this.
export type ShippingKind = "tracked" | "untracked" | "unclear" | "none";

export function classifyShipping(title: string | null | undefined): ShippingKind {
  const t = String(title ?? "").trim();
  if (!t) return "none";
  if (/track|tin/i.test(t)) return "tracked";
  if (/first[\s-]*class/i.test(t)) return "untracked";
  return "unclear";
}

// ---------- order tags ----------
// Tags carry a lot of operational meaning at The Flower Letters. These readings
// come from tags observed on live orders; anything we don't recognize is left
// as a raw tag for context, never guessed at.
const STORY_CODES: Record<string, string> = {
  AR: "Audrey Rose", LC: "Lily Clara", AM: "Adelaide Magnolia", NA: "Norah Aven",
  NA1: "Norah Aven Part 1", NA2: "Norah Aven Part 2", NA3: "Norah Aven Part 3",
  OM: "Orchid Mae", CG: "Camellia Grace", LA: "Laurel Anna",
};

export function interpretTags(tags: string[] | null | undefined): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();
  const add = (n: string) => { if (!seen.has(n)) { seen.add(n); notes.push(n); } };
  for (const raw of tags ?? []) {
    const t = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^([A-Z]{2}\d?)(STORY|TIN|COMBO)$/.exec(t)) && STORY_CODES[m[1]]) {
      add(`${STORY_CODES[m[1]]} ${m[2] === "STORY" ? "story" : m[2] === "TIN" ? "tin" : "story + tin combo"}`);
    } else if (/^scheduled$/i.test(t)) {
      add("customer chose a scheduled first-letter ship date");
    } else if ((m = /^delivery on (.+)$/i.exec(t))) {
      add(`scheduled ship date: ${m[1]}`);
    } else if (/^subscription first order$/i.test(t)) {
      add("monthly subscription - the first order");
    } else if (/^subscription recurring order$/i.test(t)) {
      add("monthly subscription - a recurring renewal order");
    } else if (/^resend$/i.test(t)) {
      add("this order is a RESEND of letters, not a new purchase");
    } else if (/^updated address$/i.test(t) || /^poppy address change/i.test(t)) {
      add("the shipping address on this order was updated after purchase");
    } else if ((m = /^letter\s*#?(\d+)\s*:\s*mailed on\s+(.+)$/i.exec(t))) {
      add(`mailing history: letter ${m[1]} recorded as mailed ${m[2]}`);
    } else if ((m = /^(.+mailing date)\s*:\s*(.+)$/i.exec(t))) {
      add(`mailing history: ${m[1].toLowerCase()} ${m[2]}`);
    }
  }
  return notes;
}

/** Line-item properties a person would recognize - drops hidden "_"/"__" keys. */
function visibleProps(attrs: Array<{ key: string; value: string }> | null | undefined): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const a of attrs ?? []) {
    if (!a?.key || a.key.startsWith("_") || !a.value) continue;
    out[a.key] = a.value;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------- mail date + expected arrival ----------
// First Class letters carry no tracking, but the team buys a shipping label in
// Shopify on the day the letter goes out, so the label event is the mail date.
// The checkout's "Estimated delivery" window (e.g. ships Sep 14 -> "September
// 16-24") gives First Class transit; every live order checked shows +2 to +10
// days. That window is the default and is overridable by the
// first_class_transit_days setting.
export const DEFAULT_FIRST_CLASS_TRANSIT: [number, number] = [2, 10];

function labelDate(events: Array<{ status: string; happenedAt: string }> | null | undefined): string | null {
  const hits = (events ?? [])
    .filter((e) => /^LABEL_(PURCHASED|PRINTED)$/.test(e?.status ?? "") && e.happenedAt)
    .map((e) => e.happenedAt)
    .sort();
  return hits[0] ?? null;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function monthIdx(word: string): number | null {
  const m = MONTHS[word.slice(0, 3).toLowerCase()];
  return m === undefined ? null : m;
}
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

/** "September 16–24, 2026" | "Sep 24 – Oct 2, 2026" | "Dec 28, 2026 – Jan 5, 2027" -> ISO window. */
export function parseArrivalWindow(raw: string | null | undefined): { from: string; to: string } | null {
  const s = String(raw ?? "").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  if (!s) return null;
  let m = /^([A-Za-z]+) (\d{1,2}) ?- ?(\d{1,2}),? (\d{4})$/.exec(s); // September 16-24, 2026
  if (m) {
    const mo = monthIdx(m[1]); if (mo == null) return null;
    const y = +m[4];
    return { from: isoDay(utc(y, mo, +m[2])), to: isoDay(utc(y, mo, +m[3])) };
  }
  m = /^([A-Za-z]+) (\d{1,2}),? ?(\d{4})? ?- ?([A-Za-z]+) (\d{1,2}),? (\d{4})$/.exec(s); // Sep 24 - Oct 2, 2026 | Dec 28, 2026 - Jan 5, 2027
  if (m) {
    const m1 = monthIdx(m[1]), m2 = monthIdx(m[4]); if (m1 == null || m2 == null) return null;
    const y2 = +m[6];
    const y1 = m[3] ? +m[3] : m1 > m2 ? y2 - 1 : y2;
    return { from: isoDay(utc(y1, m1, +m[2])), to: isoDay(utc(y2, m2, +m[5])) };
  }
  return null;
}

const addDays = (iso: string, n: number) => { const d = new Date(iso.slice(0, 10) + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000);
const short = (iso: string) => new Date(iso.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Fill in mail date, expected arrival, and the one-line orientation. */
export function finishOrder(o: OrderSummary, transit: [number, number] = DEFAULT_FIRST_CLASS_TRANSIT): OrderSummary {
  // Mail date = the earliest label on an UNTRACKED fulfillment (tracked shipments have carrier data instead).
  const untrackedLabels = o.fulfillments
    .filter((f) => f.labelCreatedAt && !f.tracking.some((t) => t.number))
    .map((f) => f.labelCreatedAt as string)
    .sort();
  o.mailedAt = untrackedLabels[0] ?? null;

  // Transit window: this order's own checkout estimate relative to its chosen ship date, else the default.
  let lo = transit[0], hi = transit[1];
  const shown = parseArrivalWindow(o.estimatedDelivery);
  if (shown && o.shipDate) {
    const a = dayDiff(o.shipDate, shown.from), b = dayDiff(o.shipDate, shown.to);
    if (a >= 0 && b >= a && b <= 45) { lo = a; hi = b; }
  }
  const tracked = o.fulfillments.some((f) => f.tracking.some((t) => t.number));
  if (!tracked && o.shippingKind !== "tracked") {
    if (o.mailedAt) {
      o.expectedArrival = {
        from: addDays(o.mailedAt, lo), to: addDays(o.mailedAt, hi),
        basis: `mailed ${o.mailedAt.slice(0, 10)} (shipping label created) + ${lo}-${hi} days First Class`,
      };
    } else if (shown) {
      o.expectedArrival = { from: shown.from, to: shown.to, basis: "arrival window shown at checkout; not mailed yet" };
    } else if (o.shipDate) {
      o.expectedArrival = {
        from: addDays(o.shipDate, lo), to: addDays(o.shipDate, hi),
        basis: `chosen ship date ${o.shipDate} + ${lo}-${hi} days First Class; not mailed yet`,
      };
    }
  }

  const story = o.tagNotes.find((n) => / (story|tin|combo)$/.test(n)) ?? o.lineItems[0]?.title ?? "order";
  const bits: string[] = [o.name, story];
  if (o.cancelledAt) bits.push("CANCELLED");
  if (o.tags.some((t) => /^resend$/i.test(t))) bits.push("resend");
  if (o.tags.some((t) => /^subscription recurring order$/i.test(t))) bits.push("monthly renewal");
  else if (o.tags.some((t) => /^subscription first order$/i.test(t))) bits.push("monthly subscription, first order");
  bits.push(o.shippingMethod ? `${o.shippingMethod} (${o.shippingKind})` : "no shipping option");
  if (o.shipDate) bits.push(`ship date chosen ${short(o.shipDate)}`);
  if (o.mailedAt) bits.push(`mailed ${short(o.mailedAt)}`);
  const trackedF = o.fulfillments.find((f) => f.tracking.some((t) => t.number));
  if (trackedF) bits.push(trackedF.deliveredAt ? `delivered ${short(trackedF.deliveredAt)}` : `${(trackedF.status ?? "shipped").toLowerCase().replace(/_/g, " ")}${trackedF.estimatedDeliveryAt ? `, carrier ETA ${short(trackedF.estimatedDeliveryAt)}` : ""}`);
  else if (o.expectedArrival) bits.push(`expected ${short(o.expectedArrival.from)}-${short(o.expectedArrival.to)}`);
  if (o.shippingAddress?.city) bits.push(`to ${o.shippingAddress.city}${o.shippingAddress.provinceCode ? " " + o.shippingAddress.provinceCode : ""}`);
  o.atAGlance = bits.join(" · ");
  return o;
}

// ---------- ship-date selection ----------
// At checkout customers can pick when their first letter ships. That choice is
// recorded redundantly by the store: an order attribute `__flare_delivery_date`
// (ISO date - the canonical value), line-item properties ("First letter ships",
// "Scheduled ship date", "Estimated delivery"), and order tags ("SCHEDULED",
// "Delivery on Sep 18 2026", a bare "09/18/2026" tag). Resends/redemptions have
// none of these. We read them in that order of trust.

type KV = { key: string; value: string };

function toISODate(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // 09/18/2026
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  const t = Date.parse(s); // "Sep 18, 2026", "Sep 18 2026"
  if (!isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

export function extractShipDate(o: {
  tags?: string[] | null;
  customAttributes?: KV[] | null;
  lineItemAttributes?: KV[][] | null;
}): { shipDate: string | null; estimatedDelivery: string | null } {
  const orderAttrs = o.customAttributes ?? [];
  const lineAttrs: KV[] = ([] as KV[]).concat(...(o.lineItemAttributes ?? []));
  const find = (list: KV[], keys: string[]): string | null => {
    for (const k of keys) {
      const hit = list.find((a) => a.key.trim().toLowerCase() === k);
      if (hit && hit.value) return hit.value;
    }
    return null;
  };

  let shipDate =
    toISODate(find(orderAttrs, ["__flare_delivery_date"]) ?? "") ??
    toISODate(find(lineAttrs, ["__flare_delivery_date", "first letter ships", "scheduled ship date"]) ?? "");

  if (!shipDate) {
    for (const t of o.tags ?? []) {
      const m = /^delivery on (.+)$/i.exec(t.trim());
      if (m) { shipDate = toISODate(m[1]); if (shipDate) break; }
    }
  }
  if (!shipDate) {
    for (const t of o.tags ?? []) {
      const iso = /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t.trim()) ? toISODate(t.trim()) : null;
      if (iso) { shipDate = iso; break; }
    }
  }
  return { shipDate, estimatedDelivery: find(lineAttrs, ["estimated delivery"]) };
}

const ORDER_FIELDS = `
          name
          createdAt
          tags
          note
          cancelledAt
          cancelReason
          customAttributes { key value }
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          shippingLine { title originalPriceSet { shopMoney { amount } } }
          shippingAddress { firstName lastName address1 address2 city provinceCode zip country countryCodeV2 }
          lineItems(first: 10) { nodes { title variantTitle sku quantity customAttributes { key value } } }
          fulfillments(first: 5) {
            createdAt displayStatus inTransitAt estimatedDeliveryAt deliveredAt
            events(first: 10) { nodes { status happenedAt } }
            trackingInfo { company number url }
          }
`;

function mapOrderNode(o: any, transitDays: [number, number]): OrderSummary {
  const build = (o: any): OrderSummary => {
    const shipInfo = extractShipDate({
      tags: o.tags,
      customAttributes: o.customAttributes,
      lineItemAttributes: (o.lineItems?.nodes ?? []).map((li: any) => li.customAttributes ?? []),
    });
    const sa = o.shippingAddress;
    const shipTo: ShipTo | null = sa
      ? {
          name: [sa.firstName, sa.lastName].filter(Boolean).join(" ") || null,
          address1: sa.address1 ?? null,
          address2: sa.address2 ?? null,
          city: sa.city ?? null,
          provinceCode: sa.provinceCode ?? null,
          zip: sa.zip ?? null,
          country: sa.country ?? null,
          countryCode: sa.countryCodeV2 ?? null,
        }
      : null;
    const method: string | null = o.shippingLine?.title ?? null;
    return {
      name: o.name,
      createdAt: o.createdAt,
      financialStatus: o.displayFinancialStatus ?? null,
      fulfillmentStatus: o.displayFulfillmentStatus ?? null,
      totalPrice: `${o.totalPriceSet?.shopMoney?.amount ?? "?"} ${o.totalPriceSet?.shopMoney?.currencyCode ?? ""}`.trim(),
      tags: o.tags ?? [],
      tagNotes: interpretTags(o.tags),
      internalNote: (o.note ?? "").trim() || null,
      cancelledAt: o.cancelledAt ?? null,
      cancelReason: o.cancelReason ?? null,
      shippingPaid: o.shippingLine?.originalPriceSet?.shopMoney?.amount ?? null,
      lineItems: (o.lineItems?.nodes ?? []).map((li: any) => ({
        title: li.title,
        quantity: li.quantity,
        variant: li.variantTitle ?? null,
        sku: li.sku ?? null,
        properties: visibleProps(li.customAttributes),
      })),
      fulfillments: (o.fulfillments ?? []).map((f: any): OrderFulfillment => ({
        createdAt: f.createdAt,
        status: f.displayStatus ?? null,
        inTransitAt: f.inTransitAt ?? null,
        estimatedDeliveryAt: f.estimatedDeliveryAt ?? null,
        deliveredAt: f.deliveredAt ?? null,
        labelCreatedAt: labelDate(f.events?.nodes),
        tracking: f.trackingInfo ?? [],
      })),
      mailedAt: null,
      expectedArrival: null,
      atAGlance: "",
      tracking: (o.fulfillments ?? []).flatMap((f: any) => f.trackingInfo ?? []),
      shippingAddressCity: o.shippingAddress?.city ?? null,
      shippingAddress: shipTo,
      shippingAddressFormatted: formatShipTo(shipTo),
      shippingMethod: method,
      shippingKind: classifyShipping(method),
      shipDate: shipInfo.shipDate,
      estimatedDelivery: shipInfo.estimatedDelivery,
    };
  };
  return finishOrder(build(o), transitDays);
}

/**
 * IDENTITY SAFETY: orders can only be looked up by the email address that
 * wrote in. The agent never accepts an email/order pair from message text -
 * the sender's own address is the only key.
 */
export async function getOrdersForEmail(email: string, limit = 10, transitDays: [number, number] = DEFAULT_FIRST_CLASS_TRANSIT): Promise<OrderSummary[]> {
  const q = `query ($query: String!, $first: Int!) { orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }`;
  const data = await adminGraphql(q, { query: `email:${JSON.stringify(email)}`, first: limit });
  return (data?.orders?.nodes ?? []).map((o: any) => mapOrderNode(o, transitDays));
}

/**
 * Find ONE order by its number (as a customer might quote it, "#557196" or "557196"),
 * returning the email it was placed with so the caller can verify ownership
 * BEFORE disclosing anything. Never disclose an order whose email != the sender.
 */
export async function getOrderByNumber(num: string, transitDays: [number, number] = DEFAULT_FIRST_CLASS_TRANSIT): Promise<{ email: string | null; order: OrderSummary } | null> {
  const digits = String(num ?? "").replace(/[^0-9]/g, "");
  if (!digits) return null;
  const q = `query ($query: String!) { orders(first: 1, query: $query) { nodes { email ${ORDER_FIELDS} } } }`;
  const data = await adminGraphql(q, { query: `name:#${digits}` });
  const n = data?.orders?.nodes?.[0];
  if (!n || String(n.name ?? "").replace(/[^0-9]/g, "") !== digits) return null;
  return { email: n.email ?? null, order: mapOrderNode(n, transitDays) };
}

// ---------- Guarded write: address change (Poppy's first real action) ----------
// Requires the app to also have the write_orders scope. Every use tags the order
// "Poppy Address Change <date>" and appends an order note - nothing is silent.

export interface AddressInput {
  first_name?: string | null;
  last_name?: string | null;
  address1: string;
  address2?: string | null;
  city: string;
  province_code?: string | null;
  zip: string;
  country_code?: string | null; // defaults to US
}

export interface OrderForChange {
  gid: string;
  name: string;
  fulfillmentStatus: string | null;
  note: string | null;
  shippingAddress: Record<string, any> | null;
}

/** Find the sender's orders with enough detail to stage an address change. */
export async function findOrdersForAddressChange(email: string): Promise<OrderForChange[]> {
  const q = `
    query ($query: String!) {
      orders(first: 10, query: $query, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          displayFulfillmentStatus
          note
          shippingAddress { firstName lastName address1 address2 city provinceCode zip countryCode }
        }
      }
    }`;
  const data = await adminGraphql(q, { query: `email:${JSON.stringify(email)}` });
  return (data?.orders?.nodes ?? []).map((o: any): OrderForChange => ({
    gid: o.id,
    name: o.name,
    fulfillmentStatus: o.displayFulfillmentStatus ?? null,
    note: o.note ?? null,
    shippingAddress: o.shippingAddress ?? null,
  }));
}

/** Current fulfillment status + note for one order, by GraphQL id. */
export async function getOrderStatus(gid: string): Promise<{ fulfillmentStatus: string | null; note: string | null }> {
  const q = `query ($id: ID!) { order: node(id: $id) { ... on Order { displayFulfillmentStatus note } } }`;
  const data = await adminGraphql(q, { id: gid });
  return { fulfillmentStatus: data?.order?.displayFulfillmentStatus ?? null, note: data?.order?.note ?? null };
}

/**
 * Apply the change: new shipping address + appended order note + order tag.
 * Caller is responsible for ALL policy checks (unfulfilled, email match, mode).
 */
export async function applyAddressChange(order: OrderForChange, addr: AddressInput): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const old = order.shippingAddress ?? {};
  const oldLine = [old.address1, old.address2, old.city, old.provinceCode, old.zip].filter(Boolean).join(", ");
  const newLine = [addr.address1, addr.address2, addr.city, addr.province_code, addr.zip].filter(Boolean).join(", ");
  const appendedNote = `${order.note ? order.note + "\n" : ""}[Poppy ${date}] Address updated per customer email: ${oldLine || "(none)"} -> ${newLine}`;

  const m = `
    mutation ($input: OrderInput!) {
      orderUpdate(input: $input) {
        userErrors { field message }
      }
    }`;
  const input: Record<string, unknown> = {
    id: order.gid,
    note: appendedNote.slice(0, 5000),
    shippingAddress: {
      firstName: addr.first_name ?? old.firstName ?? undefined,
      lastName: addr.last_name ?? old.lastName ?? undefined,
      address1: addr.address1,
      address2: addr.address2 ?? undefined,
      city: addr.city,
      provinceCode: addr.province_code ?? undefined,
      zip: addr.zip,
      countryCode: (addr.country_code ?? "US").toUpperCase(),
    },
  };
  const res = await adminGraphql(m, { input });
  const errs = res?.orderUpdate?.userErrors ?? [];
  if (errs.length) throw new Error(`orderUpdate: ${JSON.stringify(errs).slice(0, 300)}`);

  const t = `
    mutation ($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }`;
  const tres = await adminGraphql(t, { id: order.gid, tags: [`Poppy Address Change ${date}`] });
  const terrs = tres?.tagsAdd?.userErrors ?? [];
  if (terrs.length) throw new Error(`tagsAdd: ${JSON.stringify(terrs).slice(0, 300)}`);
}

/**
 * REPORTING: bulk order search for the team (Ask Poppy). Read-only.
 * `query` uses Shopify's order search syntax (created_at:, tag:, status:,
 * fulfillment_status:, ...). Paginates until `cap` orders are collected.
 */
export interface ReportOrder {
  name: string;
  createdAt: string;
  processedAt: string | null;
  email: string | null;
  customerName: string | null;
  tags: string[];
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  totalPrice: string;
  note: string | null;
  cancelledAt: string | null;
  shipping: {
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    zip: string | null;
    country: string | null;
    countryCode: string | null;
    phone: string | null;
  } | null;
  lineItems: Array<{ title: string; quantity: number; sku: string | null; unfulfilled: number }>;
  /** The ship date the customer selected at checkout (YYYY-MM-DD), if any. */
  shipDate: string | null;
  /** The shipping option chosen at checkout, verbatim. */
  shippingMethod: string | null;
}

export async function searchOrders(query: string, cap = 800): Promise<{ orders: ReportOrder[]; truncated: boolean }> {
  const q = `
    query ($query: String!, $first: Int!, $after: String) {
      orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: false) {
        pageInfo { hasNextPage endCursor }
        nodes {
          name
          createdAt
          processedAt
          email
          cancelledAt
          tags
          note
          customAttributes { key value }
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount } }
          customer { displayName }
          shippingLine { title }
          shippingAddress {
            firstName lastName company address1 address2 city provinceCode zip country countryCodeV2 phone
          }
          lineItems(first: 10) {
            nodes { title quantity sku unfulfilledQuantity customAttributes { key value } }
          }
        }
      }
    }`;
  const out: ReportOrder[] = [];
  let after: string | null = null;
  let truncated = false;
  for (let page = 0; page < 40; page++) {
    const data = await adminGraphql(q, { query, first: 50, after });
    const conn = data?.orders;
    for (const n of conn?.nodes ?? []) {
      out.push({
        name: n.name,
        createdAt: n.createdAt,
        processedAt: n.processedAt ?? null,
        email: n.email ?? null,
        customerName: n.customer?.displayName ?? null,
        tags: n.tags ?? [],
        financialStatus: n.displayFinancialStatus ?? null,
        fulfillmentStatus: n.displayFulfillmentStatus ?? null,
        totalPrice: n.totalPriceSet?.shopMoney?.amount ?? "0",
        note: n.note ?? null,
        cancelledAt: n.cancelledAt ?? null,
        shipping: n.shippingAddress
          ? {
              firstName: n.shippingAddress.firstName ?? null,
              lastName: n.shippingAddress.lastName ?? null,
              company: n.shippingAddress.company ?? null,
              address1: n.shippingAddress.address1 ?? null,
              address2: n.shippingAddress.address2 ?? null,
              city: n.shippingAddress.city ?? null,
              provinceCode: n.shippingAddress.provinceCode ?? null,
              zip: n.shippingAddress.zip ?? null,
              country: n.shippingAddress.country ?? null,
              countryCode: n.shippingAddress.countryCodeV2 ?? null,
              phone: n.shippingAddress.phone ?? null,
            }
          : null,
        lineItems: (n.lineItems?.nodes ?? []).map((li: any) => ({
          title: li.title,
          quantity: li.quantity,
          sku: li.sku ?? null,
          unfulfilled: li.unfulfilledQuantity ?? 0,
        })),
        shipDate: extractShipDate({
          tags: n.tags,
          customAttributes: n.customAttributes,
          lineItemAttributes: (n.lineItems?.nodes ?? []).map((li: any) => li.customAttributes ?? []),
        }).shipDate,
        shippingMethod: n.shippingLine?.title ?? null,
      });
      if (out.length >= cap) break;
    }
    if (out.length >= cap) { truncated = conn?.pageInfo?.hasNextPage ?? false; break; }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return { orders: out, truncated };
}

// ---------- Shipping profiles: what customers see at checkout ----------
// Needs the read_shipping scope on the Poppy app. Profiles change rarely, so the
// flattened list is cached per server instance for an hour.

export interface CheckoutOption {
  /** Shipping profile (e.g. "Prepaid Story", "Tins", "NEW - Month to Month Shipping Rates"). */
  profile: string;
  /** A sample of products the profile applies to. */
  products: string[];
  /** "Product / Variant" keys in the profile - several profiles can share one product (e.g. Prepaid vs Prepaid + Tin variants). */
  variants: string[];
  /** Zone name as set up in Shopify (e.g. "United States", "International"). */
  zone: string;
  /** "US", "CA", or "International (N countries)". */
  where: string;
  /** Rate name exactly as the customer sees it at checkout. */
  name: string;
  /** Price shown at checkout, in store currency. "carrier-calculated" when a carrier sets it. */
  price: string;
  /** When this rate only applies to orders at or above a subtotal (e.g. free over $99). */
  minOrderTotal: string | null;
  /** The description line shown under the rate at checkout - verbatim, may be empty. */
  description: string | null;
}

let profileCache: { at: number; rows: CheckoutOption[] } | null = null;

function variantKey(product: string, variant: string | null | undefined): string {
  const v = (variant ?? "").trim();
  return `${product.trim().toLowerCase()} / ${!v || v === "Default Title" ? "" : v.toLowerCase()}`;
}
const PROFILE_TTL_MS = 60 * 60 * 1000;

function summarizeCountries(countries: any[]): { where: string; codes: string[] } {
  const codes = countries.map((c) => c?.code?.countryCode).filter(Boolean) as string[];
  const row = countries.some((c) => c?.code?.restOfWorld);
  if (row) return { where: "International (rest of world)", codes };
  if (codes.length === 1) return { where: codes[0], codes };
  return { where: `International (${codes.length} countries)`, codes };
}

export async function getShippingProfiles(force = false): Promise<CheckoutOption[]> {
  if (!force && profileCache && Date.now() - profileCache.at < PROFILE_TTL_MS) return profileCache.rows;
  const q = `
    query {
      deliveryProfiles(first: 25) {
        nodes {
          name
          profileItems(first: 25) { nodes { product { title } variants(first: 100) { nodes { title } } } }
          profileLocationGroups {
            locationGroupZones(first: 30) {
              nodes {
                zone { name countries { code { countryCode restOfWorld } } }
                methodDefinitions(first: 30) {
                  nodes {
                    name description active
                    rateProvider {
                      ... on DeliveryRateDefinition { price { amount } }
                      ... on DeliveryParticipant { id }
                    }
                    methodConditions { field operator conditionCriteria { __typename ... on MoneyV2 { amount } } }
                  }
                }
              }
            }
          }
        }
      }
    }`;
  let data: any;
  try {
    data = await adminGraphql(q, {});
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/access denied|read_shipping|ACCESS_DENIED|not approved/i.test(msg)) {
      throw new Error("Shopify shipping profiles need the read_shipping permission on the Poppy app (Dev Dashboard -> Poppy -> new version with read_shipping -> release).");
    }
    throw e;
  }
  const rows: CheckoutOption[] = [];
  for (const p of data?.deliveryProfiles?.nodes ?? []) {
    const items = p.profileItems?.nodes ?? [];
    const products = items.map((n: any) => n?.product?.title).filter(Boolean);
    const variants: string[] = [];
    for (const n of items) {
      const pt = n?.product?.title;
      if (!pt) continue;
      for (const v of n.variants?.nodes ?? []) variants.push(variantKey(pt, v?.title));
    }
    for (const g of p.profileLocationGroups ?? []) {
      for (const z of g.locationGroupZones?.nodes ?? []) {
        const { where } = summarizeCountries(z.zone?.countries ?? []);
        for (const m of z.methodDefinitions?.nodes ?? []) {
          if (!m.active) continue;
          const min = (m.methodConditions ?? []).find(
            (c: any) => c.field === "TOTAL_PRICE" && /GREATER/.test(c.operator) && c.conditionCriteria?.amount != null
          );
          rows.push({
            profile: p.name,
            products: products.slice(0, 12),
            variants,
            zone: z.zone?.name ?? "",
            where,
            name: m.name,
            price: m.rateProvider?.price?.amount != null ? Number(m.rateProvider.price.amount).toFixed(2) : "carrier-calculated",
            minOrderTotal: min ? Number(min.conditionCriteria.amount).toFixed(2) : null,
            description: (m.description ?? "").trim() || null,
          });
        }
      }
    }
  }
  profileCache = { at: Date.now(), rows };
  return rows;
}

/**
 * Which checkout option did this order use? Match the order's shipping-line
 * title to profile rates, preferring the zone for the ship-to country and a
 * profile that covers one of the order's products. Returns null when the
 * title isn't a checkout rate (custom rates on resends, "free", etc.).
 */
export function matchCheckoutOption(
  order: Pick<OrderSummary, "shippingMethod" | "shippingAddress" | "lineItems" | "shippingPaid">,
  rows: CheckoutOption[]
): CheckoutOption | null {
  const title = (order.shippingMethod ?? "").trim().toLowerCase();
  if (!title) return null;
  const cands = rows.filter((r) => r.name.trim().toLowerCase() === title);
  if (!cands.length) return null;
  const cc = order.shippingAddress?.countryCode ?? "US";
  const titles = order.lineItems.map((l) => l.title.toLowerCase());
  const keys = order.lineItems.map((l) => variantKey(l.title, l.variant));
  const paid = order.shippingPaid != null ? Number(order.shippingPaid) : null;
  const score = (r: CheckoutOption) => {
    let s = 0;
    if (r.where === cc) s += 8;
    else if (cc !== "US" && r.where.startsWith("International")) s += 6;
    if (r.variants.some((v) => keys.includes(v))) s += 4;
    else if (r.products.some((p) => titles.includes(p.toLowerCase()))) s += 2;
    // Two tiers of the same rate (paid vs free-over-threshold): pick the tier they actually paid.
    if (paid != null && r.price !== "carrier-calculated" && Number(r.price) === paid) s += 1;
    return s;
  };
  return cands.slice().sort((a, b) => score(b) - score(a))[0];
}

// ---------- Gift recipients ----------
// A recipient writes from THEIR email, but the order sits under the purchaser's.
// We find it by what only the recipient reliably knows: the name and address the
// letters are mailed to. Shopify's free-text search matches the shipping last
// name + zip; we then VERIFY last name, 5-digit zip, and house number in code.
// Whatever comes back is a recipient view: facts about THEIR letters only -
// never price, purchase date, order number, subscription/billing, or anything
// about who bought it.

export interface RecipientLetters {
  /** Opaque reference for this run (L1, L2...) - the model never sees the order number. */
  ref: string;
  story: string;
  /** "letters" | "tin" | "tin + letters" | "replacement letters" */
  kind: string;
  /** Their mailing address as we hold it. */
  mailingTo: string | null;
  shippingKind: ShippingKind;
  /** First-letter ship date on the schedule. */
  scheduledShipDate: string | null;
  mailedAt: string | null;
  expectedArrival: ExpectedArrival | null;
  tracking: Array<{ company: string | null; number: string | null; url: string | null; status: string | null; estimatedDeliveryAt: string | null; deliveredAt: string | null }>;
  /** false = no further mailings scheduled on this order (say so neutrally; never why). */
  activeForMailing: boolean;
}

const zip5 = (z: string | null | undefined) => String(z ?? "").replace(/[^0-9]/g, "").slice(0, 5);
const houseNo = (a: string | null | undefined) => (/^\s*(\d+)/.exec(String(a ?? "")) ?? [])[1] ?? "";
const normName = (n: string | null | undefined) => String(n ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");

/** Orders MAILED TO this person (any purchaser), verified on last name + zip + house number. Internal: includes purchaser email. */
export async function findOrdersShippedTo(
  who: { lastName: string; zip: string; street: string; firstName?: string | null },
  transitDays: [number, number] = DEFAULT_FIRST_CLASS_TRANSIT
): Promise<Array<{ purchaserEmail: string | null; order: OrderSummary }>> {
  const last = normName(who.lastName), z = zip5(who.zip), hn = houseNo(who.street);
  if (!last || z.length !== 5 || !hn) return [];
  const q = `query ($query: String!) { orders(first: 25, query: $query, sortKey: CREATED_AT, reverse: true) { nodes { email ${ORDER_FIELDS} } } }`;
  const data = await adminGraphql(q, { query: `${who.lastName.trim()} ${z}` });
  const out: Array<{ purchaserEmail: string | null; order: OrderSummary }> = [];
  for (const n of data?.orders?.nodes ?? []) {
    const sa = n.shippingAddress;
    if (!sa) continue;
    if (normName(sa.lastName) !== last || zip5(sa.zip) !== z || houseNo(sa.address1) !== hn) continue;
    out.push({ purchaserEmail: n.email ?? null, order: mapOrderNode(n, transitDays) });
  }
  return out;
}

/** Strip an order down to what the recipient may hear. Purchaser facts never enter this object. */
export function recipientView(o: OrderSummary, ref: string): RecipientLetters {
  const titles = o.lineItems.map((l) => `${l.title} ${l.variant ?? ""}`.toLowerCase());
  const hasTin = titles.some((t) => /\btin\b/.test(t)) || o.tagNotes.some((n) => /tin/.test(n));
  const hasLetters = titles.some((t) => /letters|story|experience|set|chronicles/.test(t));
  const isReplacement = o.tags.some((t) => /^resend$/i.test(t)) || titles.some((t) => /replacement|resend/.test(t));
  const storyNote = o.tagNotes.find((n) => / (story|tin|combo)$/.test(n));
  const story = storyNote ? storyNote.replace(/ (story|tin|story \+ tin combo)$/, "") : (o.lineItems[0]?.variant?.split(" - ")[0] || o.lineItems[0]?.title || "your letters");
  // Their own address, without the purchaser-entered name line.
  const a = o.shippingAddress;
  const mailingTo = a ? formatShipTo({ ...a, name: null }) : null;
  return {
    ref,
    story,
    kind: isReplacement ? "replacement letters" : hasTin && hasLetters ? "tin + letters" : hasTin ? "tin" : "letters",
    mailingTo,
    shippingKind: o.shippingKind,
    scheduledShipDate: o.shipDate,
    mailedAt: o.mailedAt,
    expectedArrival: o.expectedArrival,
    tracking: o.fulfillments
      .filter((f) => f.tracking.some((t) => t.number))
      .map((f) => ({ ...f.tracking[0], status: f.status, estimatedDeliveryAt: f.estimatedDeliveryAt, deliveredAt: f.deliveredAt })),
    activeForMailing: !o.cancelledAt,
  };
}
