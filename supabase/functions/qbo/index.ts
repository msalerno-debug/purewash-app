// QuickBooks Online connection.
//  GET  ?code&state&realmId           Intuit sends the owner back here after they approve the connection
//  POST (owner)  {action:"connect"}    -> {url} to send the owner to Intuit
//  POST (owner)  {action:"disconnect"}
//  POST (owner/office) {action:"status"} | {action:"test"} | {action:"push", ids, customers} | {action:"payments", ids, deleted} | {action:"pull"}
//  POST x-sync-token {action:"pull"}   scheduled: brings in payments recorded in QuickBooks
// Client ID/secret are entered in Settings → APIs. Tokens live in app_secrets (server-only).
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const SYNC_TOKEN = "62121c15aea9d2371823252cf4ef07afd3500c80";
const APP = "https://purewash-app.vercel.app";
const API = "https://quickbooks.api.intuit.com";
const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const MINOR = "minorversion=75";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => (Deno.env.get(k) || "").trim();
const REDIRECT = () => `${env("SUPABASE_URL")}/functions/v1/qbo`;
type Rec = Record<string, any>;
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9@.]+/g, " ").trim();
const qs = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

class QBError extends Error { code: string; constructor(m: string, code = "") { super(m); this.code = code; } }
const FATAL = ["invalid_grant", "invalid_client", "not_connected", "401", "403", "429"];
const rethrowFatal = (e: unknown) => { if (FATAL.includes((e as QBError).code)) throw e; };

function faultMsg(j: Rec, status: number): QBError {
  const e = j?.Fault?.Error?.[0] || j?.fault?.error?.[0];
  if (e) return new QBError(`${e.Message || e.message || "QuickBooks error"}${e.Detail || e.detail ? ": " + String(e.Detail || e.detail).slice(0, 220) : ""}`, String(e.code || ""));
  if (status === 401) return new QBError("QuickBooks rejected the connection (401). Reconnect QuickBooks in Settings → APIs.", "401");
  if (status === 403) return new QBError("QuickBooks says this connection isn't allowed to do that (403). Make sure the person who connected is a QuickBooks admin.", "403");
  if (status === 429) return new QBError("QuickBooks is rate-limiting requests. Wait a minute and try again.", "429");
  return new QBError(`QuickBooks returned error ${status}.`, String(status));
}

