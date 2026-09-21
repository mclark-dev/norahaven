import { pgSelect, pgUpdate, pgInsert, pgUpsert, pgDelete, getSetting } from "./db.js";
import { latestBatchReport } from "./batchreport.js";
import type { BatchReport } from "./batchreport.js";

/**
 * Inventory forecasting.
 *
 * The core insight (verified against the Mailing Status Board, SEP 15 2026):
 * every active batch advances exactly ONE letter per mailing, and there are
 * two mailings per month ("Mailing 1" and "Mailing 2" — no fixed dates, per
 * Mike). So a batch's letter at any mailing is pure arithmetic:
 *
 *     letter = anchor(story) - batchNumber + (mailingsSince reference)
 *
 * Anchors were calibrated from the SEP 15 2026 board (= September Mailing 1).
 * Demand for a piece at a mailing = active-subscriber count of the batch that
 * is on that piece's letter (from Poppy's nightly batch count), or the
 * "dailies" estimate for cohorts that don't exist yet. Letter 1 goes out to
 * new subscribers as dailies, which the same formula covers (that cohort's
 * batch number is one above the newest batch on file).
 *
 * Supply is two human inputs per piece: our in-house count and PZ's stock.
 * Counts are entered "as of after <month> Mailing <n>"; every mailing that has
 * happened since is drawn down automatically. A PZ delivery moves quantity
 * from PZ's column to ours.
 */

// ---------- mailing index: two mailings per month ----------

/** Absolute mailing index. Sep 2026 M1 = 2026*24 + 8*2 + 0 = 48640. */
export function mailingIdx(year: number, month1to12: number, m1or2: number): number {
  return year * 24 + (month1to12 - 1) * 2 + (m1or2 - 1);
}

