import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const MODES = [["remote", "Remote"], ["hybrid", "Hybrid"], ["onsite", "Onsite"]];
const TYPES = [["ongoing", "Ongoing"], ["fixed_term", "Fixed term"], ["contract", "Contract"], ["part_time", "Part time"], ["casual", "Casual"]];

// Used only when no preferences row exists yet.
const DEFAULTS = {
  home_location: "Preston, Melbourne",
  max_commute_minutes: 45,
  salary_floor: 75000,
  salary_target: 95000,
  work_modes: ["remote", "hybrid"],
  employment_types: ["ongoing", "fixed_term"],
  keywords: [],
  excluded_employers: [],
  red_flag_phrases: [],
  fit_weight: 0.6,
};
const RULE_DEFAULTS = {
  title_include: [],
  title_exclude: [],
  auto_hide_below: 60,
  max_per_source: 10,
};

const list = (v) => (v ?? []).join(", ");
const toList = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

export default function Preferences() {
  const [form, setForm] = useState(DEFAULTS);
  const [rules, setRules] = useState(RULE_DEFAULTS);
  const [status, setStatus] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    supabase.from("preferences").select("*").maybeSingle().then(({ data }) => {
      if (data) {
        setForm({ ...DEFAULTS, ...data });
        setRules({ ...RULE_DEFAULTS, ...(data.scoring_rules ?? {}) });
      }
      setLoaded(true);
    });
  }, []);

  function set(key, value) { setForm((f) => ({ ...f, [key]: value })); }
  function setRule(key, value) { setRules((r) => ({ ...r, [key]: value })); }
  function toggle(key, value) {
    const current = form[key] ?? [];
    set(key, current.includes(value) ? current.filter((v) => v !== value) : [...current, value]);
  }

  async function save() {
    setStatus(null);
    const { data: { user } } = await supabase.auth.getUser();
    const row = {
      owner_id: user.id,
      home_location: form.home_location || null,
      max_commute_minutes: Number(form.max_commute_minutes) || null,
      salary_floor: Number(form.salary_floor) || null,
      salary_target: Number(form.salary_target) || null,
      work_modes: form.work_modes,
      employment_types: form.employment_types,
      keywords: form.keywords,
      excluded_employers: form.excluded_employers,
      red_flag_phrases: form.red_flag_phrases,
      fit_weight: Number(form.fit_weight),
      scoring_rules: {
        ...rules,
        auto_hide_below: Number(rules.auto_hide_below) || 0,
        max_per_source: Number(rules.max_per_source) || 10,
      },
    };
    const { error } = await supabase.from("preferences").upsert(row, { onConflict: "owner_id" });
    setStatus(error
      ? { type: "error", text: error.message }
      : { type: "ok", text: "Saved. The next sweep uses these settings." });
  }

  // Warn when a word appears in both lists, or when an include word is cancelled by an exclude word.
  const clashes = (rules.title_include ?? []).filter((inc) =>
    (rules.title_exclude ?? []).some((exc) =>
      inc.toLowerCase().includes(exc.toLowerCase()) || exc.toLowerCase().includes(inc.toLowerCase())));

  if (!loaded) return null;

  return (
    <section>
      <div className="intro">
        <h2>Preferences</h2>
        <p className="muted">
          What the app searches for, what it throws away, and what counts as a good job for you.
        </p>
      </div>

      <div className="panel">
        <h3>What the app searches for</h3>
        <label className="field">Search terms
          <input className="words" value={list(form.keywords)}
            onChange={(e) => set("keywords", toList(e.target.value))} />
          <span className="hint">
            Comma separated. These are the actual searches sent to Adzuna, LinkedIn and Careers.Vic, so they
            decide what gets found at all. The first six are used each sweep.
          </span>
        </label>

        <label className="field">A job title must contain one of these
          <input className="words" value={list(rules.title_include)}
            onChange={(e) => setRule("title_include", toList(e.target.value))} />
          <span className="hint">
            Checked before anything is sent for scoring, so off-topic jobs cost nothing. Leave empty to score
            everything found.
          </span>
          {(rules.title_include ?? []).length > 0 && (
            <span className="chips">
              {rules.title_include.map((w) => <span key={w} className="chip allow">{w}</span>)}
            </span>
          )}
        </label>

        <label className="field">And must not contain any of these
          <input className="words" value={list(rules.title_exclude)}
            onChange={(e) => setRule("title_exclude", toList(e.target.value))} />
          <span className="hint">Discarded first, before the list above is checked.</span>
          {(rules.title_exclude ?? []).length > 0 && (
            <span className="chips">
              {rules.title_exclude.map((w) => <span key={w} className="chip block">{w}</span>)}
            </span>
          )}
        </label>

        {clashes.length > 0 && (
          <p className="error inline" role="status">
            {clashes.join(", ")} appears in both lists. Exclude wins, so nothing with those words will ever be scored.
          </p>
        )}

        <div className="grid-2">
          <label className="field">Hide jobs scoring below
            <input type="number" min="0" max="100" value={rules.auto_hide_below ?? 0}
              onChange={(e) => setRule("auto_hide_below", e.target.value)} />
            <span className="hint">Scored once, then kept out of the table. 0 shows everything.</span>
          </label>
          <label className="field">New jobs per source, per sweep
            <input type="number" min="1" max="50" value={rules.max_per_source ?? 10}
              onChange={(e) => setRule("max_per_source", e.target.value)} />
            <span className="hint">Caps what each source can add, so one can't crowd out the others.</span>
          </label>
        </div>
      </div>

      <div className="panel">
        <h3>What makes a job suit you</h3>
        <div className="grid-2">
          <label className="field">Based in
            <input value={form.home_location ?? ""} onChange={(e) => set("home_location", e.target.value)} />
          </label>
          <label className="field">Longest acceptable commute (minutes)
            <input type="number" value={form.max_commute_minutes ?? ""} onChange={(e) => set("max_commute_minutes", e.target.value)} />
          </label>
          <label className="field">Salary floor
            <input type="number" step="1000" value={form.salary_floor ?? ""} onChange={(e) => set("salary_floor", e.target.value)} />
          </label>
          <label className="field">Salary target
            <input type="number" step="1000" value={form.salary_target ?? ""} onChange={(e) => set("salary_target", e.target.value)} />
          </label>
        </div>

        <fieldset className="choices">
          <legend>Work arrangement</legend>
          {MODES.map(([id, label]) => (
            <label key={id} className="toggle">
              <input type="checkbox" checked={(form.work_modes ?? []).includes(id)} onChange={() => toggle("work_modes", id)} />{label}
            </label>
          ))}
        </fieldset>

        <fieldset className="choices">
          <legend>Employment type</legend>
          {TYPES.map(([id, label]) => (
            <label key={id} className="toggle">
              <input type="checkbox" checked={(form.employment_types ?? []).includes(id)} onChange={() => toggle("employment_types", id)} />{label}
            </label>
          ))}
        </fieldset>

        <label className="field">Employers to ignore
          <input value={list(form.excluded_employers)} onChange={(e) => set("excluded_employers", toList(e.target.value))} />
          <span className="hint">Anything from these scores zero on the preference half.</span>
        </label>

        <label className="field">Phrases that count against a job
          <input value={list(form.red_flag_phrases)} onChange={(e) => set("red_flag_phrases", toList(e.target.value))} />
          <span className="hint">Each one found in an ad takes 10 points off the preference score.</span>
        </label>

        <label className="field">
          Balance: {Math.round(form.fit_weight * 100)}% how well you match the job,
          {" "}{Math.round((1 - form.fit_weight) * 100)}% how well it suits you
          <input type="range" min="0" max="1" step="0.05" value={form.fit_weight}
            onChange={(e) => set("fit_weight", e.target.value)} />
        </label>
      </div>

      <div className="row">
        <button className="primary" onClick={save}>Save preferences</button>
        {status && <span className={status.type === "error" ? "error inline" : "notice inline"}>{status.text}</span>}
      </div>
    </section>
  );
}
