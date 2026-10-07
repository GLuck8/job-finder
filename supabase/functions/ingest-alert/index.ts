// ingest-alert: receives the text of a job alert email (sent by a Google Apps Script
// running in the user's own Gmail), pulls the listings out of it, and scores them.
//
// Two prompts, both from jobs.active_prompts: extract_alert_listings (cheap, Haiku,
// transcription only) then rank_job for each listing. Both are logged under one run_id,
// so a single sweep can be costed as a unit.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { callClaude, fence, loadPrompt, loadRates, newRunId } from "./llm.ts";

const MAX_PER_EMAIL = 20;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

const expectListings = (p: any) => {
  if (!p || typeof p !== "object") return "reply was not an object";
  if (!Array.isArray(p.jobs)) return "jobs was not a list";
  return null;
};
const expectRanking = (p: any) => {
  if (!p || typeof p !== "object") return "reply was not an object";
  if (p.fit_score === undefined || Number.isNaN(Number(p.fit_score))) return "no numeric fit_score";
  return null;
};

function preferenceScore(job: any, prefs: any, text: string) {
  const parts: Record<string, number> = {};
  parts.work_mode = (prefs.work_modes ?? []).includes(job.work_mode) ? 35 : job.work_mode === "unknown" ? 12 : 0;
  const floor = prefs.salary_floor ?? 0, target = prefs.salary_target ?? floor;
  const pay = job.salary_max ?? job.salary_min;
  if (!pay) parts.salary = 12;
  else if (pay >= target) parts.salary = 30;
  else if (pay >= floor) parts.salary = 15 + 15 * ((pay - floor) / Math.max(1, target - floor));
  else parts.salary = clamp(15 * (pay / Math.max(1, floor)), 0, 15);
  if (job.salary_is_estimate) parts.salary *= 0.85;
  parts.employment_type = (prefs.employment_types ?? []).includes(job.employment_type) ? 20 : job.employment_type === "unknown" ? 10 : 4;
  parts.timing = 10;
  parts.keywords = (prefs.keywords ?? []).some((k: string) => text.toLowerCase().includes(k.toLowerCase())) ? 5 : 0;
  const hay = `${text} ${job.title} ${job.employer}`.toLowerCase();
  const flags = (prefs.red_flag_phrases ?? []).filter((p: string) => p && hay.includes(p.toLowerCase()));
  parts.red_flags = -10 * flags.length;
  const excluded = (prefs.excluded_employers ?? []).some((e: string) => e && norm(job.employer).includes(norm(e)));
  return { total: excluded ? 0 : clamp(Object.values(parts).reduce((a, b) => a + b, 0)), parts: { ...parts, excluded }, flags };
}

