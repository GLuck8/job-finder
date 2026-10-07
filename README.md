# Job Finder

A scheduled job-search pipeline with LLM ranking and application generation.

Pulls job ads from four sources on a schedule, scores and ranks them against a
verified store of career facts, extracts selection criteria from ads and attached
position descriptions, and generates tailored CVs, cover letters and KSC responses
that can only draw on facts the owner has confirmed.

Full architecture, model and prompt rationale, evaluation results and a
"what failed and how I fixed it" section are written up in Phase 9.

## Stack

| Layer | Technology |
| --- | --- |
| Front end | React 18, Vite, deployed on Vercel |
| Database | Supabase Postgres, row-level security, `jobs` schema |
| Server logic | Supabase Edge Functions (Deno/TypeScript) |
| Scheduling | pg_cron + pg_net, hourly trigger, window logic in the function |
| LLM | Anthropic API (Claude) for ranking, extraction and generation |
| Documents | `docx` built client-side |

## Local development

    npm install
    cp .env.example .env.local   # fill in both values
    npm run dev

Both environment variables are public by design; row-level security in Supabase
is what protects the data. Server-side secrets live only in Supabase Edge
Function secrets and never reach the browser.
