//! Tauri commands exposed to the frontend.

use crate::db::Database;
use crate::sidecar::SidecarManager;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

// -- Sidecar commands --

#[tauri::command]
pub async fn transcribe_audio(
    file_path: String,
    model_size: Option<String>,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "file_path": file_path,
        "model_size": model_size.unwrap_or_else(|| "base".to_string()),
    });

    sidecar.send_command("transcribe", params, &app)
}

#[tauri::command]
pub async fn analyze_delivery(
    segments: Value,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "segments": segments,
    });

    sidecar.send_command("analyze_delivery", params, &app)
}

#[tauri::command]
pub async fn parse_document(
    file_path: String,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "file_path": file_path,
    });

    sidecar.send_command("parse_document", params, &app)
}

// -- Database commands --

#[tauri::command]
pub async fn save_recording(
    audio_path: String,
    duration: f64,
    recording_id: Option<i64>,
    transcript: Option<String>,
    segments_json: Option<String>,
    session_type: Option<String>,
    db: State<'_, Database>,
) -> Result<Value, String> {
    let id = if let Some(existing_id) = recording_id {
        if let (Some(t), Some(s)) = (&transcript, &segments_json) {
            db.update_transcript(existing_id, t, s, Some(duration))
                .map_err(|e| e.to_string())?;
        }
        existing_id
    } else {
        let new_id = db
            .insert_recording(&audio_path, duration)
            .map_err(|e| e.to_string())?;
        // Set session type if provided
        if let Some(st) = &session_type {
            let conn = db.conn().map_err(|e| e.to_string())?;
            conn.execute("UPDATE recordings SET session_type = ?1 WHERE id = ?2", rusqlite::params![st, new_id])
                .map_err(|e| e.to_string())?;
        }

        if let (Some(t), Some(s)) = (&transcript, &segments_json) {
            db.update_transcript(new_id, t, s, None)
                .map_err(|e| e.to_string())?;
        }
        new_id
    };

    Ok(json!({ "id": id }))
}

#[tauri::command]
pub async fn list_recordings(db: State<'_, Database>) -> Result<Value, String> {
    let recordings = db.list_recordings().map_err(|e| e.to_string())?;
    serde_json::to_value(&recordings).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_recording(id: i64, db: State<'_, Database>) -> Result<Value, String> {
    let recording = db.get_recording(id).map_err(|e| e.to_string())?;
    serde_json::to_value(&recording).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_analysis(
    recording_id: i64,
    delivery_score: f64,
    filler_count: i32,
    hedging_count: i32,
    deflection_count: i32,
    pace_wpm: f64,
    flagged_moments: Value,
    db: State<'_, Database>,
) -> Result<Value, String> {
    let analysis_id = db
        .insert_analysis(
            recording_id,
            delivery_score,
            filler_count,
            hedging_count,
            deflection_count,
            pace_wpm,
            None,
        )
        .map_err(|e| e.to_string())?;

    // Save each flagged moment
    if let Some(moments) = flagged_moments.as_array() {
        for m in moments {
            let _ = db.insert_flagged_moment(
                analysis_id,
                recording_id,
                m["start"].as_f64().unwrap_or(0.0),
                m["end"].as_f64().unwrap_or(0.0),
                m["type"].as_str().unwrap_or("unknown"),
                m["severity"].as_i64().unwrap_or(0) as i32,
                m["coach_type"].as_str().unwrap_or("speech"),
                m["text"].as_str().unwrap_or(""),
                m["coaching_text"].as_str(),
            );
        }
    }

    Ok(json!({ "analysis_id": analysis_id }))
}

#[tauri::command]
pub async fn get_flagged_moments(
    recording_id: i64,
    db: State<'_, Database>,
) -> Result<Value, String> {
    let moments = db
        .get_flagged_moments_for_recording(recording_id)
        .map_err(|e| e.to_string())?;
    serde_json::to_value(&moments).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn warmup_models(
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    sidecar.send_command("warmup_models", json!({}), &app)
}

#[tauri::command]
pub async fn save_coach_session(
    conversation_json: String,
    first_impression_json: Option<String>,
    db: State<'_, Database>,
) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    let session_number: i64 = conn.query_row(
        "SELECT COALESCE(MAX(session_number), 0) + 1 FROM coach_session_history",
        [],
        |r| r.get(0),
    ).unwrap_or(1);
    conn.execute(
        "INSERT INTO coach_session_history (session_number, conversation_json, first_impression_json) VALUES (?1, ?2, ?3)",
        rusqlite::params![session_number, conversation_json, first_impression_json],
    ).map_err(|e| e.to_string())?;
    Ok(json!({"session_number": session_number}))
}

#[tauri::command]
pub async fn get_coach_session_count(
    db: State<'_, Database>,
) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM coach_session_history",
        [],
        |r| r.get(0),
    ).unwrap_or(0);
    Ok(json!({"count": count}))
}

