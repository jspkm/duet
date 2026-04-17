import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface DashboardData {
  recording_id: number;
  recorded_at: string;
  duration_seconds: number;
  delivery_score: number;
  filler_count: number;
  disfluency_count: number;
  pause_count: number;
  pace_wpm: number;
  flagged_moment_count: number;
  drill_attempt_count: number;
}

export function DashboardScreen() {
  const [data, setData] = useState<DashboardData[]>([]);
  const [baseline, setBaseline] = useState<{ filler_rate: number; pace_wpm: number; hedging_rate: number; pause_rate: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      invoke<DashboardData[]>("get_dashboard"),
      invoke<any>("get_baseline"),
    ])
      .then(([d, b]) => { setData(d); if (b) setBaseline(b); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <>
        <h1 className="settings-heading">Loading...</h1>
      </>
    );
  }

  if (data.length === 0) {
    return (
      <>
        <h1 className="settings-heading">Your progress</h1>
        <div className="card">
          <p style={{ color: "var(--color-text-muted)" }}>
            No sessions yet. Record a meeting to start tracking your progress.
          </p>
        </div>
      </>
    );
  }

  const latest = data[data.length - 1]!;
  const first = data[0]!;
  const totalRecordings = data.length;
  const totalDrills = data.reduce((sum, d) => sum + d.drill_attempt_count, 0);
  const totalMoments = data.reduce((sum, d) => sum + d.flagged_moment_count, 0);

  // Trends
  const latestFillers = latest.filler_count;
  const firstFillers = first.filler_count;
  const fillerTrend = totalRecordings > 1 ? latestFillers - firstFillers : 0;

  const latestPace = latest.pace_wpm;
  const latestScore = latest.delivery_score;

  // Bar chart max for scaling
  const maxFillers = Math.max(...data.map((d) => d.filler_count), 1);
  const maxDisfluencies = Math.max(...data.map((d) => d.disfluency_count), 1);

  // Streaks: consecutive days (today back) with any practice or drill activity
  const STREAK_ICONS = ["⚡", "🚀", "⭐", "✨", "💎", "🔥", "🌟", "💫", "🎯", "🏆", "🌈", "☄️", "🌠", "🎖️", "🥇", "👑", "🦄", "🌙", "☀️", "🪄"];
  const activeDays = new Set<string>();
  for (const d of data) {
    if (d.drill_attempt_count > 0 || d.duration_seconds > 0) {
      activeDays.add(new Date(d.recorded_at).toDateString());
    }
  }
  const dayMs = 86400000;
  let currentStreak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; ; i++) {
    const day = new Date(today.getTime() - i * dayMs).toDateString();
    if (activeDays.has(day)) currentStreak++;
    else if (i === 0) continue; // allow today to be empty
    else break;
  }
  // Highest streak across history
  const sortedDays = [...activeDays]
    .map((s) => new Date(s).getTime())
    .sort((a, b) => a - b);
  let highestStreak = 0;
  let run = 0;
  let prev = -Infinity;
  for (const t of sortedDays) {
    if (t - prev === dayMs) run++;
    else run = 1;
    if (run > highestStreak) highestStreak = run;
    prev = t;
  }
  if (currentStreak > highestStreak) highestStreak = currentStreak;
  const streakIcon = STREAK_ICONS[Math.floor(Date.now() / dayMs) % STREAK_ICONS.length];

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-md)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
          <span style={{ fontSize: 22, filter: "grayscale(0.8)", display: "inline-block" }}>{streakIcon}</span>
          <span style={{ fontSize: 15, fontWeight: 400, color: "var(--color-text)" }}>
            {currentStreak}
          </span>
        </div>
        <span style={{ fontSize: 13, color: "var(--color-text-muted)" }}>
          Highest streak is {highestStreak}
        </span>
      </div>
      <div className="card">
      <h1 className="settings-heading">Your progress</h1>

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "var(--space-md)", marginBottom: "var(--space-lg)" }}>
        <div className="card" style={{ textAlign: "center" }}>
          <p className="stat-value">{totalRecordings}</p>
          <p className="stat-label">Recording</p>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <p className="stat-value">{latestScore > 0 ? latestScore.toFixed(1) : "—"}</p>
          <p className="stat-label">Latest Score</p>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <p className="stat-value">{totalDrills}</p>
          <p className="stat-label">Drill Attempts</p>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <p className="stat-value" style={{ color: fillerTrend <= 0 ? "var(--color-success)" : "var(--color-error)" }}>
            {fillerTrend === 0 ? "—" : fillerTrend > 0 ? `+${fillerTrend}` : fillerTrend}
          </p>
          <p className="stat-label">Filler Trend</p>
        </div>
      </div>

      {/* Baseline comparison */}
      {baseline && data.length > 1 && (() => {
        const latestDur = latest.duration_seconds || 1;
        const currentFillerRate = (latest.filler_count / latestDur) * 60;
        const fillerImprovement = baseline.filler_rate > 0
          ? Math.round((1 - currentFillerRate / baseline.filler_rate) * 100)
          : 0;
        const paceChange = latest.pace_wpm - baseline.pace_wpm;

        return (
          <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
            <h3 className="settings-heading">Since your first session</h3>
            <div style={{ display: "flex", gap: "var(--space-lg)", flexWrap: "wrap" }}>
              <div>
                <p style={{ fontSize: 24, fontWeight: 700, color: fillerImprovement > 0 ? "var(--color-success)" : "var(--color-error)" }}>
                  {fillerImprovement > 0 ? `${fillerImprovement}%` : fillerImprovement === 0 ? "—" : `+${Math.abs(fillerImprovement)}%`}
                </p>
                <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                  {fillerImprovement > 0 ? "fewer fillers" : fillerImprovement < 0 ? "more fillers" : "fillers unchanged"}
                </p>
              </div>
              <div>
                <p style={{ fontSize: 24, fontWeight: 700, color: "var(--color-text)" }}>
                  {latest.pace_wpm > 0 ? `${Math.round(latest.pace_wpm)}` : "—"}
                </p>
                <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                  wpm (baseline: {Math.round(baseline.pace_wpm)})
                </p>
              </div>
              <div>
                <p style={{ fontSize: 24, fontWeight: 700, color: "var(--color-text)" }}>
                  {latest.delivery_score > 0 ? latest.delivery_score.toFixed(1) : "—"}
                </p>
                <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>delivery score</p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Filler words over time */}
      <div className="card">
        <h3 className="settings-heading">Filler words per session</h3>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 120, marginTop: "var(--space-md)" }}>
          {data.map((d, i) => (
            <div
              key={d.recording_id}
              title={`Session #${d.recording_id}: ${d.filler_count} fillers`}
              style={{
                flex: 1,
                height: `${(d.filler_count / maxFillers) * 100}%`,
                minHeight: d.filler_count > 0 ? 4 : 1,
                background: i === data.length - 1 ? "var(--color-primary)" : "var(--color-border)",
                borderRadius: "var(--radius-sm) var(--radius-sm) 0 0",
                transition: "height 0.3s ease",
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: "var(--space-xs)" }}>
          <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            {new Date(first.recorded_at).toLocaleDateString()}
          </span>
          <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            {new Date(latest.recorded_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      {/* Disfluencies over time */}
      <div className="card">
        <h3 className="settings-heading">Total disfluencies per session</h3>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 120, marginTop: "var(--space-md)" }}>
          {data.map((d, i) => (
            <div
              key={d.recording_id}
              title={`Session #${d.recording_id}: ${d.disfluency_count} disfluencies`}
              style={{
                flex: 1,
                height: `${(d.disfluency_count / maxDisfluencies) * 100}%`,
                minHeight: d.disfluency_count > 0 ? 4 : 1,
                background: i === data.length - 1 ? "var(--color-primary)" : "var(--color-border)",
                borderRadius: "var(--radius-sm) var(--radius-sm) 0 0",
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: "var(--space-xs)" }}>
          <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            {new Date(first.recorded_at).toLocaleDateString()}
          </span>
          <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            {new Date(latest.recorded_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      {/* Pace */}
      <div className="card">
        <h3 className="settings-heading">Speaking pace</h3>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-lg)", marginTop: "var(--space-md)" }}>
          <div>
            <p className="stat-value">{latestPace.toFixed(0)}</p>
            <p className="stat-label">WPM (latest)</p>
          </div>
          <div style={{ flex: 1, fontSize: 13, color: "var(--color-text-secondary)" }}>
            {latestPace < 120 && "On the slower side. Good for clarity, but watch for energy."}
            {latestPace >= 120 && latestPace <= 160 && "Good pace. Natural and conversational."}
            {latestPace > 160 && latestPace <= 190 && "Slightly fast. Your audience may struggle to keep up."}
            {latestPace > 190 && "Rushing. Slow down. Your points need room to land."}
          </div>
        </div>
      </div>

      {/* Recent recordings table */}
      <div className="card">
        <h3 className="settings-heading">Session history</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "var(--space-md)", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
              <th style={{ textAlign: "left", padding: "var(--space-sm)", color: "var(--color-text-muted)", fontWeight: 500 }}>Date</th>
              <th style={{ textAlign: "right", padding: "var(--space-sm)", color: "var(--color-text-muted)", fontWeight: 500, fontFamily: "var(--font-mono)" }}>Score</th>
              <th style={{ textAlign: "right", padding: "var(--space-sm)", color: "var(--color-text-muted)", fontWeight: 500, fontFamily: "var(--font-mono)" }}>Fillers</th>
              <th style={{ textAlign: "right", padding: "var(--space-sm)", color: "var(--color-text-muted)", fontWeight: 500, fontFamily: "var(--font-mono)" }}>Disfluencies</th>
              <th style={{ textAlign: "right", padding: "var(--space-sm)", color: "var(--color-text-muted)", fontWeight: 500, fontFamily: "var(--font-mono)" }}>WPM</th>
              <th style={{ textAlign: "right", padding: "var(--space-sm)", color: "var(--color-text-muted)", fontWeight: 500, fontFamily: "var(--font-mono)" }}>Drills</th>
            </tr>
          </thead>
          <tbody>
            {[...data].reverse().map((d) => (
              <tr key={d.recording_id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                <td style={{ padding: "var(--space-sm)" }}>
                  {new Date(d.recorded_at).toLocaleDateString()}
                </td>
                <td style={{ textAlign: "right", padding: "var(--space-sm)", fontFamily: "var(--font-mono)" }}>
                  {d.delivery_score > 0 ? d.delivery_score.toFixed(1) : "—"}
                </td>
                <td style={{ textAlign: "right", padding: "var(--space-sm)", fontFamily: "var(--font-mono)" }}>
                  {d.filler_count}
                </td>
                <td style={{ textAlign: "right", padding: "var(--space-sm)", fontFamily: "var(--font-mono)" }}>
                  {d.disfluency_count}
                </td>
                <td style={{ textAlign: "right", padding: "var(--space-sm)", fontFamily: "var(--font-mono)" }}>
                  {d.pace_wpm > 0 ? d.pace_wpm.toFixed(0) : "—"}
                </td>
                <td style={{ textAlign: "right", padding: "var(--space-sm)", fontFamily: "var(--font-mono)" }}>
                  {d.drill_attempt_count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>
    </>
  );
}
