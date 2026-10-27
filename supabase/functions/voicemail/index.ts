// Voicemail from phone.com.
//  - Scheduled sync (pg_cron, x-sync-token header): lists voicemails, saves new ones, copies recent recordings into storage.
//  - On demand (signed-in owner/office): {action:"fetch", id} copies one older recording so it can be played.
// Recordings are converted from telephone µ-law WAV to standard WAV so every browser can play them.
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { toPcmWav } from "./wav.ts";

const SYNC_TOKEN = "62121c15aea9d2371823252cf4ef07afd3500c80";
const EAGER_DAYS = 90;           // recordings newer than this are copied automatically
const AUDIO_PER_RUN = 8;         // recordings copied per scheduled run
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => (Deno.env.get(k) || "").trim();
const d10 = (p: unknown) => String(p ?? "").replace(/\D/g, "").slice(-10);

async function keys(admin: SupabaseClient) {
  const { data } = await admin.from("app_secrets").select("key,value");
  const saved = new Map((data || []).map((r) => [r.key, r.value]));
  const get = (k: string) => String(saved.get(k) ?? env(k)).trim();
  return { token: get("PHONECOM_TOKEN"), voip: get("PHONECOM_VOIP_ID") };
}

async function copyAudio(admin: SupabaseClient, token: string, voip: string, row: { id: string; data: Record<string, unknown> }) {
  const pcId = String(row.data.pcId);
  const r = await fetch(`https://api.phone.com/v4/accounts/${encodeURIComponent(voip)}/voicemail/${encodeURIComponent(pcId)}/download`, { headers: { "Authorization": `Bearer ${token}` } });
  if (r.status === 404) {
    await admin.from("voicemails").update({ data: { ...row.data, audioWanted: false, audioMissing: true } }).eq("id", row.id);
    return { ok: false, error: "This recording is no longer on phone.com." };
  }
  if (!r.ok) return { ok: false, error: `phone.com returned error ${r.status} for the recording.` };
  const raw = new Uint8Array(await r.arrayBuffer());
  const conv = toPcmWav(raw);
  const path = `${row.id}.wav`;
  const { error } = await admin.storage.from("voicemail").upload(path, conv.bytes, { contentType: "audio/wav", upsert: true });
  if (error) return { ok: false, error: "Couldn't save the recording: " + error.message };
  const audio = { path, type: "audio/wav", bytes: conv.bytes.length, converted: conv.converted, at: Date.now() };
  await admin.from("voicemails").update({ data: { ...row.data, audio, audioWanted: false, audioMissing: false, duration: row.data.duration || (conv.seconds ? Math.round(conv.seconds) : null) } }).eq("id", row.id);
  return { ok: true, audio };
}

