import { useEffect, useRef, useState } from "react";
import { supabase, BUCKET } from "../lib/supabase";
import { buildCv, buildCoverLetter, buildKsc, downloadDocx, safeName } from "../lib/docxBuilder";

const KIND_LABEL = { cv: "CV", cover_letter: "Cover letter", ksc_response: "KSC responses" };
const PAGE_HEIGHT_PX = 1122;
const USABLE = PAGE_HEIGHT_PX - 150;
const CONTACT = "0400 580 193 · glenn.c.luck@gmail.com · Preston, Melbourne VIC · glennluck.netlify.app";

export default function Applications({ focus }) {
  const [apps, setApps] = useState([]);
  const [docs, setDocs] = useState({});
  const [openApp, setOpenApp] = useState(focus ?? null);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [headerImage, setHeaderImage] = useState(null);

  async function load() {
    const { data, error } = await supabase
      .from("applications")
      .select("*, jobs(title, employer, location, work_mode)")
      .order("updated_at", { ascending: false });
    if (error) return setMessage({ type: "error", text: error.message });
    setApps(data ?? []);
    const ids = (data ?? []).map((a) => a.id);
    if (ids.length) {
      const { data: d } = await supabase.from("generated_documents").select("*").in("application_id", ids)
        .order("version", { ascending: false });
      const byApp = {};
      (d ?? []).forEach((row) => {
        byApp[row.application_id] = byApp[row.application_id] ?? {};
        if (!byApp[row.application_id][row.kind]) byApp[row.application_id][row.kind] = row;
      });
      setDocs(byApp);
    }
  }
  useEffect(() => { load(); }, []);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const { data } = await supabase.storage.from(BUCKET).download(`${user.id}/template/cv-header.png`);
      if (data) setHeaderImage(new Uint8Array(await data.arrayBuffer()));
    })().catch(() => {});
  }, []);

  async function saveContent(doc, content) {
    setDocs((d) => ({ ...d, [doc.application_id]: { ...d[doc.application_id], [doc.kind]: { ...doc, content } } }));
    await supabase.from("generated_documents").update({ content }).eq("id", doc.id);
  }

  async function tighten(app, doc) {
    setBusy(`${app.id}-${doc.kind}`);
    setMessage(null);
    const { error } = await supabase.functions.invoke("generate-application", {
      body: { job_id: app.job_id, documents: [doc.kind], pages: doc.content.pages ?? 1, tight: true },
    });
    if (error) setMessage({ type: "error", text: "Couldn't tighten that draft. Try again." });
    else { setMessage({ type: "ok", text: "Tightened. Check the page count." }); await load(); }
    setBusy(null);
  }

  async function exportDoc(app, doc) {
    const job = app.jobs ?? {};
    const base = safeName(["Glenn Luck", KIND_LABEL[doc.kind], job.employer]);
    if (doc.kind === "cv") await downloadDocx(buildCv(doc.content, headerImage), base);
    else if (doc.kind === "cover_letter") await downloadDocx(buildCoverLetter({ ...doc.content, employer: job.employer }), base);
    else await downloadDocx(buildKsc(doc.content, job.title), base);
    await supabase.from("generated_documents").update({ status: "exported" }).eq("id", doc.id);
  }

  if (!apps.length) {
    return (
      <section>
        <div className="intro">
          <h2>Applications</h2>
          <p className="muted">Nothing drafted yet. Tick jobs on the Jobs tab and press Create applications.</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="intro">
        <h2>Applications</h2>
        <p className="muted">
          Drafts are written from confirmed facts only. Edit anything, check the page count, then export to Word.
        </p>
      </div>
      {message && <p className={message.type === "error" ? "error" : "notice"} role="status">{message.text}</p>}

      {apps.map((app) => {
        const set = docs[app.id] ?? {};
        const isOpen = openApp === app.id;
        const kinds = Object.keys(set).map((k) => KIND_LABEL[k]).join(", ");
        return (
          <div className="role" key={app.id}>
            <div className="role-head">
              <div>
                <h3>{app.jobs?.title}</h3>
                <p className="muted">{app.jobs?.employer}{" · "}{kinds || "no drafts yet"}</p>
              </div>
              <div className="role-actions">
                <button className="link" onClick={() => setOpenApp(isOpen ? null : app.id)}>
                  {isOpen ? "Close" : "Open drafts"}
                </button>
              </div>
            </div>

            {isOpen && (
              <div className="drafts">
                {Object.values(set).map((doc) => (
                  <Draft key={doc.id} app={app} doc={doc} busy={busy === `${app.id}-${doc.kind}`}
                    onSave={saveContent} onTighten={tighten} onExport={exportDoc} />
                ))}
                {(set.cv?.content?.gaps_to_prepare ?? set.cover_letter?.content?.gaps_to_prepare ?? []).length > 0 && (
                  <div className="panel gaps">
                    <h4>Prepare for interview (not in the documents)</h4>
                    <ul>
                      {(set.cv?.content?.gaps_to_prepare ?? set.cover_letter?.content?.gaps_to_prepare).map((g, i) => <li key={i}>{g}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Draft({ app, doc, busy, onSave, onTighten, onExport }) {
  const [content, setContent] = useState(doc.content);
  const ref = useRef(null);
  const [pages, setPages] = useState(null);
  const target = content.pages ?? 1;

  useEffect(() => { setContent(doc.content); }, [doc.id, doc.content]);
  useEffect(() => {
    if (!ref.current) return;
    const h = ref.current.scrollHeight;
    setPages({ count: Math.max(1, Math.ceil(h / USABLE)), overflowCm: Math.max(0, h - target * USABLE) / 37.8 });
  }, [content, target]);

  function edit(patch) { setContent({ ...content, ...patch }); }
  function commit() { onSave(doc, content); }

  const fits = pages && pages.count <= target;

  return (
    <div className="draft">
      <div className="draft-head">
        <h4>{KIND_LABEL[doc.kind]} <span className="muted">v{doc.version}</span></h4>
        <div className="row">
          {pages && (
            <span className={fits ? "fit ok" : "fit over"}>
              {fits ? `Fits on ${target} page${target > 1 ? "s" : ""}` : `Spills ${pages.overflowCm.toFixed(1)}cm past ${target} page${target > 1 ? "s" : ""}`}
            </span>
          )}
          {!fits && <button className="link" disabled={busy} onClick={() => onTighten(app, doc)}>{busy ? "Tightening…" : "Tighten"}</button>}
          <button className="primary small" onClick={() => onExport(app, doc)}>Download Word</button>
        </div>
      </div>

      <div className="draft-grid">
        <div className="draft-edit">
          {doc.kind === "cv" && (
            <>
              <label className="field">Summary
                <textarea rows={4} value={content.summary ?? ""} onBlur={commit}
                  onChange={(e) => edit({ summary: e.target.value })} />
              </label>
              {(content.roles ?? []).map((r, i) => (
                <label className="field" key={i}>{r.title}, {r.employer}
                  <textarea rows={Math.max(4, (r.bullets ?? []).length + 1)} value={(r.bullets ?? []).join("\n")} onBlur={commit}
                    onChange={(e) => {
                      const roles = [...content.roles];
                      roles[i] = { ...r, bullets: e.target.value.split("\n").filter(Boolean) };
                      edit({ roles });
                    }} />
                  <span className="hint">One bullet per line.</span>
                </label>
              ))}
            </>
          )}
          {doc.kind === "cover_letter" && (
            <label className="field">Letter
              <textarea rows={16} value={(content.paragraphs ?? []).join("\n\n")} onBlur={commit}
                onChange={(e) => edit({ paragraphs: e.target.value.split(/\n\s*\n/).filter(Boolean) })} />
              <span className="hint">Blank line between paragraphs.</span>
            </label>
          )}
          {doc.kind === "ksc_response" && (content.responses ?? []).map((r, i) => (
            <label className="field" key={i}>{r.criterion}
              <textarea rows={7} value={r.response} onBlur={commit}
                onChange={(e) => {
                  const responses = [...content.responses];
                  responses[i] = { ...r, response: e.target.value };
                  edit({ responses });
                }} />
            </label>
          ))}
        </div>

        <div className="preview-wrap">
          <div className="preview" ref={ref}>
            {doc.kind === "cv" && <CvPreview c={content} />}
            {doc.kind === "cover_letter" && <LetterPreview c={content} app={app} />}
            {doc.kind === "ksc_response" && <KscPreview c={content} />}
          </div>
          {pages && <p className="hint">Preview measures {pages.count} page{pages.count > 1 ? "s" : ""} at A4.</p>}
        </div>
      </div>
    </div>
  );
}

function CvPreview({ c }) {
  return (
    <>
      <p className="p-name">GLENN LUCK</p>
      <p className="p-headline">{c.headline}</p>
      <p className="p-contact">{CONTACT}</p>
      {c.summary && <p className="p-body">{c.summary}</p>}
      {c.capabilities?.length > 0 && <><p className="p-heading">Key capabilities</p>
        <ul>{c.capabilities.map((x, i) => <li key={i}><strong>{x.label}:</strong> {x.text}</li>)}</ul></>}
      {c.tools?.length > 0 && <><p className="p-heading">Tools</p>
        <ul>{c.tools.map((x, i) => <li key={i}><strong>{x.label}:</strong> {x.text}</li>)}</ul></>}
      {c.roles?.length > 0 && <><p className="p-heading">Professional experience</p>
        {c.roles.map((r, i) => (
          <div key={i}>
            <p className="p-role"><strong>{r.title}</strong> <span className="muted">| {r.employer} {r.dates}</span></p>
            <ul>{(r.bullets ?? []).map((b, j) => <li key={j}>{b}</li>)}</ul>
          </div>
        ))}</>}
      {c.education?.length > 0 && <><p className="p-heading">Education and professional development</p>
        {c.education.map((e, i) => <p className="p-body" key={i}>{e}</p>)}</>}
      {c.referees?.length > 0 && <><p className="p-heading">Referees</p>
        {c.referees.map((r, i) => <p className="p-body" key={i}>{r}</p>)}</>}
    </>
  );
}

function LetterPreview({ c, app }) {
  return (
    <>
      <p className="p-name small">GLENN LUCK</p>
      <p className="p-contact">{CONTACT}</p>
      <p className="p-body">{new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}</p>
      <p className="p-body">{c.recipient}<br />{app.jobs?.employer}<br /><strong>{c.subject}</strong></p>
      {(c.paragraphs ?? []).map((p, i) => <p className="p-body" key={i}>{p}</p>)}
      <p className="p-body">{c.sign_off ?? "Kind regards"}<br />Glenn Luck</p>
    </>
  );
}

function KscPreview({ c }) {
  return (
    <>
      <p className="p-name small">GLENN LUCK</p>
      {(c.responses ?? []).map((r, i) => (
        <div key={i}>
          <p className="p-role"><strong>{i + 1}. {r.criterion}</strong></p>
          <p className="p-body">{r.response}</p>
        </div>
      ))}
    </>
  );
}
