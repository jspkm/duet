import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RecordingEntry, SubjectEntry } from "../types";
import { DeleteConfirmation } from "../components/DeleteConfirmation";

export function RecordingsScreen({ onSelect }: { onSelect: (id: number) => void }) {
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

  const [viewMode, setViewMode] = useState<"list" | "group">(() =>
    (localStorage.getItem("duet-sessions-view") as "list" | "group") || "list"
  );
  const toggleView = (mode: "list" | "group") => {
    setViewMode(mode);
    localStorage.setItem("duet-sessions-view", mode);
  };

  // Group recordings by session type
  const groups: { label: string; type: string; items: RecordingEntry[] }[] = [];
  if (viewMode === "group" && recordings.length > 0) {
    const typeMap: Record<string, RecordingEntry[]> = {};
    for (const r of recordings) {
      const t = r.session_type === "coach_first" ? "coach" : (r.session_type || "recording");
      (typeMap[t] ??= []).push(r);
    }
    const labels: Record<string, string> = { coach: "Practice", recording: "Recording" };
    for (const [type, items] of Object.entries(typeMap)) {
      groups.push({ label: labels[type] || type, type, items });
    }
    groups.sort((a, b) => a.label.localeCompare(b.label));
  }

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["coach", "recording"]));
  const toggleGroup = (type: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  };

  return (
    <>
      <p className="page-label">Recording</p>
      <div style={{ display: "flex", gap: 2, marginBottom: "var(--space-md)" }}>
          <button
            onClick={() => toggleView("list")}
            title="List view"
            style={{
              background: viewMode === "list" ? "var(--color-surface-raised)" : "none",
              border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm) 0 0 var(--radius-sm)",
              padding: "4px 8px", cursor: "pointer", display: "flex", alignItems: "center",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={viewMode === "list" ? "var(--color-text)" : "var(--color-text-muted)"} strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 3h12M2 6.5h12M2 10h12M2 13.5h12" />
            </svg>
          </button>
          <button
            onClick={() => toggleView("group")}
            title="Group view"
            style={{
              background: viewMode === "group" ? "var(--color-surface-raised)" : "none",
              border: "1px solid var(--color-border)", borderLeft: "none", borderRadius: "0 var(--radius-sm) var(--radius-sm) 0",
              padding: "4px 8px", cursor: "pointer", display: "flex", alignItems: "center",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={viewMode === "group" ? "var(--color-text)" : "var(--color-text-muted)"} strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" />
            </svg>
          </button>
      </div>

      {loading && <p style={{ color: "var(--color-text-muted)" }}>Loading...</p>}

      {!loading && recordings.length === 0 && (
        <div className="card">
          <p style={{ color: "var(--color-text-muted)" }}>
            No sessions yet. Hit Record to get started.
          </p>
        </div>
      )}

      {/* Group view: headers with their cards nested inside */}
      {viewMode === "group" && groups.map((group) => (
        <div key={group.type} style={{ marginBottom: "var(--space-sm)" }}>
          <div
            style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", cursor: "pointer", padding: "var(--space-xs) 0" }}
            onClick={() => toggleGroup(group.type)}
          >
            <span style={{ color: "var(--color-text-muted)", fontSize: 14, transition: "transform 0.2s", transform: expandedGroups.has(group.type) ? "rotate(90deg)" : "rotate(0deg)" }}>▸</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-secondary)" }}>
              {group.label}
            </span>
            <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>({group.items.length})</span>
          </div>
          {expandedGroups.has(group.type) && group.items.map((r) => {
            const isReady = !!r.transcript_text;
            return (
              <div
                key={r.id}
                className="card"
                style={{ cursor: isReady ? "pointer" : "default", position: "relative", opacity: isReady ? 1 : 0.7, marginBottom: "var(--space-xs)" }}
                onClick={() => isReady && onSelect(r.id)}
              >
                {!isReady && (
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(var(--color-bg-rgb, 255,255,255), 0.6)", borderRadius: "var(--radius-md)", zIndex: 2 }}>
                    <p style={{ fontSize: 13, color: "var(--color-text-muted)", fontWeight: 500 }}>Analyzing...</p>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15 }}>
                      {r.name || `Session #${r.id}`}
                    </p>
                    <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
                      {r.duration_seconds > 0 && <>{formatDuration(r.duration_seconds)} · </>}
                      {new Date(r.recorded_at.endsWith("Z") ? r.recorded_at : r.recorded_at + "Z").toLocaleDateString()} at{" "}
                      {new Date(r.recorded_at.endsWith("Z") ? r.recorded_at : r.recorded_at + "Z").toLocaleTimeString()}
                    </p>
                    {r.transcript_text && (
                      <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.transcript_text.replace(/^\[Coach\]\s*/m, "").split("\n")[0]?.slice(0, 100)}
                      </p>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                    {confirmDeleteId !== r.id && <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteClick(r.id); }}
                      style={{ background: "none", border: "none", cursor: "pointer", padding: "var(--space-xs)", borderRadius: "var(--radius-sm)", display: "flex", alignItems: "center", justifyContent: "center" }}
                      title="Delete session"
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#C94040" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M6.67 7.33v4M9.33 7.33v4M3.33 4l.67 9.33a1.33 1.33 0 001.33 1.34h5.34a1.33 1.33 0 001.33-1.34L12.67 4" />
                      </svg>
                    </button>}
                  </div>
                </div>
                {confirmDeleteId === r.id && (
                  <div onClick={(e) => e.stopPropagation()}>
                    <DeleteConfirmation onConfirm={handleConfirmDelete} onCancel={() => setConfirmDeleteId(null)} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* List view: flat list */}
      {viewMode === "list" && recordings.map((r) => {
        const isReady = !!r.transcript_text;
        return (
        <div
          key={r.id}
          className="card"
          style={{ cursor: isReady ? "pointer" : "default", position: "relative", opacity: isReady ? 1 : 0.7 }}
          onClick={() => isReady && onSelect(r.id)}
        >
          {!isReady && (
            <div style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(var(--color-bg-rgb, 255,255,255), 0.6)", borderRadius: "var(--radius-md)", zIndex: 2,
            }}>
              <p style={{ fontSize: 13, color: "var(--color-text-muted)", fontWeight: 500 }}>Analyzing...</p>
            </div>
          )}
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
                {r.duration_seconds > 0 && <>{formatDuration(r.duration_seconds)} · </>}
                {new Date(r.recorded_at.endsWith("Z") ? r.recorded_at : r.recorded_at + "Z").toLocaleDateString()} at{" "}
                {new Date(r.recorded_at.endsWith("Z") ? r.recorded_at : r.recorded_at + "Z").toLocaleTimeString()}
              </p>
              {r.transcript_text && (
                <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 400 }}>
                  {r.transcript_text.replace(/^\[Coach\]\s*/m, "").split("\n")[0]?.slice(0, 100)}
                </p>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
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
              {viewMode === "list" && (r.session_type === "coach" || r.session_type === "coach_first") && (
                <span className="metric" style={{ color: "var(--color-primary)" }}>Practice</span>
              )}
              {confirmDeleteId !== r.id && <button
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
              </button>}
            </div>
          </div>

          {/* Inline delete confirmation */}
          {confirmDeleteId === r.id && (
            <div onClick={(e) => e.stopPropagation()}>
              <DeleteConfirmation
                onConfirm={handleConfirmDelete}
                onCancel={() => setConfirmDeleteId(null)}
              />
            </div>
          )}
        </div>
      ); })}
    </>
  );
}
