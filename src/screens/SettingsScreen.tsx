import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme";

export function SettingsScreen() {
  const { mode, setMode } = useTheme();
  const [settingsTab, setSettingsTab] = useState<"general" | "session" | "account" | "billing">("general");

  return (
    <>
      <p className="page-label">Setting</p>

      {/* Settings tabs */}
      <div style={{ display: "flex", gap: 0, borderRadius: "var(--radius-md)", overflow: "hidden", border: "1px solid var(--color-border)", marginBottom: "var(--space-lg)" }}>
        {(["general", "session", "account", "billing"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setSettingsTab(tab)}
            style={{
              flex: 1,
              padding: "var(--space-sm) var(--space-md)",
              background: settingsTab === tab ? "var(--color-primary)" : "var(--color-surface)",
              color: settingsTab === tab ? "var(--color-primary-text)" : "var(--color-text-secondary)",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-body)",
              fontSize: 13,
              fontWeight: 600,
              textTransform: "capitalize",
              borderRight: tab !== "billing" ? "1px solid var(--color-border)" : "none",
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {settingsTab === "general" && <SettingsGeneral mode={mode} setMode={setMode} />}
      {settingsTab === "session" && <SettingsSession />}
      {settingsTab === "account" && <SettingsAccount />}
      {settingsTab === "billing" && <SettingsBilling />}
    </>
  );
}

function SettingsGeneral({ mode, setMode }: { mode: string; setMode: (m: "light" | "auto" | "dark") => void }) {
  const [userName, setUserName] = useState("");
  const [nameSaved, setNameSaved] = useState(false);
  const [typo, setTypo] = useState(() => localStorage.getItem("duet-typography") || "default");

  useEffect(() => {
    invoke<{ user_name: string | null }>("get_voice_profile").then((res) => {
      if (res.user_name) setUserName(res.user_name);
    }).catch(() => {});
  }, []);

  return (
    <>
      <div className="card">
        <h3 className="settings-heading">Your Name</h3>
        <p style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: "var(--space-sm)" }}>
          Used in transcripts and coaching to identify your speech.
        </p>
        <div style={{ display: "flex", gap: "var(--space-sm)" }}>
          <input
            type="text"
            value={userName}
            onChange={(e) => { setUserName(e.target.value); setNameSaved(false); }}
            placeholder="Enter your name"
            style={{
              flex: 1, padding: "var(--space-xs) var(--space-sm)",
              border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)",
              background: "var(--color-surface)", color: "var(--color-text)",
              fontFamily: "var(--font-body)", fontSize: 14,
            }}
          />
          <button
            className="btn btn-primary"
            style={{ fontSize: 13, padding: "var(--space-xs) var(--space-md)" }}
            onClick={() => {
              invoke("save_user_name", { userName: userName.trim() }).then(() => setNameSaved(true)).catch(() => {});
            }}
          >
            {nameSaved ? "Saved" : "Save"}
          </button>
        </div>
      </div>

      <div className="card">
        <h3 className="settings-heading">Appearance</h3>
        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-muted)", marginBottom: "var(--space-sm)" }}>Display</p>
        <div style={{ display: "flex", gap: "var(--space-md)" }}>
          {([
            { key: "light" as const, label: "Light", bg: "#FAFAF8", surface: "#FFFFFF", text: "#1A1A18", muted: "#7A7A72", border: "#E5E5E0", accent: "#2A7D6E" },
            { key: "auto" as const, label: "Auto", bg: "linear-gradient(90deg, #FAFAF8 50%, #1A1A18 50%)", surface: "#FFFFFF", text: "#1A1A18", muted: "#7A7A72", border: "#E5E5E0", accent: "#2A7D6E" },
            { key: "dark" as const, label: "Dark", bg: "#1A1A18", surface: "#2A2A28", text: "#E5E5E0", muted: "#7A7A72", border: "#3A3A38", accent: "#3BCEAC" },
          ]).map(({ key, label, bg, surface, text, muted, border, accent }) => (
            <div
              key={key}
              onClick={() => setMode(key)}
              style={{ cursor: "pointer", textAlign: "center", width: 120 }}
            >
              {key === "auto" ? (
                <div style={{
                  width: 120, height: 100, boxSizing: "border-box",
                  display: "flex", overflow: "hidden",
                  borderRadius: "var(--radius-md)",
                  border: mode === key ? "2px solid #2A7D6E" : "2px solid #E5E5E0",
                }}>
                  {/* Light half */}
                  <div style={{ flex: 1, background: "#FAFAF8", padding: 6, display: "flex", gap: 4 }}>
                    <div style={{ width: 12, background: "#FFFFFF", borderRadius: 2, display: "flex", flexDirection: "column", gap: 2, padding: 2 }}>
                      <div style={{ height: 2, background: "#7A7A72", borderRadius: 1 }} />
                      <div style={{ height: 2, background: "#7A7A72", borderRadius: 1 }} />
                    </div>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                      <div style={{ height: 2, width: "70%", background: "#1A1A18", borderRadius: 1, opacity: 0.6 }} />
                      <div style={{ flex: 1, background: "#FFFFFF", borderRadius: 2, padding: 3, display: "flex", flexDirection: "column", gap: 2 }}>
                        <div style={{ height: 2, background: "#7A7A72", borderRadius: 1, opacity: 0.4 }} />
                        <div style={{ height: 2, width: "60%", background: "#7A7A72", borderRadius: 1, opacity: 0.4 }} />
                      </div>
                    </div>
                  </div>
                  {/* Dark half */}
                  <div style={{ flex: 1, background: "#1A1A18", padding: 6, display: "flex", gap: 4 }}>
                    <div style={{ width: 12, background: "#2A2A28", borderRadius: 2, display: "flex", flexDirection: "column", gap: 2, padding: 2 }}>
                      <div style={{ height: 2, background: "#7A7A72", borderRadius: 1 }} />
                      <div style={{ height: 2, background: "#7A7A72", borderRadius: 1 }} />
                    </div>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                      <div style={{ height: 2, width: "70%", background: "#E5E5E0", borderRadius: 1, opacity: 0.6 }} />
                      <div style={{ flex: 1, background: "#2A2A28", borderRadius: 2, padding: 3, display: "flex", flexDirection: "column", gap: 2 }}>
                        <div style={{ height: 2, background: "#7A7A72", borderRadius: 1, opacity: 0.4 }} />
                        <div style={{ height: 2, width: "60%", background: "#7A7A72", borderRadius: 1, opacity: 0.4 }} />
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{
                  background: bg,
                  padding: 10, width: 120, height: 100, boxSizing: "border-box",
                  display: "flex", gap: 6,
                  borderRadius: "var(--radius-md)",
                  border: mode === key ? `2px solid ${accent}` : `2px solid ${border}`,
                }}>
                  <div style={{ width: 20, background: surface, borderRadius: 3, display: "flex", flexDirection: "column", gap: 2, padding: 3 }}>
                    <div style={{ height: 2, background: muted, borderRadius: 1 }} />
                    <div style={{ height: 2, background: muted, borderRadius: 1 }} />
                    <div style={{ height: 2, background: muted, borderRadius: 1 }} />
                  </div>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ height: 3, width: "60%", background: text, borderRadius: 1, opacity: 0.7 }} />
                    <div style={{ flex: 1, background: surface, borderRadius: 3, padding: 4, display: "flex", flexDirection: "column", gap: 2 }}>
                      <div style={{ height: 2, width: "80%", background: muted, borderRadius: 1, opacity: 0.5 }} />
                      <div style={{ height: 2, width: "50%", background: muted, borderRadius: 1, opacity: 0.5 }} />
                      <div style={{ height: 6, width: "40%", background: accent, borderRadius: 2, marginTop: 2, opacity: 0.8 }} />
                    </div>
                  </div>
                </div>
              )}
              <p style={{
                marginTop: 6, fontSize: 12, fontWeight: 600,
                color: mode === key ? "var(--color-primary)" : "var(--color-text-muted)",
              }}>
                {label}
              </p>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-muted)", marginTop: "var(--space-lg)", marginBottom: "var(--space-sm)" }}>Session Font</p>
        <div style={{ display: "flex", gap: "var(--space-md)" }}>
          {([
            { key: "default", label: "Default", display: '"Satoshi", system-ui, sans-serif', body: '"DM Sans", system-ui, sans-serif', sample: "The quick brown fox" },
            { key: "classic", label: "Classic", display: 'Georgia, "Times New Roman", serif', body: 'Georgia, "Times New Roman", serif', sample: "The quick brown fox" },
            { key: "modern", label: "Modern", display: '"Inter", "Helvetica Neue", system-ui, sans-serif', body: '"Inter", "Helvetica Neue", system-ui, sans-serif', sample: "The quick brown fox" },
            { key: "mono", label: "Mono", display: '"JetBrains Mono", "SF Mono", monospace', body: '"JetBrains Mono", "SF Mono", monospace', sample: "The quick brown fox" },
          ] as const).map(({ key, label, display, body, sample }) => (
              <div
                key={key}
                onClick={() => {
                  localStorage.setItem("duet-typography", key);
                  document.documentElement.style.setProperty("--font-transcript", body);
                  setTypo(key);
                }}
                style={{
                  cursor: "pointer", width: 120, textAlign: "center",
                }}
              >
                <div style={{
                  padding: "var(--space-sm)", width: 120, height: 100, boxSizing: "border-box",
                  borderRadius: "var(--radius-md)",
                  border: typo === key ? "2px solid var(--color-primary)" : "2px solid var(--color-border)",
                  display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 4,
                }}>
                  <p style={{ fontFamily: display, fontWeight: 700, fontSize: 14 }}>Aa Bb Cc</p>
                  <p style={{ fontFamily: body, fontSize: 11, color: "var(--color-text-muted)" }}>{sample}</p>
                </div>
                <p style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color: typo === key ? "var(--color-primary)" : "var(--color-text-muted)" }}>
                  {label}
                </p>
              </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 className="settings-heading">Audio</h3>
        <p style={{ color: "var(--color-text-muted)", fontSize: 14 }}>
          Microphone selection and recording quality coming soon.
        </p>
      </div>

      <div className="card">
        <h3 className="settings-heading">Data</h3>
        <p style={{ color: "var(--color-text-muted)", fontSize: 14 }}>
          All recordings and analysis data are stored locally on your device.
          Nothing leaves your machine except transcript text sent to the AI for analysis.
        </p>
      </div>
    </>
  );
}

