import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import Login from "./pages/Login.jsx";
import Documents from "./pages/Documents.jsx";
import CareerBank from "./pages/CareerBank.jsx";
import Jobs from "./pages/Jobs.jsx";
import Preferences from "./pages/Preferences.jsx";
import Applications from "./pages/Applications.jsx";

const TABS = [
  { id: "jobs", label: "Jobs" },
  { id: "applications", label: "Applications" },
  { id: "documents", label: "Documents" },
  { id: "bank", label: "Career bank" },
  { id: "preferences", label: "Preferences" },
];

export default function App() {
  const [session, setSession] = useState(undefined);
  const [tab, setTab] = useState("jobs");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) return null;
  if (!session) return <Login />;

  return (
    <div className="shell">
      <header className="top">
        <h1 className="wordmark">Job Finder</h1>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "tab is-active" : "tab"}
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>
      <main className="page">
        {tab === "documents" && <Documents session={session} onParsed={() => setTab("bank")} />}
        {tab === "bank" && <CareerBank />}
        {tab === "jobs" && <Jobs onGenerated={() => setTab("applications")} />}
        {tab === "applications" && <Applications />}
        {tab === "preferences" && <Preferences />}
      </main>
    </div>
  );
}
