import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { appDataDir, join } from "@tauri-apps/api/path";
import { useTheme } from "./theme";

type Screen = "recordings" | "session_detail" | "dashboard" | "study" | "studyplan" | "settings";

interface RecordingEntry {
  id: number;
  recorded_at: string;
  duration_seconds: number;
  local_audio_path: string;
  transcript_text: string | null;
  name: string | null;
}

interface FlaggedMomentEntry {
  id: number;
  start_time: number;
  end_time: number;
  moment_type: string;
  severity: number;
  coach_type: string;
  coaching_text: string | null;
  transcript_text: string;
}

interface ProgressEvent {
  stage: string;
  percent: number;
}

function App() {
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [activeRecordingId, setActiveRecordingId] = useState<number | null>(null);

  // Listen for tray menu navigation events
  useEffect(() => {
    const unlisten = listen<string>("navigate", (event) => {
      if (event.payload === "settings") setScreen("settings");
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  return (
    <div>
      <nav className="sidebar">
        <div className="sidebar-logo">DUET</div>
        <div className="sidebar-nav">
          {([
            ["dashboard", "Dashboard"],
            ["recordings", "Sessions"],
            ["study", "Knowledge Base"],
            ["studyplan", "Study Plan"],
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
        <div style={{ marginTop: "auto" }}>
          <a
            className={`sidebar-link ${screen === "settings" ? "active" : ""}`}
            onClick={() => setScreen("settings")}
          >
            Settings
          </a>
        </div>
      </nav>

      <main className="main">
        {/* Global Start Session button */}
        {screen !== "settings" && (
          <StartSessionButton
            onComplete={(id) => {
              setActiveRecordingId(id);
              setScreen("session_detail");
            }}
          />
        )}

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
        {screen === "study" && <KnowledgeCoachScreen />}
        {screen === "studyplan" && <StudyPlanScreen />}
        {screen === "settings" && <SettingsScreen />}
      </main>
    </div>
  );
}

// ── Record Screen ──────────────────────────────────────────

// ── Start Session Button (global, top-right) ──────────────

function StartSessionButton({ onComplete }: { onComplete: (id: number) => void }) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pauseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelledRef = useRef(false);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const unlisten = listen<string>("sidecar-progress", (event) => {
      try { setProgress(JSON.parse(event.payload) as ProgressEvent); } catch {}
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const pauseTimeoutMinutes = Number(localStorage.getItem("duet-pause-timeout") || "5");

  const togglePause = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (paused) {
      recorder.resume();
      timerRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);
      if (pauseTimeoutRef.current) { clearTimeout(pauseTimeoutRef.current); pauseTimeoutRef.current = null; }
      setPaused(false);
    } else {
      recorder.pause();
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setPaused(true);
      // Auto-stop after configured minutes
      pauseTimeoutRef.current = setTimeout(() => {
        mediaRecorderRef.current?.stop();
        mediaRecorderRef.current = null;
        setRecording(false);
        setPaused(false);
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      }, pauseTimeoutMinutes * 60 * 1000);
    }
  }, [paused, pauseTimeoutMinutes]);

  const cancelProcessing = useCallback(() => {
    cancelledRef.current = true;
    setProcessing(false);
    setProgress(null);
  }, []);

  const processAudio = useCallback(async (filePath: string, duration: number) => {
    cancelledRef.current = false;
    setProcessing(true);
    setProgress({ stage: "saving", percent: 10 });

    try {
      const saveResult = await invoke<{ id: number }>("save_recording", {
        audioPath: filePath, duration,
      });
      const recordingId = saveResult.id;

      if (cancelledRef.current) { await invoke("delete_recording", { recordingId }); return; }
      setProgress({ stage: "transcribing", percent: 25 });
      const speech = await invoke<{
        transcript: { text: string; segments: any[]; words: any[] };
        disfluencies: { fillers: any[]; all: any[] };
        flagged_moments: { start: number; end: number; type: string; severity: number; coach_type: string; transcript_text: string; detail: string }[];
        overall_metrics: { filler_count: number; total_disfluencies: number; pause_count: number; avg_pace_wpm: number; word_count: number; duration_seconds: number };
        duration_seconds: number;
      }>("analyze_speech", { audioPath: filePath });

      setProgress({ stage: "saving", percent: 60 });
      const fullText = speech.transcript.text;
      await invoke("save_recording", {
        audioPath: filePath,
        duration: speech.duration_seconds,
        transcript: fullText,
        segmentsJson: JSON.stringify(speech.transcript.segments),
      });

      const flagged = speech.flagged_moments.map((m) => ({
        ...m, text: m.transcript_text, coaching_text: null as string | null,
      }));

      let deliveryScore = 0.0;
      if (flagged.length > 0) {
        setProgress({ stage: "coaching", percent: 75 });
        try {
          let docChunks = null;
          try {
            const chunks = await invoke<any[]>("get_all_doc_chunks");
            if (chunks?.length) docChunks = chunks;
          } catch {}

          const coaching = await invoke<{
            coached_moments: { start: number; end: number; coaching_text: string; suggested_delivery: string; topic: string | null }[];
            overall_score: number; summary: string;
          }>("generate_coaching", { flaggedMoments: flagged, fullTranscript: fullText, docChunks });

          deliveryScore = coaching.overall_score;
          for (const c of coaching.coached_moments) {
            const match = flagged.find((m) => Math.abs(m.start - c.start) < 0.5);
            if (match) (match as any).coaching_text = c.coaching_text + "\n\nTry saying: \"" + c.suggested_delivery + "\"";
          }
        } catch (err) { console.warn("Coaching failed:", err); }
      }

      setProgress({ stage: "saving_analysis", percent: 90 });
      await invoke("save_analysis", {
        recordingId, deliveryScore,
        fillerCount: speech.overall_metrics.filler_count,
        hedgingCount: speech.overall_metrics.total_disfluencies,
        deflectionCount: speech.overall_metrics.pause_count,
        paceWpm: speech.overall_metrics.avg_pace_wpm,
        flaggedMoments: flagged,
      });

      if (flagged.length > 0) {
        setProgress({ stage: "extracting_clips", percent: 93 });
        try {
          const clipsDir = await join(await appDataDir(), "clips", `recording-${recordingId}`);
          await invoke("extract_clips", {
            audioPath: filePath,
            moments: flagged.map((m, i) => ({ id: i, start: m.start, end: m.end })),
            outputDir: clipsDir,
          });
        } catch (err) { console.warn("Clip extraction failed:", err); }
      }

      setProgress({ stage: "complete", percent: 100 });
      onComplete(recordingId);
    } catch (err) {
      console.error("Processing failed:", err);
      setProgress(null);
    } finally {
      setProcessing(false);
    }
  }, [onComplete]);

  const processBlob = useCallback(async (blob: Blob, duration: number) => {
    const dataDir = await appDataDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = await join(dataDir, "recordings", `session-${timestamp}.webm`);
    const { writeFile, mkdir } = await import("@tauri-apps/plugin-fs");
    await mkdir(await join(dataDir, "recordings"), { recursive: true });
    await writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
    await processAudio(filePath, duration);
  }, [processAudio]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        stream.getTracks().forEach((t) => t.stop());
        processBlob(blob, elapsed);
      };
      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      setRecording(true);
      setElapsed(0);
      setShowDropdown(false);
      timerRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);
    } catch (err) { console.error("Mic denied:", err); }
  }, [elapsed, processBlob]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
    setPaused(false);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (pauseTimeoutRef.current) { clearTimeout(pauseTimeoutRef.current); pauseTimeoutRef.current = null; }
  }, []);

  const handleUpload = useCallback(async () => {
    setShowDropdown(false);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "Audio", extensions: ["webm", "wav", "mp3", "m4a", "mp4", "ogg", "flac"] }],
      });
      if (!selected) return;
      const filePath = Array.isArray(selected) ? selected[0] : selected;
      await processAudio(filePath, 0);
    } catch (err) { console.error("Upload failed:", err); }
  }, [processAudio]);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (pauseTimeoutRef.current) clearTimeout(pauseTimeoutRef.current);
  }, []);

  // Processing overlay
  if (processing) {
    return (
      <div className="session-overlay">
        <div className="card" style={{ textAlign: "center", padding: "var(--space-2xl)", maxWidth: 400, width: "100%" }}>
          <p style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, marginBottom: "var(--space-md)" }}>
            {progress?.stage === "transcribing" && "Transcribing..."}
            {progress?.stage === "coaching" && "Generating coaching..."}
            {progress?.stage === "extracting_clips" && "Extracting clips..."}
            {progress?.stage === "saving" && "Saving..."}
            {progress?.stage === "saving_analysis" && "Saving analysis..."}
            {progress?.stage === "complete" && "Done!"}
            {!progress?.stage && "Processing..."}
          </p>
          <div style={{ height: 6, background: "var(--color-surface-raised)", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progress?.percent ?? 0}%`, background: "var(--color-primary)", borderRadius: 3, transition: "width 0.3s ease-out" }} />
          </div>
          <p className="metric" style={{ marginTop: "var(--space-sm)" }}>{progress?.percent ?? 0}%</p>
          <button
            className="btn btn-secondary"
            style={{ marginTop: "var(--space-lg)", fontSize: 13 }}
            onClick={cancelProcessing}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Recording: show pause + stop in place of Start Session
  if (recording) {
    return (
      <div className="start-session-container" style={{ flexDirection: "column", alignItems: "flex-end" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-xs)" }}>
          <button
            className="btn session-control-btn session-stop-btn"
            onClick={stopRecording}
            title="Stop"
          >
            ⏹
          </button>
          <button
            className="btn session-control-btn"
            onClick={togglePause}
            title={paused ? "Resume" : "Pause"}
          >
            {paused ? "▶" : "⏸"}
          </button>
        </div>
        <div className="session-timer-inline" style={{ marginLeft: 0, marginTop: "var(--space-xs)" }}>
          <span className="recording-dot" style={paused ? { animation: "none", opacity: 0.4 } : undefined} />
          <span className="session-timer-text">{formatTime(elapsed)}{paused ? " (paused)" : ""}</span>
        </div>
      </div>
    );
  }

  // Idle: Start Session + dropdown
  return (
    <div className="start-session-container" style={{ flexDirection: "column", alignItems: "flex-end" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
        <button className="btn start-session-btn" onClick={startRecording}>
          Start Session
        </button>
        <button
          className="btn start-session-dropdown"
          onClick={() => setShowDropdown(!showDropdown)}
        >
          ▾
        </button>
      </div>
      {showDropdown && (
        <div className="start-session-menu">
          <button className="start-session-menu-item" onClick={handleUpload}>
            Or upload audio file
          </button>
        </div>
      )}
    </div>
  );
}

// ── Recordings List ────────────────────────────────────────

function RecordingsScreen({ onSelect }: { onSelect: (id: number) => void }) {
  const [recordings, setRecordings] = useState<RecordingEntry[]>([]);
  const [subjects, setSubjects] = useState<SubjectEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deleteInfo, setDeleteInfo] = useState<{ drills: number } | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  const loadData = useCallback(() => {
    Promise.all([
      invoke<RecordingEntry[]>("list_recordings"),
      invoke<SubjectEntry[]>("list_subjects"),
    ])
      .then(([r, s]) => { setRecordings(r); setSubjects(s); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleDeleteClick = useCallback(async (id: number) => {
    const result = await invoke<{ count: number }>("get_drill_count_for_recording", { recordingId: id });
    setDeleteInfo({ drills: result.count });
    setConfirmDeleteId(id);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (confirmDeleteId == null) return;
    await invoke("delete_recording", { recordingId: confirmDeleteId });
    setConfirmDeleteId(null);
    setDeleteInfo(null);
    loadData();
  }, [confirmDeleteId, loadData]);

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <>
      <p className="page-label">Sessions</p>
      <h1 className="page-title">Your sessions</h1>

      {loading && <p style={{ color: "var(--color-text-muted)" }}>Loading...</p>}

      {!loading && recordings.length === 0 && (
        <div className="card">
          <p style={{ color: "var(--color-text-muted)" }}>
            No sessions yet. Hit Record to get started.
          </p>
        </div>
      )}

      {recordings.map((r) => (
        <div
          key={r.id}
          className="card"
          style={{ cursor: "pointer" }}
          onClick={() => onSelect(r.id)}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div onClick={(e) => editingId === r.id && e.stopPropagation()}>
              {editingId === r.id ? (
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-xs)" }}>
                  <input
                    className="input"
                    style={{ fontSize: 15, fontFamily: "var(--font-display)", fontWeight: 700, padding: "var(--space-2xs) var(--space-xs)", width: 220 }}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter") {
                        if (editName.trim()) {
                          await invoke("rename_recording", { recordingId: r.id, name: editName.trim() });
                          loadData();
                        }
                        setEditingId(null);
                      }
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    autoFocus
                  />
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (editName.trim()) {
                        await invoke("rename_recording", { recordingId: r.id, name: editName.trim() });
                        loadData();
                      }
                      setEditingId(null);
                    }}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: "var(--space-2xs)", display: "flex" }}
                    title="Save"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 8.5l3.5 3.5L13 4" />
                    </svg>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditingId(null); }}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: "var(--space-2xs)", display: "flex" }}
                    title="Cancel"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-xs)" }}>
                  <p style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>
                    {r.name || `Session #${r.id}`}
                  </p>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditName(r.name || `Session #${r.id}`);
                      setEditingId(r.id);
                    }}
                    style={{
                      background: "none", border: "none", cursor: "pointer",
                      padding: "var(--space-2xs)", display: "flex", alignItems: "center",
                      opacity: 0.4,
                    }}
                    title="Rename"
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11.33 1.33a1.89 1.89 0 012.67 2.67L5 13l-3.67 1L2.33 10.33z" />
                    </svg>
                  </button>
                </div>
              )}
              <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
                {new Date(r.recorded_at.endsWith("Z") ? r.recorded_at : r.recorded_at + "Z").toLocaleDateString()} at{" "}
                {new Date(r.recorded_at.endsWith("Z") ? r.recorded_at : r.recorded_at + "Z").toLocaleTimeString()}
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
              {subjects.length > 0 && (
                <select
                  style={{
                    padding: "var(--space-xs) var(--space-sm)",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--color-border)",
                    background: "var(--color-surface)",
                    color: "var(--color-text-secondary)",
                    fontSize: 12,
                    fontFamily: "var(--font-body)",
                  }}
                  onChange={async (e) => {
                    await invoke("assign_recording_subject", {
                      recordingId: r.id,
                      subjectId: e.target.value ? Number(e.target.value) : null,
                    });
                  }}
                >
                  <option value="">No subject</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
              <span className="metric">{formatDuration(r.duration_seconds)}</span>
              {r.transcript_text ? (
                <span className="metric" style={{ color: "var(--color-success)" }}>Analyzed</span>
              ) : (
                <span className="metric">Pending</span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); handleDeleteClick(r.id); }}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  padding: "var(--space-xs)",
                  borderRadius: "var(--radius-sm)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
                title="Delete session"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#C94040" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M6.67 7.33v4M9.33 7.33v4M3.33 4l.67 9.33a1.33 1.33 0 001.33 1.34h5.34a1.33 1.33 0 001.33-1.34L12.67 4" />
                </svg>
              </button>
            </div>
          </div>

          {/* Inline delete confirmation */}
          {confirmDeleteId === r.id && (
            <div style={{ marginTop: "var(--space-md)", paddingTop: "var(--space-md)", borderTop: "1px solid var(--color-border)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <p style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: "var(--space-sm)" }}>
                Delete this session{deleteInfo && deleteInfo.drills > 0
                  ? ` and ${deleteInfo.drills} practice drill${deleteInfo.drills > 1 ? "s" : ""}` : ""}?
                This cannot be undone.
              </p>
              <div style={{ display: "flex", gap: "var(--space-sm)" }}>
                <button
                  className="btn"
                  style={{ background: "var(--color-error)", color: "#fff", fontSize: 12, padding: "var(--space-xs) var(--space-md)" }}
                  onClick={handleConfirmDelete}
                >
                  Delete
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: 12, padding: "var(--space-xs) var(--space-md)" }}
                  onClick={() => setConfirmDeleteId(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

// ── Session Detail Screen ──────────────────────────────────

function SessionDetailScreen({ recordingId, onBack }: { recordingId: number | null; onBack: () => void }) {
  const [recording, setRecording] = useState<RecordingEntry | null>(null);
  const [moments, setMoments] = useState<FlaggedMomentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (recordingId == null) { setLoading(false); return; }

    Promise.all([
      invoke<RecordingEntry>("get_recording", { id: recordingId }),
      invoke<FlaggedMomentEntry[]>("get_flagged_moments", { recordingId }),
    ])
      .then(([rec, mom]) => {
        setRecording(rec);
        setMoments(mom);
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
        ← Sessions
      </button>

      <p className="page-label">Session #{recording.id}</p>
      <h1 className="page-title">
        {date.toLocaleDateString()} at {date.toLocaleTimeString()}
      </h1>

      {/* Session summary */}
      <div style={{ display: "flex", gap: "var(--space-sm)", marginBottom: "var(--space-md)" }}>
        <span className="metric">{formatDuration(recording.duration_seconds)}</span>
        <span className="metric">{moments.length} flagged moments</span>
        {recording.transcript_text && (
          <span className="metric" style={{ color: "var(--color-success)" }}>Analyzed</span>
        )}
      </div>

      {/* Full session playback */}
      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h3 className="settings-heading">Full Session</h3>
        <AudioPlayer clipPath={recording.local_audio_path} />
      </div>

      {/* Transcript */}
      {recording.transcript_text && (
        <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
          <h3 className="settings-heading">Transcript</h3>
          <p style={{ fontSize: 14, color: "var(--color-text-secondary)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
            {recording.transcript_text}
          </p>
        </div>
      )}

      {/* Practice Drills */}
      <h3 className="settings-heading" style={{ marginBottom: "var(--space-md)" }}>
        Practice Drills ({moments.length})
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
  );
}

// ── Practice Drills (embedded in session) ──────────────────

type DrillState = "listen" | "recording" | "review";

function PracticeDrillList({ recordingId, moments }: { recordingId: number; moments: FlaggedMomentEntry[] }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  return (
    <div>
      {moments.map((moment, idx) => {
        const typeLabel: Record<string, string> = {
          filler_words: "Filler words",
          filler: "Filler",
          hedging: "Hedging",
          deflection: "Deflection",
          "filler+repetition": "Fillers + Repetition",
          long_pause: "Long pause",
          rushing: "Rushing",
          uncertainty: "Uncertainty",
          repetition: "Repetition",
          restart: "Restart",
        };

        return (
          <div key={moment.id} className="card" style={{ marginBottom: "var(--space-xs)" }}>
            {/* Header - always visible */}
            <div
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
              onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
                <span style={{
                  width: 24, height: 24, borderRadius: "var(--radius-full)",
                  background: moment.severity >= 7 ? "var(--color-error)" : moment.severity >= 4 ? "var(--color-warning)" : "var(--color-text-muted)",
                  color: "#fff", fontSize: 11, fontWeight: 700,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {moment.severity}
                </span>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 500 }}>
                    {typeLabel[moment.moment_type] ?? moment.moment_type}
                  </p>
                  <p style={{ fontSize: 12, color: "var(--color-text-muted)", maxWidth: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    "{moment.transcript_text}"
                  </p>
                </div>
              </div>
              <span style={{ color: "var(--color-text-muted)", fontSize: 16 }}>
                {expandedIdx === idx ? "▾" : "▸"}
              </span>
            </div>

            {/* Expanded drill */}
            {expandedIdx === idx && (
              <div style={{ marginTop: "var(--space-md)", borderTop: "1px solid var(--color-border)", paddingTop: "var(--space-md)" }}>
                <DrillInteraction moment={moment} recordingId={recordingId} momentIdx={idx} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DrillInteraction({ moment, recordingId, momentIdx }: { moment: FlaggedMomentEntry; recordingId: number; momentIdx: number }) {
  const [clipPath, setClipPath] = useState<string | null>(null);
  const [drillState, setDrillState] = useState<DrillState>("listen");
  const [attempts, setAttempts] = useState<string[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const dataDir = await appDataDir();
        const p = await join(dataDir, "clips", `recording-${recordingId}`, `clip-${momentIdx}.wav`);
        setClipPath(p);
      } catch {}
    })();
  }, [recordingId, momentIdx]);

  return (
    <>
      {/* Audio clip */}
      <AudioPlayer clipPath={clipPath ?? undefined} />

      {/* Transcript quote */}
      <p style={{
        fontSize: 14, color: "var(--color-text-secondary)",
        background: "var(--color-surface-raised)", padding: "var(--space-md)",
        borderRadius: "var(--radius-md)", marginBottom: "var(--space-md)", fontStyle: "italic",
      }}>
        "{moment.transcript_text}"
      </p>

      {/* Coaching text */}
      {moment.coaching_text && (() => {
        const parts = moment.coaching_text.split("\n\nTry saying: \"");
        const coaching = parts[0];
        const suggested = parts[1]?.replace(/"$/, "");
        return (
          <div style={{ marginBottom: "var(--space-md)" }}>
            <p style={{ color: "var(--color-text-secondary)", marginBottom: "var(--space-md)", fontSize: 14 }}>
              {coaching}
            </p>
            {suggested && (
              <div style={{
                background: "var(--color-surface-raised)",
                borderLeft: "3px solid var(--color-primary)",
                padding: "var(--space-md)",
                borderRadius: "0 var(--radius-md) var(--radius-md) 0",
              }}>
                <p style={{ fontSize: 12, fontWeight: 600, color: "var(--color-primary)", marginBottom: "var(--space-xs)" }}>
                  Try saying:
                </p>
                <p style={{ fontSize: 14, color: "var(--color-text)" }}>
                  "{suggested}"
                </p>
              </div>
            )}
          </div>
        );
      })()}

      {/* Drill interaction */}
      {drillState === "listen" && (
        <button
          className="btn btn-primary-large"
          onClick={async () => {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              const recorder = new MediaRecorder(stream);
              chunksRef.current = [];
              recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
              recorder.onstop = () => {
                const blob = new Blob(chunksRef.current, { type: "audio/webm" });
                const url = URL.createObjectURL(blob);
                stream.getTracks().forEach((t) => t.stop());
                setAttempts((prev) => [...prev, url]);
                setDrillState("review");
              };
              recorder.start();
              mediaRecorderRef.current = recorder;
              setDrillState("recording");
            } catch (err) { console.error("Mic denied:", err); }
          }}
        >
          LET'S TRY AGAIN
        </button>
      )}

      {drillState === "recording" && (
        <div style={{ textAlign: "center" }}>
          <div className="recording-pulse" />
          <p style={{ fontSize: 14, color: "var(--color-text-secondary)", marginBottom: "var(--space-md)" }}>
            Say it now...
          </p>
          <button
            className="btn btn-record-stop"
            style={{ width: 60, height: 60, fontSize: 12 }}
            onClick={() => { mediaRecorderRef.current?.stop(); mediaRecorderRef.current = null; }}
          >
            DONE
          </button>
        </div>
      )}

      {drillState === "review" && (() => {
        const latest = attempts[attempts.length - 1];
        const count = attempts.length;
        const max = 3;
        return (
          <div>
            <p style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-muted)", marginBottom: "var(--space-sm)" }}>
              Your version (attempt {count}/{max})
            </p>
            {latest && (
              <div className="waveform" style={{ marginBottom: "var(--space-md)" }}>
                <audio src={latest} controls style={{ width: "100%", height: 36, borderRadius: "var(--radius-md)" }} />
              </div>
            )}
            <div style={{ display: "flex", gap: "var(--space-sm)" }}>
              {count < max ? (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => setDrillState("listen")}>
                  Try once more
                </button>
              ) : (
                <p style={{ flex: 1, fontSize: 13, color: "var(--color-text-muted)", padding: "var(--space-sm) 0" }}>
                  Good work.
                </p>
              )}
            </div>
          </div>
        );
      })()}
    </>
  );
}

// ── Legacy Practice Drill Screen (kept for reference) ──────

function PracticeDrillScreen({ recordingId }: { recordingId: number | null }) {
  const [moments, setMoments] = useState<FlaggedMomentEntry[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [clipPaths, setClipPaths] = useState<Record<number, string>>({});

  // Re-delivery recording state
  const [drillState, setDrillState] = useState<DrillState>("listen");
  const [attempts, setAttempts] = useState<Record<number, string[]>>({});  // momentIdx -> array of audio blob URLs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (recordingId == null) {
      setLoading(false);
      return;
    }

    // Load clip paths
    (async () => {
      try {
        const dataDir = await appDataDir();
        const clipsDir = await join(dataDir, "clips", `recording-${recordingId}`);
        const paths: Record<number, string> = {};
        for (let i = 0; i < 20; i++) {
          const p = await join(clipsDir, `clip-${i}.wav`);
          paths[i] = p;
        }
        setClipPaths(paths);
      } catch {}
    })();
    invoke<FlaggedMomentEntry[]>("get_flagged_moments", { recordingId })
      .then((m) => {
        setMoments(m);
        setCurrentIdx(0);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [recordingId]);

  if (loading) {
    return (
      <>
        <p className="page-label">Practice Drill</p>
        <h1 className="page-title">Loading...</h1>
      </>
    );
  }

  if (!recordingId || moments.length === 0) {
    return (
      <>
        <p className="page-label">Practice Drill</p>
        <h1 className="page-title">No flagged moments</h1>
        <div className="card">
          <p style={{ color: "var(--color-text-muted)" }}>
            {recordingId
              ? "Your speech was clean. No moments to practice."
              : "Start a session first, then come back here to practice."}
          </p>
        </div>
      </>
    );
  }

  const moment = moments[currentIdx]!;
  const typeLabel: Record<string, string> = {
    filler_words: "Filler words",
    hedging: "Hedging",
    deflection: "Deflection",
  };

  return (
    <>
      <p className="page-label">
        Practice Drill — {currentIdx + 1} of {moments.length}
      </p>
      <h1 className="page-title">Listen, then try again.</h1>

      <div className="card">
        <AudioPlayer clipPath={clipPaths[currentIdx]} />

        <p style={{
          fontFamily: "var(--font-body)",
          fontSize: 15,
          color: "var(--color-text-secondary)",
          background: "var(--color-surface-raised)",
          padding: "var(--space-md)",
          borderRadius: "var(--radius-md)",
          marginBottom: "var(--space-md)",
          fontStyle: "italic",
        }}>
          "{moment.transcript_text}"
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: "var(--space-md)" }}>
          <span className="metric">{typeLabel[moment.moment_type] ?? moment.moment_type}</span>
          <span className="metric">Severity: {moment.severity}/10</span>
          <span className="metric" style={{ textTransform: "capitalize" }}>
            {moment.coach_type} coach
          </span>
        </div>

        {moment.coaching_text && (() => {
          const parts = moment.coaching_text.split("\n\nTry saying: \"");
          const coaching = parts[0];
          const suggested = parts[1]?.replace(/"$/, "");
          return (
            <div style={{ marginBottom: "var(--space-lg)" }}>
              <p style={{ color: "var(--color-text-secondary)", marginBottom: "var(--space-md)" }}>
                {coaching}
              </p>
              {suggested && (
                <div style={{
                  background: "var(--color-surface-raised)",
                  borderLeft: "3px solid var(--color-primary)",
                  padding: "var(--space-md)",
                  borderRadius: "0 var(--radius-md) var(--radius-md) 0",
                }}>
                  <p style={{ fontSize: 12, fontWeight: 600, color: "var(--color-primary)", marginBottom: "var(--space-xs)" }}>
                    Try saying:
                  </p>
                  <p style={{ fontSize: 15, color: "var(--color-text)" }}>
                    "{suggested}"
                  </p>
                </div>
              )}
            </div>
          );
        })()}

        {/* Drill interaction */}
        {drillState === "listen" && (
          <button
            className="btn btn-primary-large"
            style={{ marginBottom: "var(--space-md)" }}
            onClick={async () => {
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const recorder = new MediaRecorder(stream);
                chunksRef.current = [];
                recorder.ondataavailable = (e) => {
                  if (e.data.size > 0) chunksRef.current.push(e.data);
                };
                recorder.onstop = () => {
                  const blob = new Blob(chunksRef.current, { type: "audio/webm" });
                  const url = URL.createObjectURL(blob);
                  stream.getTracks().forEach((t) => t.stop());
                  setAttempts((prev) => ({
                    ...prev,
                    [currentIdx]: [...(prev[currentIdx] || []), url],
                  }));
                  setDrillState("review");
                };
                recorder.start();
                mediaRecorderRef.current = recorder;
                setDrillState("recording");
              } catch (err) {
                console.error("Mic access denied:", err);
              }
            }}
          >
            LET'S TRY AGAIN
          </button>
        )}

        {drillState === "recording" && (
          <div style={{ textAlign: "center", marginBottom: "var(--space-md)" }}>
            <div className="recording-pulse" />
            <p style={{ fontSize: 14, color: "var(--color-text-secondary)", marginBottom: "var(--space-md)" }}>
              Say it now...
            </p>
            <button
              className="btn btn-record-stop"
              style={{ width: 80, height: 80, fontSize: 13 }}
              onClick={() => {
                mediaRecorderRef.current?.stop();
                mediaRecorderRef.current = null;
              }}
            >
              DONE
            </button>
          </div>
        )}

        {drillState === "review" && (() => {
          const momentAttempts = attempts[currentIdx] || [];
          const latestAttempt = momentAttempts[momentAttempts.length - 1];
          const attemptCount = momentAttempts.length;
          const maxAttempts = 3;

          return (
            <div style={{ marginBottom: "var(--space-md)" }}>
              <p style={{
                fontSize: 13, fontWeight: 600, color: "var(--color-text-muted)",
                marginBottom: "var(--space-sm)",
              }}>
                Your version (attempt {attemptCount}/{maxAttempts})
              </p>

              {/* Playback of re-delivery */}
              {latestAttempt && (
                <div className="waveform" style={{ marginBottom: "var(--space-md)" }}>
                  <audio src={latestAttempt} controls style={{
                    width: "100%", height: 36,
                    borderRadius: "var(--radius-md)",
                  }} />
                </div>
              )}

              <div style={{ display: "flex", gap: "var(--space-sm)" }}>
                {attemptCount < maxAttempts ? (
                  <button
                    className="btn btn-primary"
                    style={{ flex: 1 }}
                    onClick={() => setDrillState("listen")}
                  >
                    Try once more
                  </button>
                ) : (
                  <p style={{ flex: 1, fontSize: 13, color: "var(--color-text-muted)", padding: "var(--space-sm) 0" }}>
                    Good work. Moving on.
                  </p>
                )}
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setDrillState("listen");
                    if (currentIdx < moments.length - 1) {
                      setCurrentIdx((i) => i + 1);
                    }
                  }}
                >
                  Next moment →
                </button>
              </div>
            </div>
          );
        })()}

        {/* Navigation */}
        {drillState === "listen" && (
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <button
              className="btn btn-secondary"
              disabled={currentIdx === 0}
              onClick={() => { setDrillState("listen"); setCurrentIdx((i) => i - 1); }}
            >
              Previous
            </button>
            <button
              className="btn btn-secondary"
              disabled={currentIdx >= moments.length - 1}
              onClick={() => { setDrillState("listen"); setCurrentIdx((i) => i + 1); }}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ── Shared Components ──────────────────────────────────────

function AudioPlayer({ clipPath }: { clipPath?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      audio.play();
    }
    setPlaying(!playing);
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => {
      if (audio.duration) setProgress(audio.currentTime / audio.duration);
    };
    const onLoaded = () => setDuration(audio.duration);
    const onEnded = () => { setPlaying(false); setProgress(0); };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("ended", onEnded);
    };
  }, [clipPath]);

  // Reset when clip changes
  useEffect(() => {
    setPlaying(false);
    setProgress(0);
    setDuration(0);
  }, [clipPath]);

  const formatDur = (s: number) => {
    if (!s || !isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  if (!clipPath) {
    return (
      <div className="waveform">
        <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
          Audio clip not available
        </p>
      </div>
    );
  }

  // Convert local file path to asset URL for Tauri
  const audioSrc = `asset://localhost/${encodeURIComponent(clipPath)}`;

  return (
    <div className="waveform">
      <audio ref={audioRef} src={audioSrc} preload="metadata" />
      <button className="waveform-play" onClick={togglePlay}>
        {playing ? "⏸" : "▶"}
      </button>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{
          height: 6,
          background: "var(--color-border)",
          borderRadius: 3,
          overflow: "hidden",
          cursor: "pointer",
        }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            if (audioRef.current && audioRef.current.duration) {
              audioRef.current.currentTime = pct * audioRef.current.duration;
              setProgress(pct);
            }
          }}
        >
          <div style={{
            height: "100%",
            width: `${progress * 100}%`,
            background: "var(--color-primary)",
            borderRadius: 3,
            transition: "width 0.1s linear",
          }} />
        </div>
      </div>
      <span className="waveform-time">{formatDur(duration)}</span>
    </div>
  );
}

// ── Study Plan Screen ──────────────────────────────────────

interface StudyItem {
  id: number;
  topic_id: number | null;
  title: string;
  source_type: string;
  source_path_or_url: string | null;
  status: string;
  priority: number;
  topic_name: string | null;
}

function StudyPlanScreen() {
  const [items, setItems] = useState<StudyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newTopic, setNewTopic] = useState("");
  const [newSource, setNewSource] = useState("");
  const [filter, setFilter] = useState<"all" | "pending" | "completed">("all");

  const loadItems = useCallback(() => {
    invoke<StudyItem[]>("list_study_items")
      .then(setItems)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadItems(); }, [loadItems]);

  const handleAdd = useCallback(async () => {
    if (!newTitle.trim()) return;
    await invoke("add_study_item", {
      title: newTitle.trim(),
      topicName: newTopic.trim() || null,
      sourceType: newSource.trim() ? "external" : "manual",
      sourcePathOrUrl: newSource.trim() || null,
      priority: 5,
    });
    setNewTitle("");
    setNewTopic("");
    setNewSource("");
    setShowAdd(false);
    loadItems();
  }, [newTitle, newTopic, newSource, loadItems]);

  const handleStatusChange = useCallback(async (id: number, status: string) => {
    await invoke("update_study_item_status", { id, status });
    loadItems();
  }, [loadItems]);

  const handleDelete = useCallback(async (id: number) => {
    await invoke("delete_study_item", { id });
    loadItems();
  }, [loadItems]);

  const filtered = items.filter((item) => {
    if (filter === "pending") return item.status !== "completed" && item.status !== "dismissed";
    if (filter === "completed") return item.status === "completed";
    return item.status !== "dismissed";
  });

  const pendingCount = items.filter((i) => i.status === "pending" || i.status === "in_progress").length;
  const completedCount = items.filter((i) => i.status === "completed").length;

  // Group by topic
  const grouped: Record<string, StudyItem[]> = {};
  for (const item of filtered) {
    const topic = item.topic_name || "General";
    if (!grouped[topic]) grouped[topic] = [];
    grouped[topic].push(item);
  }

  return (
    <>
      <p className="page-label">Study Plan</p>
      <h1 className="page-title">What to study next</h1>

      {/* Summary + filter */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-lg)" }}>
        <div style={{ display: "flex", gap: "var(--space-sm)" }}>
          <span className="metric">{pendingCount} to study</span>
          <span className="metric">{completedCount} completed</span>
        </div>
        <div style={{ display: "flex", gap: 0, borderRadius: "var(--radius-md)", overflow: "hidden", border: "1px solid var(--color-border)" }}>
          {(["all", "pending", "completed"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: "var(--space-xs) var(--space-md)",
                background: filter === f ? "var(--color-primary)" : "var(--color-surface)",
                color: filter === f ? "var(--color-primary-text)" : "var(--color-text-secondary)",
                border: "none",
                cursor: "pointer",
                fontFamily: "var(--font-body)",
                fontSize: 12,
                fontWeight: 600,
                textTransform: "capitalize",
                borderRight: f !== "completed" ? "1px solid var(--color-border)" : "none",
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Add item */}
      {!showAdd ? (
        <button
          className="btn btn-secondary"
          style={{ marginBottom: "var(--space-lg)" }}
          onClick={() => setShowAdd(true)}
        >
          + Add study item
        </button>
      ) : (
        <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
            <input
              className="input"
              placeholder="What do you want to study?"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              autoFocus
            />
            <div style={{ display: "flex", gap: "var(--space-sm)" }}>
              <input
                className="input"
                placeholder="Topic (optional)"
                value={newTopic}
                onChange={(e) => setNewTopic(e.target.value)}
                style={{ flex: 1 }}
              />
              <input
                className="input"
                placeholder="Link or file path (optional)"
                value={newSource}
                onChange={(e) => setNewSource(e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
            <div style={{ display: "flex", gap: "var(--space-sm)" }}>
              <button className="btn btn-primary" onClick={handleAdd}>Add</button>
              <button className="btn btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {loading && <p style={{ color: "var(--color-text-muted)" }}>Loading...</p>}

      {!loading && filtered.length === 0 && (
        <div className="card">
          <p style={{ color: "var(--color-text-muted)", textAlign: "center", padding: "var(--space-xl) 0" }}>
            {items.length === 0
              ? "No study items yet. Duet will add topics here after analyzing your sessions, or you can add your own."
              : "No items match this filter."}
          </p>
        </div>
      )}

      {/* Grouped by topic */}
      {Object.entries(grouped).map(([topic, topicItems]) => (
        <div key={topic} style={{ marginBottom: "var(--space-lg)" }}>
          <p style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            fontWeight: 500,
            color: "var(--color-text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            marginBottom: "var(--space-sm)",
          }}>
            {topic}
          </p>

          {topicItems.map((item) => (
            <div
              key={item.id}
              className="card"
              style={{
                marginBottom: "var(--space-xs)",
                opacity: item.status === "completed" ? 0.6 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-md)" }}>
                {/* Checkbox */}
                <button
                  onClick={() => handleStatusChange(
                    item.id,
                    item.status === "completed" ? "pending" : "completed"
                  )}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "var(--radius-sm)",
                    border: `2px solid ${item.status === "completed" ? "var(--color-primary)" : "var(--color-border)"}`,
                    background: item.status === "completed" ? "var(--color-primary)" : "transparent",
                    color: "var(--color-primary-text)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {item.status === "completed" ? "✓" : ""}
                </button>

                {/* Content */}
                <div style={{ flex: 1 }}>
                  <p style={{
                    fontSize: 14,
                    fontWeight: 500,
                    textDecoration: item.status === "completed" ? "line-through" : "none",
                    color: item.status === "completed" ? "var(--color-text-muted)" : "var(--color-text)",
                  }}>
                    {item.title}
                  </p>
                  {item.source_path_or_url && (
                    <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 2 }}>
                      {item.source_type === "internal_doc" ? "📄 " : "🔗 "}
                      {item.source_path_or_url.length > 60
                        ? item.source_path_or_url.slice(0, 60) + "..."
                        : item.source_path_or_url}
                    </p>
                  )}
                </div>

                {/* Delete */}
                <button
                  onClick={() => handleDelete(item.id)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--color-text-muted)",
                    cursor: "pointer",
                    fontSize: 16,
                    padding: "var(--space-xs)",
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

// ── Knowledge Base Screen ──────────────────────────────────

interface SubjectEntry {
  id: number;
  name: string;
  description: string | null;
  doc_count: number;
  recording_count: number;
}

interface DocEntry {
  id: number;
  filename: string;
  local_path: string;
  chunk_size: number;
}

function KnowledgeCoachScreen() {
  const [subjects, setSubjects] = useState<SubjectEntry[]>([]);
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [showNewSubject, setShowNewSubject] = useState(false);
  const [newSubjectName, setNewSubjectName] = useState("");
  const [newSubjectDesc, setNewSubjectDesc] = useState("");
  const [activeSubject, setActiveSubject] = useState<number | null>(null);

  const loadData = useCallback(() => {
    Promise.all([
      invoke<SubjectEntry[]>("list_subjects"),
      invoke<DocEntry[]>("list_documents"),
    ])
      .then(([s, d]) => { setSubjects(s); setDocs(d); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleCreateSubject = useCallback(async () => {
    if (!newSubjectName.trim()) return;
    await invoke("create_subject", {
      name: newSubjectName.trim(),
      description: newSubjectDesc.trim() || null,
    });
    setNewSubjectName("");
    setNewSubjectDesc("");
    setShowNewSubject(false);
    loadData();
  }, [newSubjectName, newSubjectDesc, loadData]);

  const handleDeleteSubject = useCallback(async (id: number) => {
    await invoke("delete_subject", { id });
    if (activeSubject === id) setActiveSubject(null);
    loadData();
  }, [activeSubject, loadData]);

  const handleUpload = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        filters: [{ name: "Documents", extensions: ["pdf", "docx", "doc", "txt", "md"] }],
      });
      if (!selected) return;
      const files = Array.isArray(selected) ? selected : [selected];
      setUploading(true);

      for (const filePath of files) {
        const filename = filePath.split("/").pop() || filePath;
        setUploadProgress(`Parsing ${filename}...`);
        try {
          const result = await invoke<{
            filename: string;
            chunks: { heading: string | null; text: string }[];
          }>("parse_document", { filePath });
          await invoke("save_document", {
            filename: result.filename,
            localPath: filePath,
            chunksJson: JSON.stringify(result.chunks),
          });
          // If a subject is selected, assign the doc to it
          if (activeSubject) {
            const allDocs = await invoke<DocEntry[]>("list_documents");
            const newest = allDocs[0]; // most recent
            if (newest) {
              await invoke("assign_document_subject", {
                documentId: newest.id,
                subjectId: activeSubject,
              });
            }
          }
        } catch (err) {
          console.error(`Failed to parse ${filename}:`, err);
        }
      }
      setUploadProgress(null);
      setUploading(false);
      loadData();
    } catch (err) {
      console.error("File picker error:", err);
      setUploading(false);
      setUploadProgress(null);
    }
  }, [loadData, activeSubject]);

  const handleDeleteDoc = useCallback(async (id: number) => {
    await invoke("delete_document", { id });
    loadData();
  }, [loadData]);

  const handleAssignDoc = useCallback(async (docId: number, subjectId: number | null) => {
    await invoke("assign_document_subject", { documentId: docId, subjectId });
    loadData();
  }, [loadData]);

  return (
    <>
      <p className="page-label">Knowledge Base</p>
      <h1 className="page-title">Your knowledge base</h1>

      {/* Explainer */}
      <div className="card" style={{ borderLeft: "3px solid var(--color-primary)" }}>
        <p style={{ fontSize: 14, color: "var(--color-text-secondary)" }}>
          Organize your knowledge into subjects. Each subject has its own documents
          and sessions. When Duet analyzes a session, it uses that subject's
          documents as ground truth for coaching.
        </p>
      </div>

      {/* Subject tabs */}
      <div style={{ display: "flex", gap: "var(--space-sm)", flexWrap: "wrap", marginBottom: "var(--space-lg)", alignItems: "center" }}>
        <button
          className={`btn ${activeSubject === null ? "btn-primary" : "btn-secondary"}`}
          style={{ fontSize: 13 }}
          onClick={() => setActiveSubject(null)}
        >
          All
        </button>
        {subjects.map((s) => (
          <button
            key={s.id}
            className={`btn ${activeSubject === s.id ? "btn-primary" : "btn-secondary"}`}
            style={{ fontSize: 13 }}
            onClick={() => setActiveSubject(s.id)}
          >
            {s.name}
            <span style={{ opacity: 0.6, marginLeft: 4, fontSize: 11 }}>
              {s.doc_count}
            </span>
          </button>
        ))}
        {!showNewSubject ? (
          <button
            className="btn btn-secondary"
            style={{ fontSize: 13 }}
            onClick={() => setShowNewSubject(true)}
          >
            + New subject
          </button>
        ) : (
          <div style={{ display: "flex", gap: "var(--space-xs)", alignItems: "center" }}>
            <input
              className="input"
              placeholder="Subject name"
              value={newSubjectName}
              onChange={(e) => setNewSubjectName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateSubject()}
              style={{ width: 160, fontSize: 13, padding: "var(--space-xs) var(--space-sm)" }}
              autoFocus
            />
            <button className="btn btn-primary" style={{ fontSize: 12, padding: "var(--space-xs) var(--space-sm)" }} onClick={handleCreateSubject}>Add</button>
            <button className="btn btn-secondary" style={{ fontSize: 12, padding: "var(--space-xs) var(--space-sm)" }} onClick={() => setShowNewSubject(false)}>×</button>
          </div>
        )}
      </div>

      {/* Active subject header */}
      {activeSubject && (() => {
        const subj = subjects.find((s) => s.id === activeSubject);
        if (!subj) return null;
        return (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-md)" }}>
            <div>
              <p style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18 }}>{subj.name}</p>
              {subj.description && (
                <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>{subj.description}</p>
              )}
              <div style={{ display: "flex", gap: "var(--space-sm)", marginTop: "var(--space-xs)" }}>
                <span className="metric">{subj.doc_count} docs</span>
                <span className="metric">{subj.recording_count} sessions</span>
              </div>
            </div>
            <button
              className="btn btn-secondary"
              style={{ fontSize: 12 }}
              onClick={() => handleDeleteSubject(subj.id)}
            >
              Delete subject
            </button>
          </div>
        );
      })()}

      {/* Upload */}
      <div style={{ marginBottom: "var(--space-lg)" }}>
        <button className="btn btn-primary" onClick={handleUpload} disabled={uploading}>
          {uploading ? uploadProgress || "Processing..." : "Upload documents"}
        </button>
        <span style={{ fontSize: 12, color: "var(--color-text-muted)", marginLeft: "var(--space-sm)" }}>
          PDF, Word, TXT, Markdown
          {activeSubject ? ` — will be added to ${subjects.find((s) => s.id === activeSubject)?.name}` : ""}
        </span>
      </div>

      {/* Documents */}
      {loading && <p style={{ color: "var(--color-text-muted)" }}>Loading...</p>}

      {!loading && docs.length === 0 && (
        <div className="card">
          <p style={{ color: "var(--color-text-muted)", textAlign: "center", padding: "var(--space-xl) 0" }}>
            No documents yet. Upload documents to build your knowledge base.
          </p>
        </div>
      )}

      {docs.map((doc) => (
        <div key={doc.id} className="card" style={{ marginBottom: "var(--space-xs)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ flex: 1 }}>
              <p style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14 }}>
                {doc.filename}
              </p>
              <span className="metric" style={{ marginTop: 4 }}>
                {doc.chunk_size > 0 ? `${Math.ceil(doc.chunk_size / 1000)}K chars` : "Empty"}
              </span>
            </div>
            {subjects.length > 0 && (
              <select
                style={{
                  padding: "var(--space-xs) var(--space-sm)",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-surface)",
                  color: "var(--color-text-secondary)",
                  fontSize: 12,
                  marginRight: "var(--space-sm)",
                  fontFamily: "var(--font-body)",
                }}
                onChange={(e) => handleAssignDoc(doc.id, e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">No subject</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            <button
              className="btn btn-secondary"
              style={{ fontSize: 12, padding: "var(--space-xs) var(--space-sm)" }}
              onClick={() => handleDeleteDoc(doc.id)}
            >
              ×
            </button>
          </div>
        </div>
      ))}

      {docs.length > 0 && (
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: "var(--space-sm)" }}>
          Documents stay on your device. Only text chunks are sent to the AI during analysis.
        </p>
      )}
    </>
  );
}

// ── Dashboard Screen ───────────────────────────────────────

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

function DashboardScreen() {
  const [data, setData] = useState<DashboardData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<DashboardData[]>("get_dashboard")
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <>
        <p className="page-label">Dashboard</p>
        <h1 className="page-title">Loading...</h1>
      </>
    );
  }

  if (data.length === 0) {
    return (
      <>
        <p className="page-label">Dashboard</p>
        <h1 className="page-title">Your progress</h1>
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

  return (
    <>
      <p className="page-label">Dashboard</p>
      <h1 className="page-title">Your progress</h1>

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "var(--space-md)", marginBottom: "var(--space-lg)" }}>
        <div className="card" style={{ textAlign: "center" }}>
          <p className="stat-value">{totalRecordings}</p>
          <p className="stat-label">Sessions</p>
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
    </>
  );
}

// ── Settings Screen ────────────────────────────────────────

function SettingsScreen() {
  const { mode, setMode } = useTheme();
  const [settingsTab, setSettingsTab] = useState<"general" | "session" | "account" | "billing">("general");

  return (
    <>
      <p className="page-label">Settings</p>
      <h1 className="page-title">Settings</h1>

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
  return (
    <>
      <div className="card">
        <h3 className="settings-heading">Appearance</h3>
        <div style={{ display: "flex", gap: 0, borderRadius: "var(--radius-md)", overflow: "hidden", border: "1px solid var(--color-border)" }}>
          {(["light", "auto", "dark"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                flex: 1,
                padding: "var(--space-sm) var(--space-md)",
                background: mode === m ? "var(--color-primary)" : "var(--color-surface)",
                color: mode === m ? "var(--color-primary-text)" : "var(--color-text-secondary)",
                border: "none",
                cursor: "pointer",
                fontFamily: "var(--font-body)",
                fontSize: 13,
                fontWeight: 600,
                textTransform: "capitalize",
                borderRight: m !== "dark" ? "1px solid var(--color-border)" : "none",
              }}
            >
              {m === "auto" ? "Auto" : m === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: "var(--space-xs)" }}>
          Auto follows your system setting.
        </p>
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

  const handleChange = (val: number) => {
    setPauseTimeout(val);
    localStorage.setItem("duet-pause-timeout", String(val));
  };

  return (
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

function Placeholder({ title }: { title: string }) {
  return (
    <>
      <p className="page-label">{title}</p>
      <h1 className="page-title">{title}</h1>
      <div className="card">
        <p style={{ color: "var(--color-text-muted)" }}>Coming soon.</p>
      </div>
    </>
  );
}

export default App;