class QB {
  admin: SupabaseClient; tok: Rec | null = null; cid = ""; secret = "";
  constructor(admin: SupabaseClient) { this.admin = admin; }
  async load() {
    const { data } = await this.admin.from("app_secrets").select("key,value").in("key", ["QBO_CLIENT_ID", "QBO_CLIENT_SECRET", "QBO_TOKENS"]);
    const m = new Map((data || []).map((r) => [r.key, r.value]));
    this.cid = String(m.get("QBO_CLIENT_ID") ?? env("QBO_CLIENT_ID")).trim();
    this.secret = String(m.get("QBO_CLIENT_SECRET") ?? env("QBO_CLIENT_SECRET")).trim();
    try { this.tok = m.get("QBO_TOKENS") ? JSON.parse(String(m.get("QBO_TOKENS"))) : null; } catch { this.tok = null; }
    return this;
  }
  get connected() { return !!(this.tok && this.tok.refresh && this.tok.realmId); }
  basic() { return "Basic " + btoa(`${this.cid}:${this.secret}`); }
  async saveTok(t: Rec | null) {
    this.tok = t;
    if (!t) await this.admin.from("app_secrets").delete().eq("key", "QBO_TOKENS");
    else await this.admin.from("app_secrets").upsert({ key: "QBO_TOKENS", value: JSON.stringify(t), updated_at: new Date().toISOString() });
  }
  async tokenCall(body: Record<string, string>) {
    const r = await fetch(TOKEN_URL, { method: "POST", headers: { Authorization: this.basic(), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (j.error === "invalid_grant") throw new QBError("The QuickBooks connection expired or was disconnected. Reconnect it in Settings → APIs.", "invalid_grant");
      if (j.error === "invalid_client") throw new QBError("QuickBooks didn't accept the Client ID and Client Secret. Check them in Settings → APIs (use the Production keys).", "invalid_client");
      throw new QBError(`QuickBooks sign-in failed: ${j.error_description || j.error || r.status}`, String(j.error || r.status));
    }
    return j;
  }
  async access(force = false) {
    if (!this.connected) throw new QBError("QuickBooks isn't connected yet. Connect it in Settings → APIs.", "not_connected");
    if (!force && this.tok!.access && Date.now() < Number(this.tok!.accessExp) - 120000) return this.tok!.access as string;
    let j: Rec;
    try { j = await this.tokenCall({ grant_type: "refresh_token", refresh_token: this.tok!.refresh }); }
    catch (e) { if ((e as QBError).code === "invalid_grant") await this.saveTok({ ...this.tok, access: "", refresh: "", lostAt: Date.now() }); throw e; }
    await this.saveTok({ ...this.tok, access: j.access_token, accessExp: Date.now() + Number(j.expires_in || 3600) * 1000, refresh: j.refresh_token || this.tok!.refresh, refreshExp: Date.now() + Number(j.x_refresh_token_expires_in || 8640000) * 1000 });
    return j.access_token as string;
  }
  async req(method: string, path: string, body?: unknown, retry = true): Promise<Rec> {
    const at = await this.access();
    const url = `${API}/v3/company/${this.tok!.realmId}/${path}${path.includes("?") ? "&" : "?"}${MINOR}`;
    const r = await fetch(url, { method, headers: { Authorization: `Bearer ${at}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && retry) { await this.access(true); return this.req(method, path, body, false); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.Fault) throw faultMsg(j, r.status);
    return j;
  }
  async query(sql: string): Promise<Rec> { const j = await this.req("GET", `query?query=${encodeURIComponent(sql)}`); return j.QueryResponse || {}; }
  async queryAll(entity: string, fields = "*", where = ""): Promise<Rec[]> {
    const out: Rec[] = [];
    for (let start = 1; start < 20000; start += 1000) {
      const q = await this.query(`select ${fields} from ${entity}${where ? " where " + where : ""} startposition ${start} maxresults 1000`);
      const rows = (q[entity] || []) as Rec[]; out.push(...rows); if (rows.length < 1000) break;
    }
    return out;
  }
}

async function state(admin: SupabaseClient, key: string) { const { data } = await admin.from("sync_state").select("value").eq("key", key).maybeSingle(); return (data?.value ?? null) as Rec | null; }
async function putState(admin: SupabaseClient, key: string, value: unknown) { await admin.from("sync_state").upsert({ key, value, updated_at: new Date().toISOString() }); }

/* ---------- invoices ---------- */
type CustInfo = { displayName: string; first: string; last: string; company: string; email: string; phone: string; street: string; city: string; state: string; zip: string };

class Pusher {
  qb: QB; admin: SupabaseClient; custs: Rec[] | null = null; items: Rec[] | null = null; incomeAcct: string | null = null; services: string[] = []; taxOff = false;
  constructor(qb: QB, admin: SupabaseClient) { this.qb = qb; this.admin = admin; }

  async customer(appId: string, appC: Rec, info: CustInfo): Promise<string> {
    if (appC?.qbo?.id) {
      try { const j = await this.qb.req("GET", `customer/${appC.qbo.id}`); if (j.Customer && j.Customer.Active !== false) return String(j.Customer.Id); } catch (e) { rethrowFatal(e); /* deleted in QuickBooks: match again */ }
    }
    if (!this.custs) this.custs = await this.qb.queryAll("Customer");
    const dn = norm(info.displayName), full = norm(`${info.first} ${info.last}`), rev = norm(`${info.last}, ${info.first}`), co = norm(info.company), em = norm(info.email);
    const active = this.custs.filter((c) => c.Active !== false);
    const hit = active.find((c) => norm(c.DisplayName) === dn) || (full && active.find((c) => norm(`${c.GivenName || ""} ${c.FamilyName || ""}`) === full || norm(c.DisplayName) === full || norm(c.DisplayName) === rev))
      || (co && active.find((c) => norm(c.CompanyName) === co || norm(c.DisplayName) === co)) || (em && active.find((c) => norm(c.PrimaryEmailAddr?.Address) === em));
    let id: string;
    if (hit) id = String(hit.Id);
    else {
      const body: Rec = { DisplayName: info.displayName.slice(0, 100) || "Customer", GivenName: info.first.slice(0, 100) || undefined, FamilyName: info.last.slice(0, 100) || undefined, CompanyName: info.company.slice(0, 100) || undefined,
        PrimaryEmailAddr: info.email ? { Address: info.email } : undefined, PrimaryPhone: info.phone ? { FreeFormNumber: info.phone } : undefined,
        BillAddr: info.street || info.city ? { Line1: info.street, City: info.city, CountrySubDivisionCode: info.state, PostalCode: info.zip } : undefined };
      let made: Rec;
      try { made = await this.qb.req("POST", "customer", body); }
      catch (e) {
        if ((e as QBError).code !== "6240") throw e; // name already used by a vendor/employee/inactive customer
        made = await this.qb.req("POST", "customer", { ...body, DisplayName: `${body.DisplayName} (customer)`.slice(0, 100) });
      }
      id = String(made.Customer.Id); this.custs.push(made.Customer);
    }
    await this.admin.from("customers").update({ data: { ...appC, qbo: { id, at: Date.now() } } }).eq("id", appId);
    return id;
  }

  async item(desc: string): Promise<string> {
    if (!this.items) this.items = (await this.qb.queryAll("Item")).filter((i) => i.Active !== false);
    const d = norm(desc);
    const svc = this.services.find((s) => norm(s) && (d === norm(s) || d.startsWith(norm(s))));
    const want = (svc || "Services").replace(/:/g, "-").slice(0, 100);
    const found = this.items.find((i) => norm(i.Name) === norm(want) && i.Type !== "Category");
    if (found) return String(found.Id);
    if (!this.incomeAcct) {
      const accts = await this.qb.queryAll("Account", "*", "AccountType = 'Income'");
      const pick = accts.find((a) => /service/i.test(a.Name)) || accts.find((a) => /sales|income/i.test(a.Name)) || accts[0];
      if (!pick) throw new QBError("QuickBooks has no income account to put services in. Add one in QuickBooks (Chart of accounts) and try again.");
      this.incomeAcct = String(pick.Id);
    }
    const made = await this.qb.req("POST", "item", { Name: want, Type: "Service", IncomeAccountRef: { value: this.incomeAcct } });
    this.items.push(made.Item); return String(made.Item.Id);
  }

  async invoice(id: string, info: CustInfo | undefined): Promise<Rec> {
    const { data: row } = await this.admin.from("invoices").select("id,data").eq("id", id).maybeSingle();
    if (!row) return { id, ok: false, error: "Invoice not found." };
    const v = row.data as Rec;
    const sub = r2((v.items || []).reduce((s: number, i: Rec) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0));
    const total = r2(sub + r2(sub * (Number(v.taxRate) || 0) / 100));
    if (v.status === "Void") {
      if (!v.qbo?.id) return { id, ok: true, skipped: "Voided, so it wasn't sent." };
      const cur = await this.qb.req("GET", `invoice/${v.qbo.id}`);
      await this.qb.req("POST", "invoice?operation=void", { Id: v.qbo.id, SyncToken: cur.Invoice.SyncToken });
      await this.admin.from("invoices").update({ data: { ...v, qbo: { ...v.qbo, voided: true, at: Date.now() } } }).eq("id", id);
      return { id, ok: true, voided: true };
    }
    const lines = (v.items || []).filter((i: Rec) => i.desc || Number(i.rate));
    if (!lines.length) return { id, ok: false, error: `Invoice #${v.number} has no service lines.` };
    const { data: cr } = await this.admin.from("customers").select("id,data").eq("id", String(v.customerId || "")).maybeSingle();
    if (!cr) return { id, ok: false, error: `Invoice #${v.number} has no customer.` };
    if (!info) return { id, ok: false, error: "Customer details were missing. Refresh the app and try again." };
    const custId = await this.customer(cr.id, cr.data as Rec, info);
    const taxed = (Number(v.taxRate) || 0) > 0;
    const build = async (withTax: boolean) => ({
      CustomerRef: { value: custId }, DocNumber: String(v.number || "").slice(0, 21), TxnDate: v.date || undefined, DueDate: v.dueDate || undefined,
      BillEmail: info.email ? { Address: info.email } : undefined,
      CustomerMemo: v.notes ? { value: String(v.notes).slice(0, 1000) } : undefined,
      PrivateNote: "Sent from the PureWash app",
      Line: await Promise.all(lines.map(async (i: Rec) => ({ DetailType: "SalesItemLineDetail", Amount: r2((Number(i.qty) || 0) * (Number(i.rate) || 0)), Description: String(i.desc || "").slice(0, 4000),
        SalesItemLineDetail: { ItemRef: { value: await this.item(String(i.desc || "")) }, Qty: Number(i.qty) || 0, UnitPrice: Number(i.rate) || 0, ...(withTax ? { TaxCodeRef: { value: taxed ? "TAX" : "NON" } } : {}) } }))),
    });
    let qbId = v.qbo?.id ? String(v.qbo.id) : "", linked = false, syncToken = "";
    if (qbId) { try { const cur = await this.qb.req("GET", `invoice/${qbId}`); syncToken = cur.Invoice.SyncToken; } catch (e) { rethrowFatal(e); qbId = ""; } }
    if (!qbId && v.number) {
      const q = await this.qb.query(`select Id, SyncToken, CustomerRef from Invoice where DocNumber = '${qs(String(v.number))}'`);
      const hit = (q.Invoice || [])[0]; if (hit) { qbId = String(hit.Id); syncToken = hit.SyncToken; linked = true; }
    }
    const send = async (withTax: boolean) => { const body = await build(withTax); return qbId ? this.qb.req("POST", "invoice", { ...body, Id: qbId, SyncToken: syncToken, sparse: true }) : this.qb.req("POST", "invoice", body); };
    let res: Rec, warn = "";
    try { res = await send(!this.taxOff); }
    catch (e) {
      if (!/tax/i.test((e as Error).message)) throw e;
      this.taxOff = true; res = await send(false);
      if (taxed) warn = "QuickBooks didn't accept the sales tax setting, so the invoice was sent without tax. Check sales tax in QuickBooks.";
    }
    const q = res.Invoice;
    if (!warn && Math.abs(r2(q.TotalAmt) - total) > 0.01) warn = `QuickBooks total is $${r2(q.TotalAmt).toFixed(2)}; the app shows $${total.toFixed(2)}. ${taxed ? "QuickBooks works out sales tax from the customer's address, so it can differ." : ""}`.trim();
    const fresh = (await this.admin.from("invoices").select("data").eq("id", id).single()).data?.data as Rec || v;
    const qbo = { id: String(q.Id), syncToken: q.SyncToken, docNumber: q.DocNumber || "", total: r2(q.TotalAmt), at: Date.now(), warning: warn || null, linked: linked || undefined };
    await this.admin.from("invoices").update({ data: { ...fresh, qbo, qbExportedAt: fresh.qbExportedAt || Date.now() } }).eq("id", id);
    const pay = await this.payments(id, []);
    return { id, ok: true, number: v.number, qboId: qbo.id, created: !v.qbo?.id && !linked, linked, warning: warn || null, paymentsSent: pay.sent || 0, paymentError: pay.error || null };
  }

  async payments(id: string, deleted: string[]): Promise<Rec> {
    const { data: row } = await this.admin.from("invoices").select("id,data").eq("id", id).maybeSingle();
    if (!row) return { id, ok: false, error: "Invoice not found." };
    const v = row.data as Rec;
    if (!v.qbo?.id) return { id, ok: true, skipped: "Not in QuickBooks yet." };
    let removed = 0;
    for (const pid of deleted || []) {
      try { const cur = await this.qb.req("GET", `payment/${pid}`); await this.qb.req("POST", "payment?operation=delete", { Id: pid, SyncToken: cur.Payment.SyncToken }); removed++; }
      catch (e) { rethrowFatal(e); if (!/not found|deleted|6240|610/i.test((e as Error).message)) return { id, ok: false, error: "Couldn't remove the payment in QuickBooks: " + (e as Error).message }; }
    }
    const pays = [...(v.payments || [])] as Rec[];
    const todo = pays.map((p, i) => ({ p, i })).filter(({ p }) => !p.qboId && Number(p.amount) > 0);
    if (!todo.length) return { id, ok: true, sent: 0, removed };
    const { data: cr } = await this.admin.from("customers").select("data").eq("id", String(v.customerId || "")).maybeSingle();
    let custId = (cr?.data as Rec)?.qbo?.id;
    if (!custId) { const inv = await this.qb.req("GET", `invoice/${v.qbo.id}`); custId = inv.Invoice.CustomerRef.value; }
    let sent = 0, error = "";
    for (const { p, i } of todo) {
      try {
        const made = await this.qb.req("POST", "payment", { CustomerRef: { value: String(custId) }, TotalAmt: r2(p.amount), TxnDate: p.date || undefined, PaymentRefNum: String(p.ref || "").slice(0, 21) || undefined,
          PrivateNote: `${p.method || "Payment"} recorded in the PureWash app`, Line: [{ Amount: r2(p.amount), LinkedTxn: [{ TxnId: String(v.qbo.id), TxnType: "Invoice" }] }] });
        pays[i] = { ...p, qboId: String(made.Payment.Id) }; sent++;
      } catch (e) { rethrowFatal(e); error = (e as Error).message; break; }
    }
    const fresh = (await this.admin.from("invoices").select("data").eq("id", id).single()).data?.data as Rec || v;
    const fp = [...(fresh.payments || [])] as Rec[];
    for (const p of pays) { if (!p.qboId) continue; const k = fp.findIndex((x) => !x.qboId && Number(x.amount) === Number(p.amount) && x.date === p.date && (x.ref || "") === (p.ref || "")); if (k >= 0) fp[k] = { ...fp[k], qboId: p.qboId }; }
    await this.admin.from("invoices").update({ data: { ...fresh, payments: fp } }).eq("id", id);
    return { id, ok: !error, sent, removed, error: error || null };
  }
}

/* ---------- payments made in QuickBooks ---------- */
async function pull(qb: QB, admin: SupabaseClient) {
  const st = (await state(admin, "qbo:sync")) || {};
  const since = new Date(String(st.since || new Date(Number(qb.tok?.connectedAt) || Date.now()).toISOString())).toISOString().replace(/\.\d{3}Z$/, "Z");
  const pays = await qb.queryAll("Payment", "*", `MetaData.LastUpdatedTime > '${since}'`);
  let maxT = since, added = 0, updated = 0;
  const methods = new Map<string, string>();
  for (const p of pays) {
    const t = p.MetaData?.LastUpdatedTime ? new Date(String(p.MetaData.LastUpdatedTime)).toISOString() : ""; if (t && Date.parse(t) > Date.parse(maxT)) maxT = t;
    for (const line of p.Line || []) {
      for (const lt of line.LinkedTxn || []) {
        if (lt.TxnType !== "Invoice") continue;
        const { data: rows } = await admin.from("invoices").select("id,data").eq("data->qbo->>id", String(lt.TxnId)).limit(1);
        const row = rows && rows[0]; if (!row) continue;
        const v = row.data as Rec; const list = [...(v.payments || [])] as Rec[];
        const k = list.findIndex((x) => String(x.qboId || "") === String(p.Id));
        let method = "QuickBooks";
        if (p.PaymentMethodRef?.value) { const mk = String(p.PaymentMethodRef.value); if (!methods.has(mk)) { try { const m = await qb.req("GET", `paymentmethod/${mk}`); methods.set(mk, String(m.PaymentMethod?.Name || "QuickBooks")); } catch { methods.set(mk, "QuickBooks"); } } method = methods.get(mk)!; }
        if (k >= 0) {
          if (r2(list[k].amount) === r2(line.Amount) && list[k].date === p.TxnDate) continue;
          list[k] = { ...list[k], amount: r2(line.Amount), date: p.TxnDate }; updated++;
        } else { list.push({ amount: r2(line.Amount), date: p.TxnDate, method, ref: String(p.PaymentRefNum || ""), qboId: String(p.Id), source: "quickbooks", at: Date.now() }); added++; }
        await admin.from("invoices").update({ data: { ...v, payments: list, status: v.status === "Draft" ? "Sent" : v.status, updatedAt: Date.now() } }).eq("id", row.id);
      }
    }
  }
  await putState(admin, "qbo:sync", { ...st, since: maxT, lastPull: Date.now(), lastError: null, lastAdded: added });
  return { ok: true, added, updated };
}

/* ---------- connect ---------- */
async function callback(url: URL, admin: SupabaseClient) {
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `${APP}/?${q}` } });
  const err = url.searchParams.get("error");
  if (err) return back(`qbo=error&msg=${encodeURIComponent(err === "access_denied" ? "The connection was cancelled in QuickBooks." : "QuickBooks returned: " + err)}`);
  const code = url.searchParams.get("code") || "", st = url.searchParams.get("state") || "", realm = url.searchParams.get("realmId") || "";
  const saved = await state(admin, "qbo:oauth");
  if (!saved || saved.state !== st || Date.now() > Number(saved.exp)) return back(`qbo=error&msg=${encodeURIComponent("That connection attempt expired. Click Connect again.")}`);
  await putState(admin, "qbo:oauth", null);
  const qb = await new QB(admin).load();
  try {
    const j = await qb.tokenCall({ grant_type: "authorization_code", code, redirect_uri: REDIRECT() });
    await qb.saveTok({ realmId: realm, access: j.access_token, accessExp: Date.now() + Number(j.expires_in || 3600) * 1000, refresh: j.refresh_token, refreshExp: Date.now() + Number(j.x_refresh_token_expires_in || 8640000) * 1000, connectedAt: Date.now(), connectedBy: saved.uid });
    let company = "";
    try { const ci = await qb.req("GET", `companyinfo/${realm}`); company = String(ci.CompanyInfo?.CompanyName || ""); } catch (_) { /* name is optional */ }
    await qb.saveTok({ ...qb.tok, company });
    await putState(admin, "qbo:sync", { since: new Date().toISOString(), lastPull: null, lastError: null });
    await admin.from("activity").insert({ user_id: saved.uid, tbl: "settings", row_id: "api", action: "update", summary: `Connected QuickBooks${company ? " (" + company + ")" : ""}` });
    return back("qbo=connected");
  } catch (e) {
    return back(`qbo=error&msg=${encodeURIComponent((e as Error).message)}`);
  }
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
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "status");

    if (req.headers.get("x-sync-token") === SYNC_TOKEN) {
      const qb = await new QB(admin).load();
      if (!qb.connected) return json({ skipped: "not connected" });
      try { return json(await pull(qb, admin)); }
      catch (e) { const st = (await state(admin, "qbo:sync")) || {}; await putState(admin, "qbo:sync", { ...st, lastPull: Date.now(), lastError: (e as Error).message }); return json({ error: (e as Error).message }, 502); }
    }

    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: "Your sign-in expired. Sign in again." }, 401);
    const { data: me } = await admin.from("profiles").select("role,active").eq("id", user.id).single();
    if (!me || !me.active || !(me.role === "owner" || me.role === "office")) return json({ error: "Only the owner and office can use QuickBooks." }, 403);
    const owner = me.role === "owner";
    const qb = await new QB(admin).load();

    if (action === "status") {
      const st = await state(admin, "qbo:sync");
      return json({ ok: true, keys: !!(qb.cid && qb.secret), connected: qb.connected, lost: !!(qb.tok && !qb.tok.refresh && qb.tok.lostAt), company: qb.tok?.company || "", realmId: qb.tok?.realmId || "",
        connectedAt: qb.tok?.connectedAt || null, refreshExp: qb.tok?.refreshExp || null, lastPull: st?.lastPull || null, lastError: st?.lastError || null, redirectUri: REDIRECT() });
    }
    if (action === "connect") {
      if (!owner) return json({ error: "Only the owner can connect QuickBooks." }, 403);
      if (!qb.cid || !qb.secret) return json({ error: "Enter the Client ID and Client Secret first." }, 400);
      const s = hex(20);
      await putState(admin, "qbo:oauth", { state: s, uid: user.id, exp: Date.now() + 15 * 60000 });
      const u = `${AUTH_URL}?${new URLSearchParams({ client_id: qb.cid, response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: REDIRECT(), state: s })}`;
      return json({ ok: true, url: u });
    }
    if (action === "disconnect") {
      if (!owner) return json({ error: "Only the owner can disconnect QuickBooks." }, 403);
      if (qb.tok?.refresh) { try { await fetch(REVOKE_URL, { method: "POST", headers: { Authorization: qb.basic(), Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ token: qb.tok.refresh }) }); } catch (_) { /* local disconnect still happens */ } }
      await qb.saveTok(null);
      await admin.from("activity").insert({ user_id: user.id, tbl: "settings", row_id: "api", action: "update", summary: "Disconnected QuickBooks" });
      return json({ ok: true });
    }
    if (action === "test") {
      const checks: Rec[] = [];
      checks.push({ label: "Client ID and Client Secret entered", ok: !!(qb.cid && qb.secret), fix: qb.cid && qb.secret ? undefined : "Copy them from the Intuit Developer portal (Keys & credentials → Production) and save them here." });
      if (qb.cid && qb.secret) {
        if (!qb.connected) checks.push({ label: qb.tok?.lostAt ? "The QuickBooks connection was lost" : "QuickBooks isn't connected yet", ok: false, fix: "Click Connect to QuickBooks and approve access as a QuickBooks admin." });
        else {
          try { const ci = await qb.req("GET", `companyinfo/${qb.tok!.realmId}`); checks.push({ label: `Connected to ${ci.CompanyInfo?.CompanyName || "your QuickBooks company"}`, ok: true });
            const pr = await qb.req("GET", `preferences`); const custom = pr.Preferences?.SalesFormsPrefs?.CustomTxnNumbers;
            checks.push({ label: custom ? "Custom invoice numbers are on, so QuickBooks keeps the app's invoice numbers" : "QuickBooks will number invoices itself", ok: custom ? true : null, fix: custom ? undefined : "To keep the app's invoice numbers, turn on Custom transaction numbers in QuickBooks → Settings → Account and settings → Sales." });
            const tax = pr.Preferences?.TaxPrefs?.UsingSalesTax;
            checks.push({ label: tax ? "Sales tax is set up in QuickBooks" : "Sales tax isn't set up in QuickBooks", ok: tax ? true : null, detail: tax ? "QuickBooks works out tax from each customer's address, so totals can differ slightly from the app." : undefined, fix: tax ? undefined : "If you charge sales tax, set it up in QuickBooks → Taxes. Until then invoices go over without tax." });
          } catch (e) { checks.push({ label: "QuickBooks didn't respond normally", ok: false, detail: (e as Error).message, fix: "Reconnect QuickBooks below." }); }
          const st = await state(admin, "qbo:sync");
          if (st?.lastPull) { const m = Math.round((Date.now() - st.lastPull) / 60000); const okp = m <= 20 && !st.lastError;
            checks.push({ label: okp ? `Payment sync is running (last check ${m <= 1 ? "just now" : m + " min ago"})` : st.lastError ? "The last payment sync failed" : `Payment sync hasn't run for ${m} minutes`, ok: okp, detail: st.lastError || undefined, fix: okp ? undefined : "Click Check for QuickBooks payments. If it fails, reconnect QuickBooks." }); }
        }
      }
      const result = { at: Date.now(), ok: !checks.some((c) => c.ok === false), checks };
      await putState(admin, "test:qbo", result);
      return json({ ok: true, result });
    }
    if (action === "pull") {
      try { return json(await pull(qb, admin)); }
      catch (e) { const st = (await state(admin, "qbo:sync")) || {}; await putState(admin, "qbo:sync", { ...st, lastPull: Date.now(), lastError: (e as Error).message }); return json({ error: (e as Error).message }, 502); }
    }
    if (action === "push" || action === "payments") {
      if (!qb.connected) return json({ error: "QuickBooks isn't connected. The owner can connect it in Settings → APIs." }, 400);
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 100);
      if (!ids.length) return json({ error: "No invoices chosen." }, 400);
      const p = new Pusher(qb, admin);
      const { data: st } = await admin.from("settings").select("data").eq("id", "app").maybeSingle();
      p.services = ((st?.data as Rec)?.services || []).map((s: Rec) => String(s.name || "")).filter(Boolean).sort((a: string, b: string) => b.length - a.length);
      const results: Rec[] = [];
      for (const id of ids) {
        try { results.push(action === "push" ? await p.invoice(id, (body.customers || {})[id]) : await p.payments(id, (body.deleted || {})[id] || [])); }
        catch (e) {
          results.push({ id, ok: false, error: (e as Error).message });
          if (FATAL.includes((e as QBError).code)) break;
        }
      }
      return json({ ok: true, results });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || "Something went wrong talking to QuickBooks.", detail: String(e).slice(0, 200) }, 500);
  }
});
