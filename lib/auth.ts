import { createHash, randomBytes, scryptSync } from "node:crypto";
import { pgSelect, pgUpdate } from "./db.js";

/**
 * Named console logins: username = the person's EMAIL, plus a password.
 * The client sends them as headers: x-console-user (email) and x-console-key
 * (password). Signing in with NO email and the CONSOLE_PASSWORD env value is
 * the owner's master login (always admin).
 *
 * Passwords are stored as salted scrypt hashes ("s1:<salt>:<hash>") in
 * cs_users.key_hash - never in plain text, and a leaked database can't be
 * reversed or rainbow-tabled. (Legacy unsalted sha256 hashes from the first
 * passcode build still verify, so nothing breaks if any were created.)
 *
 * Roles:
 *   admin  - everything, including managing users and the live master switches
 *   team   - day-to-day work: Ask Poppy, flagging, confirming knowledge,
 *            approving address changes, category/behavior settings
 *   viewer - read-only: sees everything, changes nothing
 */

/**
 * Single-purpose logins:
 *   "inventory" = sees the Inventory section and nothing else
 *   "askpoppy"  = sees the Ask Poppy chat and nothing else
 */
export type Role = "admin" | "team" | "viewer" | "inventory" | "askpoppy";

/** Logins limited to one section of the console. */
export function isSinglePurpose(u: ConsoleUser | null): boolean {
  return !!u && (u.role === "inventory" || u.role === "askpoppy");
}

/** May use the Ask Poppy chat? Everyone except inventory-only logins. */
export function canAskPoppy(u: ConsoleUser | null): boolean {
  return !!u && u.role !== "inventory";
}

/** May add/edit/delete knowledge articles and topics? Admins only. */
export function canEditKnowledge(u: ConsoleUser | null): boolean {
  return !!u && u.role === "admin";
}

/** Per-user Inventory access: none = tab hidden, view = read-only, edit = can enter counts. */
export type InvAccess = "none" | "view" | "edit";

export interface ConsoleUser {
  id: number | null; // null = the master password (owner)
  name: string;
  email: string | null;
  role: Role;
  inv: InvAccess; // admins are always "edit" regardless of the stored value
}

/** Can this user see the Inventory tab / use the inventory tools at all? */
export function canSeeInventory(u: ConsoleUser | null): boolean {
  return !!u && (u.role === "admin" || u.role === "inventory" || u.inv === "view" || u.inv === "edit");
}

/** Can this user enter counts / deliveries? (Viewers can never write, whatever their inv flag.) */
export function canEditInventory(u: ConsoleUser | null): boolean {
  return !!u && (u.role === "admin" || (u.inv === "edit" && u.role !== "viewer"));
}

export function sha256hex(s: string): string {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

/** Salted scrypt password hash, stored as "s1:<salthex>:<hashhex>". */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, 32).toString("hex");
  return `s1:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!stored) return false;
  if (stored.startsWith("s1:")) {
    const [, salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    try { return scryptSync(String(password), salt, 32).toString("hex") === hash; } catch { return false; }
  }
  // Legacy: plain sha256 of a generated passcode (first build of team logins).
  return sha256hex(password) === stored;
}

/** Readable temporary password, e.g. "tfl-h4mk-x7ru-p2wd". Shown once at creation/reset. */
export function generatePasscode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no l/o/0/1
  const bytes = randomBytes(12);
  let s = "";
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) s += "-";
    s += alphabet[bytes[i] % alphabet.length];
  }
  return `tfl-${s}`;
}

export function normalizeEmail(e: string): string {
  return String(e ?? "").trim().toLowerCase();
}

export function isEmail(e: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
}

const ROLE_RANK: Record<Role, number> = { inventory: 0, askpoppy: 0, viewer: 0, team: 1, admin: 2 };

export function atLeast(user: ConsoleUser | null, min: Role): boolean {
  return !!user && ROLE_RANK[user.role] >= ROLE_RANK[min];
}

/**
 * Authenticate a request.
 *  - x-console-user empty + x-console-key = CONSOLE_PASSWORD -> Owner (admin)
 *  - x-console-user = email, x-console-key = password -> cs_users lookup
 * Returns null when credentials are missing, wrong, or the login is deactivated.
 */
export async function authenticate(req: VercelRequest): Promise<ConsoleUser | null> {
  const password = ((req.headers["x-console-key"] as string) ?? "").trim();
  const email = normalizeEmail((req.headers["x-console-user"] as string) ?? "");
  if (!password) return null;

  if (!email) {
    const master = process.env.CONSOLE_PASSWORD;
    if (master && password === master) return { id: null, name: "Owner", email: null, role: "admin", inv: "edit" };
    return null;
  }

  if (!isEmail(email)) return null;
  try {
    const rows = await pgSelect<{ id: number; name: string; email: string; role: Role; active: boolean; key_hash: string; inv: string | null }>(
      "cs_users",
      `select=id,name,email,role,active,key_hash,inv&email=eq.${encodeURIComponent(email)}&limit=1`
    );
    const u = rows[0];
    if (!u || u.active !== true) return null;
    if (!["admin", "team", "viewer", "inventory", "askpoppy"].includes(u.role)) return null;
    if (!verifyPassword(password, u.key_hash)) return null;
    // Best-effort "last seen" - never blocks the request.
    try { await pgUpdate("cs_users", `id=eq.${u.id}`, { last_seen: new Date().toISOString() }); } catch { /* ignore */ }
    let inv: InvAccess = u.role === "admin" ? "edit" : (u.inv === "view" || u.inv === "edit" ? u.inv : "none");
    if (u.role === "inventory" && inv === "none") inv = "view"; // inventory-only logins always at least see it
    if (u.role === "askpoppy") inv = "none"; // ask-poppy-only logins never get inventory
    return { id: u.id, name: u.name, email: u.email, role: u.role, inv };
  } catch {
    return null; // db hiccup -> only the master password works
  }
}
