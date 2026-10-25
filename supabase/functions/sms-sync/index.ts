// Pulls texts from phone.com into the messages table. Called every minute by pg_cron.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SYNC_TOKEN = "62121c15aea9d2371823252cf4ef07afd3500c80";
const env = (k: string) => (Deno.env.get(k) || "").trim();
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const d10 = (p: unknown) => String(p ?? "").replace(/\D/g, "").slice(-10);
const toNumber = (t: unknown): string => {
  const x = Array.isArray(t) ? t[0] : t;
  if (!x) return "";
  if (typeof x === "string") return x;
  const o = x as Record<string, unknown>;
  return String(o.number ?? o.phone_number ?? o.to ?? o.e164 ?? "");
};

Deno.serve(async (req) => {
  if (req.headers.get("x-sync-token") !== SYNC_TOKEN) return json({ error: "forbidden" }, 403);
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const { data: keyRows } = await admin.from("app_secrets").select("key,value");
  const saved = new Map((keyRows || []).map((r) => [r.key, r.value]));
  const get = (k: string) => String(saved.get(k) ?? env(k)).trim();
  const token = get("PHONECOM_TOKEN"), voip = get("PHONECOM_VOIP_ID");
  if (!token || !voip) return json({ skipped: "phone.com not configured" });

  const { data: st } = await admin.from("sync_state").select("value").eq("key", "phonecom").maybeSingle();
  const firstRun = !st;
  const prev = (st?.value || {}) as Record<string, unknown>;
  const since: number = (prev.since as number) ?? Math.floor(Date.now() / 1000) - 30 * 86400;
  const saveState = (v: Record<string, unknown>) => admin.from("sync_state").upsert({ key: "phonecom", value: { ...prev, ...v }, updated_at: new Date().toISOString() });

  const items: Record<string, unknown>[] = [];
  const H = { "Authorization": `Bearer ${token}`, "Accept": "application/json" };
  const maxPages = firstRun ? 20 : 5;
  for (let page = 0; page < maxPages; page++) {
    let r: Response;
    try { r = await fetch(`https://api.phone.com/v4/accounts/${encodeURIComponent(voip)}/sms?limit=100&offset=${page * 100}&sort[id]=desc`, { headers: H }); }
    catch (e) { await saveState({ lastRun: Date.now(), lastError: "Couldn't reach phone.com: " + String(e).slice(0, 120), lastErrorAt: Date.now() }); return json({ error: "phone.com unreachable" }, 502); }
    if (!r.ok) {
      const why = r.status === 401 ? "phone.com rejected the API token (401)" : r.status === 404 ? "phone.com couldn't find the account ID (404)" : `phone.com returned error ${r.status}`;
      await saveState({ lastRun: Date.now(), lastError: why, lastErrorAt: Date.now() });
      return json({ error: why }, 502);
    }
    const j = await r.json();
    const batch: Record<string, unknown>[] = j.items || [];
    let reachedOld = false;
    for (const it of batch) {
      if (Number(it.created_epoch || 0) <= since) { reachedOld = true; break; }
      items.push(it);
    }
    if (reachedOld || batch.length < 100) break;
  }
  if (!items.length) { await saveState({ since, lastRun: Date.now(), lastError: null }); return json({ ok: true, added: 0 }); }

  const { data: custs } = await admin.from("customers").select("id, data");
  const byPhone = new Map<string, string>();
  for (const c of custs || []) { const p = d10((c.data as Record<string, unknown>)?.phone); if (p.length === 10 && !byPhone.has(p)) byPhone.set(p, c.id); }

  let added = 0, linked = 0, maxEpoch = since;
  items.sort((a, b) => Number(a.created_epoch) - Number(b.created_epoch));
  for (const it of items) {
    const epoch = Number(it.created_epoch || 0); if (epoch > maxEpoch) maxEpoch = epoch;
    const pcId = String(it.id);
    const dir = String(it.direction) === "out" ? "out" : "in";
    const other = dir === "in" ? String(it.from || "") : toNumber(it.to);
    const digits = d10(other);
    const text = String(it.text ?? "");
    if (dir === "out") {
      const { data: pend } = await admin.from("messages").select("id, data").eq("data->>pcPending", "true").eq("data->>toDigits", digits).limit(20);
      const match = (pend || []).find((m) => String((m.data as Record<string, unknown>).body || "").trim() === text.trim());
      if (match) { await admin.from("messages").update({ data: { ...(match.data as Record<string, unknown>), pcId, pcPending: false } }).eq("id", match.id); linked++; continue; }
    }
    const row = {
      id: "pc-" + pcId,
      data: {
        channel: "phone.com", direction: dir, body: text, pcId,
        customerId: byPhone.get(digits) || "",
        number: digits, to: dir === "out" ? other : "", from: dir === "in" ? other : "",
        read: dir === "out" || firstRun, createdAt: epoch * 1000, viaPhoneCom: true,
      },
    };
    const { error } = await admin.from("messages").upsert(row, { onConflict: "id", ignoreDuplicates: true });
    if (!error) added++;
  }
  await saveState({ since: maxEpoch, lastRun: Date.now(), lastError: null });
  return json({ ok: true, added, linked, firstRun });
});
