# PureWash Field Office

Customer management, scheduling, quotes, invoices, before/after photos, texting and email for PureWash.

## How it is built

- **App:** `index.html`, a single-page app hosted on Vercel. No build step.
- **Database, logins and photos:** Supabase project `purewash` (organization MJS, US East).
  - Tables: `customers`, `jobs`, `invoices`, `photos`, `messages`, `settings`, plus `profiles` (staff and roles) and `activity` (who changed what).
  - Roles: **owner** (everything), **office** (customers, scheduling, quotes, invoices, texts, email), **crew** (their jobs, addresses, notes and photos; no prices or invoices). Enforced in the database with row-level security.
  - Photos live in the private `photos` storage bucket and are shown through short-lived signed links.
- **Server functions (Supabase Edge Functions):**
  - `team`: owner creates logins, changes roles, turns access off, resets passwords.
  - `messaging`: sends email through Resend and texts through phone.com; reports which services are connected.
  - `sms-sync`: runs every minute (Supabase cron) and pulls incoming and outgoing texts from phone.com into `messages`, matched to customers by phone number. The first run brought in the last 30 days.

## Server settings (Supabase → Edge Functions → Secrets)

| Secret | What it is |
|---|---|
| `GOOGLE_MAPS_KEY` | Google Maps key with the **Maps Embed API** enabled, restricted to the app's web address |
| `RESEND_API_KEY` | API key from resend.com |
| `EMAIL_FROM` | Sender, for example `PureWash <office@purewash.net>` (domain must be verified in Resend) |
| `PHONECOM_TOKEN` | phone.com API access token |
| `PHONECOM_VOIP_ID` | phone.com account (voip) ID |
| `PHONECOM_FROM` | Your phone.com business number, for example `9085551234` |

The app checks which of these are set and shows **Send** buttons only for connected services. Until then it falls back to copy and "Log as sent".

## First sign-in

Open the app. Because no accounts exist yet, it asks you to create the **owner** account. Then add your team under **Settings → Team**.

## Not yet included

- Automatic QuickBooks Online sync (CSV export for QuickBooks import is available on the Invoices page).