#[tauri::command]
pub async fn get_latest_coach_session(
    db: State<'_, Database>,
) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    let result = conn.query_row(
        "SELECT session_number, conversation_json, first_impression_json, created_at FROM coach_session_history ORDER BY id DESC LIMIT 1",
        [],
        |row| Ok(json!({
            "session_number": row.get::<_, i64>(0)?,
            "conversation_json": row.get::<_, Option<String>>(1)?,
            "first_impression_json": row.get::<_, Option<String>>(2)?,
            "created_at": row.get::<_, String>(3)?,
        })),
    );
    match result {
        Ok(val) => Ok(val),
        Err(_) => Ok(json!(null)),
    }
}

#[tauri::command]
pub async fn get_first_impression(
    db: State<'_, Database>,
) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    let result = conn.query_row(
        "SELECT first_impression_json FROM coach_session_history WHERE session_number = 1 AND first_impression_json IS NOT NULL ORDER BY id DESC LIMIT 1",
        [],
        |row| row.get::<_, String>(0),
    );
    match result {
        Ok(json) => Ok(json!({"impression_json": json})),
        Err(_) => Ok(json!({"impression_json": null})),
    }
}

#[tauri::command]
pub async fn transcribe_fast(
    audio_path: String,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "audio_path": audio_path,
    });
    sidecar.send_command("transcribe_fast", params, &app)
}

#[tauri::command]
pub async fn coach_conversation_turn(
    conversation_history: Value,
    user_text: String,
    is_first_session: bool,
    session_number: Option<i32>,
    user_name: Option<String>,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "conversation_history": conversation_history,
        "user_text": user_text,
        "is_first_session": is_first_session,
        "session_number": session_number.unwrap_or(1),
        "user_name": user_name.unwrap_or_default(),
    });
    sidecar.send_command("coach_conversation_turn", params, &app)
}

#[tauri::command]
pub async fn generate_first_impression(
    conversation_text: String,
    metrics: Value,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "conversation_text": conversation_text,
        "metrics": metrics,
    });
    sidecar.send_command("generate_first_impression", params, &app)
}

#[tauri::command]
pub async fn speak_text(
    text: String,
    output_path: String,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "text": text,
        "output_path": output_path,
    });
    sidecar.send_command("speak_text", params, &app)
}

#[tauri::command]
pub async fn extract_embedding(
    audio_path: String,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "audio_path": audio_path,
    });
    sidecar.send_command("extract_embedding", params, &app)
}

#[tauri::command]
pub async fn match_speaker(
    audio_path: String,
    segments: Value,
    stored_embedding: Value,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "audio_path": audio_path,
        "segments": segments,
        "stored_embedding": stored_embedding,
    });
    sidecar.send_command("match_speaker", params, &app)
}

#[tauri::command]
pub async fn save_voice_profile(
    embedding_json: String,
    user_name: Option<String>,
    db: State<'_, Database>,
) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO voice_profiles (id, embedding_json, user_name, created_at) VALUES (1, ?1, ?2, datetime('now') || 'Z')",
        rusqlite::params![embedding_json, user_name],
    ).map_err(|e| e.to_string())?;
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub async fn save_user_name(
    user_name: String,
    db: State<'_, Database>,
) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    // Check if name was already set before
    let had_name: bool = conn.query_row(
        "SELECT user_name IS NOT NULL AND user_name != '' FROM voice_profiles WHERE id = 1",
        [],
        |row| row.get(0),
    ).unwrap_or(false);

    conn.execute(
        "UPDATE voice_profiles SET user_name = ?1 WHERE id = 1",
        rusqlite::params![user_name],
    ).map_err(|e| e.to_string())?;

    // Update old transcripts only on first name capture
    if had_name {
        return Ok(json!({"ok": true}));
    }

    let mut stmt = conn.prepare(
        "SELECT id, speaker_segments FROM recordings WHERE speaker_segments IS NOT NULL"
    ).map_err(|e| e.to_string())?;

    let rows: Vec<(i64, String)> = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    for (rec_id, segments_json) in rows {
        if let Ok(mut segments) = serde_json::from_str::<Vec<serde_json::Value>>(&segments_json) {
            // Find the speaker with the most words (the user)
            let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
            for seg in &segments {
                if let Some(spk) = seg.get("speaker").and_then(|s| s.as_str()) {
                    let words = seg.get("text").and_then(|t| t.as_str()).unwrap_or("").split_whitespace().count();
                    *counts.entry(spk.to_string()).or_insert(0) += words;
                }
            }
            if let Some((top_speaker, _)) = counts.into_iter().max_by_key(|(_, c)| *c) {
                let mut changed = false;
                for seg in &mut segments {
                    if let Some(spk) = seg.get("speaker").and_then(|s| s.as_str()) {
                        if spk == top_speaker {
                            seg.as_object_mut().unwrap().insert("speaker".to_string(), json!(user_name.clone()));
                            changed = true;
                        }
                    }
                }
                if changed {
                    if let Ok(updated) = serde_json::to_string(&segments) {
                        let _ = conn.execute(
                            "UPDATE recordings SET speaker_segments = ?1 WHERE id = ?2",
                            rusqlite::params![updated, rec_id],
                        );
                    }
                }
            }
        }
    }

    Ok(json!({"ok": true}))
}

