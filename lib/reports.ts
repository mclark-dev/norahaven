import { searchOrders } from "./shopify.js";
import type { ReportOrder } from "./shopify.js";
import { pgInsert } from "./db.js";

/**
 * Order reports & mailing batch lists for the team (used by Ask Poppy).
 * Read-only against Shopify; results are saved as CSV in cs_reports and
 * downloaded from the console. Nothing here can modify an order.
 */

export interface OrderCriteria {
  created_from?: string; // YYYY-MM-DD (inclusive)
  created_to?: string; // YYYY-MM-DD (inclusive)
  status?: "open" | "closed" | "cancelled" | "any";
  fulfillment?: "unfulfilled" | "shipped" | "partial" | "any";
  financial?: string; // paid, refunded, partially_refunded, pending...
  tag?: string; // must have this Shopify tag
  tag_not?: string; // must NOT have this tag
  product_contains?: string; // line-item title contains (case-insensitive)
  country_code?: string; // shipping country, e.g. US
  exclude_country_code?: string; // e.g. US -> international only
  text?: string; // free-text search (name, email, ...)
  ship_date?: string; // customer-selected ship date equals this (YYYY-MM-DD)
  ship_from?: string; // selected ship date on/after (YYYY-MM-DD)
  ship_to?: string; // selected ship date on/before (YYYY-MM-DD)
}

