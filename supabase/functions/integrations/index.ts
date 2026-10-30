// Owner-only: save, check and test the app's outside connections (phone.com, Resend, Google Maps).
// Keys are stored in public.app_secrets, which only server functions can read. Values are never sent back to the browser.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const SYNC_TOKEN = "62121c15aea9d2371823252cf4ef07afd3500c80";
const env = (k: string) => (Deno.env.get(k) || "").trim();

const KEYS: Record<string, { secret: boolean; group: string }> = {
  PHONECOM_TOKEN: { secret: true, group: "sms" },
  PHONECOM_VOIP_ID: { secret: false, group: "sms" },
  PHONECOM_FROM: { secret: false, group: "sms" },
  RESEND_API_KEY: { secret: true, group: "email" },
  EMAIL_FROM: { secret: false, group: "email" },
  GOOGLE_MAPS_KEY: { secret: true, group: "maps" },
  QBO_CLIENT_ID: { secret: false, group: "qbo" },
  QBO_CLIENT_SECRET: { secret: true, group: "qbo" },
};

type Check = { label: string; ok: boolean | null; detail?: string; fix?: string };
const d10 = (p: unknown) => String(p ?? "").replace(/\D/g, "").slice(-10);
const emailIn = (s: string) => (s.match(/<([^>]+)>/)?.[1] || s).trim();

// Asks phone.com when a token expires. Permanent tokens have no expiry (or one decades away).
async function pcTokenInfo(token: string): Promise<{ checkedAt: number; ok: boolean; expiresAt: number | null; permanent: boolean | null; status?: number }> {
  try {
    const r = await fetch("https://api.phone.com/v4/oauth/access-token", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) return { checkedAt: Date.now(), ok: false, expiresAt: null, permanent: null, status: r.status };
    const j = await r.json().catch(() => ({}));
    let exp: unknown = null;
    const walk = (o: unknown) => { if (!o || typeof o !== "object" || exp !== null) return; for (const [k, v] of Object.entries(o as Record<string, unknown>)) { if (exp !== null) return; if (/expir/i.test(k) && v !== null && v !== "" && typeof v !== "object") exp = v; else if (typeof v === "object") walk(v); } };
    walk(j);
    let ms: number | null = null;
    if (typeof exp === "number" || /^\d+$/.test(String(exp ?? ""))) { const n = Number(exp); ms = n > 1e12 ? n : n * 1000; }
    else if (exp) { const t = Date.parse(String(exp)); ms = isNaN(t) ? null : t; }
    if (ms !== null && ms <= 0) ms = null;
    const permanent = ms === null ? true : ms - Date.now() > 3 * 365 * 864e5;
    return { checkedAt: Date.now(), ok: true, expiresAt: permanent ? null : ms, permanent };
  } catch (_) { return { checkedAt: Date.now(), ok: false, expiresAt: null, permanent: null }; }
}

