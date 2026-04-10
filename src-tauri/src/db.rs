//! SQLite database for local storage.
//!
//! All user data stays on-device. Schema migrations run automatically on startup.

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

const CURRENT_SCHEMA_VERSION: i32 = 1;

pub struct Database {
    conn: Mutex<Connection>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Recording {
    pub id: i64,
    pub recorded_at: String,
    pub duration_seconds: f64,
    pub local_audio_path: String,
    pub transcript_text: Option<String>,
    pub speaker_segments: Option<String>,
    pub name: Option<String>,
    pub session_type: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub id: i64,
    pub recording_id: i64,
    pub delivery_score: f64,
    pub filler_word_count: i32,
    pub hedging_count: i32,
    pub deflection_count: i32,
    pub pace_wpm: f64,
    pub topic_segments: Option<String>, // JSON
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FlaggedMoment {
    pub id: i64,
    pub analysis_result_id: i64,
    pub recording_id: i64,
    pub start_time: f64,
    pub end_time: f64,
    pub clip_path: Option<String>,
    pub moment_type: String,
    pub severity: i32,
    pub coach_type: String,
    pub coaching_text: Option<String>,
    pub transcript_text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DrillAttempt {
    pub id: i64,
    pub flagged_moment_id: i64,
    pub attempted_at: String,
    pub local_audio_path: String,
    pub feedback_text: Option<String>,
    pub improvement_score: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DashboardEntry {
    pub recording_id: i64,
    pub recorded_at: String,
    pub duration_seconds: f64,
    pub delivery_score: f64,
    pub filler_count: i32,
    pub disfluency_count: i32,
    pub pause_count: i32,
    pub pace_wpm: f64,
    pub flagged_moment_count: i32,
    pub drill_attempt_count: i32,
}

pub struct Topic {
    pub id: i64,
    pub name: String,
    pub first_seen_at: String,
    pub baseline_score: Option<f64>,
    pub latest_score: Option<f64>,
}

impl Database {
    /// Get a lock on the underlying connection (for ad-hoc queries from commands).
    pub fn conn(&self) -> Result<std::sync::MutexGuard<Connection>> {
        self.conn.lock().map_err(|e| rusqlite::Error::InvalidParameterName(e.to_string()))
    }

    pub fn open(data_dir: &PathBuf) -> Result<Self> {
        std::fs::create_dir_all(data_dir).ok();
        let db_path = data_dir.join("duet.db");
        let conn = Connection::open(db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);"
        )?;

        let version: i32 = conn
            .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |r| r.get(0))
            .unwrap_or(0);

        if version < 1 {
            conn.execute_batch(
                "
                CREATE TABLE IF NOT EXISTS recordings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    recorded_at TEXT NOT NULL DEFAULT (datetime('now') || 'Z'),
                    duration_seconds REAL NOT NULL DEFAULT 0,
                    local_audio_path TEXT NOT NULL,
                    transcript_text TEXT,
                    speaker_segments TEXT
                );

                CREATE TABLE IF NOT EXISTS analysis_results (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    recording_id INTEGER NOT NULL UNIQUE REFERENCES recordings(id),
                    delivery_score REAL NOT NULL DEFAULT 0,
                    filler_word_count INTEGER NOT NULL DEFAULT 0,
                    hedging_count INTEGER NOT NULL DEFAULT 0,
                    deflection_count INTEGER NOT NULL DEFAULT 0,
                    pace_wpm REAL NOT NULL DEFAULT 0,
                    topic_segments TEXT
                );

                CREATE TABLE IF NOT EXISTS flagged_moments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    analysis_result_id INTEGER NOT NULL REFERENCES analysis_results(id),
                    recording_id INTEGER NOT NULL REFERENCES recordings(id),
                    start_time REAL NOT NULL,
                    end_time REAL NOT NULL,
                    clip_path TEXT,
                    moment_type TEXT NOT NULL,
                    severity INTEGER NOT NULL DEFAULT 0,
                    coach_type TEXT NOT NULL DEFAULT 'speech',
                    coaching_text TEXT,
                    transcript_text TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS drill_attempts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    flagged_moment_id INTEGER NOT NULL REFERENCES flagged_moments(id),
                    attempted_at TEXT NOT NULL DEFAULT (datetime('now') || 'Z'),
                    local_audio_path TEXT NOT NULL,
                    feedback_text TEXT,
                    improvement_score REAL
                );

                CREATE TABLE IF NOT EXISTS topics (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    first_seen_at TEXT NOT NULL DEFAULT (datetime('now') || 'Z'),
                    baseline_score REAL,
                    latest_score REAL
                );

                CREATE TABLE IF NOT EXISTS study_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    topic_id INTEGER REFERENCES topics(id),
                    title TEXT NOT NULL,
                    source_type TEXT NOT NULL DEFAULT 'external',
                    source_path_or_url TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    priority INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS documents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    filename TEXT NOT NULL,
                    local_path TEXT NOT NULL,
                    chunks TEXT
                );

                INSERT INTO schema_version (version) VALUES (1);
                ",
            )?;
        }

