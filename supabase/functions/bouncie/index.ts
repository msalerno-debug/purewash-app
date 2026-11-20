// Bouncie vehicle tracking.
//  GET  ?code&state                    Bouncie sends the owner back here after they approve the connection
//  POST ?key=…  (Bouncie webhook)      trip / check-engine / battery / plug events, applied right away
//  POST x-sync-token {}                every 2 minutes: live location, odometer, fuel, check engine, battery for every device
//  POST (owner)        {action:"connect"} -> {url} | {action:"disconnect"}
//  POST (owner/office) {action:"status"} | {action:"sync"} | {action:"test"} | {action:"trips", imei, date:"YYYY-MM-DD"}
// Client ID/secret are entered in Settings → APIs. Bouncie has no refresh tokens: the saved authorization code is
// exchanged again for a new access token whenever the old one (about 1 hour) runs out.
// Live data goes in public.vehicle_live (one row per device, id "b-<imei>") so the vehicles table and its
// activity log aren't touched every two minutes.
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const SYNC_TOKEN = "62121c15aea9d2371823252cf4ef07afd3500c80";
const APP = "https://purewash-app.vercel.app";
const API = "https://api.bouncie.dev/v1";
const AUTH_URL = "https://auth.bouncie.com/dialog/authorize";
const TOKEN_URL = "https://auth.bouncie.com/oauth/token";
const TZ = "America/New_York";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => (Deno.env.get(k) || "").trim();
const REDIRECT = () => `${env("SUPABASE_URL")}/functions/v1/bouncie`;
type Rec = Record<string, any>;
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const num = (v: unknown) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));

class BError extends Error { code: string; constructor(m: string, code = "") { super(m); this.code = code; } }

async function state(admin: SupabaseClient, key: string) { const { data } = await admin.from("sync_state").select("value").eq("key", key).maybeSingle(); return (data?.value ?? null) as Rec | null; }
async function putState(admin: SupabaseClient, key: string, value: unknown) { await admin.from("sync_state").upsert({ key, value, updated_at: new Date().toISOString() }); }

