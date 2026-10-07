# Edge functions

Six functions, all deployed to Supabase:

| function | what it does | gateway JWT |
|---|---|---|
| `search-jobs` | the scheduled sweep: Adzuna, LinkedIn, Careers.Vic | required |
| `ingest-alert` | receives Seek alert emails from a Google Apps Script | not required |
| `add-job` | scores one ad pasted or linked by hand | required |
| `rescore-jobs` | re-ranks jobs already stored, against the current career bank | required |
| `parse-document` | reads an uploaded CV into the career bank | required |
| `generate-application` | writes a CV, cover letter and KSC responses | required |

## The shared helper

`_shared/llm.ts` is the only place any of them talks to Claude. It reads the active prompt
from `jobs.active_prompts`, wraps untrusted text in markers the prompts are told to
distrust, times the call, and writes one row to `jobs.llm_runs` whatever the outcome —
including failures, which used to be swallowed silently.

A deployed function bundle is flat, so it cannot import from a sibling directory. The
helper is therefore copied into each function directory at deploy time:

    cp supabase/functions/_shared/llm.ts supabase/functions/<name>/llm.ts

Those copies are gitignored. `_shared/llm.ts` is the version to edit; changing it means
redeploying every function that uses it.

## Things worth knowing before changing anything

- **Deploying resets the gateway JWT setting.** It defaults back to required. `ingest-alert`
  must stay not-required, because the Apps Script authenticates with `x-cron-secret` and has
  no user session. Pass `verify_jwt` explicitly on every deploy.
- **`search-jobs` is called by `pg_cron` hourly at minute 7.** The cron presents the public
  anon key to satisfy the gateway and the cron secret to unlock the service-role path, so the
  endpoint is not callable anonymously.
- **The gateway kills a request at 150 seconds idle.** `rescore-jobs` currently attempts its
  whole list in one request, which fails past roughly 20 jobs. It needs to work in batches.
- **Prompts are data, not code.** Changing wording means inserting a new row in `jobs.prompts`
  and moving the active flag, not editing a function. Old versions stay so a draft can be
  traced to the exact text that produced it.