function salaryFromText(s: string | null) {
  if (!s) return { min: null, max: null };
  const nums = [...s.matchAll(/\$\s?([\d,]+)(?:\s?k)?/gi)].map((m) => {
    let n = Number(m[1].replace(/,/g, ""));
    if (/k/i.test(m[0])) n *= 1000;
    return n < 1000 ? n * 1000 : n;
  }).filter((n) => n > 20000 && n < 500000);
  if (!nums.length) return { min: null, max: null };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!Deno.env.get("ANTHROPIC_API_KEY")) return json({ error: "ANTHROPIC_API_KEY secret is not set." }, 500);
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) return json({ error: "Not authorised." }, 401);

  let body: { source?: string; emails?: { subject?: string; body: string }[] };
  try { body = await req.json(); } catch { return json({ error: "Send { source, emails: [{ subject, body }] }." }, 400); }
  const emails = (body.emails ?? []).filter((e) => e?.body);
  if (!emails.length) return json({ ok: true, note: "No emails supplied.", added: 0 });
  const source = ["seek", "linkedin", "careers_vic", "indeed", "other"].includes(body.source ?? "") ? body.source! : "other";

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "jobs" } });
  const { data: everyone } = await supabase.from("preferences").select("*");
  const prefs = everyone?.[0];
  if (!prefs) return json({ error: "No preferences saved yet." }, 400);
  const owner = prefs.owner_id;

  let extractPrompt, rankPrompt, rates;
  try {
    [extractPrompt, rankPrompt, rates] = await Promise.all([
      loadPrompt(supabase, "extract_alert_listings"),
      loadPrompt(supabase, "rank_job"),
      loadRates(supabase),
    ]);
  } catch (e) {
    return json({ error: String((e as Error).message) }, 500);
  }
  const runId = newRunId();

  const { data: run } = await supabase.from("ingestion_runs").insert({ owner_id: owner, source: `${source}-email` }).select().single();
  const [{ data: roles }, { data: facts }] = await Promise.all([
    supabase.from("roles").select("employer, title, start_date, end_date").eq("owner_id", owner),
    supabase.from("facts").select("text, metric").eq("owner_id", owner).eq("verified", true).limit(300),
  ]);
  const candidate = `ROLES:\n${JSON.stringify(roles ?? [])}\n\nCONFIRMED FACTS:\n${(facts ?? []).map((f) => `- ${f.text}${f.metric ? ` [${f.metric}]` : ""}`).join("\n")}`;

  const listings: any[] = [];
  for (const email of emails) {
    const call = await callClaude({
      db: supabase, prompt: extractPrompt, rates,
      content: `An alert email follows. The subject line was: ${email.subject ?? "(none)"}\n${fence("EMAIL", email.body.slice(0, 40000))}\n\nList every job in it.`,
      feature: "extract_alert_listings", ownerId: owner, runId, expect: expectListings,
    });
    if (call.ok) listings.push(...((call.data as any).jobs ?? []));
  }

  const { data: existing } = await supabase.from("jobs").select("id, dedupe_key").eq("owner_id", owner);
  const known = new Map((existing ?? []).map((j) => [j.dedupe_key, j.id]));
  let added = 0, failed = 0;

  for (const l of listings.slice(0, MAX_PER_EMAIL)) {
    if (!l.title || !l.employer) continue;
    const dedupe = `${norm(l.employer)}|${norm(l.title)}`;
    if (known.has(dedupe)) {
      await supabase.from("jobs").update({ last_seen: new Date().toISOString() }).eq("id", known.get(dedupe));
      if (l.url) await supabase.from("job_listings").upsert({ owner_id: owner, job_id: known.get(dedupe), source, url: l.url }, { onConflict: "owner_id,source,url" });
      continue;
    }
    const text = `${l.title} at ${l.employer}, ${l.location ?? ""}. ${l.salary_text ?? ""} ${l.teaser ?? ""}`;

    const call = await callClaude({
      db: supabase, prompt: rankPrompt, rates,
      content: `${candidate}\n\nThe job advertisement follows, as a short listing snippet only.\n${fence("JOB_AD", text)}\n\nAssess it now.`,
      feature: "rank_job", ownerId: owner, runId, maxTokens: 1500, expect: expectRanking,
    });
    if (!call.ok) { failed++; continue; }
    const a = call.data as any;

    const stated = salaryFromText(l.salary_text);
    const job = {
      title: l.title, employer: l.employer, location: l.location ?? "Melbourne",
      work_mode: a.work_mode ?? "unknown", employment_type: a.employment_type ?? "unknown",
      salary_min: stated.min ?? a.salary_min ?? null, salary_max: stated.max ?? a.salary_max ?? null,
      salary_is_estimate: !stated.min, salary_basis: stated.min ? null : a.salary_basis, closing_date: null,
    };
    const pref = preferenceScore(job, prefs, text);
    const fit = clamp(Number(a.fit_score) || 0);
    const w = Number(prefs.fit_weight ?? 0.6);

    const { data: saved, error } = await supabase.from("jobs").upsert({
      owner_id: owner, dedupe_key: dedupe, ...job, employer_size: a.employer_size ?? "unknown",
      description: text, description_status: "snippet", last_seen: new Date().toISOString(),
    }, { onConflict: "owner_id,dedupe_key" }).select().single();
    if (error || !saved) continue;
    known.set(dedupe, saved.id);
    if (l.url) await supabase.from("job_listings").upsert({ owner_id: owner, job_id: saved.id, source, url: l.url }, { onConflict: "owner_id,source,url" });

    await supabase.from("job_scores").upsert({
      job_id: saved.id, owner_id: owner, fit_score: fit, preference_score: Math.round(pref.total),
      total_score: Math.round(fit * w + pref.total * (1 - w)), fit_reason: a.fit_reason,
      preference_breakdown: pref.parts, gaps: a.gaps ?? [], red_flags: [...(a.red_flags ?? []), ...pref.flags],
      model: rankPrompt.model, scored_at: new Date().toISOString(),
    }, { onConflict: "job_id" });
    added++;
  }

  if (run) {
    await supabase.from("ingestion_runs").update({
      finished_at: new Date().toISOString(), found: listings.length, new_jobs: added,
      errors: failed ? `failed calls: ${failed}` : null,
    }).eq("id", run.id);
  }
  return json({ ok: true, run_id: runId, emails: emails.length, listings: listings.length, added, failed_calls: failed });
});