class Bouncie {
  admin: SupabaseClient; cid = ""; secret = ""; auth: Rec | null = null; hookKey = "";
  constructor(admin: SupabaseClient) { this.admin = admin; }
  async load() {
    const { data } = await this.admin.from("app_secrets").select("key,value").in("key", ["BOUNCIE_CLIENT_ID", "BOUNCIE_CLIENT_SECRET", "BOUNCIE_AUTH", "BOUNCIE_WEBHOOK_KEY"]);
    const m = new Map((data || []).map((r) => [r.key, r.value]));
    this.cid = String(m.get("BOUNCIE_CLIENT_ID") ?? env("BOUNCIE_CLIENT_ID")).trim();
    this.secret = String(m.get("BOUNCIE_CLIENT_SECRET") ?? env("BOUNCIE_CLIENT_SECRET")).trim();
    this.hookKey = String(m.get("BOUNCIE_WEBHOOK_KEY") || "").trim();
    try { this.auth = m.get("BOUNCIE_AUTH") ? JSON.parse(String(m.get("BOUNCIE_AUTH"))) : null; } catch { this.auth = null; }
    return this;
  }
  get connected() { return !!(this.auth && this.auth.code); }
  async saveAuth(a: Rec | null) {
    this.auth = a;
    if (!a) await this.admin.from("app_secrets").delete().eq("key", "BOUNCIE_AUTH");
    else await this.admin.from("app_secrets").upsert({ key: "BOUNCIE_AUTH", value: JSON.stringify(a), updated_at: new Date().toISOString() });
  }
  async ensureHookKey() {
    if (this.hookKey) return this.hookKey;
    this.hookKey = hex(20);
    await this.admin.from("app_secrets").upsert({ key: "BOUNCIE_WEBHOOK_KEY", value: this.hookKey, updated_at: new Date().toISOString() });
    return this.hookKey;
  }
  // Bouncie's token endpoint takes a form post; fall back to JSON in case that ever changes.
  async exchange(code: string): Promise<Rec> {
    const fields = { client_id: this.cid, client_secret: this.secret, grant_type: "authorization_code", code, redirect_uri: REDIRECT() };
    let r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(fields) });
    let j = await r.json().catch(() => ({}));
    if (!r.ok && (r.status === 400 || r.status === 415) && !/invalid_(grant|client)/.test(JSON.stringify(j))) {
      r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(fields) });
      j = await r.json().catch(() => ({}));
    }
    if (!r.ok || !j.access_token) {
      const s = JSON.stringify(j);
      if (/invalid_client/.test(s) || r.status === 401) throw new BError("Bouncie didn't accept the Client ID and Client Secret. Check them in Settings → APIs.", "invalid_client");
      if (/invalid_grant/.test(s)) throw new BError("The Bouncie connection was revoked or expired. Connect Bouncie again in Settings → APIs.", "invalid_grant");
      throw new BError(`Bouncie sign-in failed: ${j.error_description || j.error || j.message || r.status}`, String(j.error || r.status));
    }
    return j;
  }
  async access(force = false): Promise<string> {
    if (!this.connected) throw new BError("Bouncie isn't connected yet. Connect it in Settings → APIs.", "not_connected");
    if (!force && this.auth!.access && Date.now() < Number(this.auth!.accessExp) - 120000) return this.auth!.access;
    let j: Rec;
    try { j = await this.exchange(this.auth!.code); }
    catch (e) { if (["invalid_grant"].includes((e as BError).code)) await this.saveAuth({ ...this.auth, code: "", access: "", lostAt: Date.now() }); throw e; }
    await this.saveAuth({ ...this.auth, access: j.access_token, accessExp: Date.now() + Number(j.expires_in || 3600) * 1000 });
    return j.access_token;
  }
  async get(path: string, params: Record<string, string> = {}, retry = true): Promise<any> {
    const at = await this.access();
    const u = new URL(API + path); for (const [k, v] of Object.entries(params)) if (v !== "") u.searchParams.set(k, v);
    const r = await fetch(u, { headers: { Authorization: at, Accept: "application/json" } });
    if (r.status === 401 && retry) { await this.access(true); return this.get(path, params, false); }
    const text = await r.text(); let j: any = null; try { j = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok) {
      if (r.status === 401) throw new BError("Bouncie rejected the connection (401). Connect Bouncie again in Settings → APIs.", "401");
      if (r.status === 429) throw new BError("Bouncie is rate-limiting requests. It will catch up on the next check.", "429");
      throw new BError(`Bouncie returned error ${r.status}${j?.message ? ": " + String(j.message).slice(0, 200) : ""}.`, String(r.status));
    }
    return j;
  }
}

/* ---------- live data ---------- */
// Trims a Bouncie vehicle to what the app shows. Keeps the last known location if this update has none.
function liveFrom(v: Rec, prev: Rec | null): Rec {
  const s = (v.stats || {}) as Rec; const loc = (s.location || {}) as Rec; const mil = (s.mil || {}) as Rec; const bat = (s.battery || {}) as Rec;
  const p = prev || {};
  const lat = num(loc.lat), lon = num(loc.lon);
  return {
    ...p,
    imei: String(v.imei || p.imei || ""), vin: String(v.vin || p.vin || "").toUpperCase(), nickName: String(v.nickName || p.nickName || ""),
    make: String(v.model?.make || p.make || ""), model: String(v.model?.name || p.model || ""), year: num(v.model?.year) ?? p.year ?? null,
    lat: lat ?? p.lat ?? null, lon: lon ?? p.lon ?? null, heading: num(loc.heading) ?? p.heading ?? null, address: loc.address ?? (lat !== null ? null : p.address ?? null),
    speed: num(s.speed) ?? 0, isRunning: s.isRunning === undefined ? !!p.isRunning : !!s.isRunning,
    odometer: num(s.odometer) ?? p.odometer ?? null, fuel: num(s.fuelLevel) ?? p.fuel ?? null,
    milOn: mil.milOn === undefined ? !!p.milOn : !!mil.milOn,
    dtcs: Array.isArray(mil.qualifiedDtcList) ? mil.qualifiedDtcList.slice(0, 20).map((d: Rec) => ({ code: String(d.code || ""), name: Array.isArray(d.name) ? d.name.join("; ") : String(d.name || "") })) : (p.dtcs || []),
    battery: String(bat.status || p.battery || ""), statsAt: s.lastUpdated ? Date.parse(String(s.lastUpdated)) || null : p.statsAt ?? null,
    tz: String(s.localTimeZone || p.tz || ""), syncedAt: Date.now(),
  };
}

