import { driveConfigured, driveGet, parseXlsxRows } from "./gdrive.js";
import { pgInsert, pgSelect } from "./db.js";

/**
 * Active-batch report: counts ACTIVE vs CANCELED rows in every un-archived
 * mailing batch file in Drive (the team's <STORY>-BATCH-<N>.xlsx files).
 *
 * "Un-archived" is defined by folder location, not by us: a batch counts as
 * active while its file still sits in a story's main Mailing Lists folder.
 * When the team moves it into a "Completed Batches" folder it drops off the
 * report automatically.
 *
 * Read-only against Drive. Each run is saved to cs_reports (kind
 * 'batch_report') so the console tab loads instantly and Ask Poppy can answer
 * from the cached numbers without re-reading ~170 files.
 */

export const STORY_NAMES: Record<string, string> = {
  AR: "Audrey Rose",
  LC: "Lily Clara",
  AM: "Adelaide Magnolia",
  OM: "Orchid Mae",
  NA: "Norah Aven",
  NA2: "Norah Aven 2",
  NA3: "Norah Aven 3",
  CG: "Camellia Grace",
  LA: "Laurel Anna",
};

export interface BatchCount {
  story: string; // e.g. "AM"
  batch: number; // e.g. 96
  file: string; // file name
  fileId: string;
  active: number;
  canceled: number;
}

