import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const ROLES = ["owner", "office", "crew"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: "Your sign-in expired. Sign in again." }, 401);
    const { data: me } = await admin.from("profiles").select("role,active").eq("id", user.id).single();
    if (!me || !me.active || me.role !== "owner") return json({ error: "Only the owner can manage the team." }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === "create") {
      const email = String(body.email || "").trim().toLowerCase();
      const name = String(body.name || "").trim();
      const role = String(body.role || "crew");
      const password = String(body.password || "");
      if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
      if (!ROLES.includes(role)) return json({ error: "Choose a role." }, 400);
      if (password.length < 8) return json({ error: "The temporary password needs at least 8 characters." }, 400);
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        app_metadata: { role, full_name: name },
        user_metadata: { full_name: name },
      });
      if (error || !data.user) return json({ error: error?.message?.includes("already") ? "Someone with that email already has an account." : (error?.message || "Could not create the account.") }, 400);
      await admin.from("profiles").upsert({ id: data.user.id, email, full_name: name, role, active: true });
      return json({ ok: true, id: data.user.id });
    }

    if (action === "update") {
      const id = String(body.id || "");
      const patch: Record<string, unknown> = {};
      if (body.role !== undefined) { if (!ROLES.includes(body.role)) return json({ error: "Unknown role." }, 400); patch.role = body.role; }
      if (body.active !== undefined) patch.active = !!body.active;
      if (body.name !== undefined) patch.full_name = String(body.name).trim();
      if (id === user.id && (patch.role && patch.role !== "owner" || patch.active === false)) {
        const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "owner").eq("active", true);
        if ((count || 0) <= 1) return json({ error: "You're the only owner. Make someone else an owner first." }, 400);
      }
      const { error } = await admin.from("profiles").update(patch).eq("id", id);
      if (error) return json({ error: error.message }, 400);
      if (patch.active !== undefined) await admin.auth.admin.updateUserById(id, { ban_duration: patch.active ? "none" : "876000h" });
      return json({ ok: true });
    }

    if (action === "password") {
      const id = String(body.id || "");
      const password = String(body.password || "");
      if (password.length < 8) return json({ error: "The password needs at least 8 characters." }, 400);
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: "Something went wrong on the server.", detail: String(e).slice(0, 200) }, 500);
  }
});