function SettingsSession() {
  const [pauseTimeout, setPauseTimeout] = useState(() =>
    Number(localStorage.getItem("duet-pause-timeout") || "5")
  );
  const [speakerMode, setSpeakerMode] = useState(() =>
    localStorage.getItem("duet-speaker-mode") || "auto"
  );

  const handleChange = (val: number) => {
    setPauseTimeout(val);
    localStorage.setItem("duet-pause-timeout", String(val));
  };

  const handleSpeakerMode = (val: string) => {
    setSpeakerMode(val);
    localStorage.setItem("duet-speaker-mode", val);
    if (val === "all") {
      localStorage.removeItem("duet-my-speaker");
    }
  };

  return (
    <>
      <div className="card">
        <h3 className="settings-heading">Speaker Detection</h3>
        <p style={{ fontSize: 14, color: "var(--color-text-secondary)", marginBottom: "var(--space-md)" }}>
          When multiple speakers are detected, choose whose speech to coach.
        </p>
        <div style={{ display: "flex", gap: 0, borderRadius: "var(--radius-md)", overflow: "hidden", border: "1px solid var(--color-border)" }}>
          {([
            { key: "auto", label: "My speech only" },
            { key: "all", label: "All speakers" },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => handleSpeakerMode(key)}
              style={{
                flex: 1,
                padding: "var(--space-sm) var(--space-md)",
                background: speakerMode === key ? "var(--color-primary)" : "var(--color-surface)",
                color: speakerMode === key ? "var(--color-primary-text)" : "var(--color-text-secondary)",
                border: "none",
                cursor: "pointer",
                fontFamily: "var(--font-body)",
                fontSize: 13,
                fontWeight: 600,
                borderRight: key !== "all" ? "1px solid var(--color-border)" : "none",
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: "var(--space-xs)" }}>
          {speakerMode === "auto"
            ? "Auto-detects you as the primary speaker. Only your disfluencies are flagged."
            : "All speakers' speech is analyzed and coached."}
        </p>
      </div>

      <div className="card">
        <h3 className="settings-heading">Auto-stop</h3>
        <p style={{ fontSize: 14, color: "var(--color-text-secondary)", marginBottom: "var(--space-md)" }}>
          Automatically stop the session when paused for too long.
        </p>

        <div>
          <p style={{ fontSize: 13, fontWeight: 500, marginBottom: "var(--space-sm)" }}>
            Stop session when paused for
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-md)" }}>
            <input
              type="range"
              min={1}
              max={10}
              value={pauseTimeout}
              onChange={(e) => handleChange(Number(e.target.value))}
              style={{ flex: 1, accentColor: "var(--color-primary)" }}
            />
            <span className="metric" style={{ minWidth: 60, textAlign: "center" }}>
              {pauseTimeout} min
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--color-text-muted)", marginTop: "var(--space-2xs)" }}>
            <span>1 min</span>
            <span>10 min</span>
          </div>
        </div>
      </div>
    </>
  );
}