async function sync(b: Bouncie, admin: SupabaseClient, only?: string) {
  const list = (await b.get("/vehicles", only ? { imei: only } : {})) as Rec[];
  const rows = Array.isArray(list) ? list.filter((v) => v && v.imei) : [];
  const ids = rows.map((v) => "b-" + v.imei);
  const { data: old } = ids.length ? await admin.from("vehicle_live").select("id,data").in("id", ids) : { data: [] };
  const prev = new Map((old || []).map((r) => [r.id, r.data as Rec]));
  const up = rows.map((v) => ({ id: "b-" + v.imei, data: liveFrom(v, prev.get("b-" + v.imei) || null), updated_at: new Date().toISOString() }));
  if (up.length) { const { error } = await admin.from("vehicle_live").upsert(up); if (error) throw new BError("Couldn't save vehicle data: " + error.message); }
  return up.length;
}

/* ---------- webhooks ---------- */
// Applies an event straight away, then asks Bouncie for the full picture of that vehicle.
async function webhook(b: Bouncie, admin: SupabaseClient, ev: Rec) {
  const imei = String(ev.imei || ""); if (!/^\d{6,20}$/.test(imei)) return { ignored: "no imei" };
  const id = "b-" + imei;
  const { data: row } = await admin.from("vehicle_live").select("data").eq("id", id).maybeSingle();
  const d: Rec = { ...((row?.data || { imei, vin: String(ev.vin || "").toUpperCase() }) as Rec) };
  const t = String(ev.eventType || "");
  const at = (x: unknown) => (x ? Date.parse(String(x)) || Date.now() : Date.now());
  const note = (kind: string, extra: Rec = {}) => { d.events = [{ kind, at: Date.now(), ...extra }, ...((d.events || []) as Rec[])].slice(0, 25); };
  if (t === "tripStart") { d.isRunning = true; d.tripStartAt = at(ev.start?.timestamp); if (num(ev.start?.odometer) !== null) d.odometer = Math.max(Number(d.odometer) || 0, Number(ev.start.odometer)); note("tripStart"); }
  else if (t === "tripEnd") { d.isRunning = false; d.speed = 0; d.lastTripEndAt = at(ev.end?.timestamp); if (num(ev.end?.odometer) !== null) d.odometer = Math.max(Number(d.odometer) || 0, Number(ev.end.odometer)); note("tripEnd"); }
  else if (t === "tripData") {
    const pts = (Array.isArray(ev.data) ? ev.data : []) as Rec[];
    const last = pts.filter((p) => p?.gps && num(p.gps.lat) !== null).sort((a, z) => at(a.timestamp) - at(z.timestamp)).pop();
    if (last) { d.lat = Number(last.gps.lat); d.lon = Number(last.gps.lon); d.heading = num(last.gps.heading) ?? d.heading ?? null; d.speed = num(last.speed) ?? d.speed ?? 0; d.isRunning = true; d.address = null; d.statsAt = at(last.timestamp); }
  }
  else if (t === "mil") { const on = String(ev.mil?.value || "").toUpperCase() === "ON" || ev.mil?.milOn === true; d.milOn = on; if (Array.isArray(ev.mil?.dtcCodes)) d.dtcs = ev.mil.dtcCodes.slice(0, 20).map((c: unknown) => ({ code: String(c), name: "" })); note(on ? "milOn" : "milOff"); }
  else if (t === "battery") { d.battery = String(ev.battery?.value || ev.battery?.status || d.battery || ""); note("battery", { value: d.battery }); }
  else if (t === "connect") { d.unplugged = false; note("connect"); }
  else if (t === "disconnect") { d.unplugged = true; d.unpluggedAt = at(ev.disconnect?.timestamp); note("disconnect"); }
  else if (t !== "tripMetrics") return { ignored: t || "unknown event" };
  d.hookAt = Date.now();
  await admin.from("vehicle_live").upsert({ id, data: d, updated_at: new Date().toISOString() });
  // the event carries little; fill in address, fuel, odometer and codes from the API (skip the chatty breadcrumb events)
  if (t !== "tripData" && b.connected) {
    try { await sync(b, admin, imei); } catch (_) { /* the 2-minute sync will catch up */ }
    if (t === "tripEnd" || t === "tripMetrics") { try { await saveTrips(admin, imei, await fetchTrips(b, imei, Date.now() - 864e5, Date.now())); } catch (_) { /* the 15-minute pass will catch up */ } }
  }
  return { ok: true, event: t };
}