        if version < 2 {
            conn.execute_batch(
                "
                CREATE TABLE IF NOT EXISTS subjects (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    description TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now') || 'Z')
                );

                -- Add subject_id to recordings and documents
                ALTER TABLE recordings ADD COLUMN subject_id INTEGER REFERENCES subjects(id);
                ALTER TABLE documents ADD COLUMN subject_id INTEGER REFERENCES subjects(id);
                ALTER TABLE topics ADD COLUMN subject_id INTEGER REFERENCES subjects(id);
                ALTER TABLE study_items ADD COLUMN subject_id INTEGER REFERENCES subjects(id);

                INSERT INTO schema_version (version) VALUES (2);
                ",
            )?;
        }

        if version < 3 {
            conn.execute_batch(
                "
                ALTER TABLE recordings ADD COLUMN name TEXT;
                INSERT INTO schema_version (version) VALUES (3);
                ",
            )?;
        }

        if version < 4 {
            conn.execute_batch(
                "
                CREATE TABLE IF NOT EXISTS voice_profiles (
                    id INTEGER PRIMARY KEY,
                    embedding_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now') || 'Z')
                );

                CREATE TABLE IF NOT EXISTS user_baseline (
                    id INTEGER PRIMARY KEY,
                    filler_rate REAL NOT NULL DEFAULT 0,
                    pace_wpm REAL NOT NULL DEFAULT 0,
                    hedging_rate REAL NOT NULL DEFAULT 0,
                    pause_rate REAL NOT NULL DEFAULT 0,
                    first_session_id INTEGER,
                    created_at TEXT NOT NULL DEFAULT (datetime('now') || 'Z')
                );

                INSERT INTO schema_version (version) VALUES (4);
                ",
            )?;
        }