function SettingsAccount() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // Check if already logged in
  useEffect(() => {
    const stored = localStorage.getItem("duet-user-email");
    if (stored) {
      setLoggedIn(true);
      setUserEmail(stored);
    }
  }, []);

  const handleSendLink = () => {
    if (!email.includes("@")) return;
    setSent(true);
    // TODO: Call proxy backend to send magic link
  };

  const handleSignOut = () => {
    localStorage.removeItem("duet-user-email");
    setLoggedIn(false);
    setUserEmail(null);
    setSent(false);
    setEmail("");
  };

  if (loggedIn && userEmail) {
    return (
      <div className="card">
        <h3 className="settings-heading">Account</h3>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "var(--space-md)" }}>
          <div>
            <p style={{ fontSize: 14, fontWeight: 500 }}>{userEmail}</p>
            <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Signed in</p>
          </div>
          <button className="btn btn-secondary" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h3 className="settings-heading">Account</h3>
      <p style={{ color: "var(--color-text-secondary)", fontSize: 14, marginBottom: "var(--space-md)" }}>
        Sign in to sync your subscription and unlock AI-powered analysis.
        We'll send a magic link to your email. No password needed.
      </p>

      {!sent ? (
        <div>
          <div style={{ display: "flex", gap: "var(--space-sm)" }}>
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSendLink()}
              className="input"
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-primary"
              onClick={handleSendLink}
              disabled={!email.includes("@")}
            >
              Send magic link
            </button>
          </div>
        </div>
      ) : (
        <div style={{ textAlign: "center", padding: "var(--space-lg)" }}>
          <p style={{ fontSize: 16, fontWeight: 500, marginBottom: "var(--space-sm)" }}>
            Check your email
          </p>
          <p style={{ color: "var(--color-text-secondary)", fontSize: 14 }}>
            We sent a sign-in link to <strong>{email}</strong>.
            Click the link in the email to sign in.
          </p>
          <button
            className="btn btn-secondary"
            style={{ marginTop: "var(--space-md)" }}
            onClick={() => setSent(false)}
          >
            Use a different email
          </button>
        </div>
      )}
    </div>
  );
}

