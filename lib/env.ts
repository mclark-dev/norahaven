function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  // Supabase (service role — server only)
  get SUPABASE_URL() { return required("SUPABASE_URL"); },
  get SUPABASE_SERVICE_ROLE_KEY() { return required("SUPABASE_SERVICE_ROLE_KEY"); },

  // Anthropic
  get ANTHROPIC_API_KEY() { return required("ANTHROPIC_API_KEY"); },
  get MODEL_TRIAGE() { return process.env.MODEL_TRIAGE ?? "claude-haiku-4-5"; },
  get MODEL_AGENT() { return process.env.MODEL_AGENT ?? "claude-sonnet-4-5"; },

  // Gorgias
  // e.g. "theflowerletters" — just the subdomain. A pasted full URL ("https://x.gorgias.com/...") is stripped automatically.
  get GORGIAS_DOMAIN() {
    return required("GORGIAS_DOMAIN")
      .replace(/^https?:\/\//i, "")
      .replace(/\.gorgias\.com.*$/i, "")
      .replace(/\/+$/, "");
  },
  get GORGIAS_USER_EMAIL() { return required("GORGIAS_USER_EMAIL"); },
  get GORGIAS_API_KEY() { return required("GORGIAS_API_KEY"); },
  get GORGIAS_WEBHOOK_SECRET() { return required("GORGIAS_WEBHOOK_SECRET"); }, // shared secret we check on inbound webhooks
  get GORGIAS_SENDER_EMAIL() { return process.env.GORGIAS_SENDER_EMAIL ?? "support@theflowerletters.com"; },

  // Footer appended to every auto-sent reply (Utah safe-harbor AI disclosure). Wording approved by Mike 2026-09-15.
  // Override with the AGENT_FOOTER env var; set it to a single space to disable.
  get AGENT_FOOTER() {
    const v = process.env.AGENT_FOOTER;
    if (v !== undefined) return v.trim();
    return "From Poppy - this is an automated response from Poppy, our automated service agent. If you'd prefer to interact with a human, please let us know and we'll connect you with our next available customer service representative.";
  },

  // Shopify Admin API (read-only scopes: read_orders, read_customers, read_fulfillments)
  // e.g. "the-flower-letters.myshopify.com" — a pasted "https://" prefix or trailing "/" is stripped automatically
  get SHOPIFY_STORE_DOMAIN() { return required("SHOPIFY_STORE_DOMAIN").replace(/^https?:\/\//i, "").replace(/\/+$/, ""); },
  // Auth mode A (legacy admin-created custom app): a permanent shpat_ token.
  get SHOPIFY_ADMIN_TOKEN() { return process.env.SHOPIFY_ADMIN_TOKEN ?? ""; },
  // Auth mode B (new Dev Dashboard app, custom distribution): Client ID + Secret,
  // exchanged automatically for 24h tokens. Required when SHOPIFY_ADMIN_TOKEN is unset.
  get SHOPIFY_CLIENT_ID() { return required("SHOPIFY_CLIENT_ID"); },
  get SHOPIFY_CLIENT_SECRET() { return required("SHOPIFY_CLIENT_SECRET"); },

  // Google Drive (OPTIONAL - Drive tools stay off until both are set).
  // A Google Cloud service account with the Drive API enabled; the team shares
  // specific folders with its email as Viewer. Read-only scope in code.
  get GOOGLE_SA_EMAIL() { return process.env.GOOGLE_SA_EMAIL ?? ""; },
  // The private_key field from the service account's JSON key file (the whole
  // -----BEGIN PRIVATE KEY----- block; pasted \n escapes are handled).
  get GOOGLE_SA_PRIVATE_KEY() { return (process.env.GOOGLE_SA_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"); },
  // OPTIONAL: act as this Workspace user (e.g. poppy@theflowerletters.com).
  // Requires domain-wide delegation for the service account in the Google
  // Workspace admin console. When set, Poppy sees whatever THIS account can
  // see in Drive - so the team just shares files with Poppy's email like a
  // coworker. When unset, share folders with the service account email itself.
  get GOOGLE_IMPERSONATE_EMAIL() { return process.env.GOOGLE_IMPERSONATE_EMAIL ?? ""; },
};
