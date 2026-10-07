// The single place every Job Finder function talks to Claude.
//
// Why this file exists:
//  * One copy of each prompt. Prompts live in the jobs.prompts table and are read
//    at call time from jobs.active_prompts, so changing wording means adding a row,
//    not redeploying five functions that had drifted out of step with each other.
//  * Untrusted text (job ads, position descriptions, alert emails, uploaded CVs) is
//    wrapped in delimiters by fence(), so the model can tell data from instructions.
//  * Every call is recorded in jobs.llm_runs, including the ones that fail. Before
//    this, a malformed reply was swallowed by a bare `continue` and nobody knew.
//
// Nothing in here is specific to one feature. Each function supplies its own
// prompt id, content and feature name.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const API = "https://api.anthropic.com/v1/messages";
const DEFAULT_TIMEOUT_MS = 110_000;

/** How a call ended. Mirrors the check constraint on jobs.llm_runs.status. */
export type RunStatus = "ok" | "api_error" | "parse_error" | "schema_error" | "timeout" | "skipped";

/** One active row from jobs.active_prompts. */
export interface Prompt {
  id: string;
  version: number;
  system_text: string;
  model: string;
  max_tokens: number;
}

/** model name -> price per million tokens, loaded once per invocation. */
export type Rates = Map<string, { input: number; output: number }>;

export interface CallResult {
  ok: boolean;
  status: RunStatus;
  data?: unknown;
  message?: string;
}

/** Groups every call made during one sweep or one button press. */
export function newRunId(): string {
  return crypto.randomUUID();
}

export function anthropicHeaders(): Record<string, string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY secret is not set.");
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  // Keys that are not scoped to a workspace need this header, keys that are must not fail on it.
  const workspaceId = Deno.env.get("ANTHROPIC_WORKSPACE_ID");
  if (workspaceId) headers["anthropic-workspace-id"] = workspaceId;
  return headers;
}

/**
 * Reads the one active version of a prompt. Fails loudly: a missing prompt is a
 * deployment mistake, and silently falling back to hardcoded text is how the five
 * copies drifted apart in the first place.
 */