async function sync(admin: SupabaseClient) {
  const { token, voip } = await keys(admin);
  if (!token || !voip) return { skipped: "phone.com not configured" };
  const { data: st } = await admin.from("sync_state").select("value").eq("key", "voicemail").maybeSingle();
  const prev = (st?.value || {}) as Record<string, unknown>;
  const firstRun = !prev.backfilled;
  const save = (v: Record<string, unknown>) => admin.from("sync_state").upsert({ key: "voicemail", value: { ...prev, ...v }, updated_at: new Date().toISOString() });
  const H = { "Authorization": `Bearer ${token}`, "Accept": "application/json" };
  const base = `https://api.phone.com/v4/accounts/${encodeURIComponent(voip)}`;

  // newest first; on the first run read everything, afterwards the newest 100 (catches new ones and heard/unheard changes)
  const items: Record<string, unknown>[] = [];
  for (let page = 0; page < (firstRun ? 20 : 1); page++) {
    let r: Response;
    try { r = await fetch(`${base}/voicemail?limit=${firstRun ? 500 : 100}&offset=${page * 500}&sort[id]=desc`, { headers: H }); }
    catch (e) { await save({ lastRun: Date.now(), lastError: "Couldn't reach phone.com: " + String(e).slice(0, 120) }); return { error: "unreachable" }; }
    if (!r.ok) {
      const why = r.status === 401 ? "phone.com rejected the API token (401)" : `phone.com returned error ${r.status} listing voicemail`;
      await save({ lastRun: Date.now(), lastError: why });
      return { error: why };
    }
    const j = await r.json();
    const batch = (j.items || []) as Record<string, unknown>[];
    items.push(...batch);
    if (!firstRun || batch.length < 500) break;
  }

  const { data: custs } = await admin.from("customers").select("id, data");
  const byPhone = new Map<string, string>();
  for (const c of custs || []) { const p = d10((c.data as Record<string, unknown>)?.phone); if (p.length === 10 && !byPhone.has(p)) byPhone.set(p, c.id); }

  const ids = items.map((it) => "vm-" + String(it.id));
  const existing = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin.from("voicemails").select("id,data").in("id", ids.slice(i, i + 200));
    for (const x of data || []) existing.set(x.id, x.data as Record<string, unknown>);
  }
  const cutoff = Date.now() - EAGER_DAYS * 86400e3;
  const fresh: { id: string; data: Record<string, unknown> }[] = [];
  let heardUpdates = 0;
  for (const it of items) {
    const id = "vm-" + String(it.id);
    const from = (it.from || {}) as Record<string, unknown>;
    const ext = (it.extension || {}) as Record<string, unknown>;
    const createdAt = Number(it.created_at || 0) * 1000;
    const old = existing.get(id);
    if (old) {
      // phone.com says it's been listened to (e.g. on the phone) -> mark heard here too
      if (it.is_new === false && old.heard === false && !old.deleted) { await admin.from("voicemails").update({ data: { ...old, heard: true, heardVia: "phone.com" } }).eq("id", id); heardUpdates++; }
      continue;
    }
    fresh.push({ id, data: {
      pcId: String(it.id), number: d10(from.number), fromRaw: String(from.number || ""), callerName: String(from.name || ""), callerCity: String(from.city || ""), callerState: String(from.state || ""),
      customerId: byPhone.get(d10(from.number)) || "", duration: Number(it.duration) || null, createdAt, folder: String(it.folder || ""), extension: String(ext.name || ""),
      heard: firstRun ? true : it.is_new === false, heardVia: it.is_new === false ? "phone.com" : null, audio: null, audioWanted: !firstRun || createdAt >= cutoff || it.is_new === true, deleted: false,
    } });
  }
  // keep phone.com's unheard flag on the first run for recent unheard messages so nothing new is missed
  if (firstRun) for (const f of fresh) { const it = items.find((x) => "vm-" + String(x.id) === f.id); if (it && it.is_new === true) f.data.heard = false; }
  for (let i = 0; i < fresh.length; i += 200) await admin.from("voicemails").upsert(fresh.slice(i, i + 200), { onConflict: "id", ignoreDuplicates: true });

  // copy a few recordings per run, newest first
  const { data: want } = await admin.from("voicemails").select("id,data").eq("data->>audioWanted", "true").limit(200);
  const queue = (want || []).sort((a, b) => Number((b.data as Record<string, unknown>).createdAt) - Number((a.data as Record<string, unknown>).createdAt)).slice(0, AUDIO_PER_RUN);
  let copied = 0, copyErrors = 0;
  for (const row of queue) { const r = await copyAudio(admin, token, voip, row as { id: string; data: Record<string, unknown> }); r.ok ? copied++ : copyErrors++; }

  await save({ backfilled: true, lastRun: Date.now(), lastError: null, total: items.length > (Number(prev.total) || 0) ? items.length : prev.total, audioQueue: Math.max(0, (want || []).length - copied) });
  return { ok: true, firstRun, added: fresh.length, heardUpdates, copied, copyErrors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  try {
    if (req.headers.get("x-sync-token") === SYNC_TOKEN) return json(await sync(admin));

    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: "Your sign-in expired. Sign in again." }, 401);
    const { data: me } = await admin.from("profiles").select("role,active").eq("id", user.id).single();
    if (!me || !me.active || !(me.role === "owner" || me.role === "office")) return json({ error: "Only the owner and office can listen to voicemail." }, 403);
    const body = await req.json().catch(() => ({}));

    if (body.action === "fetch") {
      const { data: row } = await admin.from("voicemails").select("id,data").eq("id", String(body.id || "")).maybeSingle();
      if (!row) return json({ error: "That voicemail wasn't found." }, 404);
      if ((row.data as Record<string, unknown>).audio) return json({ ok: true, already: true });
      const { token, voip } = await keys(admin);
      if (!token || !voip) return json({ error: "phone.com isn't connected. The owner can fix it in Settings → APIs." }, 503);
      const r = await copyAudio(admin, token, voip, row as { id: string; data: Record<string, unknown> });
      return r.ok ? json({ ok: true }) : json({ error: r.error }, 502);
    }
    if (body.action === "sync") {
      if (me.role !== "owner") return json({ error: "Only the owner can run a sync." }, 403);
      return json(await sync(admin));
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: "Something went wrong on the server.", detail: String(e).slice(0, 200) }, 500);
  }
});
