// Pick a MIME type that both MediaRecorder and the webview can play back.
// WKWebView (macOS) doesn't support WebM. Prefer mp4/aac, fall back to webm.
// Voice-band frequency bins. At 48kHz sample rate with fftSize=512, each bin
// spans ~94Hz. Bins 1-60 cover ~90Hz-5.6kHz, which captures voice fundamentals,
// harmonics, and most consonant energy. Averaging the full spectrum dilutes
// speech signal with high-frequency room noise.
export const VOICE_BIN_START = 1;
export const VOICE_BIN_END = 60;

// Compute the voice-band average from an analyser's byte frequency data.
export function voiceBandAvg(analyser: AnalyserNode, dataArray: Uint8Array): number {
  analyser.getByteFrequencyData(dataArray);
  const end = Math.min(VOICE_BIN_END, dataArray.length);
  let sum = 0;
  for (let i = VOICE_BIN_START; i < end; i++) sum += dataArray[i]!;
  return sum / (end - VOICE_BIN_START);
}

// Speech threshold: sensitive in quiet rooms (1.5x multiplier) but also robust
// in noisier rooms via the additive floor guard (+2 on the raw 0-255 scale).
export function speechThreshold(floor: number): number {
  return Math.max(floor * 1.5, floor + 2);
}

// Split text into sentences, keeping end punctuation. Used to pipeline TTS so
// we can start playing the first sentence while later ones are still synthesizing.
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const matches = trimmed.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g);
  if (!matches) return [trimmed];
  return matches.map((s) => s.trim()).filter(Boolean);
}

export function getRecorderMimeType(): { mimeType: string; ext: string } {
  for (const candidate of [
    { mimeType: "audio/mp4", ext: "m4a" },
    { mimeType: "audio/mp4;codecs=mp4a.40.2", ext: "m4a" },
    { mimeType: "audio/aac", ext: "aac" },
    { mimeType: "audio/webm;codecs=opus", ext: "webm" },
    { mimeType: "audio/webm", ext: "webm" },
  ]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate.mimeType)) {
      return candidate;
    }
  }
  return { mimeType: "", ext: "webm" }; // let browser pick default
}
