import { env } from "../lib/env.js";
import { createMessage, ContentBlock, MessageParam, ToolDef } from "../lib/anthropic.js";
import { searchKb } from "../lib/kb.js";
import { searchOrders, classifyShipping, getShippingProfiles } from "../lib/shopify.js";
import type { OrderSummary } from "../lib/shopify.js";
import { fetchSitePage } from "../lib/sitefetch.js";
import { searchDrive, readDriveFile, findCustomerBatch, driveConfigured } from "../lib/gdrive.js";
import { runAndSaveBatchReport, latestBatchReport } from "../lib/batchreport.js";
import { authenticate, canSeeInventory } from "../lib/auth.js";
import type { ConsoleUser } from "../lib/auth.js";
import { queryAudit, auditRowsAsText } from "../lib/auditquery.js";
import type { BatchReport } from "../lib/batchreport.js";
import { pgSelect, getSetting, audit } from "../lib/db.js";
import { triage, runReplyAgent, composeFirstTouch, nowLine, ordersWithCheckoutOptions, handoffNote } from "../lib/agent.js";
import { ALWAYS_ESCALATE_CATEGORIES, AUTO_SEND_CATEGORIES, MIN_AUTO_CONFIDENCE, TRIAGE_FIRST_CATEGORIES, IMMEDIATE_ESCALATE_CATEGORIES } from "../lib/guardrails.js";
import {
  OrderCriteria, runOrderQuery, toCSV, REPORT_COLUMNS, ordersToReportRows,
  MAILING_BATCH_COLUMNS, ordersToMailingBatchRows, saveReport, analyzeOrders,
} from "../lib/reports.js";
import type { GorgiasTicket, GorgiasMessage } from "../lib/gorgias.js";

export const config = { maxDuration: 300 };

/**
 * ASK POPPY — the team's chat with Poppy inside the console. Internal only
 * (console password). Three things happen here:
 *
 *  chat — the team asks Poppy anything: how she works, what she knows,
 *         customer lookups, order reports, mailing batch lists. She can
 *         PROPOSE a knowledge article; saving it requires a human pressing
 *         Confirm in the console (which calls the existing kb_save).
 *  test — paste a pretend customer email; Poppy runs her full brain on it
 *         read-only and shows exactly what she would do and send.
 *  GET ?report=ID — download a generated report as CSV.
 *
 * Nothing in this file writes to Gorgias, Shopify, or the KB.
 */

const CRITERIA_SCHEMA = {
  type: "object",
  properties: {
    created_from: { type: "string", description: "orders created on/after, YYYY-MM-DD" },
    created_to: { type: "string", description: "orders created on/before, YYYY-MM-DD" },
    status: { type: "string", enum: ["open", "closed", "cancelled", "any"], description: "order status (default any)" },
    fulfillment: { type: "string", enum: ["unfulfilled", "shipped", "partial", "any"], description: "fulfillment status" },
    financial: { type: "string", description: "financial status: paid, refunded, partially_refunded, pending" },
    tag: { type: "string", description: "order must carry this Shopify tag (e.g. LASTORY, Subscription, NA2TIN)" },
    tag_not: { type: "string", description: "order must NOT carry this tag" },
    product_contains: { type: "string", description: "a line-item title contains this text (e.g. 'Laurel Anna', 'Keepsake Tin')" },
    country_code: { type: "string", description: "shipping country code, e.g. US, CA, AU" },
    exclude_country_code: { type: "string", description: "exclude this shipping country (US -> international only)" },
    text: { type: "string", description: "free-text search: order number, customer email or name" },
    ship_date: { type: "string", description: "customer-selected ship date equals this (YYYY-MM-DD)" },
    ship_from: { type: "string", description: "customer-selected ship date on/after (YYYY-MM-DD)" },
    ship_to: { type: "string", description: "customer-selected ship date on/before (YYYY-MM-DD)" },
  },
} as const;