/* ---------- trips ---------- */
// Google encoded polyline (precision 5) -> [[lat,lon],...]
function decodePolyline(str: string): number[][] {
  const out: number[][] = []; let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, byte = 0;
      do { byte = str.charCodeAt(i++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && i < str.length);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lon += d;
    }
    out.push([lat / 1e5, lon / 1e5]);
  }
  return out;
}
function gpsEnds(gps: unknown): { s: number[] | null; e: number[] | null } {
  try {
    let pts: number[][] = [];
    if (typeof gps === "string" && gps) pts = decodePolyline(gps);
    else if (gps && Array.isArray((gps as Rec).coordinates)) pts = ((gps as Rec).coordinates as number[][]).map((c) => [c[1], c[0]]);
    pts = pts.filter((p) => Math.abs(p[0]) > 0.1 && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
    return { s: pts[0] || null, e: pts[pts.length - 1] || null };
  } catch { return { s: null, e: null }; }
}
// Saves trip summaries (no route) so the app can build mileage logs without calling Bouncie.
async function saveTrips(admin: SupabaseClient, imei: string, list: Rec[]) {
  const rows = list.filter((t) => t.transactionId && t.startTime).map((t) => {
    const ends = gpsEnds(t.gps);
    return { id: String(t.transactionId), imei, started_at: new Date(String(t.startTime)).toISOString(), updated_at: new Date().toISOString(), data: {
      imei, start: t.startTime, end: t.endTime || null, miles: num(t.distance), avgMph: num(t.averageSpeed), maxMph: num(t.maxSpeed) !== null ? Math.round(Number(t.maxSpeed)) : null,
      idleSec: num(t.totalIdleDuration), fuel: num(t.fuelConsumed), startOdo: num(t.startOdometer), endOdo: num(t.endOdometer), tz: String(t.timeZone || ""),
      sLat: ends.s?.[0] ?? null, sLon: ends.s?.[1] ?? null, eLat: ends.e?.[0] ?? null, eLon: ends.e?.[1] ?? null } };
  }).filter((r) => r.data.end); // only finished trips
  for (let i = 0; i < rows.length; i += 200) await admin.from("vehicle_trips").upsert(rows.slice(i, i + 200));
  return rows.length;
}
async function fetchTrips(b: Bouncie, imei: string, startMs: number, endMs: number): Promise<Rec[]> {
  const start = new Date(startMs).toISOString(), end = new Date(endMs).toISOString();
  // older and newer Bouncie docs spell the parameters differently; send both
  const list = await b.get("/trips", { imei, "gps-format": "polyline", gpsFormat: "polyline", "starts-after": start, startsAfter: start, "ends-before": end, endsBefore: end });
  return Array.isArray(list) ? list : [];
}
// Pulls finished trips for every device over the last `days` days, one week per request (Bouncie's limit).
async function backfill(b: Bouncie, admin: SupabaseClient, days: number, only?: string) {
  const { data: devs } = await admin.from("vehicle_live").select("data").like("id", "b-%");
  const imeis = (devs || []).map((d) => String((d.data as Rec).imei)).filter((x) => /^\d{6,20}$/.test(x) && (!only || x === only));
  let n = 0; const now = Date.now();
  for (const imei of imeis) {
    for (let from = now - days * 864e5; from < now; from += 7 * 864e5) {
      const list = await fetchTrips(b, imei, from, Math.min(from + 7 * 864e5 - 1000, now));
      n += await saveTrips(admin, imei, list);
    }
  }
  return n;
}

// One local day of trips for one device, with the route as an encoded polyline.
function dayRange(date: string) {
  // the business runs on New York time; build that day's start and end as UTC instants
  const [y, m, dd] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, dd, 12);
  const off = (ms: number) => { const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" }).formatToParts(new Date(ms)).find((x) => x.type === "timeZoneName")?.value || "GMT-5"; const mm = p.match(/GMT([+-]\d+)(?::(\d+))?/); return mm ? (Number(mm[1]) * 60 + Math.sign(Number(mm[1])) * Number(mm[2] || 0)) : -300; };
  const start = Date.UTC(y, m - 1, dd) - off(guess) * 60000;
  return { start: new Date(start).toISOString(), end: new Date(start + 864e5 - 1000).toISOString() };
}
async function trips(b: Bouncie, admin: SupabaseClient, imei: string, date: string) {
  const { start, end } = dayRange(date);
  const list = await fetchTrips(b, imei, Date.parse(start), Math.min(Date.parse(end), Date.now()));
  await saveTrips(admin, imei, list);
  return list.map((t) => ({
    id: String(t.transactionId || ""), start: t.startTime || null, end: t.endTime || null,
    miles: num(t.distance), avgMph: num(t.averageSpeed), maxMph: num(t.maxSpeed) !== null ? Math.round(Number(t.maxSpeed)) : null,
    idleSec: num(t.totalIdleDuration), fuel: num(t.fuelConsumed), hardBrakes: num(t.hardBrakingCount) || 0, hardAccels: num(t.hardAccelerationCount) || 0,
    startOdo: num(t.startOdometer), endOdo: num(t.endOdometer), gps: typeof t.gps === "string" ? t.gps : "",
  })).sort((a, z) => String(a.start).localeCompare(String(z.start)));
}

/* ---------- connect ---------- */
async function callback(url: URL, admin: SupabaseClient) {
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `${APP}/?${q}` } });
  const err = url.searchParams.get("error");
  if (err) return back(`bouncie=error&msg=${encodeURIComponent(err === "access_denied" ? "The connection was cancelled in Bouncie." : "Bouncie returned: " + err)}`);
  const code = url.searchParams.get("code") || "", st = url.searchParams.get("state") || "";
  const saved = await state(admin, "bouncie:oauth");
  if (!saved || saved.state !== st || Date.now() > Number(saved.exp)) return back(`bouncie=error&msg=${encodeURIComponent("That connection attempt expired. Click Connect again.")}`);
  await putState(admin, "bouncie:oauth", null);
  const b = await new Bouncie(admin).load();
  try {
    const j = await b.exchange(code);
    await b.saveAuth({ code, access: j.access_token, accessExp: Date.now() + Number(j.expires_in || 3600) * 1000, connectedAt: Date.now(), connectedBy: saved.uid });
    let who = "";
    try { const u = await b.get("/user"); who = String(u?.name || u?.email || ""); await b.saveAuth({ ...b.auth, account: who }); } catch (_) { /* name is optional */ }
    let n = 0, tr = 0; try { n = await sync(b, admin); tr = await backfill(b, admin, 30); } catch (_) { /* the scheduled sync retries */ }
    await putState(admin, "bouncie:sync", { lastRun: Date.now(), lastError: null, devices: n, lastTrips: Date.now(), backfilled: true, trips: tr });
    await b.ensureHookKey();
    await admin.from("activity").insert({ user_id: saved.uid, tbl: "settings", row_id: "api", action: "update", summary: `Connected Bouncie${who ? " (" + who + ")" : ""}` });
    return back(`bouncie=connected&n=${n}`);
  } catch (e) {
    return back(`bouncie=error&msg=${encodeURIComponent((e as Error).message)}`);
  }
}