export async function loadPrompt(db: SupabaseClient, id: string): Promise<Prompt> {
  const { data, error } = await db.from("active_prompts").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not read prompt "${id}": ${error.message}`);
  if (!data) throw new Error(`No active version of prompt "${id}" in jobs.prompts.`);
  return data as Prompt;
}

/** The rate card, read once per invocation so cost needs no extra round trip per call. */
export async function loadRates(db: SupabaseClient): Promise<Rates> {
  const rates: Rates = new Map();
  const { data } = await db.from("model_pricing").select("model, input_per_mtok, output_per_mtok");
  for (const r of data ?? []) {
    rates.set(r.model, { input: Number(r.input_per_mtok), output: Number(r.output_per_mtok) });
  }
  return rates;
}

function costOf(rates: Rates, model: string, input: number | null, output: number | null): number | null {
  const rate = rates.get(model);
  if (!rate) return null; // unknown, not free
  const usd = ((input ?? 0) / 1_000_000) * rate.input + ((output ?? 0) / 1_000_000) * rate.output;
  return Number(usd.toFixed(6));
}

/**
 * Wraps text we did not write in markers the prompts are told to distrust.
 * The replace stops an ad closing its own block and escaping into instruction space,
 * which is the cheap half of prompt-injection defence; the prompt wording is the other half.
 */
export function fence(marker: "JOB_AD" | "DOCUMENT" | "EMAIL", text: string): string {
  const safe = (text ?? "").replace(/<<<\/?[A-Z_]{2,30}>>>/g, "[marker removed]");
  return `<<<${marker}>>>\n${safe}\n<<<END_${marker}>>>`;
}

/** Pulls the JSON object out of a reply that may be wrapped in prose or code fences. */
export function parseJson(text: string): unknown {
  const clean = (text ?? "").replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(clean.slice(start, end + 1));
}

export interface LogFields {
  feature: string;
  model: string;
  ownerId: string | null;
  runId: string;
  promptId?: string | null;
  promptVersion?: number | null;
  jobId?: string | null;
  documentId?: string | null;
  status: RunStatus;
  errorMessage?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
}

/**
 * Writes one row to jobs.llm_runs. Logging is best effort on purpose: a failed
 * insert must never lose the work the call just did.
 */
export async function logRun(db: SupabaseClient, f: LogFields): Promise<void> {
  try {
    await db.from("llm_runs").insert({
      owner_id: f.ownerId,
      feature: f.feature,
      model: f.model,
      prompt_id: f.promptId ?? null,
      prompt_version: f.promptVersion ?? null,
      input_tokens: f.inputTokens ?? null,
      output_tokens: f.outputTokens ?? null,
      cache_read_tokens: f.cacheReadTokens ?? null,
      cache_write_tokens: f.cacheWriteTokens ?? null,
      cost_usd: f.costUsd ?? null,
      latency_ms: f.latencyMs ?? null,
      status: f.status,
      error_message: f.errorMessage ? String(f.errorMessage).slice(0, 500) : null,
      job_id: f.jobId ?? null,
      document_id: f.documentId ?? null,
      run_id: f.runId,
    });
  } catch (_) {
    // swallowed deliberately: see the comment above
  }
}

/** Records work we chose not to pay for, so the filters can be shown to be earning their keep. */
export async function logSkipped(
  db: SupabaseClient,
  base: { feature: string; model: string; ownerId: string | null; runId: string },
  reason: string,
): Promise<void> {
  await logRun(db, { ...base, status: "skipped", errorMessage: reason });
}

export interface CallArgs {
  db: SupabaseClient;
  prompt: Prompt;
  rates: Rates;
  /** A string, or an array of Anthropic content blocks when a PDF is attached. */
  content: unknown;
  feature: string;
  ownerId: string | null;
  runId: string;
  jobId?: string | null;
  documentId?: string | null;
  /** Overrides the prompt's own max_tokens when one call needs a smaller ceiling. */
  maxTokens?: number;
  timeoutMs?: number;
  /** Return a message to reject a reply whose shape is wrong; return null to accept. */
  expect?: (parsed: any) => string | null;
}

/**
 * Makes one Claude call and logs exactly one row for it, whatever happens.
 * Callers get a plain ok/not-ok back and never see the HTTP layer.
 */
export async function callClaude(args: CallArgs): Promise<CallResult> {
  const { db, prompt, rates, feature, ownerId, runId } = args;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();

  const base = {
    feature,
    model: prompt.model,
    ownerId,
    runId,
    promptId: prompt.id,
    promptVersion: prompt.version,
    jobId: args.jobId ?? null,
    documentId: args.documentId ?? null,
  };
  const finish = (
    status: RunStatus,
    extra: Partial<LogFields> = {},
  ) => logRun(db, { ...base, status, latencyMs: Date.now() - started, ...extra });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: anthropicHeaders(),
      signal: controller.signal,
      body: JSON.stringify({
        model: prompt.model,
        max_tokens: args.maxTokens ?? prompt.max_tokens,
        system: prompt.system_text,
        messages: [{ role: "user", content: args.content }],
      }),
    });
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    const status: RunStatus = aborted ? "timeout" : "api_error";
    const message = aborted ? `No reply within ${Math.round(timeoutMs / 1000)}s` : String((e as Error)?.message ?? e);
    await finish(status, { errorMessage: message });
    return { ok: false, status, message };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    const message = `Claude API error ${res.status}: ${body}`;
    await finish("api_error", { errorMessage: message });
    return { ok: false, status: "api_error", message };
  }

  let raw: any;
  try {
    raw = await res.json();
  } catch {
    await finish("api_error", { errorMessage: "Reply body was not JSON" });
    return { ok: false, status: "api_error", message: "The API reply could not be read." };
  }

  const usage = raw.usage ?? {};
  const tokens = {
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    cacheReadTokens: usage.cache_read_input_tokens ?? null,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? null,
  };
  const costUsd = costOf(rates, prompt.model, tokens.inputTokens, tokens.outputTokens);
  const text = (raw.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");

  let parsed: any;
  try {
    parsed = parseJson(text);
  } catch (e) {
    await finish("parse_error", {
      ...tokens,
      costUsd,
      errorMessage: `${(e as Error).message}. Reply began: ${text.slice(0, 200)}`,
    });
    return { ok: false, status: "parse_error", message: "The model did not return readable JSON." };
  }

  const complaint = args.expect?.(parsed) ?? null;
  if (complaint) {
    await finish("schema_error", { ...tokens, costUsd, errorMessage: complaint });
    return { ok: false, status: "schema_error", message: complaint };
  }

  await finish("ok", { ...tokens, costUsd });
  return { ok: true, status: "ok", data: parsed };
}