function SettingsBilling() {
  const [showPlans, setShowPlans] = useState(false);
  const [showAddCard, setShowAddCard] = useState(false);
  const [currentPlan] = useState<"free" | "pro">("free");
  const [cardLast4] = useState<string | null>(null);

  if (showPlans) {
    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", marginBottom: "var(--space-md)" }}>
          <button className="btn btn-secondary" onClick={() => setShowPlans(false)} style={{ padding: "var(--space-xs) var(--space-sm)", fontSize: 13 }}>
            ← Back
          </button>
          <p className="page-label" style={{ margin: 0 }}>Choose a plan</p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-md)" }}>
          <div className="card" style={{ border: currentPlan === "free" ? "2px solid var(--color-primary)" : undefined }}>
            <h3 className="settings-heading">Free</h3>
            <div className="plan-price">$0</div>
            <p style={{ color: "var(--color-text-muted)", fontSize: 13, marginBottom: "var(--space-md)" }}>per month</p>
            <ul className="plan-features">
              <li>3 recordings per month</li>
              <li>Speech coach only</li>
              <li>Basic delivery analysis</li>
            </ul>
            {currentPlan === "free" ? (
              <p style={{ color: "var(--color-primary)", fontSize: 13, fontWeight: 600, marginTop: "var(--space-md)" }}>Current plan</p>
            ) : (
              <button className="btn btn-secondary" style={{ width: "100%", marginTop: "var(--space-md)" }}>
                Downgrade
              </button>
            )}
          </div>

          <div className="card" style={{ border: currentPlan === "pro" ? "2px solid var(--color-primary)" : undefined }}>
            <h3 className="settings-heading">Pro</h3>
            <div className="plan-price">$19</div>
            <p style={{ color: "var(--color-text-muted)", fontSize: 13, marginBottom: "var(--space-md)" }}>per month</p>
            <ul className="plan-features">
              <li>Unlimited recordings</li>
              <li>Speech + Knowledge coach</li>
              <li>AI-powered analysis</li>
              <li>Practice drills with feedback</li>
              <li>Document ingestion</li>
              <li>Progress tracking</li>
            </ul>
            {currentPlan === "pro" ? (
              <p style={{ color: "var(--color-primary)", fontSize: 13, fontWeight: 600, marginTop: "var(--space-md)" }}>Current plan</p>
            ) : (
              <button className="btn btn-primary" style={{ width: "100%", marginTop: "var(--space-md)" }}>
                Upgrade to Pro
              </button>
            )}
          </div>
        </div>
      </>
    );
  }

  if (showAddCard) {
    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", marginBottom: "var(--space-md)" }}>
          <button className="btn btn-secondary" onClick={() => setShowAddCard(false)} style={{ padding: "var(--space-xs) var(--space-sm)", fontSize: 13 }}>
            ← Back
          </button>
          <p className="page-label" style={{ margin: 0 }}>Add payment method</p>
        </div>

        <div className="card">
          <h3 className="settings-heading">Credit or debit card</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)", marginTop: "var(--space-md)" }}>
            <div>
              <label className="input-label">Card number</label>
              <input className="input" placeholder="1234 5678 9012 3456" />
            </div>
            <div style={{ display: "flex", gap: "var(--space-md)" }}>
              <div style={{ flex: 1 }}>
                <label className="input-label">Expiry</label>
                <input className="input" placeholder="MM / YY" />
              </div>
              <div style={{ flex: 1 }}>
                <label className="input-label">CVC</label>
                <input className="input" placeholder="123" />
              </div>
            </div>
            <div>
              <label className="input-label">Name on card</label>
              <input className="input" placeholder="Full name" />
            </div>
            <button className="btn btn-primary" style={{ width: "100%", marginTop: "var(--space-sm)" }}>
              Save card
            </button>
          </div>
          <p style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: "var(--space-md)" }}>
            Your card details are processed securely. We never store your full card number.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="card">
        <h3 className="settings-heading">Current plan</h3>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "var(--space-md)" }}>
          <div>
            <p style={{ fontSize: 16, fontWeight: 600 }}>
              {currentPlan === "pro" ? "Pro" : "Free"}
            </p>
            <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>
              {currentPlan === "pro"
                ? "Unlimited recordings, full AI analysis"
                : "3 recordings per month, speech coach only"}
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => setShowPlans(true)}>
            {currentPlan === "pro" ? "Manage plan" : "Upgrade"}
          </button>
        </div>
      </div>

      <div className="card">
        <h3 className="settings-heading">Payment method</h3>
        {cardLast4 ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "var(--space-md)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
              <span className="metric">•••• {cardLast4}</span>
            </div>
            <button className="btn btn-secondary" onClick={() => setShowAddCard(true)}>
              Update
            </button>
          </div>
        ) : (
          <div style={{ marginTop: "var(--space-md)" }}>
            <p style={{ color: "var(--color-text-muted)", fontSize: 14, marginBottom: "var(--space-md)" }}>
              No payment method on file.
            </p>
            <button className="btn btn-secondary" onClick={() => setShowAddCard(true)}>
              Add credit card
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="settings-heading">Billing history</h3>
        <p style={{ color: "var(--color-text-muted)", fontSize: 14, marginTop: "var(--space-md)" }}>
          No invoices yet.
        </p>
      </div>
    </>
  );
}
