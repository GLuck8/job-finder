import { Fragment, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const MODE_LABEL = { remote: "Remote", hybrid: "Hybrid", onsite: "Onsite", unknown: "Not stated" };
const TYPE_LABEL = { ongoing: "Ongoing", fixed_term: "Fixed term", contract: "Contract", casual: "Casual", part_time: "Part time", unknown: "Not stated" };
const STATUSES = ["shortlisted", "applied", "heard_back", "interview", "offer", "rejected", "withdrawn", "closed"];
const STATUS_LABEL = { shortlisted: "Shortlisted", applied: "Applied", heard_back: "Heard back", interview: "Interview", offer: "Offer", rejected: "Rejected", withdrawn: "Withdrawn", closed: "Closed" };

const money = (n) => (n == null ? null : `$${Math.round(n / 1000)}k`);
function salaryText(j) {
  const range = j.salary_min && j.salary_max && j.salary_min !== j.salary_max
    ? `${money(j.salary_min)}–${money(j.salary_max)}` : money(j.salary_max ?? j.salary_min);
  if (!range) return "Not stated";
  return j.salary_is_estimate ? `${range} est.` : range;
}
function ageInfo(j) {
  const raw = j.posted_at ?? j.first_seen;
  if (!raw) return { label: "—", days: null, estimated: false };
  const days = Math.floor((Date.now() - new Date(raw)) / 86400000);
  const estimated = !j.posted_at;
  const label = days <= 0 ? "Today" : days === 1 ? "1 day" : `${days} days`;
  return { label, days, estimated };
}

function closesText(d) {
  if (!d) return "—";
  const days = Math.ceil((new Date(d) - Date.now()) / 86400000);
  if (days < 0) return "Closed";
  if (days <= 7) return `${days}d left`;
  return new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export default function Jobs({ onGenerated }) {
  const [rows, setRows] = useState([]);
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [open, setOpen] = useState(null);
  const [hideStale, setHideStale] = useState(true);
  const [criteria, setCriteria] = useState({});
  const [picked, setPicked] = useState([]);
  const [panel, setPanel] = useState(false);
  const [wanted, setWanted] = useState(["cv", "cover_letter"]);
  const [progress, setProgress] = useState(null);

  async function load() {
    const { data, error } = await supabase.from("dashboard").select("*").eq("hidden", false);
    if (error) return setMessage({ type: "error", text: error.message });
    setRows((data ?? []).sort((a, b) => (b.total_score ?? -1) - (a.total_score ?? -1)));
  }
  useEffect(() => { load(); }, []);

  async function addJob() {
    if (!url.trim() && !text.trim()) return;
    setBusy(true); setMessage(null);
    const { data, error } = await supabase.functions.invoke("add-job", { body: { url: url.trim(), text: text.trim() } });
    if (error) {
      let detail = error.message;
      try { detail = (await error.context.json()).error ?? detail; } catch {}
      setMessage({ type: "error", text: detail });
      if (/paste the ad text/i.test(detail)) setShowPaste(true);
    } else {
      setMessage({ type: "ok", text: `Scored ${data.title} at ${data.employer}: ${data.total_score} out of 100.` });
      setUrl(""); setText(""); setShowPaste(false);
      load();
    }
    setBusy(false);
  }

  function togglePick(id) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  function toggleWanted(kind) {
    setWanted((w) => (w.includes(kind) ? w.filter((x) => x !== kind) : [...w, kind]));
  }

  async function createApplications() {
    setProgress({ done: 0, total: picked.length });
    setMessage(null);
    let failed = 0;
    for (const [i, id] of picked.entries()) {
      const job = rows.find((r) => r.id === id);
      const isVps = (job?.sources ?? []).includes("careers_vic") || /department|victorian government/i.test(job?.employer ?? "");
      const docs = isVps && wanted.includes("cv") ? [...new Set([...wanted, "ksc_response"])] : wanted;
      const { error } = await supabase.functions.invoke("generate-application", {
        body: { job_id: id, documents: docs, pages: isVps ? 2 : 1 },
      });
      if (error) failed += 1;
      setProgress({ done: i + 1, total: picked.length });
    }
    setProgress(null);
    setPicked([]);
    setPanel(false);
    if (failed) setMessage({ type: "error", text: `${failed} of ${picked.length} didn't draft. Try those again.` });
    else onGenerated?.();
  }

  async function expand(id) {
    setOpen(open === id ? null : id);
    if (!criteria[id]) {
      const { data } = await supabase.from("job_criteria").select("*").eq("job_id", id).order("position");
      setCriteria((c) => ({ ...c, [id]: data ?? [] }));
    }
  }

  async function setStatus(job, status) {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("applications").upsert(
      { owner_id: user.id, job_id: job.id, status, applied_at: status === "applied" ? new Date().toISOString() : null },
      { onConflict: "owner_id,job_id" },
    );
    setRows((rs) => rs.map((r) => (r.id === job.id ? { ...r, application_status: status } : r)));
  }

  async function hide(job) {
    setRows((rs) => rs.filter((r) => r.id !== job.id));
    await supabase.from("jobs").update({ hidden: true }).eq("id", job.id);
  }

  const withAge = rows.map((j) => ({ ...j, age: ageInfo(j) }));
  const stale = withAge.filter((j) => j.age.days != null && j.age.days > 10).length;
  const visible = hideStale ? withAge.filter((j) => !(j.age.days != null && j.age.days > 10)) : withAge;

  return (
    <section>
      <div className="intro">
        <h2>Jobs</h2>
        <p className="muted">
          Ranked by score: how well you match the job, and how well the job suits you. Add one by link, or paste the ad
          text when a site blocks automated reading.
        </p>
      </div>

      <div className="panel adder">
        <label className="field">Job ad link
          <input value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
        </label>
        {showPaste && (
          <label className="field">Ad text
            <textarea rows={6} value={text} placeholder="Paste the whole ad here" onChange={(e) => setText(e.target.value)} />
          </label>
        )}
        <div className="row">
          <button className="primary" onClick={addJob} disabled={busy}>{busy ? "Scoring…" : "Score this job"}</button>
          <button className="link" onClick={() => setShowPaste(!showPaste)}>{showPaste ? "Hide the paste box" : "Paste ad text instead"}</button>
        </div>
      </div>

      {message && <p className={message.type === "error" ? "error" : "notice"} role="status">{message.text}</p>}

      {stale > 0 && (
        <label className="toggle filter-bar">
          <input type="checkbox" checked={hideStale} onChange={(e) => setHideStale(e.target.checked)} />
          Hide posts older than 10 days ({stale})
        </label>
      )}

      {picked.length > 0 && (
        <div className="panel select-bar">
          <div className="row">
            <strong>{picked.length} job{picked.length > 1 ? "s" : ""} selected</strong>
            <button className="primary" onClick={() => setPanel(!panel)} disabled={!!progress}>
              {progress ? `Writing ${progress.done} of ${progress.total}…` : "Create applications"}
            </button>
            <button className="link" onClick={() => setPicked([])}>Clear</button>
          </div>
          {panel && !progress && (
            <>
              <fieldset className="choices">
                <legend>Documents to write</legend>
                <label className="toggle">
                  <input type="checkbox" checked={wanted.includes("cv")} onChange={() => toggleWanted("cv")} />CV
                </label>
                <label className="toggle">
                  <input type="checkbox" checked={wanted.includes("cover_letter")} onChange={() => toggleWanted("cover_letter")} />Cover letter
                </label>
              </fieldset>
              <p className="hint">
                Victorian public sector roles automatically get two pages plus responses to the key selection
                criteria. Everything else gets one page. Takes about a minute per job.
              </p>
              <div className="row">
                <button className="primary" onClick={createApplications} disabled={!wanted.length}>
                  Write {wanted.length} document{wanted.length > 1 ? "s" : ""} for {picked.length} job{picked.length > 1 ? "s" : ""}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="empty">
          {rows.length === 0 ? "No jobs yet. Paste a link above to score the first one."
            : "Everything on the list is more than 10 days old. Untick the box above to see it."}
        </p>
      ) : (
        <table className="table jobs">
          <thead>
            <tr><th className="pick" /><th>Score</th><th>Role</th><th>Salary</th><th>Where</th><th>Type</th><th>Posted</th><th>Closes</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {visible.map((j) => (
              <Fragment key={j.id}>
                <tr>
                  <td className="pick">
                    <input type="checkbox" aria-label={`Select ${j.title}`}
                      checked={picked.includes(j.id)} onChange={() => togglePick(j.id)} />
                  </td>
                  <td className="score-cell">
                    <span className="score num">{j.total_score ?? "—"}</span>
                    <span className="score-bar" aria-hidden="true"><span style={{ width: `${j.total_score ?? 0}%` }} /></span>
                  </td>
                  <td>
                    {j.url ? <a href={j.url} target="_blank" rel="noreferrer">{j.title}</a> : j.title}
                    <span className="sub">{j.employer}</span>
                  </td>
                  <td className="num">{salaryText(j)}</td>
                  <td>{j.location}<span className="sub">{MODE_LABEL[j.work_mode]}</span></td>
                  <td>{TYPE_LABEL[j.employment_type]}</td>
                  <td className={j.age.days > 10 ? "num age is-stale" : "num age"}
                      title={j.age.estimated ? "First seen by the app; the ad did not state a posting date" : "Posted date from the listing"}>
                    {j.age.label}{j.age.estimated && <span className="sub">first seen</span>}
                  </td>
                  <td className="num">{closesText(j.closing_date)}</td>
                  <td>
                    <select value={j.application_status ?? ""} onChange={(e) => setStatus(j, e.target.value)}>
                      <option value="">Not tracked</option>
                      {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                    </select>
                  </td>
                  <td className="actions">
                    <button className="link" onClick={() => expand(j.id)}>{open === j.id ? "Less" : "Why"}</button>
                    <button className="link danger" onClick={() => hide(j)}>Hide</button>
                  </td>
                </tr>
                {open === j.id && (
                  <tr className="detail">
                    <td colSpan={10}>
                      <div className="detail-grid">
                        <div>
                          <h4>Why this score</h4>
                          <p>{j.fit_reason}</p>
                          <p className="muted">
                            Match {j.fit_score ?? "—"} / 100 · Suits you {j.preference_score ?? "—"} / 100
                            {j.salary_basis && ` · Salary: ${j.salary_basis}`}
                          </p>
                          {j.gaps?.length > 0 && <p><strong>Gaps:</strong> {j.gaps.join("; ")}</p>}
                          {j.red_flags?.length > 0 && <p className="flagged"><strong>Watch out:</strong> {j.red_flags.join("; ")}</p>}
                        </div>
                        <div>
                          <h4>What the application must address</h4>
                          <ol className="criteria">
                            {(criteria[j.id] ?? []).map((c) => <li key={c.id}>{c.text}</li>)}
                          </ol>
                          {(criteria[j.id] ?? []).length === 0 && <p className="muted">Nothing specific listed in the ad.</p>}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
