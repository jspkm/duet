import { useState, useRef, useCallback, useEffect } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import type { FirstImpression } from "../types";
import { voiceBandAvg, speechThreshold, splitSentences, getRecorderMimeType } from "../lib/recorder";

type CoachState = "idle" | "intro" | "listening" | "processing" | "speaking" | "wrapping" | "analyzing" | "done";

export function CoachScreen({ forceFirst }: { forceFirst: boolean }) {
  const [state, setState] = useState<CoachState>("idle");
  const [history, setHistory] = useState<{ role: "coach" | "user"; text: string }[]>([]);
  const [statusText, setStatusText] = useState("");
  const [firstImpression, setFirstImpression] = useState<FirstImpression | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [isFirstSession, setIsFirstSession] = useState(forceFirst);
  const [sessionNumber, setSessionNumber] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [introAudioPath, setIntroAudioPath] = useState<string | null>(null);
  const [waitingNudge, setWaitingNudge] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceStartRef = useRef<number>(0);
  const noiseFloorRef = useRef<number>(0);
  const speechDetectedRef = useRef(false);
  const animFrameRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const allChunksRef = useRef<Blob[]>([]);
  const turnStartChunkIdx = useRef(0); // Index into allChunksRef where current turn started
  const sessionRecorderRef = useRef<MediaRecorder | null>(null); // Single recorder for whole session
  const sessionStreamRef = useRef<MediaStream | null>(null);
  const mixedDestRef = useRef<MediaStreamAudioDestinationNode | null>(null); // Mixes mic + coach TTS
  const turnRecorderRef = useRef<MediaRecorder | null>(null); // Short-lived recorder per turn
  const turnChunksRef = useRef<Blob[]>([]);
  const turnResolveRef = useRef<((blob: Blob) => void) | null>(null);
  const historyRef = useRef<{ role: "coach" | "user"; text: string }[]>([]);
  const userPaceRef = useRef<number>(140);
  const sessionStartTimeRef = useRef<number>(0);

  // Check session count and pre-synthesize intro audio
  useEffect(() => {
    (async () => {
      try {
        // Ensure coach audio directory exists (once)
        const dataDir = await appDataDir();
        const { mkdir } = await import("@tauri-apps/plugin-fs");
        await mkdir(await join(dataDir, "coach"), { recursive: true });

        const [profileRes, countRes] = await Promise.all([
          invoke<{ embedding_json: string | null; user_name: string | null }>("get_voice_profile"),
          invoke<{ count: number }>("get_coach_session_count"),
        ]);
        // First session = no voice profile AND no prior coach sessions
        // forceFirst from the button is authoritative. Otherwise detect from state.
        const first = forceFirst ? true : (!profileRes.embedding_json && countRes.count === 0);
        setIsFirstSession(first);
        setSessionNumber(countRes.count);
        if (profileRes.user_name) setUserName(profileRes.user_name);

        // Pre-synthesize intro audio so there's no delay
        // First session: full intro. First exercise session: explain format. After that: skip intro.
        const introText = first
          ? "Hi, I am Lisa. This is our first session together. I'd like to spend about three to five minutes getting to know you and how you speak. It will also be a foundation for a practice session named My Athentic Voice. You can stop anytime, just say, end the session, or something like that. Ready? Tell me your name and what you do."
          : countRes.count <= 1
            ? "Welcome back. Today we're doing practice exercises. I'll ask you a question, listen to your answer, and if I hear any fillers or hesitations, I'll point them out and ask you to try again. Here's your first one."
            : null; // No intro needed, jump straight to question

        if (introText) {
          const dataDir = await appDataDir();
          const outputPath = await join(dataDir, "coach", `intro-${Date.now()}.wav`);
          const { mkdir } = await import("@tauri-apps/plugin-fs");
          await mkdir(await join(dataDir, "coach"), { recursive: true });
          await invoke("speak_text", { text: introText, outputPath });
          setIntroAudioPath(outputPath);
        }
        setReady(true);
      } catch {
        setReady(true);
      }
    })();
  }, []);

  // Play coach audio through AudioContext (routes to speakers + recording)
  const playCoachAudio = useCallback(async (audioPath: string): Promise<void> => {
    const audioCtx = audioContextRef.current;
    const mixedDest = mixedDestRef.current;

    // If no AudioContext (session not started yet or ended), use basic playback
    if (!audioCtx || audioCtx.state === "closed") {
      return new Promise((resolve) => {
        const src = convertFileSrc(audioPath);
        const audio = new Audio(src);
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      });
    }

    // Fetch the WAV file and decode it
    try {
      const src = convertFileSrc(audioPath);
      const response = await fetch(src);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

      return new Promise((resolve) => {
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        // Route to speakers
        source.connect(audioCtx.destination);
        // Route to mixed recording destination
        if (mixedDest) source.connect(mixedDest);
        source.onended = () => resolve();
        source.start();
      });
    } catch {
      // Fallback to basic playback
      return new Promise((resolve) => {
        const src = convertFileSrc(audioPath);
        const audio = new Audio(src);
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      });
    }
  }, []);

  // Speak text via Piper TTS, pipelined per-sentence so audio starts as soon as
  // the first sentence is synthesized and subsequent sentences are synthesized
  // in parallel with playback. `onSentenceStart` fires with the accumulated text
  // at the moment each sentence begins playing — used to reveal text in sync
  // with audio rather than upfront.
  const coachSpeak = useCallback(async (
    text: string,
    onSentenceStart?: (accumulated: string) => void,
  ): Promise<void> => {
    const dataDir = await appDataDir();

    // Map user WPM to coach speed (length_scale).
    // Normal pace ~130-150 WPM → 1.0. Faster user → slightly faster coach. Slower → slower.
    // Clamp to 0.88-1.15 range (never too fast or too slow).
    const userWpm = userPaceRef.current;
    const speed = Math.max(0.88, Math.min(1.15, 140 / Math.max(userWpm, 80)));

    const sentences = splitSentences(text);
    if (sentences.length === 0) return;

    const audioCtx = audioContextRef.current;
    const mixedDest = mixedDestRef.current;

    // Fallback path: no AudioContext available (e.g. session not started).
    // Use sequential file playback — less smooth but functional.
    if (!audioCtx || audioCtx.state === "closed") {
      const synth = async (chunk: string): Promise<string> => {
        const outputPath = await join(
          dataDir,
          "coach",
          `coach-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`,
        );
        await invoke("speak_text", { text: chunk, outputPath, speed });
        return outputPath;
      };
      let nextSynth = synth(sentences[0]);
      let accum = "";
      for (let i = 0; i < sentences.length; i++) {
        const path = await nextSynth;
        if (i + 1 < sentences.length) nextSynth = synth(sentences[i + 1]);
        accum = accum ? `${accum} ${sentences[i]}` : sentences[i];
        onSentenceStart?.(accum);
        await playCoachAudio(path);
      }
      return;
    }

    // Fast path: synth + decode in parallel, schedule buffers back-to-back on
    // the AudioContext timeline so sentences chain seamlessly with no gap.
    const synthAndDecode = async (chunk: string): Promise<AudioBuffer> => {
      const outputPath = await join(
        dataDir,
        "coach",
        `coach-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`,
      );
      await invoke("speak_text", { text: chunk, outputPath, speed });
      const src = convertFileSrc(outputPath);
      const resp = await fetch(src);
      const arrayBuffer = await resp.arrayBuffer();
      return await audioCtx.decodeAudioData(arrayBuffer);
    };

    let nextBufferP = synthAndDecode(sentences[0]);
    let accumulated = "";
    // Small offset so the first scheduled start is slightly in the future and
    // not clipped by scheduling latency.
    let nextStartTime = audioCtx.currentTime + 0.02;
    let lastSource: AudioBufferSourceNode | null = null;

    for (let i = 0; i < sentences.length; i++) {
      const buffer = await nextBufferP;
      if (i + 1 < sentences.length) {
        nextBufferP = synthAndDecode(sentences[i + 1]);
      }
      accumulated = accumulated ? `${accumulated} ${sentences[i]}` : sentences[i];

      // If decoding took longer than remaining scheduled audio, reset to now
      // so we don't start scheduling in the past.
      const startTime = Math.max(audioCtx.currentTime, nextStartTime);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      if (mixedDest) source.connect(mixedDest);
      source.start(startTime);
      nextStartTime = startTime + buffer.duration;
      lastSource = source;

      // Reveal the sentence's text exactly when its audio actually begins.
      const revealDelayMs = Math.max(0, (startTime - audioCtx.currentTime) * 1000);
      const sentenceText = accumulated;
      setTimeout(() => onSentenceStart?.(sentenceText), revealDelayMs);
    }

    if (lastSource) {
      await new Promise<void>((resolve) => {
        lastSource!.onended = () => resolve();
      });
    }
  }, [playCoachAudio]);

  // Speak text and progressively reveal it in the coach history turn, so text
  // lands in sync with audio. Appends a new coach turn on the first sentence
  // and updates its text as subsequent sentences begin playing.
  const coachSpeakAndReveal = useCallback(async (text: string): Promise<void> => {
    let appended = false;
    await coachSpeak(text, (accumulated) => {
      if (!appended) {
        historyRef.current = [...historyRef.current, { role: "coach", text: accumulated }];
        appended = true;
      } else {
        const last = historyRef.current.length - 1;
        historyRef.current = historyRef.current.map((t, i) =>
          i === last ? { ...t, text: accumulated } : t,
        );
      }
      setHistory([...historyRef.current]);
    });
  }, [coachSpeak]);

  // Start the session-wide recorder (called once at session start)
  const startSessionRecorder = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    sessionStreamRef.current = stream;

    // Create AudioContext with a mixed destination (mic + coach TTS)
    const audioCtx = new AudioContext();
    audioContextRef.current = audioCtx;
    const micSource = audioCtx.createMediaStreamSource(stream);

    // Analyser for silence detection (connected to mic only)
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    micSource.connect(analyser);
    analyserRef.current = analyser;

    // Mixed destination: mic + coach audio both route here
    const mixedDest = audioCtx.createMediaStreamDestination();
    micSource.connect(mixedDest);
    mixedDestRef.current = mixedDest;

    // Record from the mixed stream (captures both mic and coach)
    const fmt = getRecorderMimeType();
    const mixedStream = mixedDest.stream;
    const recorder = fmt.mimeType ? new MediaRecorder(mixedStream, { mimeType: fmt.mimeType }) : new MediaRecorder(mixedStream);
    allChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        allChunksRef.current.push(e.data);
      }
    };
    recorder.start(1000);
    sessionRecorderRef.current = recorder;

    // Calibrate the noise floor once, right now, while the room is guaranteed
    // quiet — no coach audio has played yet. We reuse this floor for every turn
    // and avoid per-turn calibration (which was contaminated by coach echo).
    const data = new Uint8Array(analyser.frequencyBinCount);
    const samples: number[] = [];
    const CALIB_MS = 600;
    const start = Date.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (Date.now() - start >= CALIB_MS) {
          resolve();
          return;
        }
        samples.push(voiceBandAvg(analyser, data));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const mean = samples.length
      ? samples.reduce((a, b) => a + b, 0) / samples.length
      : 2;
    noiseFloorRef.current = Math.max(mean, 2);
  }, []);

  // Start listening for a turn (start a turn recorder + silence detection)
  const startListening = useCallback(async () => {
    setState("listening");
    setStatusText("");
    silenceStartRef.current = 0;

    // Start a separate turn recorder on the same stream for clean per-turn audio
    const stream = sessionStreamRef.current;
    if (stream) {
      const fmt = getRecorderMimeType();
      const turnRec = fmt.mimeType ? new MediaRecorder(stream, { mimeType: fmt.mimeType }) : new MediaRecorder(stream);
      turnChunksRef.current = [];
      turnRec.ondataavailable = (e) => { if (e.data.size > 0) turnChunksRef.current.push(e.data); };
      turnRec.onstop = () => {
        const blob = new Blob(turnChunksRef.current, { type: fmt.mimeType || "audio/webm" });
        turnResolveRef.current?.(blob);
        turnResolveRef.current = null;
      };
      turnRec.start(1000);
      turnRecorderRef.current = turnRec;
    }

    // Start silence monitoring with adaptive noise floor
    const analyser = analyserRef.current;
    if (!analyser) return;

    speechDetectedRef.current = false;
    silenceStartRef.current = 0;
    setWaitingNudge(null);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    // Short settle window lets any tail of coach audio decay before we start
    // watching for speech. We don't recalibrate the floor per turn — it was set
    // once at session start in a guaranteed-quiet window.
    const listenStartTime = Date.now();
    let nudgeShown = false;
    const SETTLE_MS = 300;
    let totalSpeechFrames = 0;
    const SPEECH_ARM_FRAMES = 8; // ~135ms of cumulative speech to arm detection
    let consecSpeechFrames = 0;
    const RESUME_SPEECH_FRAMES = 5; // ~80ms of continuous speech to count as resumed
    const SILENCE_END_S = 1.8;
    // Hard fallback: if a turn runs this long after speech is detected, force
    // end it. Prevents a hang if ambient noise masks the end-of-speech silence.
    const MAX_TURN_AFTER_SPEECH_S = 45;
    let speechStartTime = 0;
    // Peak speech volume (slow decay) — lets us detect end-of-speech as a
    // relative drop from the user's own voice level, which is robust to rising
    // background noise that would otherwise sit above the absolute threshold.
    let peakAvg = 0;

    const checkSilence = () => {
      if (!analyserRef.current) return;
      const avg = voiceBandAvg(analyserRef.current, dataArray);
      const elapsed = Date.now() - listenStartTime;

      // Wait for any lingering coach audio to decay before acting on samples.
      if (elapsed < SETTLE_MS) {
        animFrameRef.current = requestAnimationFrame(checkSilence);
        return;
      }

      // Show gentle nudge if user hasn't started speaking after 6s
      if (!speechDetectedRef.current && !nudgeShown && elapsed > SETTLE_MS + 6000) {
        nudgeShown = true;
        const nudges = ["Take your time.", "Whenever you're ready.", "No rush."];
        setWaitingNudge(nudges[Math.floor(Math.random() * nudges.length)]!);
      }

      const noiseFloor = noiseFloorRef.current;
      // Combine absolute threshold (floor × 1.5, min floor+2) with a relative
      // threshold (30% of peak speech volume). Once the user has spoken loudly,
      // the relative threshold dominates and we can detect silence even if
      // ambient noise rises above the absolute threshold mid-session.
      const absThreshold = speechThreshold(noiseFloor);
      const relThreshold = peakAvg * 0.2;
      const threshold = Math.max(absThreshold, relThreshold);
      const isSpeech = avg > threshold;

      // Track peak speech volume with slow decay so a single loud frame
      // doesn't pin the relative threshold high forever.
      if (avg > peakAvg) peakAvg = avg;
      else peakAvg = peakAvg * 0.9995;

      // Hard fallback: force end if the turn has run very long after speech.
      if (
        speechDetectedRef.current &&
        speechStartTime > 0 &&
        (Date.now() - speechStartTime) / 1000 > MAX_TURN_AFTER_SPEECH_S
      ) {
        stopListeningAndProcess();
        return;
      }

      if (isSpeech) {
        totalSpeechFrames++;
        consecSpeechFrames++;
        if (totalSpeechFrames >= SPEECH_ARM_FRAMES && !speechDetectedRef.current) {
          speechDetectedRef.current = true;
          speechStartTime = Date.now();
          if (waitingNudge) setWaitingNudge(null);
        }
        // Only reset the silence timer once we have enough consecutive speech
        // to be confident it's actual speech, not a cough or a key click.
        if (consecSpeechFrames >= RESUME_SPEECH_FRAMES) {
          silenceStartRef.current = 0;
        }
      } else {
        consecSpeechFrames = 0;
        if (speechDetectedRef.current) {
          const now = Date.now();
          if (silenceStartRef.current === 0) silenceStartRef.current = now;
          const silenceDuration = (now - silenceStartRef.current) / 1000;
          const turnChunks = turnChunksRef.current.length;

          if (silenceDuration > SILENCE_END_S && turnChunks > 3) {
            stopListeningAndProcess();
            return;
          }
        }
      }

      // Freeze noise-floor adaptation once the user has started speaking.
      // Otherwise the floor drifts up during pauses between words and later
      // words fall below the threshold.
      if (!isSpeech && !speechDetectedRef.current && avg > 0) {
        noiseFloorRef.current = noiseFloor * 0.98 + avg * 0.02;
      }

      animFrameRef.current = requestAnimationFrame(checkSilence);
    };
    animFrameRef.current = requestAnimationFrame(checkSilence);
  }, []);

  // Process the user's speech from current turn (session recorder stays running)
  const stopListeningAndProcess = useCallback(async () => {
    // Stop silence monitoring
    cancelAnimationFrame(animFrameRef.current);

    setState("processing");
    setStatusText("");

    try {
      // Stop the turn recorder to get a proper self-contained audio blob
      const blob = await new Promise<Blob>((resolve) => {
        turnResolveRef.current = resolve;
        const rec = turnRecorderRef.current;
        if (rec && rec.state !== "inactive") {
          rec.stop();
        } else {
          resolve(new Blob([]));
        }
        turnRecorderRef.current = null;
      });

      if (blob.size < 1000) {
        await startListening();
        return;
      }

      const fmt = getRecorderMimeType();
      const dataDir = await appDataDir();
      const tmpPath = await join(dataDir, "coach", `turn-${Date.now()}.${fmt.ext}`);
      const fs = await import("@tauri-apps/plugin-fs");
      await fs.writeFile(tmpPath, new Uint8Array(await blob.arrayBuffer()));

      const speech = await invoke<{ text: string; duration_seconds: number }>("transcribe_fast", { audioPath: tmpPath });
      const userText = speech.text.trim();

      // Track user speaking pace for coach speed adjustment
      if (userText && speech.duration_seconds > 1) {
        const wordCount = userText.split(/\s+/).length;
        const wpm = (wordCount / speech.duration_seconds) * 60;
        if (wpm > 50 && wpm < 300) { // sanity check
          userPaceRef.current = userPaceRef.current * 0.6 + wpm * 0.4; // smoothed average
        }
      }

      fs.remove(tmpPath).catch(() => {});

      if (!userText) {
        // No speech detected, resume listening
        await startListening();
        return;
      }

      // Check for exit words
      const lower = userText.toLowerCase();
      const exitPhrases = ["end the session", "end session", "that's it", "i'm done", "let's stop", "stop", "bye", "we're done", "that's all"];
      const wantsToStop = exitPhrases.some((p) => lower.includes(p));

      if (wantsToStop) {
        historyRef.current = [...historyRef.current, { role: "user", text: userText }];
        setHistory([...historyRef.current]);
        setState("wrapping");
        setStatusText("Wrapping up...");
        await coachSpeakAndReveal("Great, that's all I need. Let me put your report together.");
        await runPostSession();
        return;
      }

      // Add user turn to history
      const updatedHistory = [...historyRef.current, { role: "user" as const, text: userText }];
      historyRef.current = updatedHistory;
      setHistory([...updatedHistory]);

      setStatusText("Thinking...");

      // Get coach response from Claude
      const response = await invoke<{ echo: string; next_question: string | null; should_wrap_up: boolean; wrap_up_message: string | null; user_name: string | null }>(
        "coach_conversation_turn", {
          conversationHistory: updatedHistory,
          userText,
          isFirstSession,
          sessionNumber: sessionNumber + 1,
          userName: userName || "",
        }
      );

      // Save user's name if Claude extracted it
      if (response.user_name && !userName) {
        setUserName(response.user_name);
        invoke("save_user_name", { userName: response.user_name }).catch(() => {});
      }

      if (response.should_wrap_up) {
        const wrapMsg = response.wrap_up_message || "Good session. Let me put together your report.";
        const coachText = response.echo ? `${response.echo} ${wrapMsg}` : wrapMsg;
        setState("speaking");
        await coachSpeakAndReveal(coachText);
        await runPostSession();
        return;
      }

      // Build coach response: echo + next question, or just echo (podcast mode)
      const coachText = response.next_question
        ? (response.echo ? `${response.echo} ${response.next_question}` : response.next_question)
        : response.echo;

      setState("speaking");
      await coachSpeakAndReveal(coachText);

      // Resume listening
      await startListening();

    } catch (err: any) {
      console.error("Coach processing error:", err);
      setError(`Something went wrong: ${err?.message || err}`);
      setState("idle");
    }
  }, [history, isFirstSession, coachSpeak, coachSpeakAndReveal, startListening]);

  // Run post-session: save immediately, analyze in background
  const runPostSession = useCallback(async () => {
    // Stop recorders and mic immediately
    const rec = sessionRecorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    sessionRecorderRef.current = null;
    const turnRec = turnRecorderRef.current;
    if (turnRec && turnRec.state !== "inactive") turnRec.stop();
    turnRecorderRef.current = null;
    sessionStreamRef.current?.getTracks().forEach((t) => t.stop());
    sessionStreamRef.current = null;
    if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }
    analyserRef.current = null;

    // Save audio file and conversation to DB immediately (fast)
    try {
      const fmt = getRecorderMimeType();
      const fullBlob = new Blob(allChunksRef.current, { type: fmt.mimeType || "audio/webm" });
      const dataDir = await appDataDir();
      const fullPath = await join(dataDir, "coach", `session-${Date.now()}.${fmt.ext}`);
      const fs = await import("@tauri-apps/plugin-fs");
      await fs.writeFile(fullPath, new Uint8Array(await fullBlob.arrayBuffer()));

      const sessionType = isFirstSession ? "coach_first" : "coach";
      const fullText = historyRef.current.map((h) => `[${h.role === "coach" ? "Coach" : (userName || "You")}] ${h.text}`).join("\n");

      const sessionDuration = Math.round((Date.now() - sessionStartTimeRef.current) / 1000);
      const saveResult = await invoke<{ id: number }>("save_recording", {
        audioPath: fullPath, duration: sessionDuration, sessionType,
        transcript: fullText, segmentsJson: JSON.stringify([]),
      });
      const recordingId = saveResult.id;

      await invoke("save_coach_session", {
        conversationJson: JSON.stringify(historyRef.current),
        firstImpressionJson: null,
      });

      // Show done immediately — user can navigate away
      setState("done");
      setStatusText("Session saved. Analyzing in background...");

      // Fire off heavy analysis in background (non-blocking)
      const isFirst = isFirstSession;
      const conversationText = fullText;
      const historySnapshot = [...historyRef.current];
      const savedRecordingId = recordingId;

      (async () => {
        try {
          // Full transcription + analysis (same pipeline as regular sessions)
          const speech = await invoke<{
            transcript: { text: string; segments: any[]; words: any[] };
            disfluencies: { fillers: any[]; all: any[] };
            flagged_moments: { start: number; end: number; type: string; severity: number; coach_type: string; transcript_text: string; detail: string }[];
            overall_metrics: { filler_count: number; total_disfluencies: number; pause_count: number; avg_pace_wpm: number; word_count: number; duration_seconds: number };
            duration_seconds: number;
          }>("analyze_speech", { audioPath: fullPath });

          const duration = speech.duration_seconds;
          const metrics = speech.overall_metrics;
          const fillerRate = duration > 0 ? (metrics.filler_count / duration) * 60 : 0;
          const hedgingRate = duration > 0 ? (metrics.total_disfluencies / duration) * 60 : 0;

          // Update recording with real duration and transcript
          await invoke("save_recording", {
            audioPath: fullPath,
            duration: speech.duration_seconds,
            recordingId: savedRecordingId,
            transcript: speech.transcript.text,
            segmentsJson: JSON.stringify(speech.transcript.segments),
          });

          // Generate coaching for flagged moments (practice points)
          const flagged = speech.flagged_moments.map((m) => ({
            ...m, text: m.transcript_text, coaching_text: null as string | null,
          }));

          let deliveryScore = 0.0;
          if (flagged.length > 0) {
            try {
              const coaching = await invoke<{
                coached_moments: { start: number; end: number; coaching_text: string; suggested_delivery: string; topic: string | null }[];
                overall_score: number; summary: string;
              }>("generate_coaching", { flaggedMoments: flagged, fullTranscript: speech.transcript.text, docChunks: null });

              deliveryScore = coaching.overall_score;
              for (const c of coaching.coached_moments) {
                const match = flagged.find((m) => Math.abs(m.start - c.start) < 0.5);
                if (match) (match as any).coaching_text = c.coaching_text + "\n\nTry saying: \"" + c.suggested_delivery + "\"";
              }
            } catch {}
          }

          // Save analysis + flagged moments
          await invoke("save_analysis", {
            recordingId: savedRecordingId, deliveryScore,
            fillerCount: metrics.filler_count,
            hedgingCount: metrics.total_disfluencies,
            deflectionCount: metrics.pause_count,
            paceWpm: metrics.avg_pace_wpm,
            flaggedMoments: flagged,
          });

          // Extract clips for practice drills
          if (flagged.length > 0) {
            try {
              const clipsDir = await join(await appDataDir(), "clips", `recording-${savedRecordingId}`);
              await invoke("extract_clips", {
                audioPath: fullPath,
                moments: flagged.map((m, i) => ({ id: i, start: m.start, end: m.end })),
                outputDir: clipsDir,
              });
            } catch {}
          }

          // Voice enrollment (first session only)
          if (isFirst) {
            try {
              const embResult = await invoke<{ embedding: number[] }>("extract_embedding", { audioPath: fullPath });
              await invoke("save_voice_profile", { embeddingJson: JSON.stringify(embResult.embedding) });
            } catch {}
            await invoke("save_baseline", {
              fillerRate, paceWpm: metrics.avg_pace_wpm, hedgingRate,
              pauseRate: duration > 0 ? (metrics.pause_count / duration) * 60 : 0,
              firstSessionId: savedRecordingId,
            });
          }

          // Generate first impression / session report
          const impression = await invoke<FirstImpression>(
            "generate_first_impression", {
              conversationText,
              metrics: { filler_rate: fillerRate, pace_wpm: metrics.avg_pace_wpm, hedging_rate: hedgingRate, pause_count: metrics.pause_count, word_count: metrics.word_count, duration: duration },
            }
          );

          await invoke("save_coach_session", {
            conversationJson: JSON.stringify(historySnapshot),
            firstImpressionJson: JSON.stringify(impression),
          });

          setFirstImpression(impression);
          setStatusText("");
        } catch (err) {
          console.warn("Background analysis failed:", err);
          setStatusText("");
        }
      })();

    } catch (err: any) {
      console.error("Session save failed:", err);
      setError(`Save failed: ${err?.message || err}`);
      setState("done");
    }
  }, [isFirstSession, userName]);

  // Start the session
  const startSession = useCallback(async () => {
    setError(null);
    setHistory([]);
    historyRef.current = [];
    allChunksRef.current = [];
    turnStartChunkIdx.current = 0;
    setFirstImpression(null);

    try {
      // Start the session-wide recorder (runs continuously)
      await startSessionRecorder();
      sessionStartTimeRef.current = Date.now();
      // First session or first exercise: play intro. After that: skip straight to question.
      const hasIntro = isFirstSession || sessionNumber <= 1;

      if (hasIntro) {
        setState("intro");
        const introText = isFirstSession
          ? "Hi, I am Lisa. This is our first session together. I'd like to spend about three minutes getting to know you and how you speak. You can stop anytime, just say, end the session, or something like that. Ready? Tell me your name and what you do."
          : "Welcome back. Today we're doing practice exercises. I'll ask you a question, listen to your answer, and if I hear any fillers or hesitations, I'll point them out and ask you to try again. Here's your first one.";

        if (introAudioPath) {
          // Cached intro audio is instantly available, so text and audio land together.
          historyRef.current = [{ role: "coach", text: introText }];
          setHistory([...historyRef.current]);
          await playCoachAudio(introAudioPath);
        } else {
          await coachSpeakAndReveal(introText);
        }
      }

      // For follow-up sessions, get the first question from Claude
      if (!isFirstSession) {
        setState("processing");
        const response = await invoke<{ echo: string; next_question: string | null; should_wrap_up: boolean; wrap_up_message: string | null; user_name: string | null }>(
          "coach_conversation_turn", {
            conversationHistory: historyRef.current,
            userText: "",
            isFirstSession: false,
            sessionNumber: sessionNumber + 1,
          }
        );
        if (response.next_question) {
          setState("speaking");
          await coachSpeakAndReveal(response.next_question);
        }
      }

      await startListening();
    } catch (err: any) {
      setError(`Could not start session: ${err?.message || err}`);
      setState("idle");
    }
  }, [isFirstSession, sessionNumber, introAudioPath, coachSpeakAndReveal, playCoachAudio, startListening, startSessionRecorder]);

  // Auto-start: skip idle screen and begin session immediately
  const [ready, setReady] = useState(false);
  const autoStarted = useRef(false);
  useEffect(() => {
    if (ready && !autoStarted.current && state === "idle" && !isFirstSession) {
      autoStarted.current = true;
      startSession();
    }
  }, [ready, state, startSession, isFirstSession]);

  // Clean up on unmount
  useEffect(() => () => {
    cancelAnimationFrame(animFrameRef.current);
    audioContextRef.current?.close();
    sessionRecorderRef.current?.stop();
    sessionStreamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  // ── Render ──

  // Done: show First Impression card
  if (state === "done") {
    return (
      <div style={{ textAlign: "center", padding: "var(--space-2xl) 0" }}>
        <p style={{ fontSize: 48, marginBottom: "var(--space-lg)" }}>
          {isFirstSession ? "Welcome aboard." : "Nice work."}
        </p>
        <p style={{ fontSize: 16, color: "var(--color-text-secondary)", lineHeight: 1.7, maxWidth: 400, margin: "0 auto var(--space-lg)" }}>
          {isFirstSession
            ? "Your coach is getting to know your voice and speech patterns. Your detailed analysis will appear in Recording shortly."
            : "Your practice session has been saved. A detailed analysis will appear in Recording shortly."}
        </p>
        <a
          onClick={() => {
            // Navigate to Sessions — need to access the parent's setScreen
            // Use a custom event since we're in a child component
            window.dispatchEvent(new CustomEvent("duet-navigate", { detail: "recordings" }));
          }}
          style={{
            color: "var(--color-primary)", cursor: "pointer", fontSize: 14, fontWeight: 600,
            textDecoration: "underline", textUnderlineOffset: 3,
          }}
        >
          Go to Recording
        </a>
      </div>
    );
  }

  // Active session or idle
  return (
    <>
      <p className="page-label">Coach</p>
      <h1 className="page-title">Practice</h1>

      {state === "idle" && (
        <div style={{ textAlign: "center", padding: "var(--space-2xl) 0" }}>
          {error && (
            <p style={{ fontSize: 13, color: "var(--color-error)", marginBottom: "var(--space-md)" }}>{error}</p>
          )}
          <p style={{ fontSize: 14, color: "var(--color-text-secondary)", marginBottom: "var(--space-lg)", lineHeight: 1.6 }}>
            {isFirstSession
              ? "Your coach will introduce itself, ask you a few questions, and learn how you speak. Just talk naturally. No buttons needed during the session."
              : "Practice session: your coach will ask questions, listen for fillers and hesitations, and ask you to try again until it's clean."}
          </p>
          <button className="btn btn-primary-large" onClick={startSession}>
            {isFirstSession ? "Meet your coach" : "Start session"}
          </button>
        </div>
      )}

      {state !== "idle" && (
        <div style={{ padding: "var(--space-lg) 0" }}>
          {/* Conversation transcript */}
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)", marginBottom: "var(--space-lg)" }}>
            {history.map((turn, i) => (
              <div key={i} style={{ display: "flex", gap: "var(--space-sm)", alignItems: "flex-start" }}>
                <span style={{
                  fontSize: 11, fontWeight: 700,
                  color: turn.role === "coach" ? "var(--color-primary)" : "var(--color-warning)",
                  minWidth: 45, paddingTop: 2, flexShrink: 0,
                  fontFamily: "var(--font-mono)",
                }}>
                  {turn.role === "coach" ? "Coach" : (userName || "You")}
                </span>
                <p style={{
                  fontSize: 14,
                  color: turn.role === "coach" ? "var(--color-text)" : "var(--color-text-secondary)",
                  lineHeight: 1.6, margin: 0,
                  fontWeight: turn.role === "coach" ? 500 : 400,
                  fontFamily: "var(--font-transcript)",
                }}>
                  {turn.text}
                </p>
              </div>
            ))}
          </div>

          {/* Status indicator */}
          <div>
            {state === "listening" && (
              <div style={{ textAlign: "center" }}>
                <div className="recording-pulse" />
                <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>
                  {waitingNudge || "Listening..."}
                </p>
              </div>
            )}
            {(state === "processing" ||
              state === "analyzing" ||
              (state === "intro" && history.length === 0)) && (
              <div
                className="typing-indicator"
                aria-label={state === "intro" ? "Coach is starting" : "Coach is thinking"}
                role="status"
              >
                <span />
                <span />
                <span />
              </div>
            )}
            {state === "wrapping" && (
              <p style={{ fontSize: 13, color: "var(--color-text-muted)", textAlign: "center" }}>
                {statusText || "Wrapping up..."}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