export function mailingLabel(idx: number): string {
  const year = Math.floor(idx / 24);
  const rem = idx % 24;
  const month = Math.floor(rem / 2) + 1;
  const m = (rem % 2) + 1;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[month - 1]} ${year} · Mailing ${m}`;
}

/** Latest mailing assumed complete as of `now` (day >= 21: M2 done; >= 7: M1 done). */
export function lastCompletedMailing(now = new Date()): number {
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth() + 1;
  const d = now.getUTCDate();
  if (d >= 21) return mailingIdx(y, mo, 2);
  if (d >= 7) return mailingIdx(y, mo, 1);
  const prevY = mo === 1 ? y - 1 : y;
  const prevMo = mo === 1 ? 12 : mo - 1;
  return mailingIdx(prevY, prevMo, 2);
}

// ---------- configuration ----------

export interface StoryCfg {
  batch: string; // prefix in batch filenames / batch report ("NA2")
  pieces: string; // prefix in piece codes ("NA")
  name: string;
  anchor: number; // letter = anchor - batchNumber at the reference mailing
  firstLetter: number;
  lastLetter: number;
  dailies: number; // est. new subscribers entering per mailing (letter-1 cohort)
  resends: number; // resend allowance added once per order horizon
}

export interface InvConfig {
  ref: number; // mailing index the anchors were calibrated at
  lead_mailings: number; // PZ print lead time expressed in mailings (~6 weeks = 3)
  horizon: number; // default order horizon in mailings (6 = one quarter)
  stories: StoryCfg[];
  roundup: Record<string, number>; // order rounding multiple by print type
}

export const DEFAULT_CONFIG: InvConfig = {
  ref: mailingIdx(2026, 9, 1), // SEP 15 2026 Mailing Status Board
  lead_mailings: 3,
  horizon: 6,
  stories: [
    { batch: "AM", pieces: "AM", name: "Adelaide Magnolia", anchor: 99, firstLetter: 1, lastLetter: 24, dailies: 300, resends: 180 },
    { batch: "AR", pieces: "AR", name: "Audrey Rose", anchor: 146, firstLetter: 1, lastLetter: 24, dailies: 300, resends: 180 },
    { batch: "LC", pieces: "LC", name: "Lily Clara", anchor: 123, firstLetter: 1, lastLetter: 24, dailies: 250, resends: 150 },
    { batch: "NA", pieces: "NA", name: "Norah Aven Pt 1", anchor: 115, firstLetter: 1, lastLetter: 24, dailies: 200, resends: 120 },
    { batch: "NA2", pieces: "NA", name: "Norah Aven Pt 2", anchor: 113, firstLetter: 25, lastLetter: 48, dailies: 10, resends: 10 },
    { batch: "NA3", pieces: "NA", name: "Norah Aven Pt 3", anchor: 85, firstLetter: 49, lastLetter: 72, dailies: 10, resends: 10 },
    { batch: "OM", pieces: "OM", name: "Orchid Mae", anchor: 61, firstLetter: 1, lastLetter: 24, dailies: 85, resends: 85 },
    { batch: "CG", pieces: "CG", name: "Camellia Grace", anchor: 21, firstLetter: 1, lastLetter: 24, dailies: 130, resends: 130 },
    { batch: "LA", pieces: "LA", name: "Laurel Anna", anchor: 5, firstLetter: 1, lastLetter: 24, dailies: 200, resends: 60 },
  ],
  roundup: {
    "1 SHEET": 8, "2 SHEET": 4, "3 SHEET": 3, "4 SHEET": 2,
    "SM CARD": 36, "POSTCARD": 25, "POSTER": 4,
    "NEWS CLIP": 10, "BOOKMARK": 10, "HALF PG": 10,
    "STICKER": 10, "BIZ CARD": 10, "TATTOO": 10, "FOLDED CARD": 10,
  },
};

export async function loadConfig(): Promise<InvConfig> {
  const raw = await getSetting("inventory_config", "");
  if (!raw) return DEFAULT_CONFIG;
  try {
    const saved = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...saved, roundup: { ...DEFAULT_CONFIG.roundup, ...(saved.roundup ?? {}) } };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// ---------- data ----------

export interface Piece {
  code: string;
  story: string;
  letter: number;
  seq: number;
  type: string;
  name: string;
}

export interface StockRow {
  code: string;
  our_count: number | null;
  our_as_of: number | null;
  pz_count: number | null;
  pz_as_of: number | null;
  updated_at: string;
  updated_by: string | null;
  our_updated_at: string | null;
  our_updated_by: string | null;
  pz_updated_at: string | null;
  pz_updated_by: string | null;
}

export interface BatchOverride { story: string; batch: number; active: number; actor: string | null; updated_at: string }

export async function loadPieces(): Promise<Piece[]> {
  return pgSelect<Piece>("inv_pieces", "select=code,story,letter,seq,type,name&active=eq.true&order=story,letter,seq&limit=2000");
}

export async function loadStock(): Promise<Map<string, StockRow>> {
  const rows = await pgSelect<StockRow>("inv_stock", "select=code,our_count,our_as_of,pz_count,pz_as_of,updated_at,updated_by,our_updated_at,our_updated_by,pz_updated_at,pz_updated_by&limit=2000");
  return new Map(rows.map((r) => [r.code, r]));
}

export async function loadOverrides(): Promise<BatchOverride[]> {
  try {
    return await pgSelect<BatchOverride>("inv_batch_overrides", "select=story,batch,active,actor,updated_at&limit=1000");
  } catch {
    return [];
  }
}

/** Apply manual batch-count overrides on top of the Drive report (override wins until cleared). */
export function applyOverrides(report: BatchReport, overrides: BatchOverride[]): BatchReport {
  if (!overrides.length) return report;
  const copy: BatchReport = JSON.parse(JSON.stringify(report));
  for (const o of overrides) {
    let story = copy.stories.find((s) => s.code === o.story);
    if (!story) {
      story = { code: o.story, name: o.story, batches: [], active: 0, canceled: 0 };
      copy.stories.push(story);
    }
    const b = story.batches.find((x) => x.batch === o.batch);
    if (b) { b.active = o.active; b.manual = true; }
    else story.batches.push({ batch: o.batch, active: o.active, canceled: 0, manual: true });
  }
  return copy;
}

// ---------- demand ----------

/**
 * Estimated subscriber count on letter L (of piece-story `pieces`) at mailing
 * `idx`. Uses the live batch counts; a cohort newer than the newest known
 * batch is estimated with the story's dailies number.
 */
function countOnLetter(cfg: StoryCfg, report: BatchReport, idx: number, letter: number, ref: number): number {
  if (letter < cfg.firstLetter || letter > cfg.lastLetter) return 0;
  const story = report.stories.find((s) => s.code === cfg.batch);
  const batchNum = cfg.anchor - letter + (idx - ref);
  if (!story || !story.batches.length) return batchNum > 0 ? cfg.dailies : 0;
  const known = story.batches.find((b) => b.batch === batchNum);
  if (known) return known.active;
  // "Future cohort" is judged against the newest DRIVE batch, so a manual
  // override entered for an even-newer batch doesn't zero out the gaps.
  const driveBatches = story.batches.filter((b) => !b.manual);
  const maxDrive = driveBatches.length ? Math.max(...driveBatches.map((b) => b.batch)) : Math.max(...story.batches.map((b) => b.batch));
  if (batchNum > maxDrive) return cfg.dailies; // future cohort, not created yet
  return 0; // batch predates records or already finished
}

/** The batch feeding a letter at a mailing, with its count and whether it's an estimate/override. */
function batchOnLetter(cfg: StoryCfg, report: BatchReport, idx: number, letter: number, ref: number): { b: number; n: number; est: boolean; ovr: boolean } | null {
  if (letter < cfg.firstLetter || letter > cfg.lastLetter) return null;
  const batchNum = cfg.anchor - letter + (idx - ref);
  if (batchNum <= 0) return null;
  const story = report.stories.find((s) => s.code === cfg.batch);
  const known = story?.batches.find((x) => x.batch === batchNum);
  if (known) return { b: batchNum, n: known.active, est: false, ovr: !!known.manual };
  const driveBatches = (story?.batches ?? []).filter((x) => !x.manual);
  const maxDrive = driveBatches.length ? Math.max(...driveBatches.map((x) => x.batch)) : 0;
  if (!story || !story.batches.length || batchNum > maxDrive) return { b: batchNum, n: cfg.dailies, est: true, ovr: false };
  return { b: batchNum, n: 0, est: false, ovr: false }; // finished / pre-records
}

/** Demand per piece code for one mailing. */
export function demandForMailing(pieces: Piece[], cfg: InvConfig, report: BatchReport, idx: number): Map<string, number> {
  const byLetter = new Map<string, Piece[]>();
  for (const p of pieces) {
    const k = `${p.story}:${p.letter}`;
    if (!byLetter.has(k)) byLetter.set(k, []);
    byLetter.get(k)!.push(p);
  }
  const out = new Map<string, number>();
  for (const sc of cfg.stories) {
    for (let letter = sc.firstLetter; letter <= sc.lastLetter; letter++) {
      const n = countOnLetter(sc, report, idx, letter, cfg.ref);
      if (!n) continue;
      for (const p of byLetter.get(`${sc.pieces}:${letter}`) ?? []) {
        out.set(p.code, (out.get(p.code) ?? 0) + n);
      }
    }
  }
  return out;
}

// ---------- forecast: two pools (our shelf vs PZ's stock) over 12 months ----------

export interface ForecastCell {
  need: number; // demand at this mailing
  show: number | null; // balance after this mailing: in-house while it lasts, then the combined pool
  state: "ok" | "pz" | "out"; // ok = covered by our shelf · pz = mailing out of PZ's stock · out = nothing left
}

export interface PieceForecast {
  code: string;
  type: string;
  name: string;
  letter: number;
  seq: number;
  our: number | null; // in-house count drawn down to today
  pz: number | null; // PZ's stock (their capacity)
  our_upd: { at: string | null; by: string | null };
  pz_upd: { at: string | null; by: string | null };
  cells: ForecastCell[]; // one per upcoming mailing
  deliver_i: number | null; // first mailing index our shelf can't cover -> PZ delivery needed before it
  print_i: number | null; // first mailing index the combined pool can't cover -> print run needed
  order_i: number | null; // print_i minus PZ's lead: last mailing by which the print order must be placed (<=0 means NOW)
  total_need: number; // demand over the whole horizon
  end: number | null; // combined balance at the end of the horizon
}

export interface Forecast {
  generated_at: string;
  last_mailing: string;
  labels: string[]; // one label per upcoming mailing (the cells columns)
  batch_report_at: string | null;
  lead_mailings: number;
  stories: {
    code: string;
    name: string;
    letters: {
      letter: number;
      /** Which batch prefix feeds this letter (e.g. "NA2" for NA letters 25-48). */
      bstory: string;
      /** Per mailing column: the batch on this letter and its count. est = estimated (no final number yet - click to enter one); ovr = manual override. */
      batches: ({ b: number; n: number; est: boolean; ovr: boolean } | null)[];
      pieces: PieceForecast[];
    }[];
    print_needed: number;
    order_now: number;
    /** Projected subscribers mailed at each upcoming mailing (includes dailies estimates). */
    mailing_totals: number[];
  }[];
  summary: { print_needed: number; order_now: number; deliver_soon: number; mailing_totals: number[] };
  dailies: Record<string, number>;
}

const SIM_MAILINGS = 24; // 12 months, two mailings per month

export async function buildForecast(now = new Date()): Promise<Forecast> {
  const [cfg, pieces, stock, rawReport, overrides] = await Promise.all([loadConfig(), loadPieces(), loadStock(), latestBatchReport(), loadOverrides()]);
  if (!rawReport) throw new Error("no_batch_report: run a Batches refresh first so Poppy knows the live batch counts");
  const report = applyOverrides(rawReport, overrides);

  const last = lastCompletedMailing(now);
  // demand for each mailing from just after the oldest stock as-of through the horizon
  const asOfs = [...stock.values()].flatMap((s) => [s.our_as_of ?? last, s.pz_as_of ?? last]);
  const earliest = Math.min(last, ...(asOfs.length ? asOfs : [last]));
  const demand = new Map<number, Map<string, number>>();
  for (let idx = earliest + 1; idx <= last + SIM_MAILINGS; idx++) {
    demand.set(idx, demandForMailing(pieces, cfg, report, idx));
  }

  const storyNames: Record<string, string> = { AM: "Adelaide Magnolia", AR: "Audrey Rose", LC: "Lily Clara", NA: "Norah Aven", OM: "Orchid Mae", CG: "Camellia Grace", LA: "Laurel Anna" };
  const byStory = new Map<string, Map<number, PieceForecast[]>>();
  let printNeeded = 0, orderNow = 0, deliverSoon = 0;

  for (const p of pieces) {
    const s = stock.get(p.code);
    let our: number | null = s?.our_count ?? null;
    if (our != null && s?.our_as_of != null) {
      for (let idx = s.our_as_of + 1; idx <= last; idx++) our -= demand.get(idx)?.get(p.code) ?? 0;
    }
    const pz = s?.pz_count ?? null;
    const unknown = our == null && pz == null;
    const ourN = our ?? 0, pzN = pz ?? 0;

    let cum = 0;
    let deliverI: number | null = null;
    let printI: number | null = null;
    const cells: ForecastCell[] = [];
    for (let k = 1; k <= SIM_MAILINGS; k++) {
      const need = demand.get(last + k)?.get(p.code) ?? 0;
      cum += need;
      const inhouse = ourN - cum;
      const total = ourN + pzN - cum;
      let state: ForecastCell["state"] = "ok";
      let show: number | null = unknown ? null : inhouse;
      if (inhouse < 0) {
        if (deliverI == null && need > 0) deliverI = k - 1;
        state = "pz";
        show = unknown ? null : total;
      }
      if (total < 0) {
        if (printI == null && need > 0) printI = k - 1;
        state = "out";
        show = unknown ? null : total;
      }
      cells.push({ need, show, state });
    }
    const orderI = printI != null ? printI - cfg.lead_mailings : null;
    if (!unknown && printI != null) printNeeded++;
    if (!unknown && orderI != null && orderI <= 0) orderNow++;
    if (!unknown && deliverI != null && deliverI < cfg.lead_mailings) deliverSoon++;

    const pf: PieceForecast = {
      code: p.code, type: p.type, name: p.name, letter: p.letter, seq: p.seq,
      our, pz,
      our_upd: { at: s?.our_updated_at ?? s?.updated_at ?? null, by: s?.our_updated_by ?? s?.updated_by ?? null },
      pz_upd: { at: s?.pz_updated_at ?? s?.updated_at ?? null, by: s?.pz_updated_by ?? s?.updated_by ?? null },
      cells,
      deliver_i: unknown ? null : deliverI,
      print_i: unknown ? null : printI,
      order_i: unknown ? null : orderI,
      total_need: cum,
      end: unknown ? null : ourN + pzN - cum,
    };
    if (!byStory.has(p.story)) byStory.set(p.story, new Map());
    const lm = byStory.get(p.story)!;
    if (!lm.has(p.letter)) lm.set(p.letter, []);
    lm.get(p.letter)!.push(pf);
  }

  const dailies: Record<string, number> = {};
  for (const sc of cfg.stories) dailies[sc.batch] = sc.dailies;

  const labels: string[] = [];
  for (let k = 1; k <= SIM_MAILINGS; k++) labels.push(mailingLabel(last + k));

  // Projected subscribers mailed per upcoming mailing, per piece-story and overall.
  const totalsByPieceStory = new Map<string, number[]>();
  const overallTotals = new Array(SIM_MAILINGS).fill(0);
  for (const sc of cfg.stories) {
    const arr = totalsByPieceStory.get(sc.pieces) ?? new Array(SIM_MAILINGS).fill(0);
    for (let k = 1; k <= SIM_MAILINGS; k++) {
      let subs = 0;
      for (let L = sc.firstLetter; L <= sc.lastLetter; L++) subs += countOnLetter(sc, report, last + k, L, cfg.ref);
      arr[k - 1] += subs;
      overallTotals[k - 1] += subs;
    }
    totalsByPieceStory.set(sc.pieces, arr);
  }

  const stories = [...byStory.entries()].map(([code, lm]) => {
    const letters = [...lm.entries()].sort((a, b) => a[0] - b[0]).map(([letter, ps]) => {
      // Which batch feeds this letter at each upcoming mailing, editable in the UI.
      const sc = cfg.stories.find((x) => x.pieces === code && letter >= x.firstLetter && letter <= x.lastLetter);
      const batches = new Array(SIM_MAILINGS).fill(null).map((_, k) => (sc ? batchOnLetter(sc, report, last + k + 1, letter, cfg.ref) : null));
      return { letter, bstory: sc?.batch ?? code, batches, pieces: ps.sort((a, b) => a.seq - b.seq) };
    });
    const flat = letters.flatMap((l) => l.pieces);
    return {
      code,
      name: storyNames[code] ?? code,
      letters,
      print_needed: flat.filter((p) => p.print_i != null).length,
      order_now: flat.filter((p) => p.order_i != null && p.order_i <= 0).length,
      mailing_totals: totalsByPieceStory.get(code) ?? new Array(SIM_MAILINGS).fill(0),
    };
  });

  return {
    generated_at: new Date().toISOString(),
    last_mailing: mailingLabel(last),
    labels,
    batch_report_at: report.generated_at ?? null,
    lead_mailings: cfg.lead_mailings,
    stories,
    summary: { print_needed: printNeeded, order_now: orderNow, deliver_soon: deliverSoon, mailing_totals: overallTotals },
    dailies,
  };
}

// ---------- order generator ----------

export interface OrderLine {
  code: string;
  type: string;
  name: string;
  need: number; // demand over horizon + resends
  our: number;
  pz: number;
  order: number; // rounded up
}

export async function buildOrder(horizon: number, now = new Date()): Promise<{ horizon: number; through: string; lines: OrderLine[]; by_type: Record<string, number> }> {
  const [cfg, pieces, stock, rawReport, overrides] = await Promise.all([loadConfig(), loadPieces(), loadStock(), latestBatchReport(), loadOverrides()]);
  if (!rawReport) throw new Error("no_batch_report: run a Batches refresh first");
  const report = applyOverrides(rawReport, overrides);
  const H = Math.min(Math.max(horizon || cfg.horizon, 1), 24);
  const last = lastCompletedMailing(now);

  const asOfs = [...stock.values()].map((s) => s.our_as_of ?? last);
  const earliest = Math.min(last, ...(asOfs.length ? asOfs : [last]));
  const demand = new Map<number, Map<string, number>>();
  for (let idx = earliest + 1; idx <= last + H; idx++) demand.set(idx, demandForMailing(pieces, cfg, report, idx));

  const resendByPieceStory = new Map<string, number>();
  for (const sc of cfg.stories) {
    // spread the story's resend allowance over its letters? No — the sheet adds it per piece.
    // Their sheet adds the flat resend number to EVERY piece's quarter need.
    for (const p of pieces) {
      if (p.story !== sc.pieces) continue;
      if (p.letter < sc.firstLetter || p.letter > sc.lastLetter) continue;
      resendByPieceStory.set(p.code, sc.resends);
    }
  }

  const lines: OrderLine[] = [];
  const byType: Record<string, number> = {};
  for (const p of pieces) {
    const s = stock.get(p.code);
    let our = s?.our_count ?? 0;
    if (s?.our_as_of != null) for (let idx = s.our_as_of + 1; idx <= last; idx++) our -= demand.get(idx)?.get(p.code) ?? 0;
    const pz = s?.pz_count ?? 0;
    let need = resendByPieceStory.get(p.code) ?? 0;
    for (let k = 1; k <= H; k++) need += demand.get(last + k)?.get(p.code) ?? 0;
    const short = need - (our + pz);
    if (short <= 0) continue;
    const m = cfg.roundup[p.type] ?? 10;
    const order = Math.ceil(short / m) * m;
    lines.push({ code: p.code, type: p.type, name: p.name, need, our, pz, order });
    byType[p.type] = (byType[p.type] ?? 0) + order;
  }
  lines.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  return { horizon: H, through: mailingLabel(last + H), lines, by_type: byType };
}

export function orderCSV(o: { lines: OrderLine[] }): string {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = "Piece,Type,Name,Need,Our Stock,PZ Stock,Order";
  return [head, ...o.lines.map((l) => [l.code, l.type, l.name, l.need, l.our, l.pz, l.order].map(esc).join(","))].join("\n");
}

// ---------- stock updates ----------

export async function setStock(
  code: string,
  patch: { our?: number; pz?: number; as_of?: number },
  actor: string
): Promise<void> {
  const nowIso = new Date().toISOString();
  const upd: Record<string, unknown> = { updated_at: nowIso, updated_by: actor };
  const asOf = patch.as_of ?? lastCompletedMailing();
  if (patch.our != null) { upd.our_count = patch.our; upd.our_as_of = asOf; upd.our_updated_at = nowIso; upd.our_updated_by = actor; }
  if (patch.pz != null) { upd.pz_count = patch.pz; upd.pz_as_of = asOf; upd.pz_updated_at = nowIso; upd.pz_updated_by = actor; }
  await pgUpdate("inv_stock", `code=eq.${encodeURIComponent(code)}`, upd);
  if (patch.our != null) await pgInsert("inv_stock_events", { code, kind: "our_count", qty: patch.our, as_of_mailing: asOf, actor });
  if (patch.pz != null) await pgInsert("inv_stock_events", { code, kind: "pz_count", qty: patch.pz, as_of_mailing: asOf, actor });
}

/** A PZ delivery arrived: quantity moves from PZ's stock to ours. */
export async function recordDelivery(code: string, qty: number, actor: string, note?: string): Promise<void> {
  const rows = await pgSelect<StockRow>("inv_stock", `select=code,our_count,pz_count&code=eq.${encodeURIComponent(code)}&limit=1`);
  const cur = rows[0];
  if (!cur) throw new Error(`unknown piece ${code}`);
  const nowIso = new Date().toISOString();
  await pgUpdate("inv_stock", `code=eq.${encodeURIComponent(code)}`, {
    our_count: (cur.our_count ?? 0) + qty,
    pz_count: (cur.pz_count ?? 0) - qty,
    updated_at: nowIso, updated_by: actor,
    our_updated_at: nowIso, our_updated_by: actor,
    pz_updated_at: nowIso, pz_updated_by: actor,
  });
  await pgInsert("inv_stock_events", { code, kind: "pz_delivery", qty, as_of_mailing: lastCompletedMailing(), actor, note: note ?? null });
}

// ---------- PZ count pull from the team's inventory workbook ----------

const PZ_SHEET_DEFAULT_ID = "11xwj-d-ON40sZN6GnHaMsddD-iJwsrzmlyfCvdHE5pk"; // INVENTORY MASTER & COUNTER
const XLSX_EXPORT_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const PIECE_CODE = /^[A-Z]{2}\d+\.\d+$/;

function sheetColumnValues(rows: string[][], headerText: string, fallbackCol: number): { col: number; note: string; values: Map<string, number> } {
  // The team appends new count columns to the RIGHT (the tab keeps history),
  // so when the header appears more than once, the rightmost match is current.
  let col = -1;
  let note = "";
  for (let r = 0; r < Math.min(rows.length, 6); r++) {
    for (let c = 0; c < (rows[r]?.length ?? 0); c++) {
      if (String(rows[r][c] ?? "").trim().toLowerCase() === headerText.toLowerCase() && c > col) {
        col = c;
        note = String(rows[r + 1]?.[c] ?? "").trim();
      }
    }
  }
  if (col < 0) col = fallbackCol;
  const values = new Map<string, number>();
  for (const row of rows) {
    let code = "";
    for (let c = 0; c < 4; c++) {
      const v = String(row[c] ?? "").trim().toUpperCase();
      if (PIECE_CODE.test(v)) { code = v; break; }
    }
    if (!code || values.has(code)) continue;
    const raw = String(row[col] ?? "").trim().replace(/,/g, "");
    if (raw === "") continue;
    const n = Math.round(Number(raw));
    if (Number.isFinite(n)) values.set(code, n);
  }
  return { col, note, values };
}

/**
 * Pull BOTH counts from the team's inventory workbook in one pass:
 *   - Our shelf  <- "MAILING COUNTER" tab, "ALL UP TOTAL" column (AK)
 *   - PZ's stock <- "PZ's Count" tab, "PZ Count" column (AZ)
 * Columns are found by header (with AK/AZ fallbacks) so the sheet can grow.
 * Overwrites counts for every piece found; pieces missing from a tab are left alone.
 */
export async function pullSheetCounts(actor: string, opts: { shelf_as_of?: number; pz_as_of?: number }): Promise<{
  shelf_updated: number; pz_updated: number; not_in_catalog: string[];
}> {
  const { driveGet, driveConfigured, parseXlsxSheetRows } = await import("./gdrive.js");
  if (!driveConfigured()) throw new Error("drive_not_configured");
  const fileId = await getSetting("inventory_pz_sheet_id", PZ_SHEET_DEFAULT_ID);
  const res = await driveGet(`files/${fileId}/export`, { mimeType: XLSX_EXPORT_MIME });
  const buf = Buffer.from(await res.arrayBuffer());

  const pzRows = parseXlsxSheetRows(buf, "PZs Count", 1500) ?? parseXlsxSheetRows(buf, "PZ's Count", 1500);
  if (!pzRows) throw new Error("pz_tab_not_found: no \"PZ's Count\" tab in the inventory workbook");
  const shelfRows = parseXlsxSheetRows(buf, "MAILING COUNTER", 1500);
  if (!shelfRows) throw new Error("counter_tab_not_found: no \"MAILING COUNTER\" tab in the inventory workbook");

  const pz = sheetColumnValues(pzRows, "PZ Count", 51); // AZ
  const shelf = sheetColumnValues(shelfRows, "ALL UP TOTAL", 36); // AK

  const catalog = new Set((await loadPieces()).map((p) => p.code));
  const nowIso = new Date().toISOString();
  const last = lastCompletedMailing();
  const shelfAsOf = opts.shelf_as_of ?? last;
  const pzAsOf = opts.pz_as_of ?? last;

  const byCode = new Map<string, Record<string, unknown>>();
  const notInCatalog = new Set<string>();
  let shelfN = 0, pzN = 0;
  for (const [code, n] of shelf.values) {
    if (!catalog.has(code)) { notInCatalog.add(code); continue; }
    byCode.set(code, { code, our_count: n, our_as_of: shelfAsOf, our_updated_at: nowIso, our_updated_by: actor, updated_at: nowIso, updated_by: actor });
    shelfN++;
  }
  for (const [code, n] of pz.values) {
    if (!catalog.has(code)) { notInCatalog.add(code); continue; }
    const row = byCode.get(code) ?? { code, updated_at: nowIso, updated_by: actor };
    Object.assign(row, { pz_count: n, pz_as_of: pzAsOf, pz_updated_at: nowIso, pz_updated_by: actor });
    byCode.set(code, row);
    pzN++;
  }
  const updates = [...byCode.values()];
  if (updates.length) await pgUpsert("inv_stock", updates as any, "code");
  return { shelf_updated: shelfN, pz_updated: pzN, not_in_catalog: [...notInCatalog].slice(0, 30) };
}

/** Set (or clear, with active=null) a manual batch-count override. Overrides win over Drive counts until cleared. */
export async function setBatchOverride(story: string, batch: number, active: number | null, actor: string): Promise<void> {
  if (active == null) {
    await pgDelete("inv_batch_overrides", `story=eq.${encodeURIComponent(story)}&batch=eq.${batch}`);
    return;
  }
  await pgUpsert("inv_batch_overrides", { story, batch, active, actor, updated_at: new Date().toISOString() }, "story,batch");
}

/** Parse "2026-10 M1" / "Oct 2026 Mailing 1" style labels into a mailing index. */
export function parseMailingRef(s: string): number | null {
  const t = String(s ?? "").trim();
  let m = t.match(/^(\d{4})-(\d{1,2})\s*(?:M|Mailing\s*)([12])$/i);
  if (m) return mailingIdx(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  m = t.match(/^([A-Za-z]{3,9})\s+(\d{4})\s*(?:·\s*)?(?:M|Mailing\s*)([12])$/i);
  if (m) {
    const mi = months.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return mailingIdx(parseInt(m[2], 10), mi + 1, parseInt(m[3], 10));
  }
  return null;
}
