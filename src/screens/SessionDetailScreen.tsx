import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RecordingEntry, FlaggedMomentEntry, FirstImpression } from "../types";
import { DeleteConfirmation } from "../components/DeleteConfirmation";
import { AudioPlayer } from "../components/AudioPlayer";
import { PracticeDrillList } from "../components/PracticeDrills";

export function SessionDetailScreen({ recordingId, onBack }: { recordingId: number | null; onBack: () => void }) {
  const [recording, setRecording] = useState<RecordingEntry | null>(null);
  const [moments, setMoments] = useState<FlaggedMomentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [userName, setUserName] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState("");
  const [firstImpression, setFirstImpression] = useState<FirstImpression | null>(null);

  useEffect(() => {
    invoke<{ user_name: string | null }>("get_voice_profile").then((res) => {
      if (res.user_name) setUserName(res.user_name);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (recordingId == null) { setLoading(false); return; }

    Promise.all([
      invoke<RecordingEntry>("get_recording", { id: recordingId }),
      invoke<FlaggedMomentEntry[]>("get_flagged_moments", { recordingId }),
      invoke<{ impression_json: string | null }>("get_first_impression"),
    ])
      .then(([rec, mom, imp]) => {
        setRecording(rec);
        setMoments(mom);
        if (imp.impression_json && (rec.session_type === "coach_first" || rec.session_type === "coach")) {
          try { setFirstImpression(JSON.parse(imp.impression_json)); } catch {}
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [recordingId]);

  if (loading) {
    return (
      <>
        <p className="page-label">Session</p>
        <h1 className="page-title">Loading...</h1>
      </>
    );
  }

  if (!recording) {
    return (
      <>
        <p className="page-label">Session</p>
        <h1 className="page-title">Session not found</h1>
        <button className="btn btn-secondary" onClick={onBack}>← Back to sessions</button>
      </>
    );
  }

  const date = new Date(recording.recorded_at.endsWith("Z") ? recording.recorded_at : recording.recorded_at + "Z");
  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <>
      <button
        className="btn btn-secondary"
        style={{ fontSize: 12, padding: "var(--space-xs) var(--space-sm)", marginBottom: "var(--space-md)" }}
        onClick={onBack}
      >
        ← Recording
      </button>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-xs)" }}>
        <div>
          {editingName ? (
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-xs)", marginBottom: 2 }}>
              <input
                style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, padding: "var(--space-2xs) var(--space-xs)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-text)", width: 250 }}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && editName.trim()) {
                    await invoke("rename_recording", { recordingId: recording.id, name: editName.trim() });
                    recording.name = editName.trim();
                    setEditingName(false);
                  }
                  if (e.key === "Escape") setEditingName(false);
                }}
                autoFocus
              />
              <button onClick={async () => { if (editName.trim()) { await invoke("rename_recording", { recordingId: recording.id, name: editName.trim() }); recording.name = editName.trim(); } setEditingName(false); }} style={{ background: "none", border: "none", cursor: "pointer", padding: "var(--space-2xs)", display: "flex" }} title="Save">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3.5 3.5L13 4" /></svg>
              </button>
              <button onClick={() => setEditingName(false)} style={{ background: "none", border: "none", cursor: "pointer", padding: "var(--space-2xs)", display: "flex" }} title="Cancel">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-xs)", marginBottom: 2 }}>
              <p style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>
                {recording.name || `Session #${recording.id}`}
              </p>
              <button
                onClick={() => { setEditName(recording.name || `Session #${recording.id}`); setEditingName(true); }}
                style={{ background: "none", border: "none", cursor: "pointer", padding: "var(--space-2xs)", display: "flex", alignItems: "center", opacity: 0.4 }}
                title="Rename"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11.33 1.33a1.89 1.89 0 012.67 2.67L5 13l-3.67 1L2.33 10.33z" />
                </svg>
              </button>
            </div>
          )}
          <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
            {recording.duration_seconds > 0 && <>{formatDuration(recording.duration_seconds)} · </>}
            {date.toLocaleDateString()} at {date.toLocaleTimeString()}
          </p>
        </div>
        {!confirmDelete ? (
          <button
            style={{
              background: "none", border: "none", cursor: "pointer",
              padding: "var(--space-xs)",
              borderRadius: "var(--radius-sm)",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
            }}
            title="Delete session"
            onClick={() => setConfirmDelete(true)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#C94040" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M6.67 7.33v4M9.33 7.33v4M3.33 4l.67 9.33a1.33 1.33 0 001.33 1.34h5.34a1.33 1.33 0 001.33-1.34L12.67 4" />
            </svg>
          </button>
        ) : null}
      </div>
      {confirmDelete && (
        <DeleteConfirmation
          onConfirm={async () => {
            await invoke("delete_recording", { recordingId: recording.id });
            onBack();
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {/* Session summary */}
      <div style={{ display: "flex", gap: "var(--space-sm)", marginBottom: "var(--space-md)", flexWrap: "wrap" }}>
        <span className="metric">{moments.length} flagged moments</span>
      </div>

      {/* Session playback + transcript */}
      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <AudioPlayer clipPath={recording.local_audio_path} />
        {recording.transcript_text && (
          <>
            <div
              style={{
                display: "flex", gap: "var(--space-sm)", alignItems: "center", cursor: "pointer",
                position: transcriptExpanded ? "sticky" : "static",
                top: 0, zIndex: 10,
                background: "var(--color-surface)",
                padding: "var(--space-sm) 0",
                marginTop: "var(--space-md)",
                borderTop: "1px solid var(--color-border)",
                borderBottom: transcriptExpanded ? "1px solid var(--color-border)" : "none",
              }}
              onClick={() => setTranscriptExpanded(!transcriptExpanded)}
            >
              <svg
                width="14" height="14" viewBox="0 0 12 12"
                style={{ transition: "transform 0.2s", transform: transcriptExpanded ? "rotate(0deg)" : "rotate(-90deg)", flexShrink: 0 }}
                aria-hidden="true"
              >
                <polygon points="2.5,3.5 9.5,3.5 6,9" fill="#ffffff" stroke="var(--color-text-secondary)" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
              <h3 className="settings-heading" style={{ margin: 0 }}>Transcript</h3>
            </div>
            <div style={{ position: "relative", maxHeight: transcriptExpanded ? "none" : 72, overflow: "hidden" }}>
              {(() => {
                let segments: { start: number; end: number; text: string; speaker: string | null }[] = [];
                try {
                  if (recording.speaker_segments) {
                    segments = JSON.parse(recording.speaker_segments);
                  }
                } catch {}

                const speakers = new Set(segments.map((s) => s.speaker).filter(Boolean));
                if (speakers.size > 1) {
                  const speakerColors: Record<string, string> = {};
                  const palette = ["var(--color-primary)", "var(--color-warning)", "#8B5CF6", "#EC4899"];
                  let colorIdx = 0;
                  const mySpeaker = localStorage.getItem("duet-my-speaker");
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
                      {segments.map((seg, i) => {
                        const spk = seg.speaker || "?";
                        if (!speakerColors[spk]) { speakerColors[spk] = palette[colorIdx % palette.length]!; colorIdx++; }
                        const isMe = spk === mySpeaker;
                        return (
                          <div key={i} style={{ display: "flex", gap: "var(--space-sm)", alignItems: "flex-start" }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: speakerColors[spk], minWidth: 50, paddingTop: 2, flexShrink: 0, fontFamily: "var(--font-mono)" }}>
                              {isMe ? (userName || "You") : spk}
                            </span>
                            <p style={{ fontSize: 14, color: isMe ? "var(--color-text)" : "var(--color-text-secondary)", lineHeight: 1.6, fontWeight: isMe ? 500 : 400, margin: 0, fontFamily: "var(--font-transcript)" }}>
                              {seg.text}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  );
                }
                return (
                  <p style={{ fontSize: 14, color: "var(--color-text-secondary)", lineHeight: 1.7, whiteSpace: "pre-wrap", fontFamily: "var(--font-transcript)" }}>
                    {recording.transcript_text}
                  </p>
                );
              })()}
              {!transcriptExpanded && (
                <div
                  style={{
                    position: "absolute",
                    bottom: 0, left: 0, right: 0, height: 32,
                    background: "linear-gradient(transparent, var(--color-surface))",
                    pointerEvents: "none",
                  }}
                />
              )}
            </div>
          </>
        )}
      </div>

      {recording && recording.session_type === "coach_first" && (
        <>
          <h3 className="settings-heading" style={{ marginBottom: "var(--space-sm)" }}>
           Assessment
          </h3>
          <div className="card" style={{ marginBottom: "var(--space-md)" }}>
            {!firstImpression?.summary ? (
              <p style={{ fontSize: 13, color: "var(--color-text-muted)", margin: 0 }}>
                No evaluation yet.
              </p>
            ) : (
              <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--color-text-secondary)", margin: 0 }}>
                {firstImpression.summary}
              </p>
            )}
          </div>
        </>
      )}

      {recording && recording.session_type === "coach_first" && firstImpression?.dimensions && firstImpression.dimensions.length > 0 && (
        <div className="score-bars" style={{ marginBottom: "var(--space-lg)" }}>
          {firstImpression.dimensions.map((d) => {
            const pct = Math.max(0, Math.min(5, d.score)) / 5 * 100;
            return (
              <div key={d.key} className="score-bar-row">
                <div className={`score-bar-fill score-${d.score}-bar`} style={{ width: `${pct}%` }} />
                <span className="score-bar-label">{d.name}</span>
                <span className="score-bar-value">{d.score}/5</span>
              </div>
            );
          })}
          <div className="score-bar-ticks" aria-hidden="true">
            {[1, 2, 3, 4, 5].map((n) => (
              <span key={n} className="score-bar-tick">
                <span className="score-bar-tick-mark" />
                <span className="score-bar-tick-num">{n}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Existing impression details */}
      {firstImpression && (
        <>

          {firstImpression.dimensions && firstImpression.dimensions.length > 0 && (
            <div style={{ marginBottom: "var(--space-lg)" }}>
              {firstImpression.dimensions.map((d) => (
                <div key={d.key} className="card" style={{ marginBottom: "var(--space-sm)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-xs)" }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text)" }}>
                      {d.name}
                    </span>
                    <span className={`score-badge score-${d.score}`}>{d.score}/5</span>
                  </div>
                  {d.evidence && d.evidence.length > 0 && (
                    <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                      {d.evidence.map((e, i) => (
                        <li key={i} style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.6, paddingLeft: 12, position: "relative" }}>
                          <span style={{ position: "absolute", left: 0 }}>·</span>{e}
                        </li>
                      ))}
                    </ul>
                  )}
                  {d.improvement && (
                    <p style={{ fontSize: 13, color: "var(--color-primary)", marginTop: "var(--space-xs)", marginBottom: 0 }}>
                      <span style={{ fontWeight: 600 }}>Practice plan: </span>{d.improvement}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Legacy shape fallback for older records */}
          {!firstImpression.dimensions && firstImpression.focus_area && (
            <div className="card" style={{ marginBottom: "var(--space-md)", borderLeft: "3px solid var(--color-primary)", borderRadius: "0 var(--radius-md) var(--radius-md) 0" }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: "var(--color-primary)", marginBottom: "var(--space-xs)" }}>
                Priority focus area
              </p>
              <p style={{ fontSize: 14, color: "var(--color-text)" }}>
                {firstImpression.focus_area}
              </p>
            </div>
          )}
          {!firstImpression.dimensions && firstImpression.strengths && firstImpression.strengths.length > 0 && (
            <div className="card" style={{ marginBottom: "var(--space-md)" }}>
              <h3 className="settings-heading">What you do well</h3>
              {firstImpression.strengths.map((s, i) => (
                <p key={i} style={{ fontSize: 14, color: "var(--color-text-secondary)", marginBottom: "var(--space-xs)" }}>{s}</p>
              ))}
            </div>
          )}
          {!firstImpression.dimensions && firstImpression.patterns && firstImpression.patterns.length > 0 && (
            <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
              <h3 className="settings-heading">Patterns observed</h3>
              {firstImpression.patterns.map((p, i) => (
                <p key={i} style={{ fontSize: 14, color: "var(--color-text-secondary)", marginBottom: "var(--space-xs)" }}>{p}</p>
              ))}
            </div>
          )}
        </>
      )}


      {/* Practice Points — hidden on first sessions (Action Plan covers it) */}
      {recording?.session_type !== "coach_first" && (
        <>
          <h3 className="settings-heading" style={{ marginBottom: "var(--space-md)" }}>
            Practice Points ({moments.length})
          </h3>

          {moments.length === 0 ? (
            <div className="card">
              <p style={{ color: "var(--color-text-muted)" }}>
                Your speech was clean. No moments to practice.
              </p>
            </div>
          ) : (
            <PracticeDrillList recordingId={recordingId!} moments={moments} />
          )}
        </>
      )}
    </>
  );
}
