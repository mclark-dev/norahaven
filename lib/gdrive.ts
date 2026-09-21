import { env } from "./env.js";
import { inflateRawSync } from "node:zlib";

/**
 * Google Drive access via a SERVICE ACCOUNT - Poppy's own Google identity.
 *
 * Safety model:
 *  - READ-ONLY scope (drive.readonly), enforced by Google, not just by us.
 *  - The service account sees ONLY files/folders the team explicitly shares
 *    with its email address. Nothing else in the Drive exists to Poppy.
 *  - Optional: until GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY are set, every
 *    function reports "not connected" and Poppy says so plainly.
 *
 * Zero dependencies: the JWT is signed with Node's built-in WebCrypto, and
 * .xlsx files (the mailing batch lists) are unpacked with built-in zlib.
 */

export function driveConfigured(): boolean {
  return !!(env.GOOGLE_SA_EMAIL && env.GOOGLE_SA_PRIVATE_KEY);
}

let cached: { token: string; exp: number } | null = null;

async function getToken(): Promise<string> {
  if (!driveConfigured()) throw new Error("Drive is not connected - the Google service account isn't configured yet.");
  if (cached && Date.now() < cached.exp) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const b64u = (s: string) => Buffer.from(s).toString("base64url");
  const claims: Record<string, unknown> = {
    iss: env.GOOGLE_SA_EMAIL,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  // With domain-wide delegation, act as Poppy's own Workspace account - then
  // anything shared with poppy@... is visible, like for any coworker.
  if (env.GOOGLE_IMPERSONATE_EMAIL) claims.sub = env.GOOGLE_IMPERSONATE_EMAIL;
  const signingInput = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify(claims))}`;
  const pemBody = env.GOOGLE_SA_PRIVATE_KEY.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(pemBody, "base64"),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, Buffer.from(signingInput));
  const jwt = `${signingInput}.${Buffer.from(sig).toString("base64url")}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
  });
  if (!res.ok) throw new Error(`Google auth ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  cached = { token: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 120) * 1000 };
  return cached.token;
}

export async function driveGet(path: string, params: Record<string, string>): Promise<Response> {
  const token = await getToken();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
}

const FILE_FIELDS = "files(id,name,mimeType,modifiedTime,webViewLink)";

export async function searchDrive(opts: { nameContains?: string; fullText?: string; limit?: number }): Promise<DriveFile[]> {
  const clean = (s: string) => s.replace(/['\\]/g, " ").trim();
  const parts = ["trashed = false"];
  if (opts.nameContains) parts.push(`name contains '${clean(opts.nameContains)}'`);
  if (opts.fullText) parts.push(`fullText contains '${clean(opts.fullText)}'`);
  const res = await driveGet("files", {
    q: parts.join(" and "),
    pageSize: String(Math.min(opts.limit ?? 15, 30)),
    orderBy: "modifiedTime desc",
    fields: FILE_FIELDS,
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    corpora: "allDrives",
  });
  return (await res.json()).files ?? [];
}

/** Read one Drive file as text: Google Docs -> text, Sheets -> CSV, .xlsx -> CSV, plain text as-is. */
export async function readDriveFile(fileId: string, maxChars = 14000): Promise<{ name: string; text: string } | { error: string }> {
  const id = String(fileId ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return { error: "A Drive file id is required (from search_drive results)." };
  const metaRes = await driveGet(`files/${id}`, { fields: "id,name,mimeType", supportsAllDrives: "true" });
  const meta = await metaRes.json();
  const mt: string = meta.mimeType ?? "";

  const exportAs = async (mime: string) => {
    const r = await driveGet(`files/${id}/export`, { mimeType: mime });
    return r.text();
  };

  try {
    if (mt === "application/vnd.google-apps.document") return { name: meta.name, text: (await exportAs("text/plain")).slice(0, maxChars) };
    if (mt === "application/vnd.google-apps.spreadsheet") return { name: meta.name, text: (await exportAs("text/csv")).slice(0, maxChars) };
    if (mt === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      const r = await driveGet(`files/${id}`, { alt: "media", supportsAllDrives: "true" });
      const rows = parseXlsxRows(Buffer.from(await r.arrayBuffer()), 3000);
      return { name: meta.name, text: rows.map((row) => row.join(",")).join("\n").slice(0, maxChars) };
    }
    if (mt.startsWith("text/") || mt === "application/json" || mt === "text/csv") {
      const r = await driveGet(`files/${id}`, { alt: "media", supportsAllDrives: "true" });
      return { name: meta.name, text: (await r.text()).slice(0, maxChars) };
    }
    return { error: `"${meta.name}" is ${mt} - I can read Google Docs, Sheets, Excel files, and plain text, but not this type yet.` };
  } catch (e: any) {
    return { error: `Couldn't read "${meta.name}": ${(e.message ?? "read failed").slice(0, 200)}` };
  }
}

