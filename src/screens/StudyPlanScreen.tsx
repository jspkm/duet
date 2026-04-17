import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

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

export function StudyPlanScreen() {
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
      <p className="page-label">Practice</p>

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
