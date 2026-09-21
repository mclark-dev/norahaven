import { getSetting } from "../lib/db.js";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const mode = await getSetting("agent_mode", "unknown");
    res.status(200).json({ ok: true, agent_mode: mode });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