        if version < 5 {
            conn.execute_batch(
                "
                ALTER TABLE recordings ADD COLUMN session_type TEXT NOT NULL DEFAULT 'recording';
                -- session_type: 'recording' (normal), 'coach' (coach session), 'coach_first' (first session)

                CREATE TABLE IF NOT EXISTS coach_session_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_number INTEGER NOT NULL DEFAULT 1,
                    conversation_json TEXT,
                    first_impression_json TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now') || 'Z')
                );

                INSERT INTO schema_version (version) VALUES (5);
                ",
            )?;
        }

        if version < 6 {
            conn.execute_batch(
                "
                ALTER TABLE voice_profiles ADD COLUMN user_name TEXT;
                INSERT INTO schema_version (version) VALUES (6);
                ",
            )?;
        }

        Ok(())
    }

    // -- Recordings --

    pub fn insert_recording(&self, audio_path: &str, duration: f64) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO recordings (local_audio_path, duration_seconds) VALUES (?1, ?2)",
            params![audio_path, duration],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_transcript(&self, id: i64, transcript: &str, segments_json: &str, duration: Option<f64>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        if let Some(dur) = duration {
            conn.execute(
                "UPDATE recordings SET transcript_text = ?1, speaker_segments = ?2, duration_seconds = ?3 WHERE id = ?4",
                params![transcript, segments_json, dur, id],
            )?;
        } else {
            conn.execute(
                "UPDATE recordings SET transcript_text = ?1, speaker_segments = ?2 WHERE id = ?3",
                params![transcript, segments_json, id],
            )?;
        }
        Ok(())
    }

    pub fn list_recordings(&self) -> Result<Vec<Recording>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, recorded_at, duration_seconds, local_audio_path, transcript_text, speaker_segments, name, session_type
             FROM recordings ORDER BY recorded_at DESC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Recording {
                id: row.get(0)?,
                recorded_at: row.get(1)?,
                duration_seconds: row.get(2)?,
                local_audio_path: row.get(3)?,
                transcript_text: row.get(4)?,
                speaker_segments: row.get(5)?,
                name: row.get(6)?,
                session_type: row.get::<_, String>(7).unwrap_or_else(|_| "recording".to_string()),
            })
        })?;
        rows.collect()
    }

    pub fn get_recording(&self, id: i64) -> Result<Recording> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, recorded_at, duration_seconds, local_audio_path, transcript_text, speaker_segments, name, session_type
             FROM recordings WHERE id = ?1",
            params![id],
            |row| {
                Ok(Recording {
                    id: row.get(0)?,
                    recorded_at: row.get(1)?,
                    duration_seconds: row.get(2)?,
                    local_audio_path: row.get(3)?,
                    transcript_text: row.get(4)?,
                    speaker_segments: row.get(5)?,
                    name: row.get(6)?,
                    session_type: row.get::<_, String>(7).unwrap_or_else(|_| "recording".to_string()),
                })
            },
        )
    }

    // -- Analysis --

    pub fn insert_analysis(
        &self,
        recording_id: i64,
        delivery_score: f64,
        filler_count: i32,
        hedging_count: i32,
        deflection_count: i32,
        pace_wpm: f64,
        topic_segments_json: Option<&str>,
    ) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO analysis_results
             (recording_id, delivery_score, filler_word_count, hedging_count, deflection_count, pace_wpm, topic_segments)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![recording_id, delivery_score, filler_count, hedging_count, deflection_count, pace_wpm, topic_segments_json],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn get_analysis_for_recording(&self, recording_id: i64) -> Result<AnalysisResult> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, recording_id, delivery_score, filler_word_count, hedging_count, deflection_count, pace_wpm, topic_segments
             FROM analysis_results WHERE recording_id = ?1",
            params![recording_id],
            |row| {
                Ok(AnalysisResult {
                    id: row.get(0)?,
                    recording_id: row.get(1)?,
                    delivery_score: row.get(2)?,
                    filler_word_count: row.get(3)?,
                    hedging_count: row.get(4)?,
                    deflection_count: row.get(5)?,
                    pace_wpm: row.get(6)?,
                    topic_segments: row.get(7)?,
                })
            },
        )
    }

    // -- Flagged Moments --

    pub fn insert_flagged_moment(
        &self,
        analysis_id: i64,
        recording_id: i64,
        start_time: f64,
        end_time: f64,
        moment_type: &str,
        severity: i32,
        coach_type: &str,
        transcript_text: &str,
        coaching_text: Option<&str>,
    ) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO flagged_moments
             (analysis_result_id, recording_id, start_time, end_time, moment_type, severity, coach_type, transcript_text, coaching_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![analysis_id, recording_id, start_time, end_time, moment_type, severity, coach_type, transcript_text, coaching_text],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn get_flagged_moments_for_recording(&self, recording_id: i64) -> Result<Vec<FlaggedMoment>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, analysis_result_id, recording_id, start_time, end_time, clip_path,
                    moment_type, severity, coach_type, coaching_text, transcript_text
             FROM flagged_moments WHERE recording_id = ?1 ORDER BY severity DESC"
        )?;
        let rows = stmt.query_map(params![recording_id], |row| {
            Ok(FlaggedMoment {
                id: row.get(0)?,
                analysis_result_id: row.get(1)?,
                recording_id: row.get(2)?,
                start_time: row.get(3)?,
                end_time: row.get(4)?,
                clip_path: row.get(5)?,
                moment_type: row.get(6)?,
                severity: row.get(7)?,
                coach_type: row.get(8)?,
                coaching_text: row.get(9)?,
                transcript_text: row.get(10)?,
            })
        })?;
        rows.collect()
    }

    // -- Drill Attempts --

    pub fn insert_drill_attempt(
        &self,
        flagged_moment_id: i64,
        audio_path: &str,
    ) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO drill_attempts (flagged_moment_id, local_audio_path) VALUES (?1, ?2)",
            params![flagged_moment_id, audio_path],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_drill_feedback(
        &self,
        id: i64,
        feedback: &str,
        improvement_score: f64,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE drill_attempts SET feedback_text = ?1, improvement_score = ?2 WHERE id = ?3",
            params![feedback, improvement_score, id],
        )?;
        Ok(())
    }

    pub fn get_dashboard_data(&self) -> Result<Vec<DashboardEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT r.id, r.recorded_at, r.duration_seconds,
                    a.delivery_score, a.filler_word_count, a.hedging_count,
                    a.deflection_count, a.pace_wpm,
                    (SELECT COUNT(*) FROM flagged_moments WHERE recording_id = r.id) as moment_count,
                    (SELECT COUNT(*) FROM drill_attempts da
                     JOIN flagged_moments fm ON da.flagged_moment_id = fm.id
                     WHERE fm.recording_id = r.id) as drill_count
             FROM recordings r
             LEFT JOIN analysis_results a ON a.recording_id = r.id
             ORDER BY r.recorded_at ASC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(DashboardEntry {
                recording_id: row.get(0)?,
                recorded_at: row.get(1)?,
                duration_seconds: row.get(2)?,
                delivery_score: row.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
                filler_count: row.get::<_, Option<i32>>(4)?.unwrap_or(0),
                disfluency_count: row.get::<_, Option<i32>>(5)?.unwrap_or(0),
                pause_count: row.get::<_, Option<i32>>(6)?.unwrap_or(0),
                pace_wpm: row.get::<_, Option<f64>>(7)?.unwrap_or(0.0),
                flagged_moment_count: row.get::<_, i32>(8)?,
                drill_attempt_count: row.get::<_, i32>(9)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_drill_attempts_for_moment(&self, moment_id: i64) -> Result<Vec<DrillAttempt>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, flagged_moment_id, attempted_at, local_audio_path, feedback_text, improvement_score
             FROM drill_attempts WHERE flagged_moment_id = ?1 ORDER BY attempted_at DESC"
        )?;
        let rows = stmt.query_map(params![moment_id], |row| {
            Ok(DrillAttempt {
                id: row.get(0)?,
                flagged_moment_id: row.get(1)?,
                attempted_at: row.get(2)?,
                local_audio_path: row.get(3)?,
                feedback_text: row.get(4)?,
                improvement_score: row.get(5)?,
            })
        })?;
        rows.collect()
    }
}
