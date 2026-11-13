import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => (Deno.env.get(k) || "").trim();

type Rec = Record<string, unknown>;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
const money = (n: number) => "$" + (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const longDate = (iso: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return ""; const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }); };
const QUOTE_LINE = "Review your quote and accept or decline it online:";

// Branded email, used for everything sent from the app. Colors follow the PureWash logo: navy #1E3A6E / #2B5190 and cyan #00B4EE.
//  quote:   band with the proposed date, total and Accept/Decline buttons
//  invoice: band with the amount due and due date
//  other:   plain branded letter
// A 1x1 image at the end lets the app see when the customer opens it.
function brandedEmailHtml(text: string, o: { link?: string; quote?: Rec; invoice?: Rec; pixel?: string; origin: string }, s: Rec): string {
  const NAVY = "#1E3A6E", BLUE = "#2B5190", CYAN = "#00B4EE", TINT = "#E8F7FD", INK = "#24324A", MUTED = "#5F6B7E", FONT = "Arial,Helvetica,sans-serif";
  const name = String(s.businessName || "").trim();
  const rawLogo = String(s.logo || "/purewash-logo.png");
  const logo = rawLogo.startsWith("/") ? o.origin + rawLogo : /^https:\/\//.test(rawLogo) ? rawLogo : "";
  const card = (o.quote || o.invoice || {}) as Rec;
  const num = String(card.number || "").trim();
  const total = card.total == null || card.total === "" ? NaN : Number(card.total);
  let msg = text;
  if (o.link) msg = msg.split(o.link).join("").replace(QUOTE_LINE, "");
  msg = msg.replace(/\n{3,}/g, "\n\n").trim();
  const paras = msg.split(/\n\s*\n/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const site = String(s.website || "").trim();
  const siteHref = site ? (/^https?:\/\//.test(site) ? site : "https://" + site) : "";
  const nw = (h: string) => `<span style="white-space:nowrap">${h}</span>`;
  const contact = [s.phone ? nw(esc(s.phone)) : "", s.email ? nw(`<a href="mailto:${esc(s.email)}" style="color:${MUTED};text-decoration:none">${esc(s.email)}</a>`) : "", site ? nw(`<a href="${esc(siteHref)}" style="color:${MUTED};text-decoration:none">${esc(site)}</a>`) : ""].filter(Boolean).join(` &nbsp;&middot;&nbsp; `);
  const btn = (href: string, label: string) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto"><tr><td bgcolor="${BLUE}" style="border-radius:6px;background:${BLUE}"><a href="${esc(href)}" style="display:inline-block;padding:14px 44px;font-family:${FONT};font-size:17px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px">${label}</a></td></tr></table>`;
  const big = (label: string) => Number.isFinite(total) ? `<div style="font-size:46px;line-height:1.1;font-weight:bold;color:${NAVY};padding:10px 0 4px">${esc(money(total))}</div><div style="font-size:13px;color:${MUTED};padding-bottom:${o.quote ? 18 : 2}px">${label}${num ? ` &middot; #${esc(num)}` : ""}</div>` : `<div style="height:${o.quote ? 16 : 4}px"></div>`;
  let kindLabel = "", band = "", note = "";
  if (o.quote && o.link) {
    const date = longDate(String(card.date || ""));
    kindLabel = `Quote${num ? " " + esc(num) : ""}`;
    band = `<div style="font-size:15px;font-weight:bold;color:${NAVY}">${date ? `Proposed service date: ${esc(date)}` : "Service date: to be scheduled together"}</div>${big("Quote total")}
      ${btn(o.link + "&d=accept", "Review and accept")}
      <div style="padding-top:14px;font-size:14px"><a href="${esc(o.link + "&d=decline")}" style="color:${BLUE};text-decoration:underline">Decline this quote</a></div>`;
    note = "Your quote is attached as a PDF.";
  } else if (o.invoice) {
    const due = longDate(String(card.due || ""));
    const paid = Number.isFinite(total) && total <= 0;
    kindLabel = `Invoice${num ? " " + esc(num) : ""}`;
    band = `<div style="font-size:15px;font-weight:bold;color:${NAVY}">${paid ? "Paid in full. Thank you!" : due ? `Due ${esc(due)}` : "Due on receipt"}</div>${big(paid ? "Balance" : "Amount due")}`;
    note = "Your invoice is attached as a PDF.";
  }
  const preview = o.quote ? `Your quote${num ? " #" + num : ""}${Number.isFinite(total) ? " for " + money(total) : ""} from ${name || "us"}` : o.invoice ? `Invoice${num ? " #" + num : ""}${Number.isFinite(total) ? ": " + money(total) + " due" : ""} from ${name || "us"}` : msg.slice(0, 120);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(name || "Message")}</title></head>
<body style="margin:0;padding:0;background:#F1F5FA">
<div style="display:none;max-height:0;overflow:hidden">${esc(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5FA"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;font-family:${FONT};color:${INK}">
  <tr><td style="height:6px;background:${CYAN};font-size:0;line-height:0">&nbsp;</td></tr>
  ${kindLabel ? `<tr><td align="center" style="padding:22px 24px 0;font-size:12px;letter-spacing:2px;color:${MUTED};text-transform:uppercase">${kindLabel}</td></tr>` : ""}
  <tr><td align="center" style="padding:${kindLabel ? 14 : 24}px 24px 0">${logo ? `<img src="${esc(logo)}" alt="${esc(name)}" width="${band ? 260 : 220}" style="display:block;width:${band ? 260 : 220}px;max-width:80%;height:auto;border:0">` : ""}</td></tr>
  ${name && !logo ? `<tr><td align="center" style="padding:6px 24px 0;font-size:24px;font-weight:bold;color:${NAVY}">${esc(name)}</td></tr>` : ""}
  ${band ? `<tr><td style="padding:24px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${TINT}"><tr><td align="center" style="padding:28px 24px 24px">${band}</td></tr></table></td></tr>` : ""}
  <tr><td style="padding:26px 32px 8px;font-size:16px;line-height:1.55;color:${INK}">${paras}${note ? `<p style="margin:0 0 14px;font-size:14px;color:${MUTED}">${note}</p>` : ""}</td></tr>
  <tr><td style="padding:0 32px"><div style="border-top:1px dotted #B9C3D1;font-size:0;line-height:0">&nbsp;</div></td></tr>
  <tr><td align="center" style="padding:18px 32px 26px;font-size:14px;line-height:1.7;color:${MUTED}">
    ${name ? `<div style="font-weight:bold;color:${NAVY}">${esc(name)}</div>` : ""}${s.address ? `<div>${esc(s.address)}</div>` : ""}${contact ? `<div>${contact}</div>` : ""}
  </td></tr>
  <tr><td style="height:6px;background:${NAVY};font-size:0;line-height:0">&nbsp;</td></tr>
</table>
</td></tr></table>${o.pixel ? `<img src="${esc(o.pixel)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">` : ""}
</body></html>`;
}

function e164(p: string): string | null {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: "Your sign-in expired. Sign in again." }, 401);
    const { data: me } = await admin.from("profiles").select("role,active").eq("id", user.id).single();
    if (!me || !me.active) return json({ error: "Your account doesn't have access." }, 403);

    // keys saved in the app (Settings → APIs) win over Supabase dashboard secrets
    const { data: rows } = await admin.from("app_secrets").select("key,value");
    const saved = new Map((rows || []).map((r) => [r.key, r.value]));
    const get = (k: string) => String(saved.get(k) ?? env(k)).trim();

    const body = await req.json().catch(() => ({}));

    if (body.action === "status") {
      return json({
        email: !!(get("RESEND_API_KEY") && get("EMAIL_FROM")),
        sms: !!(get("PHONECOM_TOKEN") && get("PHONECOM_VOIP_ID") && get("PHONECOM_FROM")),
        mapsKey: get("GOOGLE_MAPS_KEY") || null,
      });
    }

    if (body.action === "email") {
      if (!(me.role === "owner" || me.role === "office")) return json({ error: "Only the owner and office can send email." }, 403);
      const key = get("RESEND_API_KEY"), from = get("EMAIL_FROM");
      if (!key || !from) return json({ error: "Email sending isn't set up yet. The owner can connect it in Settings → APIs.", notConfigured: true }, 503);
      const to = String(body.to || "").trim();
      if (!/^\S+@\S+\.\S+$/.test(to)) return json({ error: "Enter a valid email address." }, 400);
      const payload: Record<string, unknown> = { from, to: [to], subject: String(body.subject || "").slice(0, 300), text: String(body.text || "") };
      if (body.replyTo && /^\S+@\S+\.\S+$/.test(body.replyTo)) payload.reply_to = body.replyTo;
      const link = String(body.quoteLink || "");
      const isQuote = /^https:\/\/[^\s"<>]+\/quote\?t=[a-f0-9]{32,64}$/.test(link) && String(payload.text).includes(link);
      const track = (body.track || {}) as Rec;
      const token = /^[a-f0-9]{32}$/.test(String(track.token || "")) && track.customerId ? String(track.token) : "";
      const origin = /^https:\/\/[a-z0-9.-]+$/i.test(String(body.appOrigin || "")) ? String(body.appOrigin) : isQuote ? new URL(link).origin : "https://purewash-app.vercel.app";
      const { data: st } = await admin.from("settings").select("data").eq("id", "app").maybeSingle();
      payload.html = brandedEmailHtml(String(payload.text), {
        link: isQuote ? link : undefined, quote: isQuote ? (body.quoteCard || {}) as Rec : undefined, invoice: !isQuote && body.invoiceCard ? body.invoiceCard as Rec : undefined,
        pixel: token ? `${env("SUPABASE_URL")}/functions/v1/track?t=${token}` : "", origin,
      }, (st?.data || {}) as Rec);
      if (Array.isArray(body.attachments) && body.attachments.length) {
        payload.attachments = body.attachments.slice(0, 3).map((a: { filename: string; content: string }) => ({ filename: String(a.filename).slice(0, 120), content: String(a.content) }));
      }
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: `The email service refused the message: ${out?.message || r.status}. The owner can test the connection in Settings → APIs.` }, 502);
      if (token) {
        const doc = isQuote ? "quote" : body.invoiceCard ? "invoice" : "";
        const card = (isQuote ? body.quoteCard : body.invoiceCard) as Rec | undefined;
        try { await admin.from("customer_events").insert({ id: "ev-" + crypto.randomUUID(), data: {
          kind: "email_sent", token, customerId: String(track.customerId), jobId: String(track.jobId || ""), invoiceId: String(track.invoiceId || ""), doc, number: String(card?.number || ""),
          amount: card?.total ?? null, subject: String(payload.subject || "").slice(0, 200), to, by: user.id, at: Date.now() } }); } catch (_) { /* activity is best effort */ }
      }
      return json({ ok: true, id: out?.id || null });
    }

    if (body.action === "sms") {
      const token = get("PHONECOM_TOKEN"), voip = get("PHONECOM_VOIP_ID"), fromRaw = get("PHONECOM_FROM");
      if (!token || !voip || !fromRaw) return json({ error: "Texting through phone.com isn't set up yet. The owner can connect it in Settings → APIs.", notConfigured: true }, 503);
      const to = e164(body.to), from = e164(fromRaw);
      if (!to) return json({ error: "That phone number doesn't look like a 10-digit US number." }, 400);
      if (!from) return json({ error: "The texting number in Settings → APIs isn't a valid US number." }, 500);
      const text = String(body.text || "").slice(0, 1600);
      if (!text.trim()) return json({ error: "Write a message first." }, 400);
      const r = await fetch(`https://api.phone.com/v4/accounts/${encodeURIComponent(voip)}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ from, to: [to], text }),
      });
      const raw = await r.text();
      if (!r.ok) return json({ error: `phone.com refused the text (${r.status}): ${raw.slice(0, 200)}. The owner can test the connection in Settings → APIs.` }, 502);
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: "Something went wrong on the server.", detail: String(e).slice(0, 200) }, 500);
  }
});
