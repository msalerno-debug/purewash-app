// Email open tracking. Every email sent from the app carries a tiny invisible image that points here:
//   GET ?t=<token>   -> logs "email_opened" for the customer the email went to, returns a 1x1 transparent GIF
// The token was stored by the messaging function in the "email_sent" activity entry. No sign-in: the random token is the key.
import { createClient } from "jsr:@supabase/supabase-js@2";

const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
const pixel = () => new Response(GIF, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache" } });
const env = (k: string) => (Deno.env.get(k) || "").trim();
type Rec = Record<string, unknown>;

Deno.serve(async (req) => {
  const t = new URL(req.url).searchParams.get("t") || "";
  if (!/^[a-f0-9]{32}$/.test(t)) return pixel();
  try {
    const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
    const { data: sent } = await admin.from("customer_events").select("data").eq("data->>kind", "email_sent").eq("data->>token", t).limit(1);
    const s = sent?.[0]?.data as Rec | undefined;
    if (!s || !s.customerId) return pixel();
    // ignore opens in the first 5 seconds (mail security scanners) and repeat opens within an hour
    if (Date.now() - Number(s.at || 0) < 5000) return pixel();
    const { data: last } = await admin.from("customer_events").select("data").eq("data->>kind", "email_opened").eq("data->>token", t).order("created_at", { ascending: false }).limit(1);
    if (last?.length && Date.now() - Number((last[0].data as Rec).at || 0) < 3600000) return pixel();
    await admin.from("customer_events").insert({ id: "ev-" + crypto.randomUUID(), data: {
      kind: "email_opened", token: t, customerId: s.customerId, jobId: s.jobId || "", invoiceId: s.invoiceId || "", doc: s.doc || "", number: s.number || "", subject: s.subject || "", at: Date.now(),
    } });
  } catch (_) { /* never break the image */ }
  return pixel();
});