export function buildOrderQuery(c: OrderCriteria): string {
  const parts: string[] = [];
  if (c.created_from) parts.push(`created_at:>='${c.created_from}'`);
  if (c.created_to) parts.push(`created_at:<='${c.created_to}T23:59:59Z'`);
  if (c.status && c.status !== "any") parts.push(`status:${c.status}`);
  if (c.fulfillment && c.fulfillment !== "any") {
    const f = c.fulfillment === "unfulfilled" ? "unshipped" : c.fulfillment === "partial" ? "partial" : "shipped";
    parts.push(`fulfillment_status:${f}`);
  }
  if (c.financial) parts.push(`financial_status:${c.financial}`);
  if (c.tag) parts.push(`tag:'${String(c.tag).replace(/'/g, "")}'`);
  if (c.tag_not) parts.push(`-tag:'${String(c.tag_not).replace(/'/g, "")}'`);
  if (c.text) parts.push(String(c.text).replace(/['"]/g, "").slice(0, 100));
  return parts.join(" ");
}

/** Filters Shopify search can't express — applied to the fetched orders. */
export function applyClientFilters(orders: ReportOrder[], c: OrderCriteria): ReportOrder[] {
  let out = orders;
  if (c.product_contains) {
    const needle = c.product_contains.toLowerCase();
    out = out.filter((o) => o.lineItems.some((li) => li.title.toLowerCase().includes(needle)));
  }
  if (c.country_code) {
    const cc = c.country_code.toUpperCase();
    out = out.filter((o) => (o.shipping?.countryCode ?? "") === cc);
  }
  if (c.exclude_country_code) {
    const cc = c.exclude_country_code.toUpperCase();
    out = out.filter((o) => (o.shipping?.countryCode ?? "") !== cc);
  }
  // Ship-date filters use the customer's checkout selection (null never matches).
  if (c.ship_date) out = out.filter((o) => o.shipDate === c.ship_date);
  if (c.ship_from) out = out.filter((o) => o.shipDate != null && o.shipDate >= c.ship_from!);
  if (c.ship_to) out = out.filter((o) => o.shipDate != null && o.shipDate <= c.ship_to!);
  return out;
}

export async function runOrderQuery(c: OrderCriteria, cap = 800): Promise<{ orders: ReportOrder[]; truncated: boolean }> {
  const { orders, truncated } = await searchOrders(buildOrderQuery(c), cap);
  return { orders: applyClientFilters(orders, c), truncated };
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** Generic order report — one row per order, the details the team works with. */
export const REPORT_COLUMNS = [
  "Order Number", "Order Date", "Ship Date", "Shipping Method", "Customer Name", "Customer Email", "Status", "Fulfillment", "Payment",
  "Total", "Tags", "Products", "Ship To Name", "Address 1", "Address 2", "City", "State-Province",
  "Zip", "Country", "Notes",
];

export function ordersToReportRows(orders: ReportOrder[]): unknown[][] {
  return orders.map((o) => {
    const s = o.shipping;
    return [
      o.name.replace(/^#/, ""),
      (o.processedAt ?? o.createdAt).slice(0, 10),
      o.shipDate ?? "",
      o.shippingMethod ?? "",
      o.customerName ?? "",
      o.email ?? "",
      o.cancelledAt ? "Cancelled" : "Open",
      o.fulfillmentStatus ?? "",
      o.financialStatus ?? "",
      o.totalPrice,
      o.tags.join(", "),
      o.lineItems.map((li) => `${li.title} x${li.quantity}`).join("; "),
      s ? [s.firstName, s.lastName].filter(Boolean).join(" ") : "",
      s?.address1 ?? "",
      s?.address2 ?? "",
      s?.city ?? "",
      s?.provinceCode ?? "",
      s?.zip ?? "",
      s?.country ?? "",
      o.note ?? "",
    ];
  });
}

/**
 * MAILING BATCH format — matches the team's per-batch xlsx files exactly
 * (e.g. LA-BATCH-2.xlsx): 23 columns, one row per order, recipient address
 * first, purchaser details after. Zip is split US-style into Zip + Zip4.
 * Color is left blank for the team to fill.
 */
export const MAILING_BATCH_COLUMNS = [
  "Batch", "Status", "First Name", "Last Name", "Company", "Address 1", "Address 2", "City",
  "State-Province", "Zip", "Zip4", "Country", "Letter Number", "Customer Name", "Customer Email",
  "Status", "Tags", "Fulfillable Quantity", "Notes", "Order Processed Date", "Order Number",
  "Product Name", "Color",
];

export function ordersToMailingBatchRows(orders: ReportOrder[], batchNumber: number, letterNumber: number | string): unknown[][] {
  return orders.map((o) => {
    const s = o.shipping;
    let zip = s?.zip ?? "";
    let zip4 = "";
    const m = /^(\d{5})-(\d{4})$/.exec(zip.trim());
    if (m) { zip = m[1]; zip4 = m[2]; }
    const cancelled = !!o.cancelledAt || o.tags.some((t) => t.toUpperCase() === "CANCEL");
    return [
      batchNumber,
      cancelled ? "CANCELED" : "ACTIVE",
      s?.firstName ?? "",
      s?.lastName ?? "",
      s?.company ?? "",
      s?.address1 ?? "",
      s?.address2 ?? "",
      s?.city ?? "",
      s?.provinceCode ?? "",
      zip,
      zip4,
      (s?.country ?? "").toUpperCase(),
      letterNumber,
      o.customerName ?? "",
      o.email ?? "",
      o.cancelledAt ? "Cancelled" : "Open",
      o.tags.join(", "),
      o.lineItems.reduce((n, li) => n + (li.unfulfilled ?? 0), 0),
      o.note ?? "",
      (o.processedAt ?? o.createdAt).slice(0, 10),
      o.name.replace(/^#/, ""),
      o.lineItems[0]?.title ?? "",
      "", // Color — the team fills this per letter
    ];
  });
}

export async function saveReport(opts: {
  title: string;
  kind: "report" | "mailing_batch";
  criteria: OrderCriteria;
  csv: string;
  rowCount: number;
}): Promise<number> {
  const row = await pgInsert("cs_reports", {
    title: opts.title.slice(0, 200),
    kind: opts.kind,
    criteria: opts.criteria,
    row_count: opts.rowCount,
    csv: opts.csv,
  });
  return row.id;
}

/**
 * In-memory analysis of a matched order set - the numbers the team actually
 * asks for: totals, breakdowns, single vs multi item, co-purchases around a
 * focus product. Poppy answers from this instead of "generate the report and
 * look yourself".
 */
export function analyzeOrders(orders: ReportOrder[], focusProduct?: string): Record<string, unknown> {
  const count = orders.length;
  const inc = (m: Record<string, number>, k: string, by = 1) => { m[k] = (m[k] ?? 0) + by; };
  const top = (m: Record<string, number>, n: number) =>
    Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}: ${v}`);

  let revenue = 0;
  const byFulfillment: Record<string, number> = {};
  const byCountry: Record<string, number> = {};
  const byState: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  const byShipDate: Record<string, number> = {};
  const byProduct: Record<string, number> = {};
  const byTag: Record<string, number> = {};
  let singleItem = 0, multiItem = 0, cancelled = 0;

  const needle = (focusProduct ?? "").toLowerCase();
  let focusOnly = 0, focusPlusOthers = 0;
  const coProducts: Record<string, number> = {};

  for (const o of orders) {
    revenue += parseFloat(o.totalPrice) || 0;
    inc(byFulfillment, o.fulfillmentStatus ?? "unknown");
    inc(byCountry, o.shipping?.country ?? "unknown");
    if ((o.shipping?.countryCode ?? "") === "US") inc(byState, o.shipping?.provinceCode ?? "?");
    inc(byMonth, (o.processedAt ?? o.createdAt).slice(0, 7));
    if (o.shipDate) inc(byShipDate, o.shipDate);
    if (o.cancelledAt) cancelled++;
    const titles = o.lineItems.map((li) => li.title);
    const totalUnits = o.lineItems.reduce((n, li) => n + li.quantity, 0);
    if (totalUnits > 1 || titles.length > 1) multiItem++; else singleItem++;
    for (const li of o.lineItems) inc(byProduct, li.title, li.quantity);
    for (const t of o.tags) inc(byTag, t);
    if (needle) {
      const has = titles.some((t) => t.toLowerCase().includes(needle));
      const others = titles.filter((t) => !t.toLowerCase().includes(needle));
      if (has && others.length === 0) focusOnly++;
      else if (has) { focusPlusOthers++; for (const t of others) inc(coProducts, t); }
    }
  }

  const out: Record<string, unknown> = {
    orders: count,
    cancelled,
    revenue_total: Math.round(revenue * 100) / 100,
    revenue_average: count ? Math.round((revenue / count) * 100) / 100 : 0,
    single_item_orders: singleItem,
    multi_item_orders: multiItem,
    by_fulfillment: byFulfillment,
    by_country: top(byCountry, 8),
    top_us_states: top(byState, 8),
    by_month: byMonth,
    orders_with_ship_date: Object.values(byShipDate).reduce((n, v) => n + v, 0),
    by_ship_date: top(byShipDate, 14),
    top_products: top(byProduct, 10),
    top_tags: top(byTag, 12),
  };
  if (needle) {
    out.focus_product = focusProduct;
    out.orders_with_focus_only = focusOnly;
    out.orders_with_focus_plus_other_items = focusPlusOthers;
    out.top_products_bought_alongside = top(coProducts, 10);
  }
  return out;
}