const TOOLS: ToolDef[] = [
  {
    name: "search_kb",
    description: "Search Poppy's knowledge base (the same articles used to answer customers).",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "get_settings",
    description: "Read Poppy's current live settings: mode, per-category modes, channels, response time, caps, address-change mode, offers.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_site_page",
    description: "Read a page from theflowerletters.com as plain text (current prices, FAQ, story pages, policies). Our own site only - no other websites.",
    input_schema: { type: "object", properties: { url: { type: "string", description: "a theflowerletters.com URL or path, e.g. /pages/faq" } }, required: ["url"] },
  },
  {
    name: "search_drive",
    description: "Search the Google Drive folders shared with Poppy (mailing batch lists, CS guides, docs). Returns file names, types, and ids for read_drive_file.",
    input_schema: {
      type: "object",
      properties: {
        name_contains: { type: "string", description: "part of the file name, e.g. 'LA-BATCH' or 'Address Change'" },
        full_text: { type: "string", description: "text inside the file, e.g. a customer email or a phrase" },
      },
    },
  },
  {
    name: "read_drive_file",
    description: "Read a Drive file as text: Google Docs, Google Sheets, Excel (.xlsx, including the mailing batch files), and plain text. Use the id from search_drive.",
    input_schema: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] },
  },
  {
    name: "find_customer_batch",
    description: "Find which mailing batch(es) and letter number a customer is in, by their email, straight from the batch files in Drive.",
    input_schema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
  },
  {
    name: "batch_counts",
    description: "The active-batch report: ACTIVE vs CANCELED counts for every un-archived mailing batch file in Drive, by story. Answers 'how many active in AM-89?', 'which batches look empty?', story totals, etc. Uses the cached report (the console's Batches tab refreshes it); pass refresh=true only if the team explicitly wants a fresh re-count (takes about a minute).",
    input_schema: {
      type: "object",
      properties: {
        refresh: { type: "boolean", description: "re-read every batch file from Drive now instead of using the cached report" },
      },
    },
  },
  {
    name: "lookup_customer",
    description: "Look up a customer's recent Shopify orders by email (team-initiated internal lookup), in full detail: items with variants and properties, status, every tag with a plain-language reading, the order note, cancellation, the selected ship date and the arrival window shown at checkout, the full ship-to address, the shipping option they chose matched to the exact checkout rate and description, what they paid for shipping, and every fulfillment with tracking, carrier status, and estimated/actual delivery dates.",
    input_schema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
  },
  {
    name: "shipping_options",
    description: "Every shipping rate customers can see at checkout, straight from the Shopify shipping profiles: profile, which products it covers, zone (US / Canada / International), rate name, price, free-over-order-total threshold, and the description shown under the rate. Use for 'what do customers see at checkout', shipping cost or tracking questions, or spotting outdated rate descriptions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "query_orders",
    description: "Count and preview Shopify orders matching criteria. Use this to check numbers before generating a report. Returns the total found and the first few rows.",
    input_schema: { type: "object", properties: { criteria: CRITERIA_SCHEMA as any }, required: ["criteria"] },
  },
  {
    name: "analyze_orders",
    description: "Compute real numbers over the orders matching criteria: totals, revenue, single-item vs multi-item orders, breakdowns by fulfillment / country / US state / month / product / tag. With focus_product set (e.g. 'tin'), also splits focus-only orders vs focus-plus-other-items and lists what's bought alongside. Use this for ANY 'how many', 'what percent', or 'break it down' question instead of guessing or only offering a report.",
    input_schema: {
      type: "object",
      properties: {
        criteria: CRITERIA_SCHEMA as any,
        focus_product: { type: "string", description: "product-title text to pivot the analysis around, e.g. 'tin' or 'Laurel Anna'" },
      },
      required: ["criteria"],
    },
  },
  {
    name: "generate_report",
    description: "Run an order query and save the full result as a downloadable CSV for the team. format 'report' = general order report; format 'mailing_batch' = a mailing batch list in the team's exact 23-column batch-file format (requires batch_number and letter_number).",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "short human title, e.g. 'LA Batch 3 - US' or 'Unfulfilled tins September'" },
        format: { type: "string", enum: ["report", "mailing_batch"] },
        criteria: CRITERIA_SCHEMA as any,
        batch_number: { type: "number", description: "mailing_batch only: the batch number for the Batch column" },
        letter_number: { type: "number", description: "mailing_batch only: the Letter Number for every row" },
      },
      required: ["title", "format", "criteria"],
    },
  },
  {
    name: "propose_knowledge",
    description: "Propose a new or updated knowledge article from what a teammate just taught you. It is NOT saved - the teammate sees the draft with a Confirm button and decides. Use when someone tells you a fact, policy, or correction Poppy should keep.",
    input_schema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "kebab-case id; reuse an existing slug to update that article" },
        title: { type: "string" },
        content: { type: "string", description: "the article, written the way you'd tell a customer" },
      },
      required: ["slug", "title", "content"],
    },
  },
];

// Per-user tool: inventory. Appended to TOOLS only when the signed-in person's
// login has Inventory access (View or Edit on the Team tab; admins always).
const INVENTORY_TOOL: ToolDef = {
  name: "inventory_status",
  description: "Live printed-piece inventory forecast: per-piece stock (ours + PZ's), demand per upcoming mailing computed from the batch counts, when each piece runs out, and what to order from PZ. No input = the at-risk summary. piece (e.g. 'AM7.4') = that piece's full picture. story (e.g. 'CG') = that story's pieces. order_horizon (mailings, e.g. 6 = a quarter) = the PZ order list.",
  input_schema: {
    type: "object",
    properties: {
      piece: { type: "string", description: "one piece code, e.g. AM7.4" },
      story: { type: "string", description: "story code: AM, AR, LC, NA, OM, CG, LA" },
      order_horizon: { type: "number", description: "build the PZ order list covering this many upcoming mailings (2 per month; 6 = one quarter)" },
    },
  },
};

