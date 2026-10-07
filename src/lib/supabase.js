import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  // Fails loudly at startup rather than silently returning empty tables.
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. " +
    "Set both as environment variables in Vercel, or in .env.local for local development."
  );
}

export const supabase = createClient(url, key, { db: { schema: "jobs" } });

export const BUCKET = "job-hunt";

export function formatMonth(d) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-AU", { month: "short", year: "numeric" });
}
