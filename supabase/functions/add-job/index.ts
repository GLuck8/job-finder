// add-job: reads a job ad (from a URL or pasted text), stores it, and scores it
// against the career bank and the saved preferences.
//
// Uses the same rank_job prompt as the automatic sweep, read from jobs.active_prompts,
// so a job added by hand is judged by exactly the same rubric as one found by the cron.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { callClaude, fence, loadPrompt, loadRates, newRunId } from "./llm.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sourceOf = (url: string) => {
  const u = (url ?? "").toLowerCase();
  if (u.includes("seek.com")) return "seek";
  if (u.includes("linkedin.com")) return "linkedin";
  if (u.includes("careers.vic.gov.au")) return "careers_vic";
  if (u.includes("indeed.com")) return "indeed";
  return u ? "other" : "manual";
};

// A job added by hand has no title or employer of its own yet, so the reply must carry them.
const expectRanking = (p: any) => {
  if (!p || typeof p !== "object") return "reply was not an object";
  if (!p.title || !p.employer) return "reply had no title or employer";
  if (p.fit_score === undefined || Number.isNaN(Number(p.fit_score))) return "no numeric fit_score";
  if (p.criteria !== undefined && !Array.isArray(p.criteria)) return "criteria was not a list";
  return null;
};

// Preference score: transparent, rule-based, so the dashboard can explain itself.
function preferenceScore(job: any, prefs: any, text: string) {
  const parts: Record<string, number> = {};
  const modes: string[] = prefs.work_modes ?? [];
  parts.work_mode = modes.includes(job.work_mode) ? 35 : job.work_mode === "unknown" ? 12 : 0;

  const floor = prefs.salary_floor ?? 0;
  const target = prefs.salary_target ?? floor;
  const pay = job.salary_max ?? job.salary_min;
  if (!pay) parts.salary = 12;
  else if (pay >= target) parts.salary = 30;
  else if (pay >= floor) parts.salary = 15 + 15 * ((pay - floor) / Math.max(1, target - floor));
  else parts.salary = clamp(15 * (pay / Math.max(1, floor)), 0, 15);
  if (job.salary_is_estimate) parts.salary *= 0.85;

  const types: string[] = prefs.employment_types ?? [];
  parts.employment_type = types.includes(job.employment_type) ? 20 : job.employment_type === "unknown" ? 10 : 4;

  const closing = job.closing_date ? new Date(job.closing_date) : null;
  const days = closing ? (closing.getTime() - Date.now()) / 86400000 : null;
  parts.timing = days === null ? 10 : days < 0 ? 0 : days < 2 ? 5 : 10;

  parts.keywords = 5 * ((prefs.keywords ?? []).filter((k: string) => text.toLowerCase().includes(k.toLowerCase())).length ? 1 : 0);

  const hay = `${text} ${job.title} ${job.employer}`.toLowerCase();
  const flags = (prefs.red_flag_phrases ?? []).filter((p: string) => p && hay.includes(p.toLowerCase()));
  parts.red_flags = -10 * flags.length;

  const excluded = (prefs.excluded_employers ?? []).some((e: string) => e && norm(job.employer).includes(norm(e)));
  const total = excluded ? 0 : clamp(Object.values(parts).reduce((a, b) => a + b, 0));
  return { total, parts: { ...parts, excluded }, matched_flags: flags };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!Deno.env.get("ANTHROPIC_API_KEY")) return json({ error: "ANTHROPIC_API_KEY secret is not set in Supabase." }, 500);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization")! } }, db: { schema: "jobs" } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "Not signed in." }, 401);

  let body: { url?: string; text?: string; job_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Send { url } or { text }." }, 400); }

  const { data: prefs } = await supabase.from("preferences").select("*").eq("owner_id", user.id).maybeSingle();
  if (!prefs) return json({ error: "Set your preferences first, on the Preferences tab." }, 400);

  // Get the ad text
  let text = (body.text ?? "").trim();
  const url = (body.url ?? "").trim();
  if (!text && url) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "accept-language": "en-AU,en" } });
      if (r.ok) {
        const html = await r.text();
        text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
      }
    } catch { /* fall through to the paste message */ }
  }
  if (text.length < 300) {
    return json({ error: "Couldn't read that page (Seek and LinkedIn block automated reads). Paste the ad text into the box instead." }, 422);
  }
  text = text.slice(0, 60000);

  // Candidate evidence: confirmed facts only
  const [{ data: roles }, { data: facts }, { data: projects }] = await Promise.all([
    supabase.from("roles").select("employer, title, start_date, end_date, is_current"),
    supabase.from("facts").select("text, kind, metric").eq("verified", true).limit(300),
    supabase.from("portfolio_projects").select("name, client, sector, outcome").limit(50),
  ]);
  const candidate = `ROLES:\n${JSON.stringify(roles ?? [])}\n\nCONFIRMED FACTS:\n${(facts ?? []).map((f) => `- ${f.text}${f.metric ? ` [${f.metric}]` : ""}`).join("\n")}\n\nPROJECTS:\n${JSON.stringify(projects ?? [])}`;
  const prefSummary = `PREFERENCES: based in ${prefs.home_location ?? "Melbourne"}; wants ${(prefs.work_modes ?? []).join(" or ")}; salary floor ${prefs.salary_floor ?? "n/a"}, target ${prefs.salary_target ?? "n/a"}; prefers ${(prefs.employment_types ?? []).join(", ")}.`;

  let prompt, rates;
  try {
    [prompt, rates] = await Promise.all([loadPrompt(supabase, "rank_job"), loadRates(supabase)]);
  } catch (e) {
    return json({ error: String((e as Error).message) }, 500);
  }

  const call = await callClaude({
    db: supabase, prompt, rates,
    // The ad is the only untrusted part, so it is the only part inside the markers.
    content: `${candidate}\n\n${prefSummary}\n\nThe job advertisement follows.\n${fence("JOB_AD", text)}\n\nAssess it now. Include the title, employer and location you read from the ad.`,
    feature: "add_job", ownerId: user.id, runId: newRunId(), expect: expectRanking,
  });
  if (!call.ok) {
    return json({ error: call.message ?? "Couldn't read the assessment. Try again." }, 502);
  }
  const a = call.data as any;

  const pref = preferenceScore(a, prefs, text);
  const fit = clamp(Number(a.fit_score) || 0);
  const w = Number(prefs.fit_weight ?? 0.6);
  const total = Math.round(fit * w + pref.total * (1 - w));

  const dedupe = `${norm(a.employer)}|${norm(a.title)}`;
  const { data: job, error: jobErr } = await supabase.from("jobs").upsert({
    owner_id: user.id, dedupe_key: dedupe, title: a.title, employer: a.employer,
    employer_size: a.employer_size, location: a.location, work_mode: a.work_mode,
    employment_type: a.employment_type, salary_min: a.salary_min, salary_max: a.salary_max,
    salary_is_estimate: !!a.salary_is_estimate, salary_basis: a.salary_basis,
    closing_date: /^\d{4}-\d{2}-\d{2}$/.test(a.closing_date ?? "") ? a.closing_date : null,
    description: text.slice(0, 20000), description_status: body.text ? "manual" : "full", last_seen: new Date().toISOString(),
  }, { onConflict: "owner_id,dedupe_key" }).select().single();
  if (jobErr) return json({ error: `Saving the job failed: ${jobErr.message}` }, 500);

  if (url) {
    await supabase.from("job_listings").upsert(
      { owner_id: user.id, job_id: job.id, source: sourceOf(url), url },
      { onConflict: "owner_id,source,url" },
    );
  }

  await supabase.from("job_criteria").delete().eq("job_id", job.id);
  const criteria = (a.criteria ?? []).filter((c: any) => c.text).map((c: any, i: number) => ({
    owner_id: user.id, job_id: job.id, source: "ad",
    kind: ["ksc", "responsibility", "requirement", "screening_question"].includes(c.kind) ? c.kind : "requirement",
    position: i + 1, text: c.text, must_address: c.must_address !== false,
  }));
  if (criteria.length) await supabase.from("job_criteria").insert(criteria);

  await supabase.from("job_scores").upsert({
    job_id: job.id, owner_id: user.id, fit_score: fit, preference_score: Math.round(pref.total),
    total_score: total, fit_reason: a.fit_reason, preference_breakdown: pref.parts,
    gaps: a.gaps ?? [], red_flags: [...(a.red_flags ?? []), ...pref.matched_flags], model: prompt.model,
    scored_at: new Date().toISOString(),
  }, { onConflict: "job_id" });

  return json({ job_id: job.id, title: a.title, employer: a.employer, total_score: total, fit_score: fit, preference_score: Math.round(pref.total) });
});
