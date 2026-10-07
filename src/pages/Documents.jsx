import { useEffect, useState } from "react";
import { supabase, BUCKET } from "../lib/supabase";

const KINDS = [
  { id: "cv", label: "CV" },
  { id: "cover_letter", label: "Cover letter" },
  { id: "portfolio", label: "Portfolio (PDF or text)" },
  { id: "portfolio_asset", label: "Portfolio image or asset" },
  { id: "other", label: "Other career document" },
];
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label]));
const READABLE = ["cv", "cover_letter", "portfolio", "other"];

const STATUS = {
  pending: "Reading…",
  parsed: "Added to career bank",
  failed: "Couldn't read",
  skipped: "Stored",
};

async function extractText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) {
    const { default: mammoth } = await import("mammoth");
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return value;
  }
  if (name.endsWith(".txt") || name.endsWith(".md")) return await file.text();
  return null; // PDFs are read by Claude directly
}

export default function Documents({ session, onParsed }) {
  const [docs, setDocs] = useState([]);
  const [kind, setKind] = useState("cv");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  async function load() {
    const { data, error } = await supabase.from("documents").select("*").order("created_at", { ascending: false });
    if (error) setMessage({ type: "error", text: schemaHint(error) });
    else setDocs(data);
  }
  useEffect(() => { load(); }, []);

  async function parse(id) {
    await supabase.from("documents").update({ parse_status: "pending" }).eq("id", id);
    load();
    const { data, error } = await supabase.functions.invoke("parse-document", { body: { document_id: id } });
    if (error) {
      let detail = error.message;
      try { detail = (await error.context.json()).error ?? detail; } catch {}
      setMessage({ type: "error", text: detail });
    } else {
      setMessage({
        type: "ok",
        text: `Added ${data.facts_added} facts, ${data.roles_added} roles and ${data.projects_added} projects. Check them in the career bank.`,
        action: true,
      });
    }
    load();
  }

  async function upload(e) {
    const files = [...e.target.files];
    e.target.value = "";
    if (!files.length) return;
    setBusy(true);
    setMessage(null);
    for (const file of files) {
      const safe = file.name.replace(/[^\w.\-]+/g, "_");
      const path = `${session.user.id}/documents/${crypto.randomUUID()}-${safe}`;
      const up = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type });
      if (up.error) { setMessage({ type: "error", text: `Upload failed for ${file.name}: ${up.error.message}` }); continue; }
      let text = null;
      try { text = READABLE.includes(kind) ? await extractText(file) : null; } catch { text = null; }
      const { data: doc, error } = await supabase.from("documents").insert({
        kind, filename: file.name, storage_path: path, mime_type: file.type || null,
        parsed_text: text, parse_status: READABLE.includes(kind) ? "pending" : "skipped",
      }).select().single();
      if (error) { setMessage({ type: "error", text: schemaHint(error) }); continue; }
      await load();
      if (READABLE.includes(kind)) await parse(doc.id);
    }
    setBusy(false);
  }

  async function remove(doc) {
    if (!confirm(`Delete ${doc.filename}? Facts already added to the career bank stay.`)) return;
    if (doc.storage_path) await supabase.storage.from(BUCKET).remove([doc.storage_path]);
    await supabase.from("documents").delete().eq("id", doc.id);
    load();
  }

  return (
    <section>
      <div className="intro">
        <h2>Documents</h2>
        <p className="muted">
          Upload CVs, cover letters and portfolio files. Each one is read and broken into roles, facts and
          projects. Nothing is used in an application until you've checked it in the career bank.
        </p>
      </div>

      <div className="uploader">
        <label className="field">
          This is a
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </label>
        <label className={busy ? "primary is-busy" : "primary"}>
          {busy ? "Reading…" : "Choose files"}
          <input type="file" multiple hidden disabled={busy}
            accept={kind === "portfolio_asset" ? "image/*,.pdf,.svg" : ".pdf,.docx,.txt,.md"}
            onChange={upload} />
        </label>
        <span className="hint">PDF, DOCX or TXT. Reading takes about 30 seconds per document.</span>
      </div>

      {message && (
        <p className={message.type === "error" ? "error" : "notice"} role="status">
          {message.text}{" "}
          {message.action && <button className="link" onClick={onParsed}>Open career bank</button>}
        </p>
      )}

      {docs.length === 0 ? (
        <p className="empty">No documents yet. Start with your two current CVs.</p>
      ) : (
        <table className="table">
          <thead><tr><th>File</th><th>Type</th><th>Status</th><th>Uploaded</th><th /></tr></thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td>{d.filename}</td>
                <td>{KIND_LABEL[d.kind] ?? d.kind}</td>
                <td className={`status status-${d.parse_status}`}>{STATUS[d.parse_status]}</td>
                <td className="num">{new Date(d.created_at).toLocaleDateString("en-AU")}</td>
                <td className="actions">
                  {READABLE.includes(d.kind) && d.parse_status !== "pending" && (
                    <button className="link" onClick={() => parse(d.id)}>Read again</button>
                  )}
                  <button className="link danger" onClick={() => remove(d)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function schemaHint(error) {
  if (/schema/i.test(error.message)) {
    return "The database isn't reachable yet. In Supabase, add \"jobs\" to Exposed schemas in the Data API settings.";
  }
  return error.message;
}
