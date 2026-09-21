# Poppy — Go-Live Setup

Poppy is The Flower Letters' automated support assistant: she answers customer emails in Gorgias when she can, sends an honest acknowledgment when a human is needed, and is controlled from a team console. This is the setup checklist to get her deployed. Do the steps in order; steps 1–3 are yours, the rest is Claude's.

## Step 1 — Let Claude deploy to Vercel (the current blocker)

Claude created the Vercel project `tfl-cs-agent` but can't push code to it until you grant access:

1. Go to vercel.com and open your team (Michael Clark's projects).
2. Open **Settings → Integrations** (team-level), find the **Claude / Anthropic** integration, and open **Manage**.
3. Under project access, add **tfl-cs-agent** (or set access to All Projects).
4. Tell Claude "access granted" — deployment happens immediately after.

If you don't see an integrations entry to manage, the fallback works just as well: in the `tfl-cs-agent` project → Settings → confirm your own account role can deploy, and tell Claude — we'll troubleshoot from the exact error.

## Step 2 — Add the keys in Vercel

Vercel dashboard → **tfl-cs-agent** project → **Settings → Environment Variables**. For each variable below: click **Add**, paste the Key exactly as written, paste the Value, leave environment set to **All / Production**, and Save.

| # | Key | Value / where to get it |
|---|---|---|
| 1 | `SUPABASE_URL` | Paste exactly: `https://anvxeswrchrdevkmjcfv.supabase.co` |
| 2 | `SUPABASE_SERVICE_ROLE_KEY` | supabase.com/dashboard → project **the-flower-letters-digital-app** → ⚙️ Project Settings → **API Keys** → copy the **service_role** key (click Reveal). Treat like a password. |
| 3 | `ANTHROPIC_API_KEY` | console.anthropic.com → **API Keys** → Create Key → name it "Poppy" → copy (starts `sk-ant-`) |
| 4 | `GORGIAS_DOMAIN` | Your Gorgias subdomain only — the X in `X.gorgias.com` when you're logged in |
| 5 | `GORGIAS_USER_EMAIL` | Best practice: first create a Gorgias user named **Poppy** (e.g. poppy@theflowerletters.com) so her actions are clearly labeled in ticket history; use that email here. Your own admin email also works to start. |
| 6 | `GORGIAS_API_KEY` | Poppy's Gorgias role must be **Admin** (Gorgias only shows the REST API page to admins). Then log into Gorgias **as Poppy** → Settings gear → **Account → REST API** → copy the API key. Give her account a strong password and 2FA. |
| 7 | `GORGIAS_WEBHOOK_SECRET` | Paste exactly: `423c34ed516dcaa5e7513849b051333139d62859db3b5954` |
| 8 | `SHOPIFY_STORE_DOMAIN` | Your `.myshopify.com` domain (Shopify admin URL shows it) |
| 9 | `SHOPIFY_CLIENT_ID` | From the app created in Shopify's **Dev Dashboard** (dev.shopify.com — new stores can no longer make admin custom apps). In the app: configure its Admin API access scopes to ONLY **read_orders**, **read_customers**, **read_fulfillments**; set distribution to **Custom distribution** for your store; **install it on the store**. Then copy the **Client ID** from the app's Settings page. Read-only on purpose: Poppy cannot change anything in Shopify. |
| 9b | `SHOPIFY_CLIENT_SECRET` | Same page as the Client ID — click the reveal/copy icon next to **Secret**. Poppy exchanges these two for a fresh access token automatically every 24 hours, so there is no permanent token to copy or lose. (`SHOPIFY_ADMIN_TOKEN` is only for stores that still have a legacy admin custom app; skip it.) |
| 10 | `CONSOLE_PASSWORD` | Choose the password your team will use to open Poppy's console. Any strong phrase. |

Optional now, needed later: `KLAVIYO_API_KEY` (read-only private key, for campaign/offer knowledge). The AI-disclosure footer is built in with Mike's approved wording ("From Poppy - this is an automated response from Poppy, our automated service agent...") and is appended to every auto-sent reply; set an `AGENT_FOOTER` env var only if you want to change it.

## Step 3 — Wire Gorgias (after Claude confirms the deploy)

Gorgias → Settings → **App Store → HTTP Integration** → create:
- Trigger: **Ticket message created**
- Method: **POST** · URL: `https://<production-domain>/api/gorgias-webhook` (Claude supplies the exact domain after deploy)
- Header: `x-webhook-secret` = the value from key #7
- Body (JSON): `{"ticket_id": {{ticket.id}}}`

Also on go-live day: **turn off the existing auto-responder** so customers don't get two automated replies.

## What Claude does after step 1

Deploy the service + Poppy's console → verify health and run a synthetic ticket → hand you the console URL and the exact Gorgias values for step 3. Then: macro + 90-day ticket back-test, Drive knowledge ingestion per the approved taxonomy, and team testing via the console's chat — all in draft mode before anything auto-sends.

## Safety recap

Launch state is **draft mode** (Poppy proposes, humans send). Money categories (refunds, cancellations, payments, address changes, damaged items) always go to humans and have no switch. The console has the pause control; `agent_mode` in the database is the master switch. Every action Poppy takes is audit-logged.
