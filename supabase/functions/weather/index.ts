// 7-day forecast from the U.S. National Weather Service for the calendar. Cached for 30 minutes.
// Location: settings.weatherLat / weatherLon, else Union, NJ.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => (Deno.env.get(k) || "").trim();
type Rec = Record<string, any>;
const UA = { "User-Agent": "PureWash business app (purewash.net)", Accept: "application/geo+json" };
const DEFAULT = { lat: 40.6976, lon: -74.2632 };
const dateOf = (iso: string) => String(iso).slice(0, 10); // NWS times carry the local offset, so the first 10 chars are the local date
const hourOf = (iso: string) => Number(String(iso).slice(11, 13));

async function get(url: string) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`Weather service returned ${r.status}`);
  return r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: "Sign in again." }, 401);

    const { data: st } = await admin.from("settings").select("data").eq("id", "app").maybeSingle();
    const s = (st?.data || {}) as Rec;
    const lat = Number(s.weatherLat), lon = Number(s.weatherLon);
    const loc = isFinite(lat) && isFinite(lon) && lat && lon ? { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 } : DEFAULT;
    const key = `${loc.lat},${loc.lon}`;

    const { data: cache } = await admin.from("sync_state").select("value").eq("key", "weather").maybeSingle();
    const c = cache?.value as Rec | null;
    if (c && c.key === key && Date.now() - Number(c.at) < 30 * 60000) return json({ ok: true, cached: true, ...c });

    let pts = c && c.key === key ? c.points : null;
    if (!pts) {
      const p = await get(`https://api.weather.gov/points/${key}`);
      const rl = p.properties?.relativeLocation?.properties || {};
      pts = { forecast: p.properties?.forecast, hourly: p.properties?.forecastHourly, place: [rl.city, rl.state].filter(Boolean).join(", ") };
      if (!pts.forecast) throw new Error("No forecast for this location (the National Weather Service covers U.S. locations only).");
    }
    const [f, h] = await Promise.all([get(pts.forecast), pts.hourly ? get(pts.hourly).catch(() => null) : Promise.resolve(null)]);
    const days: Record<string, Rec> = {};
    for (const p of (f.properties?.periods || []) as Rec[]) {
      const d = dateOf(p.startTime); const day = days[d] ||= {};
      const pop = p.probabilityOfPrecipitation?.value;
      if (p.isDaytime) { day.hi = p.temperature; day.short = p.shortForecast; day.wind = p.windSpeed; day.pop = Math.max(Number(day.pop ?? 0), Number(pop ?? 0)); }
      else { day.lo = p.temperature; if (!day.short) day.short = p.shortForecast; day.nightPop = pop ?? null; if (day.pop == null) day.pop = Number(pop ?? 0); }
    }
    if (h) {
      const byDay: Record<string, { max: number; wet: number[] }> = {};
      for (const p of (h.properties?.periods || []) as Rec[]) {
        const hr = hourOf(p.startTime); if (hr < 7 || hr >= 17) continue;
        const d = dateOf(p.startTime); const pop = Number(p.probabilityOfPrecipitation?.value ?? 0);
        const b = byDay[d] ||= { max: 0, wet: [] }; b.max = Math.max(b.max, pop); if (pop >= 50) b.wet.push(hr);
      }
      const fmt = (x: number) => `${x % 12 || 12}${x < 12 ? "am" : "pm"}`;
      for (const [d, b] of Object.entries(byDay)) {
        const day = days[d] ||= {}; day.workPop = b.max;
        const runs: string[] = []; let a = -1, prev = -2;
        for (const x of [...b.wet, 99]) { if (x !== prev + 1) { if (a >= 0) runs.push(`${fmt(a)}–${fmt(prev + 1)}`); a = x; } prev = x; }
        day.rainHours = runs;
      }
    }
    const out = { key, at: Date.now(), place: pts.place, days, points: pts };
    await admin.from("sync_state").upsert({ key: "weather", value: out, updated_at: new Date().toISOString() });
    return json({ ok: true, ...out });
  } catch (e) {
    return json({ error: (e as Error).message || "Forecast unavailable" }, 502);
  }
});
