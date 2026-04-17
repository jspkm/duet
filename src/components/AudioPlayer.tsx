import { useState, useRef, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

export function AudioPlayer({ clipPath }: { clipPath?: string }) {
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

  const audioSrc = convertFileSrc(clipPath);

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