// Admin-only tool: full audit-log search. Appended to TOOLS only when the
// signed-in console user is an admin - other roles never even see it exists.
const AUDIT_TOOL: ToolDef = {
  name: "audit_log",
  description: "Search Poppy's complete audit log (everything she and the team have ever done): triage decisions, tool calls, replies/drafts/escalations, setting changes, knowledge saves, flags, address changes, logins. Filter by date range, person (actor), action type, or ticket number. Read-only history.",
  input_schema: {
    type: "object",
    properties: {
      date_from: { type: "string", description: "entries on/after this date, YYYY-MM-DD" },
      date_to: { type: "string", description: "entries on/before this date, YYYY-MM-DD" },
      actor_contains: { type: "string", description: "person or system, partial match: a teammate's name (e.g. 'sarah'), 'console' (any console action), 'agent' (Poppy on tickets), 'ask-poppy'" },
      action_contains: { type: "string", description: "action type, partial match: e.g. 'reply_sent', 'address', 'kb_saved', 'setting', 'flag', 'tool:', 'escalated'" },
      ticket_id: { type: "number", description: "only entries for this Gorgias ticket number" },
      limit: { type: "number", description: "max entries (default 100, cap 500)" },
    },
  },
};

const INTERNAL_PROMPT = `You are Poppy, The Flower Letters' automated customer service agent - but right now you are NOT talking to a customer. You are chatting with your own TEAM inside the internal console. Be their warm, candid, plain-spoken colleague: first person "I" is right here, explain honestly how you work, admit what you can't do, and keep answers short and useful. No AI-disclosure footer here. Never invent facts - use your tools, and say so when you don't know.

HOW YOU WORK (explain freely when asked): every new customer email is triaged into a category. Money and other protected categories (refunds, cancellations, payment, damaged/missing, legal, serious complaints, address changes) always go to a human - you send the customer a personal first-touch acknowledgment and hand the ticket over. Categories on the auto-answer list are answered by you when confidence is high, using only the Knowledge tab's articles and the sender's own order data. Everything is logged in the Activity feed, and the team can pause you with one switch.

MAILING BATCHES (how the business mails letters): each story collection is mailed in numbered batches. A batch list is one spreadsheet per batch, saved in Drive under "<Story> Mailing Lists" -> "<XX> Batch <n> (<dates>)" as <XX>-BATCH-<n>.xlsx (XX = story code: LA, CG, AM, NA, LC, AR...). Exact columns, in order: Batch, Status (ACTIVE or CANCELED), First Name, Last Name, Company, Address 1, Address 2, City, State-Province, Zip, Zip4, Country, Letter Number, Customer Name, Customer Email, Status (Open/Cancelled), Tags, Fulfillable Quantity, Notes, Order Processed Date, Order Number, Product Name, Color. The First/Last name and address are the RECIPIENT (shipping address - often a gift, so it can differ from Customer Name/Email, the purchaser). Tags come straight from the Shopify order (story tag like LASTORY, tin tags like LATIN/NA2TIN, Subscription, SCHEDULED, delivery-date tags). Color is filled by the team per letter. Orders usually enter a batch by the date window they were placed in and the story product they bought. You can generate a new batch list with generate_report (format mailing_batch): typically two lists per batch - US (country_code US) and international (exclude_country_code US) - filtered by the story's product or tag and the batch's order-date window. ALWAYS query_orders first, tell the team the count, and confirm the criteria (story, date window, batch number, letter number) before generating. The generated file is a CSV the team saves into the Drive batch folder as xlsx.

DRIVE: you can search and read the Google Drive folders the team has shared with your service account - the per-story Mailing Lists folders with their batch files, guides, and docs. search_drive finds files (by name, or by text inside them - searching a customer's email finds their batch files), read_drive_file reads Docs, Sheets, and the .xlsx batch files, and find_customer_batch answers "which batch/letter is this customer in?" directly. You have READ-ONLY access, and only to what's been shared with you; if a search comes up empty, the folder may simply not be shared yet - say so. When answering customers (not here in the console), you only ever surface a sender's own batch row, never anyone else's.

THE WEBSITE: you can read pages on theflowerletters.com live with read_site_page - current prices, FAQ, story pages, policies. That is your ONLY window to the web; you cannot search the internet or read any other site, on purpose. When a teammate asks about current site content, read the page rather than guessing, and if the site contradicts a knowledge article, say so - that's a sign the article needs updating.

BATCH COUNTS: batch_counts gives you the active-batch report - ACTIVE vs CANCELED for every un-archived batch file in Drive, story by story. Use it for any "how many active" question about batches instead of reading files one by one. It reads the cached report (refreshed nightly and from the console's Batches tab); only pass refresh=true when the team explicitly asks for a fresh re-count, and warn them it takes about a minute. A batch drops off this report when the team moves its file into a Completed Batches folder.

SHIP DATES: at checkout customers can choose when their first letter ships. You can see that choice on every order (shipDate, YYYY-MM-DD) - it comes from the order's __flare_delivery_date attribute, its line-item "First letter ships"/"Scheduled ship date" properties, and its "Delivery on ..." / date tags; orders without a selection (resends, redemptions, older orders) have none. Use it when the team asks about a customer's chosen date, and use the ship_date / ship_from / ship_to criteria to query or analyze orders by selected ship date ("how many chose Sep 18?" -> analyze_orders with ship_date, or look at by_ship_date in any analysis). A future shipDate means the order is intentionally waiting, not late.

INVENTORY (printed pieces - per-person access: the inventory_status tool is only in your toolkit when the signed-in person's login has Inventory access; if someone asks about inventory and you don't have the tool, say inventory is limited to a few people and an admin can grant access in the Team tab): inventory_status is your window into piece inventory - stock on hand (the team's count + PZ the printer's stock), computed demand for upcoming mailings, run-out timing, and PZ order lists. The math: every active batch advances one letter per mailing (two mailings a month, "Mailing 1" and "Mailing 2" - no fixed dates), so demand for each piece is the live batch counts applied to the letter each batch is on next. Use it for "when do we run out of AM7.4?", "how's CG inventory?", "what should the October PZ order be?" (order_horizon 6 covers a quarter). Stock counts are entered by the team in the console's Inventory tab; if numbers look stale or negative, say a fresh count is needed there. You can read all of this but not change stock numbers - that's the Inventory tab.

ORDER REPORTS & ANALYSIS: the team can ask you for orders by any criteria - date range, story/product, fulfillment status, tags, destination country, cancelled or not, or the customer's selected ship date. Use query_orders to preview counts, analyze_orders for ANY numbers question ("how many also bought X", "what percent shipped", "break it down by state/month/product", revenue totals) - run it rather than saying you can't break something down - and generate_report to produce the downloadable file. If a request truly needs a filter you don't have (e.g. by discount code used), say so plainly rather than approximating silently.

AUDIT LOG (admins only - the audit_log tool is only in your toolkit when the signed-in person is an admin): everything you and the team do is permanently logged. With audit_log you can answer "what happened yesterday?", "what did Sarah change this week?", "show me every address change in September", "what did you do on ticket 12345?". Summarize the results usefully - group by person or action, call out failures - rather than dumping raw lines. If someone asks and you DON'T have the tool, they're not an admin: say the audit history is there but admin-only, and the full searchable view is in the console's Audit tab.

TEACHING: when a teammate tells you something you should remember for customers, use propose_knowledge to draft the article and tell them to hit Confirm. Never claim it's saved until they confirm. If they ask about behavior rules (categories, modes), point them to the "What it handles" tab - those are switches, not articles.

Keep replies conversational text - no markdown headings, no bullet spam. Plain short paragraphs.`;