export interface BatchReport {
  generated_at: string;
  files_counted: number;
  active_total: number;
  canceled_total: number;
  stories: {
    code: string;
    name: string;
    batches: { batch: number; active: number; canceled: number; manual?: boolean }[];
    active: number;
    canceled: number;
  }[];
  /** Batch files with zero rows — usually a mistake worth checking. */
  empty_files: string[];
  errors: string[];
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** List every *-BATCH-*.xlsx in Drive with its parent folder id (paginated). */
async function listBatchFiles(): Promise<{ id: string; name: string; parents: string[] }[]> {
  const out: { id: string; name: string; parents: string[] }[] = [];
  let pageToken = "";
  do {
    const params: Record<string, string> = {
      q: `name contains 'BATCH' and mimeType = '${XLSX_MIME}' and trashed = false`,
      pageSize: "1000",
      fields: "nextPageToken,files(id,name,parents)",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: "allDrives",
    };
    if (pageToken) params.pageToken = pageToken;
    const res = await driveGet("files", params);
    const data = await res.json();
    for (const f of data.files ?? []) out.push({ id: f.id, name: f.name, parents: f.parents ?? [] });
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

/**
 * One paginated listing of every folder Poppy can see, so archive checks can
 * walk the WHOLE ancestor chain locally. This matters because the team
 * archives a batch by moving its per-batch folder ("AM Batch 12 (…)") into a
 * "Completed Batches" folder — the file's immediate parent keeps its normal
 * name and only a grandparent says "Completed".
 */
async function listAllFolders(): Promise<Map<string, { name: string; parents: string[] }>> {
  const map = new Map<string, { name: string; parents: string[] }>();
  let pageToken = "";
  do {
    const params: Record<string, string> = {
      q: `mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      pageSize: "1000",
      fields: "nextPageToken,files(id,name,parents)",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: "allDrives",
    };
    if (pageToken) params.pageToken = pageToken;
    const res = await driveGet("files", params);
    const data = await res.json();
    for (const f of data.files ?? []) map.set(f.id, { name: f.name ?? "", parents: f.parents ?? [] });
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return map;
}

const ARCHIVE_RE = /complet|archiv/i; // "Completed Batches", "Complete", "Archived", "Archive"

/** True when the file sits anywhere under an archive folder (any ancestor). */
function isArchived(parents: string[], folders: Map<string, { name: string; parents: string[] }>): boolean {
  const queue = [...parents];
  const visited = new Set<string>();
  let hops = 0;
  while (queue.length && hops < 100) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    hops++;
    const f = folders.get(id);
    if (!f) continue; // ancestor not visible to Poppy - can't be judged, treat as live
    if (ARCHIVE_RE.test(f.name)) return true;
    queue.push(...f.parents);
  }
  return false;
}

/** Download one batch file and count its Status column. */
async function countFile(fileId: string): Promise<{ active: number; canceled: number; rows: number }> {
  const res = await driveGet(`files/${fileId}`, { alt: "media", supportsAllDrives: "true" });
  const rows = parseXlsxRows(Buffer.from(await res.arrayBuffer()), 6000);
  if (!rows.length) return { active: 0, canceled: 0, rows: 0 };
  // Header-driven: first column named "Status" (the recipient status, column B in the team's format).
  let statusIdx = rows[0].findIndex((h) => String(h ?? "").trim().toLowerCase() === "status");
  if (statusIdx < 0) statusIdx = 1;
  let active = 0, canceled = 0;
  for (let i = 1; i < rows.length; i++) {
    const v = String(rows[i][statusIdx] ?? "").trim().toUpperCase();
    if (v === "ACTIVE") active++;
    else if (v === "CANCELED" || v === "CANCELLED") canceled++;
  }
  return { active, canceled, rows: active + canceled };
}

const BATCH_NAME = /^([A-Z][A-Z0-9]*)-BATCH-(\d+)/i;

export async function runBatchReport(): Promise<BatchReport> {
  if (!driveConfigured()) throw new Error("drive_not_configured");

  const [all, folders] = await Promise.all([listBatchFiles(), listAllFolders()]);

  // Keep only files whose name matches <STORY>-BATCH-<N> and that are NOT
  // anywhere under an archive folder ("Completed Batches" etc.) — checked up
  // the whole ancestor chain, because archiving moves the per-batch FOLDER.
  // Dedupe by name (names are unique per batch in practice).
  const keep: { id: string; name: string; story: string; batch: number }[] = [];
  const seen = new Set<string>();
  for (const f of all) {
    const m = BATCH_NAME.exec(f.name);
    if (!m) continue;
    if (isArchived(f.parents, folders)) continue;
    const key = `${m[1].toUpperCase()}-${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push({ id: f.id, name: f.name, story: m[1].toUpperCase(), batch: parseInt(m[2], 10) });
  }

  // Count with limited concurrency so ~170 downloads finish in ~1 minute.
  const counts: BatchCount[] = [];
  const errors: string[] = [];
  const queue = [...keep];
  const workers = Array.from({ length: 8 }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      try {
        const c = await countFile(item.id);
        counts.push({ story: item.story, batch: item.batch, file: item.name, fileId: item.id, active: c.active, canceled: c.canceled });
      } catch (e: any) {
        errors.push(`${item.name}: ${(e.message ?? "read failed").slice(0, 120)}`);
      }
    }
  });
  await Promise.all(workers);

  const byStory = new Map<string, BatchCount[]>();
  for (const c of counts) {
    if (!byStory.has(c.story)) byStory.set(c.story, []);
    byStory.get(c.story)!.push(c);
  }
  const storyOrder = [...byStory.keys()].sort((a, b) => {
    const ka = Object.keys(STORY_NAMES).indexOf(a);
    const kb = Object.keys(STORY_NAMES).indexOf(b);
    return (ka < 0 ? 99 : ka) - (kb < 0 ? 99 : kb);
  });

  const report: BatchReport = {
    generated_at: new Date().toISOString(),
    files_counted: counts.length,
    active_total: counts.reduce((n, c) => n + c.active, 0),
    canceled_total: counts.reduce((n, c) => n + c.canceled, 0),
    stories: storyOrder.map((code) => {
      const list = byStory.get(code)!.sort((a, b) => a.batch - b.batch);
      return {
        code,
        name: STORY_NAMES[code] ?? code,
        batches: list.map((c) => ({ batch: c.batch, active: c.active, canceled: c.canceled })),
        active: list.reduce((n, c) => n + c.active, 0),
        canceled: list.reduce((n, c) => n + c.canceled, 0),
      };
    }),
    empty_files: counts.filter((c) => c.active + c.canceled === 0).map((c) => c.file).sort(),
    errors,
  };
  return report;
}

export function batchReportCSV(r: BatchReport): string {
  const lines = ["Story,Story Code,Batch,Active,Canceled,Total"];
  for (const s of r.stories) {
    for (const b of s.batches) {
      lines.push(`"${s.name}",${s.code},${b.batch},${b.active},${b.canceled},${b.active + b.canceled}`);
    }
  }
  lines.push(`TOTAL,,,${r.active_total},${r.canceled_total},${r.active_total + r.canceled_total}`);
  return lines.join("\r\n");
}

/** Run + persist to cs_reports; returns the saved report. */
export async function runAndSaveBatchReport(): Promise<BatchReport> {
  const report = await runBatchReport();
  const day = report.generated_at.slice(0, 10);
  await pgInsert("cs_reports", {
    title: `Active batch report ${day}`,
    kind: "batch_report",
    criteria: report,
    row_count: report.active_total + report.canceled_total,
    csv: batchReportCSV(report),
    created_by: "batch-report",
  });
  return report;
}

/** Latest saved report, or null. */
export async function latestBatchReport(): Promise<BatchReport | null> {
  const rows = await pgSelect<{ criteria: BatchReport }>(
    "cs_reports",
    "select=criteria&kind=eq.batch_report&order=created_at.desc&limit=1"
  );
  return rows[0]?.criteria ?? null;
}
