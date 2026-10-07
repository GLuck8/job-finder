// generate-application: writes a CV, cover letter and (for VPS roles) KSC responses
// for one job, using ONLY confirmed career-bank facts and the criteria already stored.
//
// The writing rules live in jobs.prompts under the id write_application. The version
// used is stored on every run in jobs.llm_runs, so a draft can be traced back to the
// exact wording that produced it.
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

// Content budgets. 'tight' is what the Tighten button asks for when a draft spills a page.
const BUDGETS: Record<string, any> = {
  "1-normal": { summary: 55, capabilities: 0, tools: 3, bullets: [6, 4, 3], letter: 380 },
  "1-tight": { summary: 40, capabilities: 0, tools: 2, bullets: [5, 3, 2], letter: 320 },
  "2-normal": { summary: 85, capabilities: 5, tools: 5, bullets: [6, 6, 5], letter: 700 },
  "2-tight": { summary: 65, capabilities: 4, tools: 4, bullets: [5, 5, 4], letter: 600 },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!Deno.env.get("ANTHROPIC_API_KEY")) return json({ error: "ANTHROPIC_API_KEY secret is not set." }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Not signed in." }, 401);
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
    { global: { headers: { Authorization: authHeader } }, db: { schema: "jobs" } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "Not signed in." }, 401);

  let body: { job_id?: string; documents?: string[]; pages?: number; tight?: boolean };
  try { body = await req.json(); } catch { return json({ error: "Send { job_id, documents }." }, 400); }
  if (!body.job_id) return json({ error: "Send a job_id." }, 400);
  const wanted = body.documents?.length ? body.documents : ["cv", "cover_letter"];

  const { data: job } = await supabase.from("jobs").select("*").eq("id", body.job_id).single();
  if (!job) return json({ error: "Job not found." }, 404);

  const [{ data: criteria }, { data: roles }, { data: facts }, { data: projects }, { data: listings }] = await Promise.all([
    supabase.from("job_criteria").select("*").eq("job_id", job.id).order("position"),
    supabase.from("roles").select("*").order("start_date", { ascending: false, nullsFirst: false }),
    supabase.from("facts").select("id, role_id, kind, text, metric").eq("verified", true),
    supabase.from("portfolio_projects").select("name, client, sector, brief, idea, outcome").eq("verified", true),
    supabase.from("job_listings").select("source").eq("job_id", job.id),
  ]);

  const isVps = (listings ?? []).some((l) => l.source === "careers_vic")
    || /\bVPS\b|Victorian Government|Department of/i.test(`${job.employer} ${job.description ?? ""}`);
  const pages = body.pages ?? (isVps ? 2 : 1);
  const budget = BUDGETS[`${pages}-${body.tight ? "tight" : "normal"}`] ?? BUDGETS["1-normal"];
  const mentionsPm = /project manage|project coordination|project delivery/i.test(job.description ?? "");
  const includePmCert = isVps || mentionsPm;

  const bank = (roles ?? []).map((r) => {
    const mine = (facts ?? []).filter((f) => f.role_id === r.id);
    return `ROLE ${r.title} | ${r.employer} | ${r.start_date ?? "?"} to ${r.is_current ? "present" : (r.end_date ?? "?")}\n`
      + mine.map((f) => `  [${f.id}] (${f.kind}) ${f.text}${f.metric ? ` {figure: ${f.metric}}` : ""}`).join("\n");
  }).join("\n\n");
  const loose = (facts ?? []).filter((f) => !f.role_id).map((f) => `  [${f.id}] (${f.kind}) ${f.text}`).join("\n");

  const criteriaText = (criteria ?? []).length
    ? (criteria ?? []).map((c, i) => `${i + 1}. (${c.kind}${c.must_address ? ", must address" : ""}) ${c.text}`).join("\n")
    : "(none captured; work from the ad text)";

  // The career bank and the stored criteria are ours, so they sit outside the markers.
  // Only the raw ad text is fenced.
  const instruction = [
    "CANDIDATE: Glenn Luck, 0400 580 193, glenn.c.luck@gmail.com, Preston, Melbourne VIC, glennluck.netlify.app",
    "",
    "CAREER BANK (confirmed facts only, ids in brackets):",
    bank,
    "",
    "OTHER CONFIRMED FACTS:",
    loose || "(none)",
    "",
    "PORTFOLIO PROJECTS:",
    JSON.stringify(projects ?? []),
    "",
    `THE JOB: ${job.title} at ${job.employer}, ${job.location}. ${job.work_mode} work. ${job.employment_type}.`,
    "The advertisement text follows.",
    fence("JOB_AD", (job.description ?? "").slice(0, 25000)),
    "",
    "WHAT THE APPLICATION MUST ADDRESS:",
    criteriaText,
    "",
    `WRITE: ${wanted.join(", ")}.`,
    `FORMAT: ${pages} page${pages > 1 ? "s" : ""}${isVps ? " (Victorian public sector application)" : ""}.`,
    `BUDGET: summary at most ${budget.summary} words; ${budget.capabilities ? `${budget.capabilities} capability lines` : "NO capabilities section"}; ${budget.tools} tool lines; bullets per role, most recent first: ${budget.bullets.join(", ")}; cover letter body at most ${budget.letter} words.`,
    `include_pm_cert: ${includePmCert}.`,
    wanted.includes("ksc_response")
      ? "Write one KSC response per must-address criterion, at most 220 words each."
      : "Do not write KSC responses.",
    "",
    "Write it now.",
  ].join("\n");

  /** Rejects a reply that is missing every document that was asked for. */
  const expectDraft = (p: any) => {
    if (!p || typeof p !== "object") return "reply was not an object";
    const got = wanted.filter((k) => (k === "ksc_response" ? Array.isArray(p.ksc_responses) && p.ksc_responses.length : p[k]));
    if (!got.length) return `reply contained none of the requested documents (${wanted.join(", ")})`;
    return null;
  };

  let prompt, rates;
  try {
    [prompt, rates] = await Promise.all([loadPrompt(supabase, "write_application"), loadRates(supabase)]);
  } catch (e) {
    return json({ error: String((e as Error).message) }, 500);
  }

  const call = await callClaude({
    db: supabase, prompt, rates, content: instruction,
    feature: body.tight ? "write_application_tighten" : "write_application",
    ownerId: user.id, runId: newRunId(), jobId: job.id, expect: expectDraft,
  });
  if (!call.ok) return json({ error: call.message ?? "Couldn't read the draft. Try again." }, 502);
  const out = call.data as any;

  const { data: app } = await supabase.from("applications").upsert(
    { owner_id: user.id, job_id: job.id, status: "drafted", base_cv: isVps ? "coordination" : "creative" },
    { onConflict: "owner_id,job_id" },
  ).select().single();
  if (!app) return json({ error: "Couldn't save the application." }, 500);

  const { data: prior } = await supabase.from("generated_documents").select("kind, version").eq("application_id", app.id);
  const nextVersion = (kind: string) =>
    Math.max(0, ...(prior ?? []).filter((p) => p.kind === kind).map((p) => p.version)) + 1;
  const factIds = (out.facts_used ?? []).filter((id: string) => /^[0-9a-f-]{36}$/.test(id));

  const rows: any[] = [];
  if (wanted.includes("cv") && out.cv) {
    rows.push({
      owner_id: user.id, application_id: app.id, kind: "cv", version: nextVersion("cv"), model: prompt.model,
      content: { ...out.cv, pages, template: isVps ? "clean" : "designed", notes: out.notes, gaps_to_prepare: out.gaps_to_prepare ?? [] },
      fact_ids: factIds,
    });
  }
  if (wanted.includes("cover_letter") && out.cover_letter) {
    rows.push({
      owner_id: user.id, application_id: app.id, kind: "cover_letter", version: nextVersion("cover_letter"), model: prompt.model,
      content: { ...out.cover_letter, pages, gaps_to_prepare: out.gaps_to_prepare ?? [] }, fact_ids: factIds,
    });
  }
  if (wanted.includes("ksc_response") && out.ksc_responses?.length) {
    rows.push({
      owner_id: user.id, application_id: app.id, kind: "ksc_response", version: nextVersion("ksc_response"), model: prompt.model,
      content: { responses: out.ksc_responses, gaps_to_prepare: out.gaps_to_prepare ?? [] }, fact_ids: factIds,
    });
  }
  if (!rows.length) return json({ error: "Nothing was drafted. Try again." }, 502);

  const { data: saved, error } = await supabase.from("generated_documents").insert(rows).select();
  if (error) return json({ error: `Saving the drafts failed: ${error.message}` }, 500);

  return json({
    application_id: app.id, job_title: job.title, employer: job.employer,
    is_vps: isVps, pages, documents: saved,
    prompt: `${prompt.id} v${prompt.version}`,
    gaps_to_prepare: out.gaps_to_prepare ?? [], notes: out.notes ?? null,
  });
});