function validate(key: string, raw: string): { value?: string; error?: string } {
  const v = raw.trim();
  if (!v) return { value: "" };
  switch (key) {
    case "GOOGLE_MAPS_KEY": return /^AIza[0-9A-Za-z_\-]{35}$/.test(v) ? { value: v } : { error: "Google Maps keys start with \"AIza\" and are 39 characters long. Copy it again from Google Cloud → Credentials." };
    case "RESEND_API_KEY": return /^re_[0-9A-Za-z_]{8,}$/.test(v) ? { value: v } : { error: "Resend API keys start with \"re_\". Copy it again from resend.com → API Keys." };
    case "EMAIL_FROM": return /^\S+@\S+\.\S+$/.test(emailIn(v)) ? { value: v } : { error: "Use an address like office@purewash.net, or with a name: PureWash <office@purewash.net>." };
    case "PHONECOM_VOIP_ID": return /^\d+$/.test(v) ? { value: v } : { error: "The account (VoIP) ID is digits only." };
    case "PHONECOM_FROM": { const d = d10(v); return d.length === 10 ? { value: d } : { error: "Enter your 10-digit phone.com number, for example 908-555-1234." }; }
    case "QBO_CLIENT_ID": return /^[A-Za-z0-9]{20,80}$/.test(v) ? { value: v } : { error: "The Client ID is a long string of letters and numbers. Copy it again from Intuit (Keys & credentials → Production)." };
    case "QBO_CLIENT_SECRET": return /^[A-Za-z0-9]{20,80}$/.test(v) ? { value: v } : { error: "The Client Secret is a long string of letters and numbers. Copy it again from Intuit (Keys & credentials → Production)." };
    case "PHONECOM_TOKEN": return v.length >= 20 && !/\s/.test(v) ? { value: v } : { error: "That doesn't look like a phone.com API token. Copy the whole token with no spaces." };
  }
  return { error: "Unknown setting." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: "Your sign-in expired. Sign in again." }, 401);
    const { data: me } = await admin.from("profiles").select("role,active,email").eq("id", user.id).single();
    if (!me || !me.active || me.role !== "owner") return json({ error: "Only the owner can manage API connections." }, 403);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "list");

    const { data: rows } = await admin.from("app_secrets").select("key,value,updated_at");
    const saved = new Map((rows || []).map((r) => [r.key, r]));
    const get = (k: string) => (saved.get(k)?.value ?? env(k)).trim();

    async function state(key: string) { const { data } = await admin.from("sync_state").select("value").eq("key", key).maybeSingle(); return data?.value ?? null; }
    async function putState(key: string, value: unknown) { await admin.from("sync_state").upsert({ key, value, updated_at: new Date().toISOString() }); }

    async function list() {
      const keys: Record<string, unknown> = {};
      for (const [k, def] of Object.entries(KEYS)) {
        const row = saved.get(k); const v = (row?.value ?? env(k)).trim();
        keys[k] = {
          set: !!v,
          source: row ? "app" : (env(k) ? "server" : null),
          display: !v ? "" : def.secret ? `••••${v.slice(-4)}` : v,
          updatedAt: row?.updated_at ?? null,
        };
      }
      const tests: Record<string, unknown> = {};
      for (const g of ["sms", "email", "maps", "qbo"]) tests[g] = await state("test:" + g);
      return { ok: true, keys, tests, pcToken: await state("phonecom:token"), smsSync: await state("phonecom"), vmSync: await state("voicemail"), ownerEmail: me.email || user.email };
    }

    if (action === "list") return json(await list());

    if (action === "set") {
      const key = String(body.key || "");
      if (!KEYS[key]) return json({ error: "Unknown setting." }, 400);
      const r = validate(key, String(body.value ?? ""));
      if (r.error) return json({ error: r.error }, 400);
      if (r.value === "") await admin.from("app_secrets").delete().eq("key", key);
      else await admin.from("app_secrets").upsert({ key, value: r.value, updated_at: new Date().toISOString(), updated_by: user.id });
      await admin.from("activity").insert({ user_id: user.id, tbl: "settings", row_id: "api", action: "update", summary: `${r.value === "" ? "Removed" : "Saved"} ${key.replace(/_/g, " ").toLowerCase()}` });
      await putState("test:" + KEYS[key].group, null);
      let warning: string | null = null;
      if (key === "PHONECOM_TOKEN") {
        if (r.value === "") await putState("phonecom:token", null);
        else {
          const info = await pcTokenInfo(r.value!);
          await putState("phonecom:token", info);
          if (info.ok && info.permanent === false && info.expiresAt) warning = `Saved, but this is a temporary token. phone.com will stop accepting it ${new Date(info.expiresAt).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. In phone.com's API Client, tick "Create permanent token" before signing in, then save that token here instead.`;
          else if (!info.ok && info.status === 401) warning = "Saved, but phone.com rejected this token right away. It may be expired or copied incompletely.";
        }
      }
      const { data: rows2 } = await admin.from("app_secrets").select("key,value,updated_at");
      saved.clear(); for (const x of rows2 || []) saved.set(x.key, x);
      return json({ ...(await list()), warning });
    }

    if (action === "resync") {
      const call = (fn: string) => fetch(`${env("SUPABASE_URL")}/functions/v1/${fn}`, { method: "POST", headers: { "x-sync-token": SYNC_TOKEN, "Content-Type": "application/json" }, body: "{}" }).then(async (r) => ({ r, out: await r.json().catch(() => ({})) }));
      const [t, v] = await Promise.all([call("sms-sync"), call("voicemail")]);
      if (!t.r.ok || t.out.error) return json({ error: t.out.error || `Text sync failed (${t.r.status}).` }, 502);
      if (!v.r.ok || v.out.error) return json({ error: v.out.error || `Voicemail sync failed (${v.r.status}).` }, 502);
      return json({ ok: true, added: t.out.added || 0, vmAdded: v.out.added || 0, skipped: t.out.skipped || null });
    }

    if (action === "test") {
      const which = String(body.integration || "");
      const checks: Check[] = [];
      const add = (c: Check) => { checks.push(c); return c.ok; };

      if (which === "sms") {
        const token = get("PHONECOM_TOKEN"), voip = get("PHONECOM_VOIP_ID"), from = d10(get("PHONECOM_FROM"));
        add({ label: "API token entered", ok: !!token, fix: token ? undefined : "Create a permanent token in phone.com's API Client, then paste it into API token." });
        add({ label: "Account (VoIP) ID entered", ok: /^\d+$/.test(voip), fix: /^\d+$/.test(voip) ? undefined : "Enter your phone.com account ID (digits only). phone.com support can tell you what it is." });
        add({ label: "Texting number entered", ok: from.length === 10, fix: from.length === 10 ? undefined : "Enter the 10-digit phone.com number your texts should come from." });
        if (token && /^\d+$/.test(voip)) {
          const H = { "Authorization": `Bearer ${token}`, "Accept": "application/json" };
          const r = await fetch(`https://api.phone.com/v4/accounts/${encodeURIComponent(voip)}`, { headers: H });
          const ti = await pcTokenInfo(token); if (ti.ok) await putState("phonecom:token", ti);
          if (r.status === 200) add({ label: "phone.com accepted the token and account ID", ok: true });
          else if (r.status === 401) add({ label: "phone.com rejected the token", ok: false, detail: "Error 401. If this keeps happening every day or two, the token is a temporary one that expired.", fix: "In phone.com's API Client (api-client.cit-phone.com), tick \"Create permanent token\" before you sign in, then save the new token here. Temporary tokens stop working after a short time." });
          else if (r.status === 403) add({ label: "The token isn't allowed to use this account", ok: false, detail: "Error 403", fix: "The token belongs to a different account or lacks permissions. Check the account ID, or ask phone.com API support (apisupport@phone.com) to enable API access." });
          else if (r.status === 404) add({ label: "phone.com couldn't find that account ID", ok: false, detail: "Error 404", fix: "Double-check the account (VoIP) ID. It's the number phone.com uses for your account, not your phone number." });
          else add({ label: "phone.com didn't respond normally", ok: false, detail: `Error ${r.status}`, fix: "phone.com may be having trouble. Wait a few minutes and test again." });
          if (ti.ok) add(ti.permanent ? { label: "The token is permanent", ok: true } : { label: "The token is temporary and will expire", ok: false, detail: ti.expiresAt ? `phone.com will stop accepting it ${new Date(ti.expiresAt).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.` : undefined, fix: "In phone.com's API Client, tick \"Create permanent token\" before you sign in, then save that token here. Texts and voicemail stop syncing when a temporary token expires." });
          if (r.status === 200 && from.length === 10) {
            const pr = await fetch(`https://api.phone.com/v4/accounts/${encodeURIComponent(voip)}/phone-numbers?limit=200`, { headers: H });
            if (pr.ok) {
              const pj = await pr.json().catch(() => ({}));
              const nums = (pj.items || []).map((it: Record<string, unknown>) => d10(it.phone_number ?? it.name ?? JSON.stringify(it)));
              const has = nums.includes(from);
              add({ label: has ? "The texting number is on this phone.com account" : "The texting number isn't on this phone.com account", ok: has, detail: has ? undefined : `${nums.length} number${nums.length === 1 ? "" : "s"} found on the account`, fix: has ? undefined : "Enter one of your phone.com numbers that can send texts." });
            } else add({ label: "Couldn't list the account's phone numbers", ok: null, detail: `Error ${pr.status}`, fix: "Not required for texting. Send a test text to confirm the number works." });
            const lr = await fetch(`https://api.phone.com/v4/accounts/${encodeURIComponent(voip)}/sms?limit=1&filters[direction]=in`, { headers: H });
            add({ label: lr.ok ? "Incoming texts can be read" : "Incoming texts can't be read", ok: lr.ok, detail: lr.ok ? undefined : `Error ${lr.status}`, fix: lr.ok ? undefined : "The token may not include messaging. Ask phone.com API support to enable SMS for your token." });
          }
        }
        const sync = await state("phonecom") as { lastRun?: number; lastError?: string; lastErrorAt?: number } | null;
        if (sync?.lastRun) {
          const mins = Math.round((Date.now() - sync.lastRun) / 60000);
          const fresh = mins <= 5 && !sync.lastError;
          add({ label: fresh ? `Text sync is running (last check ${mins <= 1 ? "just now" : mins + " min ago"})` : sync.lastError ? "The last text sync failed" : `Text sync hasn't run for ${mins} minutes`, ok: fresh, detail: sync.lastError || undefined, fix: fresh ? undefined : "Fix any problems above, then click Sync texts now." });
        } else add({ label: "Text sync hasn't run yet", ok: null, fix: "Once the checks above pass, click Sync texts now." });
        if (token && /^\d+$/.test(voip)) {
          const vr = await fetch(`https://api.phone.com/v4/accounts/${encodeURIComponent(voip)}/voicemail?limit=1`, { headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" } });
          add({ label: vr.ok ? "Voicemail can be read" : "Voicemail can't be read", ok: vr.ok, detail: vr.ok ? undefined : `Error ${vr.status}`, fix: vr.ok ? undefined : "Ask phone.com API support to allow voicemail access for your token." });
        }
        const vs = await state("voicemail") as { lastRun?: number; lastError?: string; audioQueue?: number } | null;
        if (vs?.lastRun) {
          const m = Math.round((Date.now() - vs.lastRun) / 60000);
          const okv = m <= 6 && !vs.lastError;
          add({ label: okv ? `Voicemail sync is running (last check ${m <= 1 ? "just now" : m + " min ago"})` : vs.lastError ? "The last voicemail sync failed" : `Voicemail sync hasn't run for ${m} minutes`, ok: okv, detail: vs.lastError || (vs.audioQueue ? `${vs.audioQueue} recording${vs.audioQueue === 1 ? "" : "s"} still being copied` : undefined), fix: okv ? undefined : "Fix any problems above, then click Sync texts now." });
        }
        const sendTo = d10(body.sendTo);
        if (body.sendTo !== undefined) {
          if (sendTo.length !== 10) add({ label: "Test text not sent", ok: false, fix: "Enter a 10-digit number to send the test text to." });
          else if (token && /^\d+$/.test(voip) && from.length === 10) {
            const sr = await fetch(`https://api.phone.com/v4/accounts/${encodeURIComponent(voip)}/messages`, { method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ from: "+1" + from, to: ["+1" + sendTo], text: "Test text from your PureWash app. Texting is working." }) });
            const st = await sr.text();
            add({ label: sr.ok ? `Test text sent to ${sendTo.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3")}` : "phone.com refused the test text", ok: sr.ok, detail: sr.ok ? "Reply to it to check that replies come back into Messages." : `Error ${sr.status}: ${st.slice(0, 160)}`, fix: sr.ok ? undefined : sr.status === 402 ? "Your phone.com plan may not include API texting, or the account needs payment. Contact phone.com." : "Check that the texting number can send SMS in phone.com, then try again." });
          }
        }
      } else if (which === "email") {
        const key = get("RESEND_API_KEY"), fromRaw = get("EMAIL_FROM"); const from = emailIn(fromRaw); const domain = from.split("@")[1]?.toLowerCase() || "";
        add({ label: "Resend API key entered", ok: !!key, fix: key ? undefined : "Create an API key at resend.com → API Keys and paste it here." });
        add({ label: "Send-from address entered", ok: !!from && from.includes("@"), fix: from ? undefined : "Enter the address emails come from, for example PureWash <office@purewash.net>." });
        if (key) {
          const r = await fetch("https://api.resend.com/domains", { headers: { "Authorization": `Bearer ${key}` } });
          const j = await r.json().catch(() => ({}));
          if (r.status === 200) {
            add({ label: "Resend accepted the API key", ok: true });
            const doms = (j.data || []) as { name: string; status: string }[];
            const d = doms.find((x) => x.name?.toLowerCase() === domain);
            if (!domain) { /* reported above */ }
            else if (!d) add({ label: `${domain} hasn't been added to Resend`, ok: false, fix: `In Resend → Domains, add ${domain}, then add the DNS records it shows at your domain host.` });
            else if (d.status === "verified") add({ label: `${domain} is verified for sending`, ok: true });
            else add({ label: `${domain} isn't verified yet`, ok: false, detail: `Resend says: ${String(d.status).replace(/_/g, " ")}`, fix: d.status === "failed" || d.status === "temporary_failure" ? "Resend couldn't find the DNS records. Check that they were entered exactly as shown (no extra domain at the end), then click Verify in Resend." : "Add the DNS records Resend shows for this domain at your domain host, then click Verify in Resend. It can take up to an hour." });
          } else if (r.status === 401 && /restricted/i.test(JSON.stringify(j))) {
            add({ label: "The key can only send email", ok: null, detail: "It can't check domain status. That's fine for the app.", fix: "Use Send test email below to confirm sending works." });
          } else if (r.status === 401 || r.status === 403) add({ label: "Resend rejected the API key", ok: false, detail: j.message || `Error ${r.status}`, fix: "Create a new API key in Resend and save it here." });
          else add({ label: "Resend didn't respond normally", ok: false, detail: `Error ${r.status}`, fix: "Resend may be having trouble. Test again in a few minutes." });
          if (body.sendTest) {
            const to = String(me.email || user.email || "");
            const sr = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: fromRaw, to: [to], subject: "Test email from your PureWash app", text: "This is a test from the APIs page in Settings. Email sending is working." }) });
            const sj = await sr.json().catch(() => ({}));
            add({ label: sr.ok ? `Test email sent to ${to}` : "Resend refused the test email", ok: sr.ok, detail: sr.ok ? "Check your inbox (and spam folder)." : (sj.message || `Error ${sr.status}`), fix: sr.ok ? undefined : /domain/i.test(sj.message || "") ? "The send-from address must use a domain verified in Resend." : "Check the key and the send-from address, then try again." });
          }
        }
      } else if (which === "maps") {
        const k = get("GOOGLE_MAPS_KEY");
        add({ label: "Maps API key entered", ok: !!k, fix: k ? undefined : "Create an API key in Google Cloud → Credentials and paste it here." });
        if (k) add({ label: "Key format looks right", ok: /^AIza[0-9A-Za-z_\-]{35}$/.test(k), fix: /^AIza/.test(k) ? undefined : "Google Maps keys start with AIza. Copy it again." });
        if (k) add({ label: "Check the preview below", ok: null, detail: "Google only lets Street View load inside the app's own pages, so this last check is visual.", fix: "If the preview shows an error: enable the Maps Embed API in Google Cloud, make sure billing is set up on the project, and allow https://purewash-app.vercel.app/* under the key's website restrictions." });
      } else return json({ error: "Unknown connection." }, 400);

      const hard = checks.filter((c) => c.ok === false).length;
      const result = { at: Date.now(), ok: hard === 0, checks };
      await putState("test:" + which, result);
      return json({ ok: true, result });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: "Something went wrong on the server.", detail: String(e).slice(0, 200) }, 500);
  }
});
