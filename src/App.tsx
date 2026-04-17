import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Screen } from "./types";
import { StartSessionButton } from "./components/StartSessionButton";
import { RecordingsScreen } from "./screens/RecordingsScreen";
import { SessionDetailScreen } from "./screens/SessionDetailScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { StudyPlanScreen } from "./screens/StudyPlanScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { CoachScreen } from "./screens/CoachScreen";

function App() {
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [activeRecordingId, setActiveRecordingId] = useState<number | null>(null);
  const [setupDone, setSetupDone] = useState<boolean | null>(null); // null = checking
  const [setupStatus, setSetupStatus] = useState("Preparing Duet...");

  // Apply saved transcript typography on load
  useEffect(() => {
    const typo = localStorage.getItem("duet-typography") || "default";
    const fonts: Record<string, string> = {
      default: '"DM Sans", system-ui, sans-serif',
      classic: 'Georgia, "Times New Roman", serif',
      modern: '"Inter", "Helvetica Neue", system-ui, sans-serif',
      mono: '"JetBrains Mono", "SF Mono", monospace',
    };
    document.documentElement.style.setProperty("--font-transcript", fonts[typo] || fonts.default!);
  }, []);

  // Listen for tray menu navigation events
  useEffect(() => {
    const unlisten = listen<string>("navigate", (event) => {
      if (event.payload === "settings") setScreen("settings");
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // Listen for in-app navigation (from child components)
  useEffect(() => {
    const handler = (e: Event) => {
      const screen = (e as CustomEvent).detail as Screen;
      if (screen) setScreen(screen);
    };
    window.addEventListener("duet-navigate", handler);
    return () => window.removeEventListener("duet-navigate", handler);
  }, []);

  // Listen for warmup progress
  useEffect(() => {
    const unlisten = listen<string>("sidecar-progress", (event) => {
      try {
        const data = JSON.parse(event.payload);
        if (data.stage && typeof data.stage === "string" && data.stage.length > 3) {
          setSetupStatus(data.stage);
        }
      } catch {}
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // First launch: check if models are cached, run warmup if needed
  useEffect(() => {
    (async () => {
      try {
        const profileRes = await invoke<{ embedding_json: string | null; user_name: string | null }>("get_voice_profile");
        const countRes = await invoke<{ count: number }>("get_coach_session_count");

        // Run warmup in background (fast if models already cached)
        invoke("warmup_models").then(() => {
          setSetupDone(true);
          if (!profileRes.embedding_json && countRes.count === 0) {
            setScreen("coach");
          }
        }).catch(() => setSetupDone(true));

        // If models are likely cached (returning user), don't block
        if (profileRes.embedding_json || countRes.count > 0) {
          setSetupDone(true);
        }
      } catch {
        setSetupDone(true);
      }
    })();
  }, []);

  // Show setup screen while models are downloading (first launch only)
  if (setupDone === null || (setupDone === false)) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--color-bg)" }}>
        <div style={{ textAlign: "center", maxWidth: 400 }}>
          <div className="sidebar-logo" style={{ fontSize: 32, marginBottom: "var(--space-lg)" }}>DUET</div>
          <p style={{ fontSize: 14, color: "var(--color-text-secondary)", marginBottom: "var(--space-md)" }}>
            {setupStatus}
          </p>
          <div style={{ height: 4, background: "var(--color-surface-raised)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: "100%", background: "var(--color-primary)", borderRadius: 2, animation: "pulse-dot 2s ease-in-out infinite" }} />
          </div>
          <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: "var(--space-md)" }}>
            First launch downloads speech models (~3 GB). This only happens once.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <nav className="sidebar">
        <div className="sidebar-nav">
          {([
            ["dashboard", "Dashboard"],
            ["recordings", "Recording"],
            ["studyplan", "Practice"],
            ["settings", "Setting"],
          ] as [Screen, string][]).map(([key, label]) => (
            <a
              key={key}
              className={`sidebar-link ${screen === key ? "active" : ""}`}
              onClick={() => setScreen(key)}
            >
              {label}
            </a>
          ))}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "var(--space-sm)", padding: "0 var(--space-md)" }}>
          <button
            className="btn"
            style={{
              width: "100%", padding: "var(--space-xs) var(--space-md)",
              background: "transparent", color: "var(--color-text-muted)",
              border: "1px dashed var(--color-border)", fontSize: 11, fontWeight: 500,
              cursor: "pointer", fontFamily: "var(--font-body)",
              borderRadius: "var(--radius-md)",
            }}
            onClick={() => setScreen("coach_first")}
          >
            First Session
          </button>
          <button
            className="btn"
            style={{
              width: "100%", padding: "var(--space-sm) var(--space-md)",
              background: "transparent", color: "var(--color-primary)",
              border: "1.5px solid var(--color-primary)", fontSize: 13, fontWeight: 600,
              cursor: "pointer", fontFamily: "var(--font-body)",
              borderRadius: "var(--radius-md)",
            }}
            onClick={() => setScreen("coach")}
          >
            Start Practice
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)", padding: "0 var(--space-md) var(--space-md)" }}>
          <StartSessionButton
            onComplete={(id) => {
              setActiveRecordingId(id);
              setScreen("session_detail");
            }}
          />
        </div>
      </nav>

      <main className="main">
        {screen === "recordings" && (
          <RecordingsScreen
            onSelect={(id) => {
              setActiveRecordingId(id);
              setScreen("session_detail");
            }}
          />
        )}
        {screen === "session_detail" && (
          <SessionDetailScreen
            recordingId={activeRecordingId}
            onBack={() => setScreen("recordings")}
          />
        )}
        {screen === "dashboard" && <DashboardScreen />}
        {screen === "studyplan" && <StudyPlanScreen />}
        {screen === "settings" && <SettingsScreen />}
        {screen === "coach" && <CoachScreen forceFirst={false} />}
        {screen === "coach_first" && <CoachScreen forceFirst={true} />}
      </main>
    </div>
  );
}

export default App;