async function runSync(b: Bouncie, admin: SupabaseClient, force = false) {
  const st = (await state(admin, "bouncie:sync")) || {};
  try {
    const n = await sync(b, admin);
    let trips = 0, lastTrips = st.lastTrips || 0;
    if (force || Date.now() - lastTrips > 15 * 60000) { trips = await backfill(b, admin, st.backfilled ? 2 : 30); lastTrips = Date.now(); }
    await putState(admin, "bouncie:sync", { ...st, lastRun: Date.now(), lastError: null, devices: n, lastTrips, backfilled: true });
    return { ok: true, devices: n, trips };
  }
  catch (e) { await putState(admin, "bouncie:sync", { ...st, lastRun: Date.now(), lastError: (e as Error).message, lastErrorAt: Date.now() }); throw e; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const url = new URL(req.url);
  try {
    if (req.method === "GET") {
      if (url.searchParams.has("code") || url.searchParams.has("error")) return await callback(url, admin);
      return new Response(null, { status: 302, headers: { Location: APP } });
    }

    // scheduled sync
    if (req.headers.get("x-sync-token") === SYNC_TOKEN) {
      const b = await new Bouncie(admin).load();
      if (!b.connected) return json({ skipped: "not connected" });
      try { return json(await runSync(b, admin)); } catch (e) { return json({ error: (e as Error).message }, 502); }
    }

    // Bouncie webhook: the key is in the URL we give the owner, and Bouncie may also send it as the Authorization header
    const hookKey = url.searchParams.get("key") || "";
    const authHdr = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (hookKey || (authHdr && !authHdr.startsWith("eyJ"))) {
      const b = await new Bouncie(admin).load();
      if (!b.hookKey || (hookKey !== b.hookKey && authHdr !== b.hookKey)) return json({ error: "Unknown webhook key." }, 401);
      const ev = await req.json().catch(() => ({}));
      const out = await webhook(b, admin, ev as Rec);
      const st = (await state(admin, "bouncie:sync")) || {};
      await putState(admin, "bouncie:sync", { ...st, lastHook: Date.now(), lastHookType: String((ev as Rec).eventType || "") });
      return json(out);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "status");
    const { data: { user } } = await admin.auth.getUser(authHdr);
    if (!user) return json({ error: "Your sign-in expired. Sign in again." }, 401);
    const { data: me } = await admin.from("profiles").select("role,active").eq("id", user.id).single();
    if (!me || !me.active || !(me.role === "owner" || me.role === "office")) return json({ error: "Only the owner and office can use Bouncie." }, 403);
    const owner = me.role === "owner";
    const b = await new Bouncie(admin).load();

    if (action === "status") {
      const st = await state(admin, "bouncie:sync");
      return json({ ok: true, keys: !!(b.cid && b.secret), connected: b.connected, lost: !!(b.auth && !b.auth.code && b.auth.lostAt), account: b.auth?.account || "",
        connectedAt: b.auth?.connectedAt || null, lastRun: st?.lastRun || null, lastError: st?.lastError || null, devices: st?.devices ?? null, lastHook: st?.lastHook || null, lastHookType: st?.lastHookType || "",
        redirectUri: REDIRECT(), webhookUrl: owner && b.hookKey ? `${REDIRECT()}?key=${b.hookKey}` : null, webhookKey: owner ? b.hookKey || null : null });
    }
    if (action === "connect") {
      if (!owner) return json({ error: "Only the owner can connect Bouncie." }, 403);
      if (!b.cid || !b.secret) return json({ error: "Enter the Client ID and Client Secret first." }, 400);
      const s = hex(20);
      await putState(admin, "bouncie:oauth", { state: s, uid: user.id, exp: Date.now() + 15 * 60000 });
      await b.ensureHookKey();
      return json({ ok: true, url: `${AUTH_URL}?${new URLSearchParams({ client_id: b.cid, redirect_uri: REDIRECT(), response_type: "code", state: s })}` });
    }
    if (action === "disconnect") {
      if (!owner) return json({ error: "Only the owner can disconnect Bouncie." }, 403);
      await b.saveAuth(null);
      await putState(admin, "bouncie:sync", null);
      if (body.clear) { await admin.from("vehicle_live").delete().like("id", "b-%"); await admin.from("vehicle_trips").delete().neq("id", ""); }
      await admin.from("activity").insert({ user_id: user.id, tbl: "settings", row_id: "api", action: "update", summary: "Disconnected Bouncie" });
      return json({ ok: true });
    }
    if (action === "sync") {
      try { return json(await runSync(b, admin, true)); } catch (e) { return json({ error: (e as Error).message }, 502); }
    }
    if (action === "trips") {
      const imei = String(body.imei || ""), date = String(body.date || "");
      if (!/^\d{6,20}$/.test(imei) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Pick a vehicle and a day." }, 400);
      try { return json({ ok: true, date, trips: await trips(b, admin, imei, date) }); } catch (e) { return json({ error: (e as Error).message }, 502); }
    }
    if (action === "test") {
      const checks: Rec[] = [];
      const add = (c: Rec) => { checks.push(c); return c.ok; };
      add({ label: "Client ID and Client Secret entered", ok: !!(b.cid && b.secret), fix: b.cid && b.secret ? undefined : "Copy them from your app at bouncie.dev and save them here." });
      if (b.cid && b.secret) {
        if (!b.connected) add({ label: b.auth?.lostAt ? "The Bouncie connection was lost" : "Bouncie isn't connected yet", ok: false, fix: "Click Connect Bouncie and approve access to your vehicles." });
        else {
          try {
            await b.access(true);
            add({ label: "Bouncie accepted the connection", ok: true });
            const n = await sync(b, admin);
            const st = (await state(admin, "bouncie:sync")) || {};
            await putState(admin, "bouncie:sync", { ...st, lastRun: Date.now(), lastError: null, devices: n });
            add({ label: n ? `Found ${n} vehicle${n === 1 ? "" : "s"} with a Bouncie device` : "No vehicles found on this Bouncie account", ok: n > 0 ? true : null, fix: n ? undefined : "Make sure the devices are activated in the Bouncie app under the account you connected." });
            const { data: veh } = await admin.from("vehicles").select("id,data");
            const { data: live } = await admin.from("vehicle_live").select("id,data").like("id", "b-%");
            const linked = (live || []).filter((l) => (veh || []).some((v) => String((v.data as Rec).bouncieImei || "") === (l.data as Rec).imei || (!!(l.data as Rec).vin && String((v.data as Rec).vin || "").toUpperCase() === (l.data as Rec).vin))).length;
            if (n) add({ label: linked === n ? "Every device is linked to a vehicle in Fleet" : `${linked} of ${n} devices linked to a vehicle in Fleet`, ok: linked === n ? true : null, fix: linked === n ? undefined : "Open each vehicle in Fleet and pick its Bouncie device, or enter the same VIN on the vehicle." });
          } catch (e) { add({ label: "Bouncie didn't accept the connection", ok: false, detail: (e as Error).message, fix: "Click Connect Bouncie again. If it keeps failing, check the Client ID, Client Secret and Redirect URL at bouncie.dev." }); }
          const st = await state(admin, "bouncie:sync");
          add(st?.lastHook ? { label: `Instant updates are on (last event ${Math.round((Date.now() - st.lastHook) / 60000)} min ago)`, ok: true }
            : { label: "Instant updates (webhook) haven't been received yet", ok: null, detail: "Not required. Without them, locations still update every 2 minutes.", fix: "Paste the Webhook URL below into your app at bouncie.dev, then take a short drive." });
        }
      }
      const result = { at: Date.now(), ok: !checks.some((c) => c.ok === false), checks };
      await putState(admin, "test:bouncie", result);
      return json({ ok: true, result });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || "Something went wrong on the server." }, 500);
  }
});
