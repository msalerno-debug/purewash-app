// Public photo page backend. No sign-in: the long random token in the link is the key.
//  {t} -> the business, the customer's first name, and the shared photos as short-lived links
// Views are logged to the customer's Activity (at most once every 30 minutes).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => (Deno.env.get(k) || "").trim();
type Rec = Record<string, unknown>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);
  try {
    const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));
    const t = String(body.t || "");
    if (!/^[a-f0-9]{32}$/.test(t)) return json({ error: "This photo link isn't valid. Please contact us." }, 404);
    const { data: rows } = await admin.from("photo_shares").select("id,data").eq("data->>token", t).limit(1);
    const share = rows?.[0]; if (!share) return json({ error: "We couldn't find these photos. Please contact us." }, 404);
    const d = share.data as Rec;
    if (Number(d.expiresAt) && Date.now() > Number(d.expiresAt)) return json({ error: "This photo link has expired. Please contact us and we'll send a new one." }, 410);
    const ids = ((d.photoIds || []) as string[]).map(String).slice(0, 200);
    const [{ data: ph }, { data: st }, { data: cr }, { data: jr }] = await Promise.all([
      admin.from("photos").select("id,data").in("id", ids.length ? ids : ["-"]),
      admin.from("settings").select("data").eq("id", "app").maybeSingle(),
      admin.from("customers").select("data").eq("id", String(d.customerId || "")).maybeSingle(),
      admin.from("jobs").select("data").eq("id", String(d.jobId || "")).maybeSingle(),
    ]);
    const byId = new Map((ph || []).map((r) => [r.id, r.data as Rec]));
    const list = ids.map((id) => ({ id, p: byId.get(id) })).filter((x) => x.p && x.p.assetId) as { id: string; p: Rec }[];
    const { data: signed } = list.length ? await admin.storage.from("photos").createSignedUrls(list.map((x) => String(x.p.assetId)), 60 * 60 * 6) : { data: [] };
    const url = new Map((signed || []).map((s: Rec) => [String(s.path), String(s.signedUrl || "")]));
    const s = (st?.data || {}) as Rec, c = (cr?.data || {}) as Rec, j = (jr?.data || {}) as Rec;
    const logo = (() => { const l = String(s.logo || "/purewash-logo.png"); return l.startsWith("/") ? "https://purewash-app.vercel.app" + l : l; })();
    const photos = list.map((x) => ({ url: url.get(String(x.p.assetId)) || "", kind: String(x.p.kind || ""), caption: String(x.p.caption || ""), at: Number(x.p.createdAt) || 0 })).filter((x) => x.url);

    // log the view on the customer's Activity
    if (d.customerId && body.view !== false) {
      try {
        const since = Date.now() - 30 * 60000;
        const { data: recent } = await admin.from("customer_events").select("data").eq("data->>kind", "photos_viewed").eq("data->>token", t).order("created_at", { ascending: false }).limit(1);
        if (!recent?.length || Number((recent[0].data as Rec).at) < since) {
          await admin.from("customer_events").insert({ id: "ev-" + crypto.randomUUID(), data: { kind: "photos_viewed", token: t, customerId: String(d.customerId), jobId: String(d.jobId || ""), count: photos.length, at: Date.now() } });
        }
      } catch (_) { /* best effort */ }
    }
    return json({
      ok: true,
      business: { name: s.businessName || "", phone: s.phone || "", email: s.email || "", website: s.website || "", logo },
      customer: { first: String(c.firstName || String(c.name || "").split(/\s+/)[0] || "").trim() },
      job: { date: String(j.date || "") },
      note: String(d.note || ""),
      photos,
    });
  } catch (e) {
    return json({ error: "Something went wrong. Please try again or contact us.", detail: String(e).slice(0, 200) }, 500);
  }
});
