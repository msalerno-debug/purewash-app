// Public quote page backend. No sign-in: the long random token in the link is the key.
//  {action:"get", t}                       -> what the customer sees (no internal notes, crew or prices beyond the quote)
//  {action:"respond", t, decision, note}  -> accept or decline once; updates the job and notifies the business
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => (Deno.env.get(k) || "").trim();
type Rec = Record<string, unknown>;
const money = (n: number) => "$" + (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const total = (items: Rec[]) => (items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);
const fmtDate = (s: string) => { if (!s) return ""; const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }); };
const custName = (c: Rec | null) => { if (!c) return "Customer"; const ln = String(c.lastName || "").trim(), fn = String(c.firstName || "").trim(); return ln || fn ? [ln, fn].filter(Boolean).join(", ") : String(c.name || c.company || "Customer"); };
const firstName = (c: Rec | null) => String((c && (c.firstName || String(c.name || "").split(/\s+/)[0])) || "").trim();
const address = (c: Rec | null) => c ? [c.street, [c.city, c.state].filter(Boolean).join(", "), c.zip].map((x) => String(x || "").trim()).filter(Boolean).join(" ").replace(/\s+,/g, ",") : "";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);
  try {
    const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));
    const t = String(body.t || "");
    if (!/^[a-f0-9]{32,64}$/.test(t)) return json({ error: "This quote link isn't valid. Please contact us." }, 404);

    const { data: rows } = await admin.from("jobs").select("id,data").eq("data->>quoteToken", t).limit(1);
    const row = rows && rows[0];
    if (!row) return json({ error: "We couldn't find this quote. It may have been replaced. Please contact us." }, 404);
    const j = row.data as Rec;
    const [{ data: st }, { data: cr }] = await Promise.all([
      admin.from("settings").select("data").eq("id", "app").maybeSingle(),
      admin.from("customers").select("id,data").eq("id", String(j.customerId || "")).maybeSingle(),
    ]);
    const s = (st?.data || {}) as Rec; const c = (cr?.data || null) as Rec | null;
    const items = ((j.items || []) as Rec[]).filter((i) => i.desc || i.rate);
    const resp = (j.quoteResponse || null) as Rec | null;
    const state = resp ? String(resp.decision) : j.status === "Quoted" ? "open" : "closed";

    const view = () => ({
      ok: true, state,
      business: { name: s.businessName || "", phone: s.phone || "", email: s.email || "", address: s.address || "" },
      customer: { first: firstName(c), address: address(c) },
      items: items.map((i) => ({ desc: String(i.desc || ""), qty: Number(i.qty) || 0, rate: Number(i.rate) || 0 })),
      total: total(items), date: String(j.date || ""), response: resp ? { decision: resp.decision, at: resp.at } : null,
    });

    if (body.action === "get") return json(view());

    if (body.action === "respond") {
      const decision = body.decision === "accept" ? "accepted" : body.decision === "decline" ? "declined" : "";
      if (!decision) return json({ error: "Choose accept or decline." }, 400);
      if (state !== "open") return json({ ...view(), error: state === "closed" ? "This quote is no longer open. Please contact us." : "You already answered this quote. Contact us if you'd like to change it." }, 409);
      const note = String(body.note || "").trim().slice(0, 1000);
      const now = Date.now();
      const booked = decision === "accepted" && !!j.date;
      const upd: Rec = { ...j, quoteResponse: { decision, note, at: now, seen: false, booked }, updatedAt: now };
      if (booked) upd.status = "Scheduled";
      if (decision === "declined") upd.status = "Cancelled";
      // only change it if it is still an unanswered quote (guards against a double click)
      const { data: done } = await admin.from("jobs").update({ data: upd }).eq("id", row.id).eq("data->>status", "Quoted").is("data->quoteResponse", null).select("id");
      if (!done || !done.length) return json({ ...view(), error: "You already answered this quote." }, 409);
      if (decision === "accepted" && c && (c.status === "Lead" || c.status === "Quoted")) await admin.from("customers").update({ data: { ...c, status: "Active", updatedAt: now } }).eq("id", cr!.id);

      // notify the business by email
      try {
        const { data: keys } = await admin.from("app_secrets").select("key,value");
        const k = new Map((keys || []).map((r) => [r.key, r.value]));
        const key = String(k.get("RESEND_API_KEY") ?? env("RESEND_API_KEY")).trim(), from = String(k.get("EMAIL_FROM") ?? env("EMAIL_FROM")).trim();
        let to = String(s.email || "").trim();
        if (!/^\S+@\S+\.\S+$/.test(to)) { const { data: own } = await admin.from("profiles").select("email").eq("role", "owner").eq("active", true).limit(1); to = own?.[0]?.email || ""; }
        if (key && from && to) {
          const name = custName(c); const amt = money(total(items));
          const what = decision === "accepted" ? (booked ? `accepted and is booked for ${fmtDate(String(j.date))}` : "accepted. The date is TBD, so pick one in the app to book it") : "declined";
          const subject = `Quote ${decision}: ${name} (${amt})`;
          const text = `${name} ${what}.\n\nServices:\n${items.map((i) => `- ${i.desc}${Number(i.qty) > 1 ? ` x${i.qty}` : ""}: ${money((Number(i.qty) || 0) * (Number(i.rate) || 0))}`).join("\n")}\nTotal: ${amt}\n${note ? `\nTheir note: "${note}"\n` : ""}\nAddress: ${address(c) || "none on file"}${c?.phone ? `\nPhone: ${c.phone}` : ""}\n\nOpen the app: https://purewash-app.vercel.app`;
          const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#13233f;line-height:1.5"><p style="font-size:17px"><strong>${esc(name)}</strong> ${esc(what)}.</p><p>${items.map((i) => `${esc(i.desc)}: ${esc(money((Number(i.qty) || 0) * (Number(i.rate) || 0)))}`).join("<br>")}<br><strong>Total: ${esc(amt)}</strong></p>${note ? `<p style="background:#f2f5fa;padding:10px 12px;border-radius:8px">Their note: “${esc(note)}”</p>` : ""}<p>${esc(address(c))}${c?.phone ? `<br>${esc(c.phone)}` : ""}</p><p><a href="https://purewash-app.vercel.app" style="background:#2B5190;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">Open PureWash</a></p></div>`;
          await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, text, html }) });
        }
      } catch (_) { /* the in-app alert still shows */ }

      const { data: fresh } = await admin.from("jobs").select("data").eq("id", row.id).single();
      Object.assign(j, fresh?.data || {});
      return json({ ...view(), state: decision, response: { decision, at: now } });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: "Something went wrong. Please try again or contact us.", detail: String(e).slice(0, 200) }, 500);
  }
});
