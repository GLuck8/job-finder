// rescore-jobs: re-runs the ranking for jobs already in the table, against the career
// bank as it stands now.
//
// Why this exists: a job was scored once, when it arrived, and never again. So improving
// the career bank changed nothing about any job already found. Glenn confirmed eight
// technical facts at 09:34 and the last sweep had scored at 09:07, which left a whole
// dashboard of scores describing a version of him from before he had written any code.
//
// Takes either an explicit list of job ids, or a filter. Reports the old score next to
// the new one so the effect of a career bank change is visible rather than assumed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { callClaude, fence, loadPrompt, loadRates, newRunId } from "./llm.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const expectRanking = (p: any) => {
  if (!p || typeof p !== "object") return "reply was not an object";
  if (p.fit_score === undefined || Number.isNaN(Number(p.fit_score))) return "no numeric fit_score";
  return null;
};

// Identical to the sweep's preference scoring. Deterministic, no model involved, so a
// rescore moves the fit half only and the preference half stays comparable.
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
  const days = job.closing_date ? (new Date(job.closing_date).getTime() - Date.now()) / 86400000 : null;
  parts.timing = days === null ? 10 : days < 0 ? 0 : days < 2 ? 5 : 10;
  parts.keywords = (prefs.keywords ?? []).some((k: string) => text.toLowerCase().includes(k.toLowerCase())) ? 5 : 0;
  const hay = `${text} ${job.title} ${job.employer}`.toLowerCase();
  const flags = (prefs.red_flag_phrases ?? []).filter((p: string) => p && hay.includes(p.toLowerCase()));
  parts.red_flags = -10 * flags.length;
  const excluded = (prefs.excluded_employers ?? []).some((e: string) => e && norm(job.employer).includes(norm(e)));
  return { total: excluded ? 0 : clamp(Object.values(parts).reduce((a, b) => a + b, 0)), parts: { ...parts, excluded }, flags };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!Deno.env.get("ANTHROPIC_API_KEY")) return json({ error: "ANTHROPIC_API_KEY secret is not set." }, 500);

  const cronSecret = Deno.env.get("CRON_SECRET");
  const fromCron = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;
  const authHeader = req.headers.get("Authorization");
  if (!fromCron && !authHeader) return json({ error: "Not authorised." }, 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    fromCron ? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! : (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!),
    { global: fromCron ? {} : { headers: { Authorization: authHeader! } }, db: { schema: "jobs" } },
  );

  let owner: string | null = null;
  if (fromCron) {
    const { data } = await supabase.from("preferences").select("owner_id").limit(1).maybeSingle();
    owner = data?.owner_id ?? null;
  } else {
    const { data: { user } } = await supabase.auth.getUser();
    owner = user?.id ?? null;
  }
  if (!owner) return json({ error: "No owner found." }, 400);

  let body: { job_ids?: string[]; visible_only?: boolean; limit?: number; dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const cap = Math.min(Number(body.limit ?? 25), 60);

  const { data: prefs } = await supabase.from("preferences").select("*").eq("owner_id", owner).maybeSingle();
  if (!prefs) return json({ error: "No preferences saved." }, 400);

  // Which jobs. An explicit list wins; otherwise the visible ones, worst score first,
  // because those are the ones most likely to be wrong after a career bank change.
  let query = supabase
    .from("jobs")
    .select("id, title, employer, location, work_mode, employment_type, salary_min, salary_max, salary_is_estimate, closing_date, description, description_status")
    .eq("owner_id", owner);
  if (body.job_ids?.length) query = query.in("id", body.job_ids);
  else if (body.visible_only !== false) query = query.eq("hidden", false);
  const { data: jobs, error: jobsErr } = await query.limit(cap);
  if (jobsErr) return json({ error: jobsErr.message }, 500);
  if (!jobs?.length) return json({ ok: true, rescored: 0, note: "Nothing matched." });

  const { data: before } = await supabase
    .from("job_scores").select("job_id, fit_score, total_score")
    .in("job_id", jobs.map((j) => j.id));
  const priorByJob = new Map((before ?? []).map((s) => [s.job_id, s]));

  if (body.dry_run) {
    return json({
      ok: true, dry_run: true, would_rescore: jobs.length,
      titles: jobs.map((j) => j.title),
    });
  }

  let prompt, rates;
  try {
    [prompt, rates] = await Promise.all([loadPrompt(supabase, "rank_job"), loadRates(supabase)]);
  } catch (e) {
    return json({ error: String((e as Error).message) }, 500);
  }

  // The career bank as it stands RIGHT NOW. This is the whole point of the function.
  const [{ data: roles }, { data: facts }] = await Promise.all([
    supabase.from("roles").select("employer, title, start_date, end_date").eq("owner_id", owner),
    supabase.from("facts").select("text, metric").eq("owner_id", owner).eq("verified", true).limit(300),
  ]);
  const candidate = `ROLES:\n${JSON.stringify(roles ?? [])}\n\nCONFIRMED FACTS:\n${(facts ?? []).map((f) => `- ${f.text}${f.metric ? ` [${f.metric}]` : ""}`).join("\n")}`;

  const runId = newRunId();
  const results: any[] = [];
  let failed = 0;

  for (const job of jobs) {
    const text = (job.description ?? "").slice(0, 40000);
    if (text.length < 80) { results.push({ title: job.title, skipped: "no stored ad text" }); continue; }

    const call = await callClaude({
      db: supabase, prompt, rates,
      content: [
        candidate,
        "",
        `The job advertisement follows, as ${job.description_status === "full" ? "the full ad" : "a short snippet only"}.`,
        fence("JOB_AD", text),
        "",
        "Assess it now.",
      ].join("\n"),
      feature: "rescore_job", ownerId: owner, runId, jobId: job.id, expect: expectRanking,
    });
    if (!call.ok) { failed++; results.push({ title: job.title, error: call.status }); continue; }
    const a = call.data as any;

    const shaped = {
      title: job.title, employer: job.employer,
      work_mode: a.work_mode ?? job.work_mode ?? "unknown",
      employment_type: a.employment_type ?? job.employment_type ?? "unknown",
      salary_min: job.salary_min ?? a.salary_min ?? null,
      salary_max: job.salary_max ?? a.salary_max ?? null,
      salary_is_estimate: job.salary_is_estimate,
      closing_date: job.closing_date,
    };
    const pref = preferenceScore(shaped, prefs, text);
    const fit = clamp(Number(a.fit_score) || 0);
    const w = Number(prefs.fit_weight ?? 0.6);
    const total = Math.round(fit * w + pref.total * (1 - w));

    await supabase.from("job_scores").upsert({
      job_id: job.id, owner_id: owner, fit_score: fit, preference_score: Math.round(pref.total),
      total_score: total, fit_reason: a.fit_reason, preference_breakdown: pref.parts,
      gaps: a.gaps ?? [], red_flags: [...(a.red_flags ?? []), ...pref.flags],
      model: prompt.model, scored_at: new Date().toISOString(),
    }, { onConflict: "job_id" });

    const prior = priorByJob.get(job.id);
    results.push({
      title: job.title,
      employer: job.employer,
      fit_before: prior?.fit_score ?? null,
      fit_after: fit,
      total_before: prior?.total_score ?? null,
      total_after: total,
      moved: prior?.total_score != null ? total - prior.total_score : null,
    });
  }

  results.sort((x, y) => (y.total_after ?? -1) - (x.total_after ?? -1));
  return json({
    ok: true, run_id: runId, prompt: `${prompt.id} v${prompt.version}`,
    rescored: results.length - failed, failed, results,
  });
});