#[tauri::command]
pub async fn get_voice_profile(
    db: State<'_, Database>,
) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    let result = conn.query_row(
        "SELECT embedding_json, user_name FROM voice_profiles WHERE id = 1",
        [],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
    );
    match result {
        Ok((emb, name)) => Ok(json!({"embedding_json": emb, "user_name": name})),
        Err(_) => Ok(json!({"embedding_json": null, "user_name": null})),
    }
}

#[tauri::command]
pub async fn save_baseline(
    filler_rate: f64,
    pace_wpm: f64,
    hedging_rate: f64,
    pause_rate: f64,
    first_session_id: i64,
    db: State<'_, Database>,
) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO user_baseline (id, filler_rate, pace_wpm, hedging_rate, pause_rate, first_session_id, created_at) VALUES (1, ?1, ?2, ?3, ?4, ?5, datetime('now') || 'Z')",
        rusqlite::params![filler_rate, pace_wpm, hedging_rate, pause_rate, first_session_id],
    ).map_err(|e| e.to_string())?;
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub async fn get_baseline(
    db: State<'_, Database>,
) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    let result = conn.query_row(
        "SELECT filler_rate, pace_wpm, hedging_rate, pause_rate, first_session_id FROM user_baseline WHERE id = 1",
        [],
        |row| {
            Ok(json!({
                "filler_rate": row.get::<_, f64>(0)?,
                "pace_wpm": row.get::<_, f64>(1)?,
                "hedging_rate": row.get::<_, f64>(2)?,
                "pause_rate": row.get::<_, f64>(3)?,
                "first_session_id": row.get::<_, i64>(4)?,
            }))
        },
    );
    match result {
        Ok(val) => Ok(val),
        Err(_) => Ok(json!(null)),
    }
}

#[tauri::command]
pub async fn generate_coaching(
    flagged_moments: Value,
    full_transcript: String,
    doc_chunks: Option<Value>,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "flagged_moments": flagged_moments,
        "full_transcript": full_transcript,
        "doc_chunks": doc_chunks.unwrap_or(json!([])),
    });

    sidecar.send_command("generate_coaching", params, &app)
}

#[tauri::command]
pub async fn evaluate_drill(
    original_text: String,
    moment_type: String,
    suggested_delivery: String,
    attempt_transcript: String,
    attempt_number: i32,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "original_text": original_text,
        "moment_type": moment_type,
        "suggested_delivery": suggested_delivery,
        "attempt_transcript": attempt_transcript,
        "attempt_number": attempt_number,
    });

    sidecar.send_command("evaluate_drill", params, &app)
}

#[tauri::command]
pub async fn analyze_speech(
    audio_path: String,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "audio_path": audio_path,
    });

    sidecar.send_command("analyze_speech", params, &app)
}

#[tauri::command]
pub async fn analyze_words(
    words: Value,
    segments: Value,
    duration_seconds: f64,
    full_text: String,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "words": words,
        "segments": segments,
        "duration_seconds": duration_seconds,
        "full_text": full_text,
    });

    sidecar.send_command("analyze_words", params, &app)
}

#[tauri::command]
pub async fn analyze_audio(
    audio_path: String,
    transcript_segments: Value,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "audio_path": audio_path,
        "transcript_segments": transcript_segments,
    });

    sidecar.send_command("analyze_audio", params, &app)
}

#[tauri::command]
pub async fn extract_clips(
    audio_path: String,
    moments: Value,
    output_dir: String,
    app: AppHandle,
    sidecar: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let params = json!({
        "audio_path": audio_path,
        "moments": moments,
        "output_dir": output_dir,
    });

    sidecar.send_command("extract_clips", params, &app)
}

