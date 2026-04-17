import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { appDataDir, join } from "@tauri-apps/api/path";
import type { ProgressEvent } from "../types";
import { getRecorderMimeType } from "../lib/recorder";

export function StartSessionButton({ onComplete }: { onComplete: (id: number) => void }) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pauseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const elapsedRef = useRef(0);
  const cancelledRef = useRef(false);

  // Incremental background processing state
  const bgProcessingRef = useRef(false);
  const bgIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const processedChunkCountRef = useRef(0);
  const accumulatedRef = useRef<{
    segments: any[];
    words: any[];
    processedDuration: number;
    fullText: string;
  }>({ segments: [], words: [], processedDuration: 0, fullText: "" });
  const segmentFilesRef = useRef<string[]>([]);

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
      timerRef.current = setInterval(() => setElapsed((p) => { elapsedRef.current = p + 1; return p + 1; }), 1000);
      if (pauseTimeoutRef.current) { clearTimeout(pauseTimeoutRef.current); pauseTimeoutRef.current = null; }
      setPaused(false);
    } else {
      recorder.pause();
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setPaused(true);
      // Auto-stop after configured minutes
      pauseTimeoutRef.current = setTimeout(() => {
        if (bgIntervalRef.current) { clearInterval(bgIntervalRef.current); bgIntervalRef.current = null; }
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

  // Process a segment of new audio chunks in the background
  const processSegmentBg = useCallback(async () => {
    if (bgProcessingRef.current) return;
    const startIdx = processedChunkCountRef.current;
    const currentChunks = chunksRef.current;
    if (startIdx >= currentChunks.length) return;
    // Need at least a few chunks (~5s) to be worth processing
    if (currentChunks.length - startIdx < 5) return;

    bgProcessingRef.current = true;
    try {
      const newChunks = currentChunks.slice(startIdx);
      const snapshotCount = currentChunks.length;
      const segmentBlob = new Blob(newChunks, { type: getRecorderMimeType().mimeType || "audio/webm" });

      const dataDir = await appDataDir();
      const segPath = await join(dataDir, "recordings", `segment-${Date.now()}.${getRecorderMimeType().ext}`);
      const { writeFile, mkdir } = await import("@tauri-apps/plugin-fs");
      await mkdir(await join(dataDir, "recordings"), { recursive: true });
      await writeFile(segPath, new Uint8Array(await segmentBlob.arrayBuffer()));
      segmentFilesRef.current.push(segPath);

      const speech = await invoke<{
        transcript: { text: string; segments: any[]; words: any[] };
        duration_seconds: number;
      }>("analyze_speech", { audioPath: segPath });

      // Offset timestamps by accumulated duration
      const offset = accumulatedRef.current.processedDuration;
      const offsetSegments = speech.transcript.segments.map((s: any) => ({
        ...s, start: s.start + offset, end: s.end + offset,
      }));
      const offsetWords = speech.transcript.words.map((w: any) => ({
        ...w, start: w.start + offset, end: w.end + offset,
      }));

      accumulatedRef.current = {
        segments: [...accumulatedRef.current.segments, ...offsetSegments],
        words: [...accumulatedRef.current.words, ...offsetWords],
        processedDuration: accumulatedRef.current.processedDuration + speech.duration_seconds,
        fullText: accumulatedRef.current.fullText + (accumulatedRef.current.fullText ? " " : "") + speech.transcript.text,
      };
      processedChunkCountRef.current = snapshotCount;
    } catch (err) {
      console.warn("Background segment processing failed:", err);
    } finally {
      bgProcessingRef.current = false;
    }
  }, []);

  const processAudio = useCallback(async (filePath: string, duration: number, preAccumulated?: typeof accumulatedRef.current) => {
    cancelledRef.current = false;
    setProcessing(true);
    setProgress({ stage: "saving", percent: 10 });

    type SpeechResult = {
      transcript: { text: string; segments: any[]; words: any[] };
      disfluencies: { fillers: any[]; all: any[] };
      flagged_moments: { start: number; end: number; type: string; severity: number; coach_type: string; transcript_text: string; detail: string }[];
      overall_metrics: { filler_count: number; total_disfluencies: number; pause_count: number; avg_pace_wpm: number; word_count: number; duration_seconds: number };
      duration_seconds: number;
    };

    try {
      const saveResult = await invoke<{ id: number }>("save_recording", {
        audioPath: filePath, duration,
      });
      const recordingId = saveResult.id;

      if (cancelledRef.current) { await invoke("delete_recording", { recordingId }); return; }

      let speech: SpeechResult;

      if (preAccumulated && preAccumulated.words.length > 0) {
        setProgress({ stage: "finalizing", percent: 40 });
        speech = await invoke<SpeechResult>("analyze_words", {
          words: preAccumulated.words,
          segments: preAccumulated.segments,
          durationSeconds: preAccumulated.processedDuration,
          fullText: preAccumulated.fullText,
        });
      } else {
        setProgress({ stage: "transcribing", percent: 25 });
        speech = await invoke<SpeechResult>("analyze_speech", { audioPath: filePath });
      }

      // Filter to user's speech only when multiple speakers detected
      const speakerMode = localStorage.getItem("duet-speaker-mode") || "auto";
      if (speakerMode === "auto") {
        const allWords = speech.transcript.words;
        const speakers = new Map<string, number>();
        for (const w of allWords) {
          const spk = w.speaker || "unknown";
          speakers.set(spk, (speakers.get(spk) || 0) + 1);
        }

        if (speakers.size > 1) {
          let mySpeaker: string | null = null;

          // Try voiceprint matching first (most reliable)
          try {
            const profileRes = await invoke<{ embedding_json: string | null; user_name: string | null }>("get_voice_profile");
            if (profileRes.embedding_json) {
              const matchRes = await invoke<{ matched_speaker: string | null; similarity: number }>(
                "match_speaker", {
                  audioPath: filePath,
                  segments: speech.transcript.segments,
                  storedEmbedding: JSON.parse(profileRes.embedding_json),
                }
              );
              if (matchRes.matched_speaker && matchRes.similarity > 0.5) {
                mySpeaker = matchRes.matched_speaker;
              }
            }
          } catch {}

          // Fallback: stored preference or most words
          if (!mySpeaker) {
            const storedSpeaker = localStorage.getItem("duet-my-speaker");
            mySpeaker = storedSpeaker && speakers.has(storedSpeaker) ? storedSpeaker
              : [...speakers.entries()].sort((a, b) => b[1] - a[1])[0]![0];
          }
          localStorage.setItem("duet-my-speaker", mySpeaker);

          const myWords = allWords.filter((w: any) => (w.speaker || "unknown") === mySpeaker);
          const mySegments = speech.transcript.segments.filter((s: any) => s.speaker === mySpeaker);
          const myText = mySegments.map((s: any) => s.text).join(" ");
          const myDuration = myWords.length > 0
            ? myWords[myWords.length - 1].end - myWords[0].start
            : speech.duration_seconds;

          setProgress({ stage: "filtering", percent: 55 });
          speech = await invoke<SpeechResult>("analyze_words", {
            words: myWords,
            segments: mySegments,
            durationSeconds: myDuration,
            fullText: myText,
          });
        }
      }

      setProgress({ stage: "saving", percent: 60 });
      const fullText = speech.transcript.text;
      await invoke("save_recording", {
        audioPath: filePath,
        duration: speech.duration_seconds,
        recordingId,
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

  const processBlob = useCallback(async (blob: Blob, duration: number, accumulated: typeof accumulatedRef.current) => {
    const dataDir = await appDataDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const recFmt = getRecorderMimeType();
    const filePath = await join(dataDir, "recordings", `session-${timestamp}.${recFmt.ext}`);
    const { writeFile, mkdir, remove } = await import("@tauri-apps/plugin-fs");
    await mkdir(await join(dataDir, "recordings"), { recursive: true });
    await writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));

    // If we have unprocessed chunks remaining, transcribe just the tail segment
    const remainingIdx = processedChunkCountRef.current;
    const allChunks = chunksRef.current;
    if (remainingIdx < allChunks.length && remainingIdx > 0) {
      // Wait for any in-flight bg processing to finish
      while (bgProcessingRef.current) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // Re-read accumulated in case bg processing just finished
      accumulated = accumulatedRef.current;

      try {
        const tailChunks = allChunks.slice(remainingIdx);
        const tailBlob = new Blob(tailChunks, { type: recFmt.mimeType || "audio/webm" });
        const tailPath = await join(dataDir, "recordings", `segment-tail-${Date.now()}.${recFmt.ext}`);
        await writeFile(tailPath, new Uint8Array(await tailBlob.arrayBuffer()));
        segmentFilesRef.current.push(tailPath);

        const tailSpeech = await invoke<{
          transcript: { text: string; segments: any[]; words: any[] };
          duration_seconds: number;
        }>("analyze_speech", { audioPath: tailPath });

        const offset = accumulated.processedDuration;
        const offsetSegments = tailSpeech.transcript.segments.map((s: any) => ({
          ...s, start: s.start + offset, end: s.end + offset,
        }));
        const offsetWords = tailSpeech.transcript.words.map((w: any) => ({
          ...w, start: w.start + offset, end: w.end + offset,
        }));

        accumulated = {
          segments: [...accumulated.segments, ...offsetSegments],
          words: [...accumulated.words, ...offsetWords],
          processedDuration: accumulated.processedDuration + tailSpeech.duration_seconds,
          fullText: accumulated.fullText + (accumulated.fullText ? " " : "") + tailSpeech.transcript.text,
        };
      } catch (err) {
        console.warn("Tail segment processing failed, falling back to full transcription:", err);
        accumulated = { segments: [], words: [], processedDuration: 0, fullText: "" };
      }
    }

    // Clean up temp segment files
    for (const segFile of segmentFilesRef.current) {
      try { await remove(segFile); } catch {}
    }
    segmentFilesRef.current = [];

    await processAudio(filePath, duration, accumulated.words.length > 0 ? accumulated : undefined);
  }, [processAudio]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recFmt = getRecorderMimeType();
      const recorder = recFmt.mimeType ? new MediaRecorder(stream, { mimeType: recFmt.mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      processedChunkCountRef.current = 0;
      accumulatedRef.current = { segments: [], words: [], processedDuration: 0, fullText: "" };
      segmentFilesRef.current = [];

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recFmt.mimeType || "audio/webm" });
        stream.getTracks().forEach((t) => t.stop());
        processBlob(blob, elapsedRef.current, accumulatedRef.current);
      };
      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      setRecording(true);
      setMicError(null);
      setElapsed(0);
      elapsedRef.current = 0;
      setShowDropdown(false);
      timerRef.current = setInterval(() => setElapsed((p) => { elapsedRef.current = p + 1; return p + 1; }), 1000);
      // Start background transcription every 30 seconds
      bgIntervalRef.current = setInterval(processSegmentBg, 30000);
    } catch (err: any) {
      console.error("Mic denied:", err);
      setMicError(err?.message === "Permission denied" || err?.name === "NotAllowedError"
        ? "Microphone access denied. Check System Settings > Privacy & Security > Microphone."
        : `Recording failed: ${err?.message || err}`);
    }
  }, [processBlob, processSegmentBg]);

  const stopRecording = useCallback(() => {
    // Stop background processing interval
    if (bgIntervalRef.current) { clearInterval(bgIntervalRef.current); bgIntervalRef.current = null; }
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
    if (bgIntervalRef.current) clearInterval(bgIntervalRef.current);
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

  // Recording: show controls + timer in sidebar
  if (recording) {
    return (
      <div style={{ width: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "var(--space-xs)", marginBottom: "var(--space-xs)" }}>
          <button
            className="btn session-control-btn session-stop-btn"
            onClick={stopRecording}
            title="Stop"
            style={{ width: 32, height: 32, fontSize: 12 }}
          >
            ⏹
          </button>
          <button
            className="btn session-control-btn"
            onClick={togglePause}
            title={paused ? "Resume" : "Pause"}
            style={{ width: 32, height: 32, fontSize: 12 }}
          >
            {paused ? "▶" : "⏸"}
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "var(--space-xs)" }}>
          <span className="recording-dot" style={paused ? { animation: "none", opacity: 0.4 } : undefined} />
          <span className="session-timer-text" style={{ fontSize: 13 }}>{formatTime(elapsed)}{paused ? " (paused)" : ""}</span>
        </div>
      </div>
    );
  }

  // Idle: Start Session button in sidebar
  return (
    <div style={{ width: "100%" }}>
      {micError && (
        <p style={{ fontSize: 11, color: "var(--color-error)", marginBottom: "var(--space-xs)", textAlign: "center" }}>
          {micError}
        </p>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
        <button
          className="btn start-session-btn"
          style={{ flex: 1, fontSize: 13, padding: "var(--space-sm) var(--space-md)" }}
          onClick={startRecording}
        >
          Record
        </button>
        <button
          className="btn start-session-dropdown"
          style={{ fontSize: 11, padding: "var(--space-sm) var(--space-xs)" }}
          onClick={() => setShowDropdown(!showDropdown)}
        >
          ▾
        </button>
      </div>
      {showDropdown && (
        <div style={{ marginTop: "var(--space-xs)" }}>
          <button
            className="start-session-menu-item"
            style={{ width: "100%", fontSize: 12, padding: "var(--space-xs) var(--space-sm)", textAlign: "left" }}
            onClick={handleUpload}
          >
            Upload audio file
          </button>
        </div>
      )}
    </div>
  );
}
