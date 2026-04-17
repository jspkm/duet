import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import type { FlaggedMomentEntry } from "../types";
import { getRecorderMimeType } from "../lib/recorder";
import { AudioPlayer } from "./AudioPlayer";

type DrillState = "listen" | "recording" | "review";

export function PracticeDrillList({ recordingId, moments }: { recordingId: number; moments: FlaggedMomentEntry[] }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  return (
    <div>
      {moments.map((moment, idx) => {
        const typeLabel: Record<string, string> = {
          filler_words: "Filler Words",
          filler: "Filler Words",
          hedging: "Hedging Language",
          deflection: "Deflection",
          "filler+repetition": "Fillers & Repetition",
          long_pause: "Extended Pause",
          rushing: "Rushing",
          uncertainty: "Uncertain Delivery",
          repetition: "Word Repetition",
          restart: "False Start",
        };

        const drillTip: Record<string, string> = {
          filler_words: "Pause and breathe instead of filling silence. Practice saying your key point, then stop. Let the silence land. Repeat 5 times, making each pause longer.",
          filler: "Pause and breathe instead of filling silence. Practice saying your key point, then stop. Let the silence land. Repeat 5 times, making each pause longer.",
          hedging: "Replace hedge words with direct statements. Instead of 'I think maybe we should...' say 'We should...' Record yourself making 3 recommendations without any qualifiers.",
          deflection: "Own your statements. Replace 'they say' or 'people think' with 'I believe' or 'our data shows.' Practice making 3 direct claims about your area of expertise.",
          "filler+repetition": "This is a pattern of circling back when you're unsure. Write your point in one sentence first, then practice saying just that sentence cleanly. No extras.",
          long_pause: "Long pauses break momentum. If you need to think, bridge with a short phrase like 'The key factor here is...' while you gather your next point. Practice transitions between your main ideas.",
          rushing: "You're compressing your words when the stakes feel high. Practice the replacement phrase below at half speed, then gradually speed up. Your natural pace should feel almost too slow.",
          uncertainty: "Your voice is dropping or trailing off mid-sentence, signaling doubt. Practice landing your sentences with downward vocal energy. Record the phrase below and listen for a strong, definitive ending.",
          repetition: "Repeating words signals your brain is buffering. Practice the technique of completing your thought silently before speaking. Say the replacement phrase below in one clean pass.",
          restart: "You're starting sentences and abandoning them. Before you speak, silently finish the sentence in your head first, then say it out loud. Practice this 5 times with the replacement below.",
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
                  fontSize: 16, fontWeight: 700, color: "var(--color-text-muted)",
                  minWidth: 20, textAlign: "center",
                  fontFamily: "var(--font-mono)",
                }}>
                  {idx + 1}
                </span>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 500 }}>
                    {typeLabel[moment.moment_type] ?? moment.moment_type}
                  </p>
                  <p style={{ fontSize: 12, color: "var(--color-text-muted)", maxWidth: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    "{moment.transcript_text}"
                  </p>
                  {expandedIdx !== idx && (() => {
                    // Show coaching text (from Claude) or fallback drill tip
                    const coachText = moment.coaching_text
                      ? moment.coaching_text.split("\n\nTry saying:")[0]
                      : drillTip[moment.moment_type] ?? "";
                    if (!coachText) return null;
                    return (
                      <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4, lineHeight: 1.5, maxWidth: 600 }}>
                        {coachText}
                      </p>
                    );
                  })()}
                </div>
              </div>
              <span style={{ color: "var(--color-text-muted)", fontSize: 16 }}>
                {expandedIdx === idx ? "▾" : "▸"}
              </span>
            </div>

            {/* Expanded drill */}
            {expandedIdx === idx && (
              <div style={{ marginTop: "var(--space-md)", borderTop: "1px solid var(--color-border)", paddingTop: "var(--space-md)" }}>
                <DrillInteraction
                  moment={moment}
                  recordingId={recordingId}
                  momentIdx={idx}
                  onNext={idx < moments.length - 1 ? () => setExpandedIdx(idx + 1) : undefined}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DrillInteraction({ moment, recordingId, momentIdx, onNext }: { moment: FlaggedMomentEntry; recordingId: number; momentIdx: number; onNext?: () => void }) {
  const [clipPath, setClipPath] = useState<string | null>(null);
  const [drillState, setDrillState] = useState<DrillState>("listen");
  const [attempts, setAttempts] = useState<string[]>([]);
  const [micError, setMicError] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [evaluation, setEvaluation] = useState<{ passed: boolean; score: number; feedback: string; remaining_issues: string[] } | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const lastBlobRef = useRef<Blob | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const dataDir = await appDataDir();
        const p = await join(dataDir, "clips", `recording-${recordingId}`, `clip-${momentIdx}.wav`);
        setClipPath(p);
      } catch {}
    })();
  }, [recordingId, momentIdx]);

  // Auto-evaluate when entering review state with a new recording
  useEffect(() => {
    if (drillState !== "review" || evaluating || evaluation) return;
    const blob = lastBlobRef.current;
    if (!blob) return;

    (async () => {
      setEvaluating(true);
      try {
        const dataDir = await appDataDir();
        const drillFmt = getRecorderMimeType();
        const tmpPath = await join(dataDir, "recordings", `drill-attempt-${Date.now()}.${drillFmt.ext}`);
        const { writeFile, mkdir, remove } = await import("@tauri-apps/plugin-fs");
        await mkdir(await join(dataDir, "recordings"), { recursive: true });
        await writeFile(tmpPath, new Uint8Array(await blob.arrayBuffer()));

        const speech = await invoke<{ transcript: { text: string } }>("analyze_speech", { audioPath: tmpPath });
        const attemptText = speech.transcript.text;

        try { await remove(tmpPath); } catch {}

        let suggested = "";
        if (moment.coaching_text) {
          const parts = moment.coaching_text.split('\n\nTry saying: "');
          if (parts[1]) suggested = parts[1].replace(/"$/, "");
        }

        const result = await invoke<{ passed: boolean; score: number; feedback: string; remaining_issues: string[] }>(
          "evaluate_drill", {
            originalText: moment.transcript_text,
            momentType: moment.moment_type,
            suggestedDelivery: suggested,
            attemptTranscript: attemptText,
            attemptNumber: attempts.length,
          }
        );
        setEvaluation(result);
      } catch (err) {
        console.warn("Drill evaluation failed:", err);
        setEvaluation({ passed: false, score: 0, feedback: "Could not evaluate this attempt. Try again.", remaining_issues: [] });
      } finally {
        setEvaluating(false);
      }
    })();
  }, [drillState, attempts.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
      {(() => {
        const fallbackTips: Record<string, string> = {
          filler_words: "Pause and breathe instead of filling silence. Practice saying your key point, then stop completely. Let the silence land for a full two seconds. Repeat 5 times, making each pause longer. Silence reads as confidence to your audience.",
          filler: "Pause and breathe instead of filling silence. Practice saying your key point, then stop completely. Let the silence land for a full two seconds. Repeat 5 times, making each pause longer. Silence reads as confidence to your audience.",
          hedging: "Replace hedge words (\"I think,\" \"maybe,\" \"sort of\") with direct statements. Instead of \"I think maybe we should...\" say \"We should...\" Record yourself making 3 recommendations without any qualifiers. Notice how much more authoritative you sound.",
          deflection: "Own your statements. Replace \"they say\" or \"people think\" with \"I believe\" or \"our data shows.\" Practice making 3 direct claims about your area of expertise. Your audience wants to hear YOUR conviction.",
          "filler+repetition": "You're circling back and filling when you're unsure. Write your point in one sentence. Then practice saying just that sentence, cleanly, with a full stop at the end. No extras, no filler, no repeating. Do this 5 times until it feels natural.",
          long_pause: "Extended pauses break your momentum and lose your listener. If you need to think, bridge with a short phrase like \"The key factor here is...\" while you gather your next point. Practice smooth transitions between your 3 main ideas.",
          rushing: "You're compressing your words when the stakes feel high. Practice the replacement phrase below at half your normal speed. Then gradually increase. Your \"comfortable\" pace should feel almost too slow to you, but it sounds authoritative to listeners.",
          uncertainty: "Your voice is dropping or trailing off mid-sentence, which signals doubt. Practice landing your sentences with downward vocal energy on the last word. Record yourself and listen for a strong, definitive ending on each sentence.",
          repetition: "Repeating words signals your brain is buffering while your mouth runs ahead. Before you speak, silently complete the full sentence in your head. Then say it in one clean pass. Practice this with the example below, 5 reps.",
          restart: "False starts happen when you begin speaking before your thought is fully formed. Pause. Finish the thought silently. Then deliver it in one clean sentence. Practice: think of a point, wait two beats, then say it. Repeat 5 times.",
        };

        if (moment.coaching_text) {
          const parts = moment.coaching_text.split("\n\nTry saying: \"");
          const coaching = parts[0];
          const suggested = parts[1]?.replace(/"$/, "");
          return (
            <div style={{ marginBottom: "var(--space-md)" }}>
              <p style={{ color: "var(--color-text-secondary)", marginBottom: "var(--space-md)", fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
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
        }

        const tip = fallbackTips[moment.moment_type];
        if (tip) {
          return (
            <div style={{
              marginBottom: "var(--space-md)",
              background: "var(--color-surface-raised)",
              borderLeft: "3px solid var(--color-warning)",
              padding: "var(--space-md)",
              borderRadius: "0 var(--radius-md) var(--radius-md) 0",
            }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: "var(--color-warning)", marginBottom: "var(--space-xs)" }}>
                Coach says
              </p>
              <p style={{ fontSize: 14, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
                {tip}
              </p>
            </div>
          );
        }

        return null;
      })()}

      {/* Drill interaction */}
      {micError && (
        <p style={{ fontSize: 13, color: "var(--color-error)", marginBottom: "var(--space-sm)" }}>
          {micError}
        </p>
      )}
      {drillState === "listen" && (
        <button
          className="btn btn-primary-large"
          onClick={async () => {
            setMicError(null);
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              const drillFmt = getRecorderMimeType();
              const recorder = drillFmt.mimeType ? new MediaRecorder(stream, { mimeType: drillFmt.mimeType }) : new MediaRecorder(stream);
              chunksRef.current = [];
              recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
              recorder.onstop = () => {
                const blob = new Blob(chunksRef.current, { type: drillFmt.mimeType || "audio/webm" });
                const url = URL.createObjectURL(blob);
                stream.getTracks().forEach((t) => t.stop());
                lastBlobRef.current = blob;
                setAttempts((prev) => [...prev, url]);
                setEvaluation(null);
                setDrillState("review");
              };
              recorder.start();
              mediaRecorderRef.current = recorder;
              setDrillState("recording");
            } catch (err: any) {
              console.error("Mic denied:", err);
              setMicError(err?.message === "Permission denied" || err?.name === "NotAllowedError"
                ? "Microphone access denied. Check System Settings > Privacy & Security > Microphone."
                : `Recording failed: ${err?.message || err}`);
            }
          }}
        >
          LET'S PRACTICE
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
        const max = 5;

        return (
          <div>
            <p style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-muted)", marginBottom: "var(--space-sm)" }}>
              Your version (attempt {count})
            </p>
            {latest && (
              <div className="waveform" style={{ marginBottom: "var(--space-md)" }}>
                <audio src={latest} controls style={{ width: "100%", height: 36, borderRadius: "var(--radius-md)" }} />
              </div>
            )}

            {/* Evaluation feedback */}
            {evaluating && (
              <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginBottom: "var(--space-md)" }}>
                Evaluating your delivery...
              </p>
            )}
            {evaluation && (
              <div style={{
                marginBottom: "var(--space-md)",
                padding: "var(--space-md)",
                background: "var(--color-surface-raised)",
                borderLeft: `3px solid ${evaluation.passed ? "var(--color-success)" : "var(--color-warning)"}`,
                borderRadius: "0 var(--radius-md) var(--radius-md) 0",
              }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: evaluation.passed ? "var(--color-success)" : "var(--color-warning)", marginBottom: "var(--space-xs)" }}>
                  {evaluation.passed ? "Nice work!" : "Keep going"} — {evaluation.score}/10
                </p>
                <p style={{ fontSize: 14, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                  {evaluation.feedback}
                </p>
                {evaluation.remaining_issues.length > 0 && (
                  <ul style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: "var(--space-xs)", paddingLeft: "var(--space-md)" }}>
                    {evaluation.remaining_issues.map((issue, i) => <li key={i}>{issue}</li>)}
                  </ul>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: "var(--space-sm)" }}>
              {evaluation?.passed && onNext ? (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={onNext}>
                  Next drill
                </button>
              ) : count < max && evaluation ? (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => { setEvaluation(null); setDrillState("listen"); }}>
                  Try again
                </button>
              ) : null}
              {evaluation?.passed && !onNext && (
                <p style={{ flex: 1, fontSize: 13, color: "var(--color-success)", padding: "var(--space-sm) 0", fontWeight: 500 }}>
                  You nailed it. Last drill in this session.
                </p>
              )}
            </div>
          </div>
        );
      })()}
    </>
  );
}