#[tauri::command]
pub async fn save_document(
    filename: String,
    local_path: String,
    chunks_json: String,
    db: State<'_, Database>,
) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO documents (filename, local_path, chunks) VALUES (?1, ?2, ?3)",
        rusqlite::params![filename, local_path, chunks_json],
    ).map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(json!({ "id": id }))
}

#[tauri::command]
pub async fn list_documents(db: State<'_, Database>) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, filename, local_path, LENGTH(chunks) as chunk_size FROM documents ORDER BY id DESC"
    ).map_err(|e| e.to_string())?;
    let rows: Vec<Value> = stmt.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, i64>(0)?,
            "filename": row.get::<_, String>(1)?,
            "local_path": row.get::<_, String>(2)?,
            "chunk_size": row.get::<_, i64>(3)?,
        }))
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();
    Ok(json!(rows))
}

#[tauri::command]
pub async fn delete_document(id: i64, db: State<'_, Database>) -> Result<(), String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM documents WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// -- Subject commands --

#[tauri::command]
pub async fn list_subjects(db: State<'_, Database>) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT s.id, s.name, s.description, s.created_at,
                (SELECT COUNT(*) FROM documents WHERE subject_id = s.id) as doc_count,
                (SELECT COUNT(*) FROM recordings WHERE subject_id = s.id) as recording_count
         FROM subjects s ORDER BY s.name"
    ).map_err(|e| e.to_string())?;
    let rows: Vec<Value> = stmt.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, i64>(0)?,
            "name": row.get::<_, String>(1)?,
            "description": row.get::<_, Option<String>>(2)?,
            "created_at": row.get::<_, String>(3)?,
            "doc_count": row.get::<_, i32>(4)?,
            "recording_count": row.get::<_, i32>(5)?,
        }))
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();
    Ok(json!(rows))
}

#[tauri::command]
pub async fn create_subject(
    name: String,
    description: Option<String>,
    db: State<'_, Database>,
) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO subjects (name, description) VALUES (?1, ?2)",
        rusqlite::params![name, description],
    ).map_err(|e| e.to_string())?;
    Ok(json!({ "id": conn.last_insert_rowid() }))
}

#[tauri::command]
pub async fn delete_subject(id: i64, db: State<'_, Database>) -> Result<(), String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    // Unlink recordings and docs, don't delete them
    conn.execute("UPDATE recordings SET subject_id = NULL WHERE subject_id = ?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
    conn.execute("UPDATE documents SET subject_id = NULL WHERE subject_id = ?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM subjects WHERE id = ?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn assign_recording_subject(
    recording_id: i64,
    subject_id: Option<i64>,
    db: State<'_, Database>,
) -> Result<(), String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE recordings SET subject_id = ?1 WHERE id = ?2",
        rusqlite::params![subject_id, recording_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn assign_document_subject(
    document_id: i64,
    subject_id: Option<i64>,
    db: State<'_, Database>,
) -> Result<(), String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE documents SET subject_id = ?1 WHERE id = ?2",
        rusqlite::params![subject_id, document_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_doc_chunks_for_subject(
    subject_id: i64,
    db: State<'_, Database>,
) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT chunks FROM documents WHERE subject_id = ?1 AND chunks IS NOT NULL"
    ).map_err(|e| e.to_string())?;
    let mut all_chunks: Vec<Value> = Vec::new();
    let rows = stmt.query_map(rusqlite::params![subject_id], |row| {
        row.get::<_, String>(0)
    }).map_err(|e| e.to_string())?;
    for row in rows {
        if let Ok(json_str) = row {
            if let Ok(chunks) = serde_json::from_str::<Vec<Value>>(&json_str) {
                all_chunks.extend(chunks);
            }
        }
    }
    Ok(json!(all_chunks))
}

// -- Study item commands --

#[tauri::command]
pub async fn list_study_items(db: State<'_, Database>) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT si.id, si.topic_id, si.title, si.source_type, si.source_path_or_url,
                si.status, si.priority, t.name as topic_name
         FROM study_items si
         LEFT JOIN topics t ON si.topic_id = t.id
         ORDER BY si.priority DESC, si.id ASC"
    ).map_err(|e| e.to_string())?;
    let rows: Vec<Value> = stmt.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, i64>(0)?,
            "topic_id": row.get::<_, Option<i64>>(1)?,
            "title": row.get::<_, String>(2)?,
            "source_type": row.get::<_, String>(3)?,
            "source_path_or_url": row.get::<_, Option<String>>(4)?,
            "status": row.get::<_, String>(5)?,
            "priority": row.get::<_, i32>(6)?,
            "topic_name": row.get::<_, Option<String>>(7)?,
        }))
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();
    Ok(json!(rows))
}