// ---------- minimal .xlsx reader (a zip of XML, unpacked with built-in zlib) ----------

function zipEntries(buf: any): Map<string, any> {
  const out = new Map<string, any>();
  // Find End Of Central Directory (sig 0x06054b50) near the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip/xlsx file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    // Local header: name/extra lengths can differ from the central ones.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + csize);
    out.set(name, method === 8 ? inflateRawSync(raw) : raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function xmlUnescape(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    if (ch >= "A" && ch <= "Z") n = n * 26 + (ch.charCodeAt(0) - 64);
    else break;
  }
  return n - 1;
}

/** Rows of the FIRST worksheet as strings. Numbers stay raw (Excel serial dates included). */
export function parseXlsxRows(buf: any, maxRows = 3000): string[][] {
  const entries = zipEntries(buf);
  const sharedXml = entries.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const shared: string[] = [];
  for (const m of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlUnescape(t[1]));
    shared.push(texts.join(""));
  }
  const sheetName = entries.has("xl/worksheets/sheet1.xml")
    ? "xl/worksheets/sheet1.xml"
    : [...entries.keys()].find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  const sheetXml = sheetName ? entries.get(sheetName).toString("utf8") : "";
  const rows: string[][] = [];
  for (const rm of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= maxRows) break;
    const row: string[] = [];
    // Drop self-closing empty cells (<c r="E2" s="7"/>) first - otherwise the
    // regex below swallows them together with the NEXT cell's value.
    const rowXml = rm[1].replace(/<c[^>]*\/>/g, "");
    for (const cm of rowXml.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1];
      const inner = cm[2];
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "";
      const idx = ref ? colIndex(ref) : row.length;
      const type = /t="(\w+)"/.exec(attrs)?.[1] ?? "";
      let val = "";
      if (type === "s") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
        val = shared[parseInt(v, 10)] ?? "";
      } else if (type === "inlineStr") {
        val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlUnescape(t[1])).join("");
      } else {
        val = xmlUnescape(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
      }
      while (row.length < idx) row.push("");
      row[idx] = val;
    }
    rows.push(row);
  }
  return rows;
}

