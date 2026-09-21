import { driveConfigured } from "../lib/gdrive.js";
import { runAndSaveBatchReport, latestBatchReport, batchReportCSV } from "../lib/batchreport.js";
import { authenticate, atLeast } from "../lib/auth.js";

export const config = { maxDuration: 300 };

/**
 * Active-batch report endpoint (console "Batches" tab + nightly cron).
 *
 *   GET  /api/batch-report            -> latest cached report (JSON)
 *   GET  /api/batch-report?refresh=1  -> re-count every un-archived batch file now (~1 min)
 *   GET  /api/batch-report?csv=1      -> latest report as a CSV download
 *
 * Auth: console password (x-console-key), or the Vercel cron for the nightly
 * refresh (Bearer CRON_SECRET when configured). Read-only against Drive.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = (req.headers["authorization"] as string) ?? "";
  const cronSecret = process.env.CRON_SECRET;
  const okCron = cronSecret ? auth === `Bearer ${cronSecret}` : String(req.headers["user-agent"] ?? "").includes("vercel-cron");
  const user = okCron ? null : await authenticate(req);
  const okConsole = !!user;
  if (!okCron && !okConsole) return res.status(401).json({ error: "unauthorized" });
  // Inventory-only logins get the Inventory tab alone; its forecast reads the
  // batch report server-side, so this endpoint stays closed to them.
  if (user && user.role === "inventory") return res.status(403).json({ error: "this login is inventory-only" });

  if (!driveConfigured()) {
    return res.status(200).json({ error: "drive_not_configured", detail: "Set GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY (and GOOGLE_IMPERSONATE_EMAIL for Poppy's account) to connect Drive, then redeploy." });
  }

  try {
    const wantRefresh = String(req.query?.refresh ?? "") === "1";
    const wantCSV = String(req.query?.csv ?? "") === "1";

    if (wantRefresh) {
      // A forced re-count reads ~175 Drive files; viewers get the cached report only.
      if (okConsole && !atLeast(user, "team")) return res.status(403).json({ error: "your account is view-only - the cached report is available without refresh" });
      const report = await runAndSaveBatchReport();
      // Cron calls just need an ack, not the payload.
      if (okCron && !okConsole) return res.status(200).json({ ok: true, files_counted: report.files_counted });
      return res.status(200).json({ report });
    }

    const report = await latestBatchReport();
    if (!report) return res.status(200).json({ report: null });

    if (wantCSV) {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="active-batch-report-${report.generated_at.slice(0, 10)}.csv"`);
      return res.status(200).send(batchReportCSV(report));
    }
    return res.status(200).json({ report });
  } catch (e: any) {
    return res.status(500).json({ error: (e.message ?? "batch report failed").slice(0, 300) });
  }
}
