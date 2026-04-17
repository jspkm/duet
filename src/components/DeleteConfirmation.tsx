export function DeleteConfirmation({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{ marginTop: "var(--space-md)", paddingTop: "var(--space-md)", borderTop: "1px solid var(--color-border)", textAlign: "right" }}>
      <p style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: "var(--space-sm)" }}>
        Delete this session? This cannot be undone.
      </p>
      <div style={{ display: "flex", gap: "var(--space-sm)", justifyContent: "flex-end" }}>
        <button
          className="btn"
          style={{ background: "var(--color-error)", color: "#fff", fontSize: 12, padding: "var(--space-xs) var(--space-md)" }}
          onClick={onConfirm}
        >
          Delete
        </button>
        <button
          className="btn btn-secondary"
          style={{ fontSize: 12, padding: "var(--space-xs) var(--space-md)" }}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
