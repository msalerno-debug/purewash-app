import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => (Deno.env.get(k) || "").trim();

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
      if (/^https:\/\/[^\s"<>]+\/quote\?t=[a-f0-9]{32,64}$/.test(link) && String(payload.text).includes(link)) {
        const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
        const btn = (href: string, label: string, bg: string, fg: string, border: string) => `<a href="${esc(href)}" style="display:inline-block;padding:12px 22px;margin:4px 8px 4px 0;border-radius:8px;background:${bg};color:${fg};border:1px solid ${border};text-decoration:none;font-weight:bold;font-size:15px">${label}</a>`;
        const buttons = `<div style="margin:14px 0">${btn(link + "&d=accept", "Accept quote", "#2B5190", "#ffffff", "#2B5190")}${btn(link + "&d=decline", "Decline", "#ffffff", "#2B5190", "#c5d2e6")}</div>`;
        const parts = String(payload.text).split(link).map((p) => esc(p).replace(/\n/g, "<br>"));
        payload.html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#13233f">${parts.join(buttons)}</div>`;
      }
      if (Array.isArray(body.attachments) && body.attachments.length) {
        payload.attachments = body.attachments.slice(0, 3).map((a: { filename: string; content: string }) => ({ filename: String(a.filename).slice(0, 120), content: String(a.content) }));
      }
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: `The email service refused the message: ${out?.message || r.status}. The owner can test the connection in Settings → APIs.` }, 502);
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
