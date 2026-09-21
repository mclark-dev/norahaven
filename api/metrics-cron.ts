import { env } from "../lib/env.js";
import { listRecentTickets, listMessages } from "../lib/gorgias.js";
import { getSetting, pgUpsert, audit } from "../lib/db.js";

export const config = { maxDuration: 120 };

/**
 * Live response-time metric. Runs on a Vercel cron (see vercel.json): samples
 * recent tickets, measures time from the customer's first message to the first
 * HUMAN reply (Poppy's api-sent messages are excluded), and updates the
 * `human_response_time` phrase used in every acknowledgment.
 *
 * The team can freeze it: setting `response_time_auto` to false makes this a
 * no-op and whatever the console says stands.
 */

function phraseFor(medianHours: number): string {
  if (medianHours <= 5) return "a few hours";
  if (medianHours <= 26) return "1 business day";
  if (medianHours <= 52) return "1-2 business days";
  return "2-3 business days";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Accept: Vercel cron (Bearer CRON_SECRET when configured), or the console key.
  const auth = (req.headers["authorization"] as string) ?? "";
  const consoleKey = (req.headers["x-console-key"] as string) ?? "";
  const cronSecret = process.env.CRON_SECRET;
  const okCron = cronSecret ? auth === `Bearer ${cronSecret}` : String(req.headers["user-agent"] ?? "").includes("vercel-cron");
  const okConsole = !!process.env.CONSOLE_PASSWORD && consoleKey === process.env.CONSOLE_PASSWORD;
  if (!okCron && !okConsole) return res.status(401).json({ error: "unauthorized" });

  try {
    if ((await getSetting("response_time_auto", "true")) !== "true") {
      return res.status(200).json({ skipped: "response_time_auto=false" });
    }

    const { tickets } = await listRecentTickets(40);
    const hours: number[] = [];
    for (const t of tickets) {
      if (hours.length >= 25) break;
      let messages;
      try { messages = await listMessages(t.id); } catch { continue; }
      const first = messages.find((m) => !m.from_agent && m.channel !== "internal-note");
      if (!first) continue;
      const humanReply = messages.find(
        (m) => m.from_agent && m.via !== "api" && m.channel !== "internal-note" && m.created_datetime > first.created_datetime
      );
      if (!humanReply) continue;
      const dt = (new Date(humanReply.created_datetime).getTime() - new Date(first.created_datetime).getTime()) / 3600000;
      if (dt >= 0 && dt < 24 * 14) hours.push(dt);
    }

    if (hours.length < 5) {
      return res.status(200).json({ skipped: `only ${hours.length} measurable tickets - keeping current phrase` });
    }
    hours.sort((a, b) => a - b);
    const median = hours[Math.floor(hours.length / 2)];
    const phrase = phraseFor(median);
    const current = await getSetting("human_response_time", "");
    if (phrase !== current) {
      await pgUpsert("cs_settings", { key: "human_response_time", value: phrase, updated_at: new Date().toISOString() }, "key");
      await audit({ actor: "metrics", action: "response_time_updated", output: { from: current, to: phrase, medianHours: Math.round(median * 10) / 10, sample: hours.length } });
    }
    return res.status(200).json({ medianHours: Math.round(median * 10) / 10, sample: hours.length, phrase, changed: phrase !== current });
  } catch (e: any) {
    return res.status(200).json({ error: (e.message ?? "metrics failed").slice(0, 300) });
  }
}