/** Rows of a NAMED worksheet tab (case-insensitive, ignoring apostrophes/spaces). Returns null when the tab doesn't exist. */
export function parseXlsxSheetRows(buf: any, tabName: string, maxRows = 3000): string[][] | null {
  const entries = zipEntries(buf);
  const wb = entries.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const relMap = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\s+[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) relMap.set(id, target.replace(/^\//, "").replace(/^(?!xl\/)/, "xl/"));
  }
  const norm = (s: string) => s.toLowerCase().replace(/['’\s]/g, "");
  let path: string | undefined;
  for (const m of wb.matchAll(/<sheet\s+[^>]*>/g)) {
    const name = xmlUnescape(/name="([^"]+)"/.exec(m[0])?.[1] ?? "");
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1] ?? "";
    if (norm(name) === norm(tabName)) { path = relMap.get(rid); break; }
  }
  if (!path || !entries.has(path)) return null;
  const sharedXml = entries.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const shared: string[] = [];
  for (const m of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlUnescape(t[1]));
    shared.push(texts.join(""));
  }
  const sheetXml = entries.get(path)!.toString("utf8");
  const rows: string[][] = [];
  for (const rm of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= maxRows) break;
    const row: string[] = [];
    const rowXml = rm[1].replace(/<c[^>]*\/>/g, "");
    for (const cm of rowXml.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1];
      const inner = cm[2];
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "";
      const idx = ref ? colIndex(ref) : row.length;
      const type = /t="(\w+)"/.exec(attrs)?.[1] ?? "";
      let val = "";
      if (type === "s") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
        val = shared[parseInt(v, 10)] ?? "";
      } else if (type === "inlineStr") {
        val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlUnescape(t[1])).join("");
      } else {
        val = xmlUnescape(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
      }
      while (row.length < idx) row.push("");
      row[idx] = val;
    }
    rows.push(row);
  }
  return rows;
}

// ---------- batch lookup (safe for the customer-facing agent) ----------

/**
 * Find the SENDER'S OWN rows in the mailing batch files. Drive's full-text
 * index finds which batch files contain the email; we open only those and
 * return only that customer's rows. Other customers' data never leaves here.
 */
export async function findCustomerBatch(email: string): Promise<string> {
  const e = String(email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return "No valid email to look up.";
  const files = await searchDrive({ fullText: e, nameContains: "BATCH", limit: 5 });
  const xlsx = files.filter((f) => f.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").slice(0, 3);
  if (!xlsx.length) return `No mailing batch file contains ${e}. (Either they aren't in a batch yet, or the batch folders haven't been shared with Poppy's Drive account.)`;

  const found: string[] = [];
  for (const f of xlsx) {
    try {
      const r = await driveGet(`files/${f.id}`, { alt: "media", supportsAllDrives: "true" });
      const rows = parseXlsxRows(Buffer.from(await r.arrayBuffer()), 5000);
      if (!rows.length) continue;
      const header = rows[0].map((h) => h.toLowerCase().trim());
      const col = (label: string, fallback: number) => {
        const i = header.indexOf(label);
        return i >= 0 ? i : fallback;
      };
      const cEmail = col("customer email", 14);
      const cBatch = col("batch", 0);
      const cStatus = col("status", 1);
      const cLetter = col("letter number", 12);
      const cFirst = col("first name", 2);
      const cLast = col("last name", 3);
      const cOrder = col("order number", 20);
      const cTags = col("tags", 16);
      const tidy = (v: string) => String(v ?? "").replace(/\.0$/, ""); // Excel numerics export as "2.0"
      let hits = 0;
      for (const row of rows.slice(1)) {
        if ((row[cEmail] ?? "").toLowerCase().trim() !== e) continue;
        if (hits >= 4) { found.push(`  ...more rows in ${f.name}`); break; }
        hits++;
        const deliveryTag = (row[cTags] ?? "").split(",").map((t: string) => t.trim()).find((t: string) => /^delivery on /i.test(t));
        found.push(
          `${f.name}: batch ${tidy(row[cBatch]) || "?"}, letter ${tidy(row[cLetter]) || "?"}, recipient ${[row[cFirst], row[cLast]].filter(Boolean).join(" ") || "?"}, status ${row[cStatus] ?? "?"}, order ${tidy(row[cOrder]) || "?"}${deliveryTag ? `, ${deliveryTag}` : ""}`
        );
      }
    } catch {
      found.push(`  (couldn't open ${f.name})`);
    }
  }
  return found.length
    ? `This customer's mailing batch rows (their own rows only):\n${found.join("\n")}`
    : `Batch files matched the search but no row carries ${e} in the Customer Email column.`;
}
