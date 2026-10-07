import { useEffect, useMemo, useState } from "react";
import { supabase, formatMonth } from "../lib/supabase";

const KIND_LABEL = {
  achievement: "Achievement", responsibility: "Responsibility", skill: "Skill", tool: "Tool",
  metric: "Figure", qualification: "Qualification", education: "Education", other: "Other",
};

export default function CareerBank() {
  const [roles, setRoles] = useState([]);
  const [facts, setFacts] = useState([]);
  const [projects, setProjects] = useState([]);
  const [onlyUnchecked, setOnlyUnchecked] = useState(true);
  const [error, setError] = useState(null);
  const [removing, setRemoving] = useState(null);

  async function load() {
    const [r, f, p] = await Promise.all([
      supabase.from("roles").select("*").order("start_date", { ascending: false, nullsFirst: false }),
      supabase.from("facts").select("*").order("created_at"),
      supabase.from("portfolio_projects").select("*").order("year", { ascending: false, nullsFirst: false }),
    ]);
    const err = r.error || f.error || p.error;
    if (err) return setError(err.message);
    setRoles(r.data); setFacts(f.data); setProjects(p.data);
  }
  useEffect(() => { load(); }, []);

  const checked = facts.filter((f) => f.verified).length;
  const groups = useMemo(() => {
    const visible = onlyUnchecked ? facts.filter((f) => !f.verified) : facts;
    const byRole = roles.map((role) => ({ role, facts: visible.filter((f) => f.role_id === role.id) }));
    const loose = visible.filter((f) => !f.role_id);
    return { byRole, loose };
  }, [roles, facts, onlyUnchecked]);

  async function updateFact(id, patch) {
    setFacts((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
    const { error } = await supabase.from("facts").update(patch).eq("id", id);
    if (error) { setError(error.message); load(); }
  }
  async function deleteFact(id) {
    setFacts((fs) => fs.filter((f) => f.id !== id));
    await supabase.from("facts").delete().eq("id", id);
  }
  async function addFact(roleId) {
    const { data, error } = await supabase.from("facts")
      .insert({ role_id: roleId, kind: "achievement", text: "New fact", verified: false }).select().single();
    if (error) return setError(error.message);
    setFacts((fs) => [...fs, { ...data, _editing: true }]);
  }
  async function confirmAll(list) {
    const ids = list.filter((f) => !f.verified).map((f) => f.id);
    if (!ids.length) return;
    setFacts((fs) => fs.map((f) => (ids.includes(f.id) ? { ...f, verified: true } : f)));
    await supabase.from("facts").update({ verified: true }).in("id", ids);
  }
  async function updateRole(id, patch) {
    setRoles((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    await supabase.from("roles").update(patch).eq("id", id);
  }
  async function removeRole(role, action, targetId) {
    const mine = facts.filter((f) => f.role_id === role.id);
    if (mine.length) {
      if (action === "move" && targetId) {
        const { error } = await supabase.from("facts").update({ role_id: targetId }).eq("role_id", role.id);
        if (error) return setError(error.message);
      } else if (action === "unlink") {
        const { error } = await supabase.from("facts").update({ role_id: null }).eq("role_id", role.id);
        if (error) return setError(error.message);
      } else if (action === "delete") {
        const { error } = await supabase.from("facts").delete().eq("role_id", role.id);
        if (error) return setError(error.message);
      }
    }
    const { error } = await supabase.from("roles").delete().eq("id", role.id);
    if (error) return setError(error.message);
    setRemoving(null);
    load();
  }

  async function updateProject(id, patch) {
    setProjects((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    await supabase.from("portfolio_projects").update(patch).eq("id", id);
  }
  async function deleteProject(id) {
    if (!confirm("Delete this project from the career bank?")) return;
    setProjects((ps) => ps.filter((p) => p.id !== id));
    await supabase.from("portfolio_projects").delete().eq("id", id);
  }

  const empty = roles.length === 0 && facts.length === 0 && projects.length === 0;

  return (
    <section>
      <div className="intro">
        <h2>Career bank</h2>
        <p className="muted">
          Applications are written only from facts you've confirmed here. Fix anything that's wrong, check every
          figure, and delete anything you wouldn't say in an interview.
        </p>
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {empty ? (
        <p className="empty">Nothing here yet. Upload a CV on the Documents tab and its contents will appear here.</p>
      ) : (
        <>
          <div className="bank-bar">
            <p className="progress"><strong className="num">{checked}</strong> of <span className="num">{facts.length}</span> facts confirmed</p>
            <div className="meter" aria-hidden="true"><span style={{ width: facts.length ? `${(checked / facts.length) * 100}%` : 0 }} /></div>
            <label className="toggle">
              <input type="checkbox" checked={onlyUnchecked} onChange={(e) => setOnlyUnchecked(e.target.checked)} />
              Show only facts still to check
            </label>
          </div>

          {removing && (
            <RemoveRole removing={removing} roles={roles.filter((r) => r.id !== removing.role.id)}
              onCancel={() => setRemoving(null)} onConfirm={removeRole} />
          )}

          {groups.byRole.map(({ role, facts: list }) => (
            <RoleBlock key={role.id} role={role} facts={list} onRole={updateRole}
              onFact={updateFact} onDelete={deleteFact} onAdd={() => addFact(role.id)}
              onConfirmAll={() => confirmAll(list)}
              factCount={facts.filter((f) => f.role_id === role.id).length}
              onRemove={() => setRemoving({ role, count: facts.filter((f) => f.role_id === role.id).length })} />
          ))}
          {groups.loose.length > 0 && (
            <div className="role">
              <div className="role-head"><h3>Not linked to a role</h3></div>
              <ul className="facts">
                {groups.loose.map((f) => (
                  <FactRow key={f.id} fact={f} roles={roles} onChange={updateFact} onDelete={deleteFact} />
                ))}
              </ul>
            </div>
          )}

          <h2 className="section-title">Portfolio projects</h2>
          {projects.length === 0 && <p className="empty">No projects yet. Upload a portfolio PDF to add them.</p>}
          <div className="projects">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} onChange={updateProject} onDelete={deleteProject} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function RoleBlock({ role, facts, onRole, onFact, onDelete, onAdd, onConfirmAll, onRemove, factCount }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(role);
  const dates = [formatMonth(role.start_date), role.is_current ? "now" : formatMonth(role.end_date)].filter(Boolean).join(" to ");

  return (
    <div className="role">
      <div className="role-head">
        {editing ? (
          <div className="role-edit">
            <input aria-label="Job title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <input aria-label="Employer" value={draft.employer} onChange={(e) => setDraft({ ...draft, employer: e.target.value })} />
            <input aria-label="Start" type="date" value={draft.start_date ?? ""} onChange={(e) => setDraft({ ...draft, start_date: e.target.value || null })} />
            <input aria-label="End" type="date" value={draft.end_date ?? ""} disabled={draft.is_current} onChange={(e) => setDraft({ ...draft, end_date: e.target.value || null })} />
            <label className="toggle"><input type="checkbox" checked={draft.is_current} onChange={(e) => setDraft({ ...draft, is_current: e.target.checked })} />Current</label>
            <button className="primary small" onClick={() => {
              onRole(role.id, { title: draft.title, employer: draft.employer, start_date: draft.start_date, end_date: draft.is_current ? null : draft.end_date, is_current: draft.is_current });
              setEditing(false);
            }}>Save role</button>
          </div>
        ) : (
          <>
            <div>
              <h3>{role.title}</h3>
              <p className="muted">{role.employer}{dates && `, ${dates}`}</p>
            </div>
            <div className="role-actions">
              <button className="link" onClick={() => { setDraft(role); setEditing(true); }}>Edit role</button>
              {facts.some((f) => !f.verified) && <button className="link" onClick={onConfirmAll}>Confirm all shown</button>}
              <button className="link" onClick={onAdd}>Add fact</button>
              <button className="link danger" onClick={onRemove}>Delete role{factCount ? ` (${factCount})` : ""}</button>
            </div>
          </>
        )}
      </div>
      {facts.length > 0 && (
        <ul className="facts">
          {facts.map((f) => <FactRow key={f.id} fact={f} onChange={onFact} onDelete={onDelete} />)}
        </ul>
      )}
    </div>
  );
}

function FactRow({ fact, roles, onChange, onDelete }) {
  const [editing, setEditing] = useState(!!fact._editing);
  const [text, setText] = useState(fact.text);

  function save() {
    setEditing(false);
    if (text.trim() && text !== fact.text) onChange(fact.id, { text: text.trim() });
  }

  return (
    <li className={fact.verified ? "fact is-verified" : "fact"}>
      <div className="fact-body">
        {editing ? (
          <textarea autoFocus rows={2} value={text} onChange={(e) => setText(e.target.value)}
            onBlur={save} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } }} />
        ) : (
          <p className="fact-text" onClick={() => setEditing(true)}>{fact.text}</p>
        )}
        <div className="fact-meta">
          <select aria-label="Type" value={fact.kind} onChange={(e) => onChange(fact.id, { kind: e.target.value })}>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {fact.metric && <span className="figure">Figure: {fact.metric}</span>}
          {roles && (
            <select aria-label="Role" value="" onChange={(e) => e.target.value && onChange(fact.id, { role_id: e.target.value })}>
              <option value="">Link to a role…</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.title}, {r.employer}</option>)}
            </select>
          )}
        </div>
      </div>
      <div className="fact-actions">
        <button className={fact.verified ? "check is-on" : "check"} aria-pressed={fact.verified}
          onClick={() => onChange(fact.id, { verified: !fact.verified })}>
          {fact.verified ? "Confirmed" : "Confirm"}
        </button>
        <button className="link" onClick={() => setEditing(true)}>Edit</button>
        <button className="link danger" onClick={() => onDelete(fact.id)}>Delete</button>
      </div>
    </li>
  );
}

function RemoveRole({ removing, roles, onCancel, onConfirm }) {
  const { role, count } = removing;
  const [action, setAction] = useState(roles.length ? "move" : "unlink");
  const [target, setTarget] = useState(roles[0]?.id ?? "");

  if (!count) {
    return (
      <div className="panel remove-role">
        <p><strong>Delete {role.title}, {role.employer}?</strong> There are no facts attached to it.</p>
        <div className="row">
          <button className="primary" onClick={() => onConfirm(role, "none")}>Delete role</button>
          <button className="link" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel remove-role">
      <p>
        <strong>Delete {role.title}, {role.employer}?</strong>{" "}
        It has {count} fact{count === 1 ? "" : "s"} attached. Where should {count === 1 ? "it" : "they"} go?
      </p>
      <div className="choices">
        {roles.length > 0 && (
          <label className="toggle">
            <input type="radio" name="removeaction" checked={action === "move"} onChange={() => setAction("move")} />
            Move to another role
          </label>
        )}
        <label className="toggle">
          <input type="radio" name="removeaction" checked={action === "unlink"} onChange={() => setAction("unlink")} />
          Keep them, not linked to any role
        </label>
        <label className="toggle">
          <input type="radio" name="removeaction" checked={action === "delete"} onChange={() => setAction("delete")} />
          Delete them as well
        </label>
      </div>
      {action === "move" && roles.length > 0 && (
        <label className="field">Move the facts to
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.title}, {r.employer}</option>)}
          </select>
        </label>
      )}
      <div className="row">
        <button className="primary" onClick={() => onConfirm(role, action, target)}>
          {action === "move" ? "Move facts and delete role" : action === "delete" ? "Delete role and facts" : "Delete role, keep facts"}
        </button>
        <button className="link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const PROJECT_FIELDS = [
  ["brief", "Brief"], ["idea", "Idea"], ["rationale", "Why it looks like that"], ["outcome", "Outcome"],
];

function ProjectCard({ project, onChange, onDelete }) {
  return (
    <article className={project.verified ? "project is-verified" : "project"}>
      <header>
        <input className="project-name" aria-label="Project name" defaultValue={project.name}
          onBlur={(e) => e.target.value !== project.name && onChange(project.id, { name: e.target.value })} />
        <p className="muted">{[project.client, project.sector, project.year].filter(Boolean).join(", ")}</p>
      </header>
      {PROJECT_FIELDS.map(([key, label]) => (
        <label key={key} className="field">
          {label}
          <textarea rows={2} defaultValue={project[key] ?? ""} placeholder={key === "rationale" ? "Missing. Employers ask for this." : ""}
            onBlur={(e) => (e.target.value || null) !== project[key] && onChange(project.id, { [key]: e.target.value || null })} />
        </label>
      ))}
      <label className="field">
        Link
        <input defaultValue={project.url ?? ""} placeholder="https://"
          onBlur={(e) => (e.target.value || null) !== project.url && onChange(project.id, { url: e.target.value || null })} />
      </label>
      <div className="fact-actions">
        <button className={project.verified ? "check is-on" : "check"} aria-pressed={project.verified}
          onClick={() => onChange(project.id, { verified: !project.verified })}>
          {project.verified ? "Confirmed" : "Confirm"}
        </button>
        <button className="link danger" onClick={() => onDelete(project.id)}>Delete</button>
      </div>
    </article>
  );
}
