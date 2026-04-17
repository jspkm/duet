export type Screen = "recordings" | "session_detail" | "dashboard" | "studyplan" | "settings" | "coach" | "coach_first";

export interface RecordingEntry {
  id: number;
  recorded_at: string;
  duration_seconds: number;
  local_audio_path: string;
  transcript_text: string | null;
  speaker_segments: string | null;
  name: string | null;
  session_type: string; // "recording" | "coach" | "coach_first"
}

export interface FlaggedMomentEntry {
  id: number;
  start_time: number;
  end_time: number;
  moment_type: string;
  severity: number;
  coach_type: string;
  coaching_text: string | null;
  transcript_text: string;
}

export interface ProgressEvent {
  stage: string;
  percent: number;
}

export interface ImpressionDimension {
  key: string;
  name: string;
  score: number;
  evidence: string[];
  improvement: string;
}

export interface FirstImpression {
  summary: string;
  dimensions?: ImpressionDimension[];
  // Legacy shape from older records; rendered as a fallback.
  focus_area?: string;
  strengths?: string[];
  patterns?: string[];
}

export interface SubjectEntry {
  id: number;
  name: string;
  description: string | null;
  doc_count: number;
  recording_count: number;
}