// Any signed-in console user (any role) may talk to Poppy: chat and test are
// read-only, and everything that saves (kb Confirm, settings) goes through
// console-data where roles are enforced.

async function runTool(name: string, input: Record<string, any>, out: { proposals: any[]; reports: any[] }, me: ConsoleUser): Promise<string> {
  if (name === "audit_log") {
    // Defense in depth: the tool is only offered to admins, but check anyway.
    if (me.role !== "admin") return "The audit log is admin-only. The signed-in account doesn't have access.";
    const rows = await queryAudit({
      date_from: input.date_from ? String(input.date_from) : undefined,
      date_to: input.date_to ? String(input.date_to) : undefined,
      actor_contains: input.actor_contains ? String(input.actor_contains) : undefined,
      action_contains: input.action_contains ? String(input.action_contains) : undefined,
      ticket_id: input.ticket_id ? parseInt(String(input.ticket_id), 10) : undefined,
      limit: input.limit,
    });
    const text = auditRowsAsText(rows);
    return `${rows.length} entries${rows.length >= 500 ? " (capped at 500 - narrow the filters)" : ""}:\n${text}`.slice(0, 7000);
  }
  if (name === "search_kb") {
    const hits = await searchKb(String(input.query ?? ""), 4);
    return hits.length ? hits.map((h) => `[${h.slug}] ${h.title}\n${h.content.slice(0, 1200)}`).join("\n\n---\n\n") : "No matching articles.";
  }
  if (name === "get_settings") {
    const rows = await pgSelect("cs_settings", "select=key,value&order=key");
    return rows.map((r: any) => `${r.key} = ${r.value}`).join("\n");
  }
  if (name === "read_site_page") {
    const r = await fetchSitePage(String(input.url ?? ""));
    return "error" in r ? r.error : `[${r.url}]\n${r.text}`;
  }
  if (name === "search_drive") {
    if (!driveConfigured()) return "Drive isn't connected yet - the Google service account hasn't been set up.";
    const files = await searchDrive({ nameContains: input.name_contains ? String(input.name_contains) : undefined, fullText: input.full_text ? String(input.full_text) : undefined, limit: 15 });
    if (!files.length) return "No files found. Remember: I can only see folders the team has shared with my Drive account.";
    return files.map((f) => `${f.name} [${f.mimeType.split(".").pop()}] id=${f.id} modified=${(f.modifiedTime ?? "").slice(0, 10)}`).join("\n");
  }
  if (name === "read_drive_file") {
    if (!driveConfigured()) return "Drive isn't connected yet - the Google service account hasn't been set up.";
    const r = await readDriveFile(String(input.file_id ?? ""));
    return "error" in r ? r.error : `[${r.name}]\n${r.text}`;
  }
  if (name === "find_customer_batch") {
    if (!driveConfigured()) return "Drive isn't connected yet - the Google service account hasn't been set up.";
    return await findCustomerBatch(String(input.email ?? ""));
  }
  if (name === "batch_counts") {
    if (!driveConfigured()) return "Drive isn't connected yet - the Google service account hasn't been set up, so I can't read the batch files.";
    let report: BatchReport | null;
    if (input.refresh === true) {
      report = await runAndSaveBatchReport();
    } else {
      report = await latestBatchReport();
      if (!report) report = await runAndSaveBatchReport();
    }
    const lines: string[] = [
      `Report generated ${report.generated_at} - ${report.files_counted} un-archived batch files, ${report.active_total} ACTIVE / ${report.canceled_total} CANCELED total.`,
    ];
    for (const s of report.stories) {
      lines.push(`\n${s.name} (${s.code}) - ${s.batches.length} batches, ${s.active} active / ${s.canceled} canceled:`);
      lines.push(s.batches.map((b) => `${b.batch}:${b.active}/${b.canceled}`).join(" "));
    }
    if (report.empty_files.length) lines.push(`\nEMPTY files (no rows at all - worth flagging): ${report.empty_files.join(", ")}`);
    if (report.errors.length) lines.push(`\nFiles I couldn't read: ${report.errors.join("; ")}`);
    lines.push(`\n(Per-batch format is batch:active/canceled. The full table with CSV download is in the console's Batches tab.)`);
    return lines.join("\n").slice(0, 7000);
  }
  if (name === "inventory_status") {
    // Defense in depth: the tool is only offered when the login has access, but check anyway.
    if (!canSeeInventory(me)) return "Inventory access hasn't been granted to this login - an admin can turn it on in the console's Team tab.";
    const { buildForecast, buildOrder } = await import("../lib/inventory.js");
    try {
      if (input.order_horizon) {
        const o = await buildOrder(parseInt(String(input.order_horizon), 10) || 6);
        if (!o.lines.length) return `Nothing to order - every piece covers the next ${o.horizon} mailings (through ${o.through}).`;
        const byType = Object.entries(o.by_type).map(([t, n]) => `${t} ${n}`).join(", ");
        const lines = o.lines.map((l) => `${l.code} [${l.type}] need ${l.need}, have ${l.our}+${l.pz} -> ORDER ${l.order}`);
        return `PZ order covering the next ${o.horizon} mailings (through ${o.through}) - ${o.lines.length} pieces.\nTotals by type: ${byType}\n${lines.join("\n")}`.slice(0, 7000);
      }
      const f = await buildForecast();
      const orderBy = (p: { order_i: number | null }) => p.order_i == null ? null : (p.order_i <= 0 ? "NOW (deadline passed)" : f.labels[p.order_i]);
      const deliverBy = (p: { deliver_i: number | null }) => p.deliver_i == null ? null : f.labels[p.deliver_i];
      const pieceQ = input.piece ? String(input.piece).trim().toUpperCase() : "";
      const storyQ = input.story ? String(input.story).trim().toUpperCase() : "";
      if (pieceQ) {
        for (const s of f.stories) {
          for (const l of s.letters) {
            const p = l.pieces.find((x) => x.code === pieceQ);
            if (p) {
              return `${p.code} - ${p.name}\nOur shelf (drawn down to today): ${p.our ?? "unknown"} | PZ's stock: ${p.pz ?? "unknown"}\nNext mailing (${f.labels[0]}) needs: ${p.cells[0]?.need ?? 0} | 12-month need: ${p.total_need}\nOur shelf runs dry: ${deliverBy(p) ?? "not within 12 months"} (a PZ delivery covers it while their stock lasts)\nPZ's stock runs dry too: ${p.print_i != null ? f.labels[p.print_i] : "not within 12 months"}${p.print_i != null ? ` -> print order must be placed by ${orderBy(p)}` : ""}\n12-month end balance: ${p.end ?? "unknown"}\n(As of after ${f.last_mailing}; batch counts from ${f.batch_report_at ?? "?"}.)`;
            }
          }
        }
        return `I don't have a piece called ${pieceQ}. Piece codes look like AM7.4 (story + letter.piece).`;
      }
      if (storyQ) {
        const s = f.stories.find((x) => x.code === storyQ);
        if (!s) return `No story ${storyQ}. Stories: ${f.stories.map((x) => x.code).join(", ")}.`;
        const lines: string[] = [];
        for (const l of s.letters) for (const p of l.pieces) {
          lines.push(`${p.code}: shelf ${p.our ?? "?"} + PZ ${p.pz ?? "?"}${p.deliver_i != null ? `, delivery by ${deliverBy(p)}` : ""}${p.print_i != null ? `, PRINT order by ${orderBy(p)}` : ""}`);
        }
        return `${s.name} - ${s.letters.reduce((n, l) => n + l.pieces.length, 0)} pieces: ${s.print_needed} need a print run within 12 months, ${s.order_now} past the order-now point.\n${lines.join("\n")}`.slice(0, 7000);
      }
      const head = `Inventory as of after ${f.last_mailing} (12-month view). ${f.summary.print_needed} pieces need a print order within 12 months; ${f.summary.order_now} are at or past the order-now deadline; ${f.summary.deliver_soon} need a PZ delivery within ${f.lead_mailings} mailings.`;
      if (!f.summary.order_now) return head;
      const urgent: string[] = [];
      for (const s of f.stories) for (const l of s.letters) for (const p of l.pieces) {
        if (p.order_i != null && p.order_i <= 0) urgent.push(`${p.code} (out at ${p.print_i != null ? f.labels[p.print_i] : "?"})`);
      }
      return `${head}\nOrder NOW: ${urgent.join(", ")}`.slice(0, 7000);
    } catch (e: any) {
      if (String(e?.message ?? "").startsWith("no_batch_report")) return "I can't build the forecast yet - the batch counts haven't been run. Ask the team to hit Refresh on the console's Batches tab first.";
      throw e;
    }
  }
  if (name === "lookup_customer") {
    const email = String(input.email ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return "That doesn't look like an email address.";
    // Full internal detail (team console only): tags, note, ship-to, checkout rate, fulfillments.
    const got: any = await ordersWithCheckoutOptions(email).catch((e: any) => ({ orders: [], note: String(e?.message ?? e) }));
    const orders: OrderSummary[] = Array.isArray(got) ? got : got.orders ?? [];
    const warn = Array.isArray(got) ? "" : got.note ? `\n(${got.note})` : "";
    if (!orders.length) return `No orders found for ${email}.${warn}`;
    const d = (x: string | null | undefined) => (x ? x.slice(0, 10) : "");
    return orders
      .map((o) => {
        const items = o.lineItems.map((li) => {
          const props = li.properties ? ` {${Object.entries(li.properties).map(([k, v]) => `${k}: ${v}`).join("; ")}}` : "";
          return `${li.title}${li.variant ? ` (${li.variant})` : ""} x${li.quantity}${props}`;
        }).join("; ") || "none";
        const co = o.checkoutOption;
        const rate = co
          ? `${co.name} - $${co.price}${co.minOrderTotal ? ` (free tier: orders $${co.minOrderTotal}+)` : ""} · profile "${co.profile}" · ${co.where}${co.description ? ` · checkout says: "${co.description}"` : ""}`
          : o.shippingMethod ? `${o.shippingMethod} (not a checkout rate - custom/manual)` : "none on this order";
        const fl = o.fulfillments.map((f) => {
          const t = f.tracking.map((x) => [x.company, x.number].filter(Boolean).join(" ")).filter(Boolean).join(", ");
          return `${f.status ?? "?"} created ${d(f.createdAt)}${f.inTransitAt ? `, in transit ${d(f.inTransitAt)}` : ""}${f.estimatedDeliveryAt ? `, carrier ETA ${d(f.estimatedDeliveryAt)}` : ""}${f.deliveredAt ? `, DELIVERED ${d(f.deliveredAt)}` : ""}${t ? ` · ${t}` : " · no tracking"}`;
        }).join(" | ");
        return `${o.name} (${d(o.createdAt)})${o.cancelledAt ? ` CANCELLED ${d(o.cancelledAt)}${o.cancelReason ? ` (${o.cancelReason})` : ""}` : ""}
  items: ${items}
  status: ${o.fulfillmentStatus ?? "?"} / ${o.financialStatus ?? "?"} / ${o.totalPrice}
  at a glance: ${o.atAGlance}
  ship date chosen: ${o.shipDate ?? "none"}${o.estimatedDelivery ? ` · arrival window shown at checkout: ${o.estimatedDelivery}` : ""}
  mailed: ${o.mailedAt ? `${d(o.mailedAt)} (shipping label created)` : "no shipping label yet"}${o.expectedArrival ? ` · expected arrival ${o.expectedArrival.from} to ${o.expectedArrival.to} (${o.expectedArrival.basis})` : ""}
  shipping: ${rate} · paid $${o.shippingPaid ?? "?"} · ${classifyShipping(o.shippingMethod)}
  fulfillments: ${fl || "none yet"}
  ship to: ${o.shippingAddressFormatted ?? "no shipping address"}
  tags: ${o.tags.join(", ") || "none"}${o.tagNotes.length ? `\n  reading: ${o.tagNotes.join("; ")}` : ""}${o.internalNote ? `\n  note: ${o.internalNote.slice(0, 300)}` : ""}`;
      })
      .join("\n") + warn;
  }
  if (name === "shipping_options") {
    const rows = await getShippingProfiles(true);
    if (!rows.length) return "No active shipping rates found.";
    const today = new Date();
    return rows.map((r) => {
      const stale = r.description && /ships by ([A-Za-z]+ \d{1,2})/i.exec(r.description);
      let flag = "";
      if (stale) {
        const dt = new Date(`${stale[1]} ${today.getFullYear()}`);
        if (!isNaN(dt.getTime()) && dt < today) flag = "  <- this date has already passed; customers still see it at checkout";
      }
      return `[${r.profile}] ${r.where} · ${r.name} · $${r.price}${r.minOrderTotal ? ` (orders $${r.minOrderTotal}+)` : ""}${r.description ? ` · "${r.description}"` : ""}${flag}\n    products: ${r.products.join(", ") || "(none listed)"}`;
    }).join("\n");
  }
  if (name === "query_orders") {
    const { orders, truncated } = await runOrderQuery((input.criteria ?? {}) as OrderCriteria, 800);
    const preview = orders.slice(0, 8).map((o) => `${o.name} ${(o.processedAt ?? o.createdAt).slice(0, 10)} ${o.customerName ?? o.email ?? "?"} - ${o.lineItems[0]?.title ?? ""} [${o.fulfillmentStatus ?? "?"}] ${o.shipping?.countryCode ?? ""}`).join("\n");
    return `${orders.length}${truncated ? "+ (capped at 800 - narrow the criteria)" : ""} orders match.\n${preview}${orders.length > 8 ? "\n..." : ""}`;
  }
  if (name === "analyze_orders") {
    const { orders, truncated } = await runOrderQuery((input.criteria ?? {}) as OrderCriteria, 3000);
    if (!orders.length) return "No orders match those criteria.";
    const a = analyzeOrders(orders, input.focus_product ? String(input.focus_product) : undefined);
    return JSON.stringify(a, null, 1).slice(0, 5500) + (truncated ? "\n(NOTE: capped at 3000 orders - numbers are a floor, not exact)" : "");
  }
  if (name === "generate_report") {
    const criteria = (input.criteria ?? {}) as OrderCriteria;
    const format = input.format === "mailing_batch" ? "mailing_batch" : "report";
    const { orders, truncated } = await runOrderQuery(criteria, 3000);
    if (!orders.length) return "No orders match those criteria - nothing to generate.";
    let csv: string;
    if (format === "mailing_batch") {
      const batch = Number(input.batch_number ?? 0);
      const letter = Number(input.letter_number ?? 0);
      if (!batch || !letter) return "mailing_batch needs batch_number and letter_number - ask the team which batch and letter this is.";
      csv = toCSV(MAILING_BATCH_COLUMNS as unknown as string[], ordersToMailingBatchRows(orders, batch, letter));
    } else {
      csv = toCSV(REPORT_COLUMNS as unknown as string[], ordersToReportRows(orders));
    }
    const id = await saveReport({ title: String(input.title ?? "Report"), kind: format, criteria, csv, rowCount: orders.length });
    out.reports.push({ id, title: String(input.title ?? "Report"), row_count: orders.length, kind: format });
    await audit({ actor: `ask-poppy:${me.name}`, action: "report_generated", input: { id, title: String(input.title ?? ""), kind: format, rows: orders.length } });
    return `Report saved (${orders.length} orders${truncated ? ", capped at 3000" : ""}). The team sees a Download button for "${input.title}" in this chat.`;
  }
  if (name === "propose_knowledge") {
    const slug = String(input.slug ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80);
    const title = String(input.title ?? "").slice(0, 200);
    const content = String(input.content ?? "").slice(0, 10000);
    if (!slug || !title || !content) return "Proposal needs slug, title and content.";
    out.proposals.push({ slug, title, content });
    return "Draft shown to the teammate with a Confirm button. Not saved yet - tell them to review and confirm.";
  }
  return `Unknown tool ${name}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const me = await authenticate(req);
  if (!me) return res.status(401).json({ error: "unauthorized" });
  // Inventory-only logins see only the Inventory tab - Ask Poppy is off limits.
  if (me.role === "inventory") return res.status(403).json({ error: "this login is inventory-only" });

  try {
    // ---- CSV download ----
    if (req.method === "GET") {
      const id = parseInt(String(req.query?.report ?? ""), 10);
      if (!id) return res.status(400).json({ error: "report id required" });
      const rows = await pgSelect("cs_reports", `select=id,title,csv&id=eq.${id}&limit=1`);
      if (!rows[0]) return res.status(404).json({ error: "not found" });
      const fname = rows[0].title.replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "report";
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fname}.csv"`);
      return res.status(200).send(rows[0].csv);
    }

    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });
    const mode = String(req.body?.mode ?? "chat");

    // ---- test as customer: full read-only dry run ----
    if (mode === "test") {
      const body = String(req.body?.body ?? "").slice(0, 8000);
      const subject = String(req.body?.subject ?? "").slice(0, 300);
      if (!body.trim()) return res.status(400).json({ error: "body required" });
      const fromEmail = String(req.body?.from_email ?? "test@example.com").slice(0, 200);
      const fromName = String(req.body?.from_name ?? "Test Customer").slice(0, 120);

      const ticket: GorgiasTicket = {
        id: 0, subject: subject || "(test)", status: "open", channel: "email",
        customer: { id: 0, email: fromEmail, name: fromName }, tags: [], assignee_user: null,
      };
      const messages: GorgiasMessage[] = [{
        id: 0, ticket_id: 0, channel: "email", via: "email", from_agent: false,
        body_text: body, body_html: null, subject: subject || null,
        sender: { email: fromEmail, name: fromName }, created_datetime: new Date().toISOString(),
      }];

      const tri = await triage(subject, body);
      let wouldDo: string;
      const triageFirst = TRIAGE_FIRST_CATEGORIES.has(tri.category) && (await getSetting("triage_enabled", "true")) === "true";
      if (tri.category === "spam") wouldDo = "skip (spam)";
      else if (IMMEDIATE_ESCALATE_CATEGORIES.has(tri.category)) wouldDo = "hand straight to a person (legal / press / serious complaint)";
      else if (triageFirst) wouldDo = "triage it - confirm what they want and gather what the team needs - then hand off to a person";
      else if (ALWAYS_ESCALATE_CATEGORIES.has(tri.category)) wouldDo = "escalate to human (protected category)";
      else if (!AUTO_SEND_CATEGORIES.has(tri.category)) wouldDo = "draft for review (not on auto-send list)";
      else if (tri.confidence < MIN_AUTO_CONFIDENCE) wouldDo = `draft for review (confidence ${tri.confidence} below ${MIN_AUTO_CONFIDENCE})`;
      else wouldDo = "answer autonomously (in auto mode; drafts in draft mode)";

      let proposedReply: string | null = null;
      let escalationReason: string | null = null;
      let firstTouch: string | null = null;
      let outgoingEmail: string | null = null;
      let askMissing: string[] | null = null;
      let handoffCard: string | null = null;
      if (tri.category !== "spam") {
        const responseTime = await getSetting("human_response_time", "1-2 business days");
        if (triageFirst || !ALWAYS_ESCALATE_CATEGORIES.has(tri.category)) {
          const outcome = await runReplyAgent({ ticket, messages, triageResult: tri, dbTicketId: 0, mode: triageFirst ? "triage" : "normal", gatherRoundsUsed: 0 });
          proposedReply = outcome.action === "reply" ? (outcome.replyText ?? null) : null;
          escalationReason = outcome.action === "escalate" ? (outcome.escalationReason ?? null) : null;
          if (outcome.action === "ask") {
            askMissing = outcome.askMissing ?? [];
            wouldDo += ` -> first she'd ask the customer: ${askMissing.join("; ") || "for more detail"}`;
            outgoingEmail = env.AGENT_FOOTER ? `${outcome.askText}\n\n${env.AGENT_FOOTER}` : (outcome.askText ?? null);
          }
          if (outcome.action === "handoff" && outcome.handoff) {
            wouldDo += ` -> triaged and handed to the team (${outcome.handoff.kind.replace(/_/g, " ")})`;
            handoffCard = handoffNote(outcome.handoff, { name: fromName, email: fromEmail }, tri.category);
            outgoingEmail = env.AGENT_FOOTER ? `${outcome.handoff.customerMessage}\n\n${env.AGENT_FOOTER}` : outcome.handoff.customerMessage;
          }
        }
        if (outgoingEmail) {
          // question or hand-off message already set
        } else if (proposedReply) {
          outgoingEmail = env.AGENT_FOOTER ? `${proposedReply}\n\n${env.AGENT_FOOTER}` : proposedReply;
        } else {
          const ft = await composeFirstTouch({ ticket, messages, triageResult: tri, responseTime });
          if (ft === "NO_REPLY") firstTouch = "NO_REPLY";
          else if (ft) { firstTouch = ft; outgoingEmail = env.AGENT_FOOTER ? `${ft}\n\n${env.AGENT_FOOTER}` : ft; }
        }
      }
      await audit({ actor: `ask-poppy:${me.name}`, action: "test_run", input: { subject: subject.slice(0, 120) }, output: { category: tri.category, wouldDo } });
      return res.status(200).json({
        category: tri.category, confidence: tri.confidence, summary: tri.summary,
        would_do: wouldDo, proposed_reply: proposedReply, escalation_reason: escalationReason,
        first_touch: firstTouch, outgoing_email: outgoingEmail,
        ask_missing: askMissing, handoff_card: handoffCard,
      });
    }

    // ---- chat ----
    const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const history: MessageParam[] = raw
      .slice(-24)
      .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string" && m.content.trim())
      .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 8000) }));
    if (!history.length || history[history.length - 1].role !== "user") {
      return res.status(400).json({ error: "messages must end with a user message" });
    }

    const out = { proposals: [] as any[], reports: [] as any[] };
    const convo: MessageParam[] = [...history];
    let reply = "";

    for (let turn = 0; turn < 10; turn++) {
      const r = await createMessage({
        model: env.MODEL_AGENT,
        max_tokens: 1600,
        system: INTERNAL_PROMPT + nowLine(),
        tools: [...TOOLS, ...(canSeeInventory(me) ? [INVENTORY_TOOL] : []), ...(me.role === "admin" ? [AUDIT_TOOL] : [])],
        tool_choice: { type: "auto" },
        messages: convo,
      });
      const toolUses = r.content.filter((b): b is ContentBlock & { id: string; name: string } => b.type === "tool_use");
      if (toolUses.length === 0) {
        reply = r.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
        break;
      }
      convo.push({ role: "assistant", content: r.content });
      const results: ContentBlock[] = [];
      for (const tu of toolUses) {
        let result: string;
        try { result = await runTool(tu.name, (tu.input ?? {}) as Record<string, any>, out, me); }
        catch (e: any) { result = `Tool error: ${(e.message ?? "failed").slice(0, 300)}`; }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: result.slice(0, 6000) } as ContentBlock);
      }
      convo.push({ role: "user", content: results });
    }
    if (!reply) reply = "Sorry - I ran out of steps on that one. Try asking it a smaller piece at a time.";

    await audit({ actor: `ask-poppy:${me.name}`, action: "chat", input: { q: String(history[history.length - 1].content).slice(0, 200) }, output: { reports: out.reports.length, proposals: out.proposals.length } });
    return res.status(200).json({ reply, proposals: out.proposals, reports: out.reports });
  } catch (e: any) {
    console.error("ask-poppy error", e);
    return res.status(500).json({ error: (e.message ?? "server error").slice(0, 300) });
  }
}