#[tauri::command]
pub async fn add_study_item(
    title: String,
    topic_name: Option<String>,
    source_type: String,
    source_path_or_url: Option<String>,
    priority: i32,
    db: State<'_, Database>,
) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;

    // Create or find topic
    let topic_id = if let Some(name) = &topic_name {
        conn.execute(
            "INSERT OR IGNORE INTO topics (name) VALUES (?1)",
            rusqlite::params![name],
        ).map_err(|e| e.to_string())?;
        let id: i64 = conn.query_row(
            "SELECT id FROM topics WHERE name = ?1",
            rusqlite::params![name],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Some(id)
    } else {
        None
    };

    conn.execute(
        "INSERT INTO study_items (topic_id, title, source_type, source_path_or_url, priority)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![topic_id, title, source_type, source_path_or_url, priority],
    ).map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(json!({ "id": id }))
}

#[tauri::command]
pub async fn update_study_item_status(
    id: i64,
    status: String,
    db: State<'_, Database>,
) -> Result<(), String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE study_items SET status = ?1 WHERE id = ?2",
        rusqlite::params![status, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_study_item(id: i64, db: State<'_, Database>) -> Result<(), String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM study_items WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_topics(db: State<'_, Database>) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, name, first_seen_at, baseline_score, latest_score FROM topics ORDER BY name"
    ).map_err(|e| e.to_string())?;
    let rows: Vec<Value> = stmt.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, i64>(0)?,
            "name": row.get::<_, String>(1)?,
            "first_seen_at": row.get::<_, String>(2)?,
            "baseline_score": row.get::<_, Option<f64>>(3)?,
            "latest_score": row.get::<_, Option<f64>>(4)?,
        }))
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();
    Ok(json!(rows))
}

#[tauri::command]
pub async fn get_all_doc_chunks(db: State<'_, Database>) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT chunks FROM documents WHERE chunks IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let mut all_chunks: Vec<Value> = Vec::new();
    let rows = stmt.query_map([], |row| {
        row.get::<_, String>(0)
    }).map_err(|e| e.to_string())?;
    for row in rows {
        if let Ok(json_str) = row {
            if let Ok(chunks) = serde_json::from_str::<Vec<Value>>(&json_str) {
                all_chunks.extend(chunks);
            }
        }
    }
    Ok(json!(all_chunks))
}

#[tauri::command]
pub async fn rename_recording(
    recording_id: i64,
    name: String,
    db: State<'_, Database>,
) -> Result<(), String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    // Add name column if not exists (migration-safe)
    conn.execute_batch(
        "ALTER TABLE recordings ADD COLUMN name TEXT;"
    ).ok(); // ignore if already exists
    conn.execute(
        "UPDATE recordings SET name = ?1 WHERE id = ?2",
        rusqlite::params![name, recording_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_recording(
    recording_id: i64,
    db: State<'_, Database>,
) -> Result<(), String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    // Cascade: drill_attempts → flagged_moments → analysis_results → recording
    conn.execute(
        "DELETE FROM drill_attempts WHERE flagged_moment_id IN
         (SELECT id FROM flagged_moments WHERE recording_id = ?1)",
        rusqlite::params![recording_id],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM flagged_moments WHERE recording_id = ?1",
        rusqlite::params![recording_id],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM analysis_results WHERE recording_id = ?1",
        rusqlite::params![recording_id],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM recordings WHERE id = ?1",
        rusqlite::params![recording_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_drill_count_for_recording(
    recording_id: i64,
    db: State<'_, Database>,
) -> Result<Value, String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM drill_attempts da
         JOIN flagged_moments fm ON da.flagged_moment_id = fm.id
         WHERE fm.recording_id = ?1",
        rusqlite::params![recording_id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    Ok(json!({ "count": count }))
}

#[tauri::command]
pub async fn get_dashboard(db: State<'_, Database>) -> Result<Value, String> {
    let entries = db.get_dashboard_data().map_err(|e| e.to_string())?;
    serde_json::to_value(&entries).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_coaching_text(
    moment_id: i64,
    coaching_text: String,
    db: State<'_, Database>,
) -> Result<(), String> {
    let conn = db.conn().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE flagged_moments SET coaching_text = ?1 WHERE id = ?2",
        rusqlite::params![coaching_text, moment_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
