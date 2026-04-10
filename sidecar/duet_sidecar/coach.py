"""Claude API integration for coaching analysis.

Sends transcript segments + NLP metrics to Claude for:
- Confidence scoring per topic
- Coaching text for flagged moments (how to say it better)
- Knowledge gap detection (when internal docs are available)

Only transcript text and doc chunks are sent. Never raw audio.
"""

import json
import os
from typing import Callable

try:
    import anthropic
except ImportError:
    anthropic = None


def _get_client():
    if anthropic is None:
        raise RuntimeError(
            "anthropic package not installed. Run: pip install anthropic"
        )
    api_key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("DUET_API_KEY")
    if not api_key:
        raise ValueError(
            "No API key found. Set ANTHROPIC_API_KEY or DUET_API_KEY environment variable."
        )
    return anthropic.Anthropic(api_key=api_key)


COACHING_SYSTEM_PROMPT = """You are Duet, a professional speech coach with deep expertise in executive communication, public speaking, and vocal performance. You've coached hundreds of speakers from startup founders to Fortune 500 executives.

Your coaching style:
- Name the specific pattern you hear, explain WHY it undermines their message, and give a concrete physical or mental technique to fix it.
- Reference their exact words. Never give generic advice like "try to reduce fillers." Instead: "You said 'um' three times before your main point about pricing. That signals uncertainty to your audience right when you need authority."
- For each moment, give a PRACTICE DRILL: a specific exercise they can repeat 5-10 times to build muscle memory. Think like a vocal coach or acting teacher. Examples: "Pause for a full 2-count before your next sentence instead of filling with 'um'" or "Say the replacement phrase below three times, each time slower and more deliberately."
- Connect the fix to the outcome: what will the audience feel differently when they nail it.

Never be condescending. The user is a professional who wants to get sharper. Treat them like an athlete reviewing game tape with their coach."""


def generate_coaching(params: dict, progress_callback: Callable) -> dict:
    """Generate coaching feedback for flagged moments.

    Params:
        flagged_moments: List of {start, end, type, severity, text, matches}
        full_transcript: The complete transcript text for context
        doc_chunks: Optional list of {heading, text} from internal docs

    Returns:
        {
            "coached_moments": [
                {
                    "start": float,
                    "end": float,
                    "coaching_text": str,
                    "suggested_delivery": str,
                    "topic": str | null
                }
            ],
            "overall_score": float,
            "summary": str
        }
    """
    flagged_moments = params.get("flagged_moments", [])
    full_transcript = params.get("full_transcript", "")
    doc_chunks = params.get("doc_chunks", [])

    if not flagged_moments:
        return {
            "coached_moments": [],
            "overall_score": 10.0,
            "summary": "Clean delivery. No moments flagged.",
        }

    progress_callback({"type": "progress", "stage": "coaching", "percent": 10})

    client = _get_client()

    # Build the prompt
    moments_text = ""
    for i, m in enumerate(flagged_moments[:10]):  # Cap at 10 to manage context
        moments_text += f"\n--- Moment {i+1} ({m['type']}, severity {m['severity']}/10) ---\n"
        moments_text += f"What they said: \"{m['text']}\"\n"
        if m.get("matches"):
            moments_text += f"Flagged patterns: {', '.join(m['matches'])}\n"

    doc_context = ""
    if doc_chunks:
        doc_context = "\n\n--- INTERNAL DOCUMENTATION (use this as ground truth for subject matter) ---\n"
        for chunk in doc_chunks[:5]:  # Cap at 5 chunks
            heading = chunk.get("heading", "")
            if heading:
                doc_context += f"\n## {heading}\n"
            doc_context += chunk["text"] + "\n"

    user_prompt = f"""Here is a meeting transcript to analyze:

--- FULL TRANSCRIPT ---
{full_transcript[:8000]}

--- FLAGGED MOMENTS ---
{moments_text}
{doc_context}

For each flagged moment, provide:

1. **coaching_text**: 4-6 sentences of professional speech coaching. Structure it as:
   - WHAT happened: Name the exact pattern and quote their words. ("You used 'like' as a verbal crutch four times in this sentence...")
   - WHY it matters: How this specific pattern affects the listener's perception. ("This makes your recommendation sound tentative when you actually have strong conviction...")
   - THE FIX: A concrete technique or exercise, not just "try to avoid it." Give them a physical action, mental reframe, or practice drill. ("Before your next key point, take a deliberate breath and let one full beat of silence pass. Silence reads as confidence...")
   - PRACTICE TIP: How to drill this at home. ("Record yourself saying the replacement phrase below 5 times. On each rep, slow down slightly and emphasize the verb...")

2. **suggested_delivery**: Rewrite what they said as a polished version. Write 2-3 natural sentences they should actually practice saying out loud. Keep their meaning and personality intact but remove the disfluency pattern. This should sound like them on their best day, not like a script.

3. **topic**: If this moment relates to a specific subject/topic, name it. Otherwise null.

Also provide:
- **overall_score**: 1-10 delivery score (10 = broadcast-quality, 7 = solid professional, 4 = needs work, 1 = significant coaching needed). Be calibrated and honest.
- **summary**: 3-4 sentence overall assessment. Lead with what's working (specific strength), then the #1 pattern to fix, then a concrete next step.

Respond in JSON format:
{{
    "coached_moments": [
        {{
            "index": 0,
            "coaching_text": "...",
            "suggested_delivery": "...",
            "topic": "..." or null
        }}
    ],
    "overall_score": N,
    "summary": "..."
}}"""

    progress_callback({"type": "progress", "stage": "coaching", "percent": 30})

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=2000,
        system=COACHING_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )

    progress_callback({"type": "progress", "stage": "coaching", "percent": 80})

    # Parse the response
    response_text = response.content[0].text

    # Extract JSON from response (handle markdown code blocks)
    json_text = response_text
    if "```json" in json_text:
        json_text = json_text.split("```json")[1].split("```")[0]
    elif "```" in json_text:
        json_text = json_text.split("```")[1].split("```")[0]

    result = json.loads(json_text.strip())

    # Merge coaching text back with timestamps from flagged moments
    coached = []
    for item in result.get("coached_moments", []):
        idx = item.get("index", 0)
        if idx < len(flagged_moments):
            moment = flagged_moments[idx]
            coached.append({
                "start": moment["start"],
                "end": moment["end"],
                "coaching_text": item.get("coaching_text", ""),
                "suggested_delivery": item.get("suggested_delivery", ""),
                "topic": item.get("topic"),
            })

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    return {
        "coached_moments": coached,
        "overall_score": result.get("overall_score", 5.0),
        "summary": result.get("summary", ""),
    }


def evaluate_drill(params: dict, progress_callback: Callable) -> dict:
    """Evaluate a user's drill attempt against the original flagged moment.

    Params:
        original_text: What the user originally said (the flagged moment)
        moment_type: Type of disfluency (filler, hedging, etc.)
        suggested_delivery: The coached version they should aim for
        attempt_transcript: What they said in this drill attempt
        attempt_number: Which attempt this is (1, 2, or 3)

    Returns:
        {
            "passed": bool,
            "score": float (1-10),
            "feedback": str (2-3 sentences),
            "remaining_issues": [str] or []
        }
    """
    original_text = params.get("original_text", "")
    moment_type = params.get("moment_type", "")
    suggested_delivery = params.get("suggested_delivery", "")
    attempt_transcript = params.get("attempt_transcript", "")
    attempt_number = params.get("attempt_number", 1)

    if not attempt_transcript.strip():
        return {
            "passed": False,
            "score": 0,
            "feedback": "No speech detected. Make sure your microphone is working and try again.",
            "remaining_issues": [],
        }

    progress_callback({"type": "progress", "stage": "evaluating", "percent": 30})

    client = _get_client()

    user_prompt = f"""You are evaluating a speech drill. The user had a disfluency in their original speech and is practicing saying it cleanly.

ORIGINAL (what they said, with the problem):
"{original_text}"

PROBLEM TYPE: {moment_type}

TARGET (what clean delivery sounds like):
"{suggested_delivery}"

THEIR ATTEMPT (attempt #{attempt_number}):
"{attempt_transcript}"

Evaluate:
1. Did they eliminate the specific disfluency ({moment_type})? Check for fillers (um, uh, like, you know), repetitions, false starts, hedging words, and long pauses.
2. Does it sound natural, not robotic?
3. Did they convey the same meaning?

Be encouraging but honest. If they still have the same disfluency, point it out specifically. If they cleaned it up, celebrate that.

Respond in JSON:
{{
    "passed": true/false,
    "score": N (1-10, where 7+ = passed),
    "feedback": "2-3 sentences. Be specific about what improved and what remains.",
    "remaining_issues": ["list of specific remaining disfluencies, if any"]
}}"""

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=500,
        system="You are a speech coach evaluating a practice drill. Be warm, specific, and encouraging. Celebrate improvement even if it's not perfect yet.",
        messages=[{"role": "user", "content": user_prompt}],
    )

    progress_callback({"type": "progress", "stage": "evaluating", "percent": 90})

    response_text = response.content[0].text
    json_text = response_text
    if "```json" in json_text:
        json_text = json_text.split("```json")[1].split("```")[0]
    elif "```" in json_text:
        json_text = json_text.split("```")[1].split("```")[0]

    result = json.loads(json_text.strip())

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    return {
        "passed": result.get("passed", False),
        "score": result.get("score", 5),
        "feedback": result.get("feedback", ""),
        "remaining_issues": result.get("remaining_issues", []),
    }


COACH_FIRST_SESSION_SYSTEM = """You are a warm, direct speech coach having a conversation with a new client. This is your first session together. Your goal is to get to know them and hear how they speak naturally.

Rules:
- Keep your responses SHORT. 1-2 sentences for the echo, 1 sentence for the next question. You're a coach, not a lecturer.
- Do NOT summarize or echo back what they said at length. A brief acknowledgment is fine ("Got it." or "Okay.") then move on to your next question immediately.
- Adapt your next question based on what they told you. If they mention sales, ask about pitching. If they mention board meetings, ask about presenting.
- Sound natural and conversational. Keep it moving.
- Never use filler words yourself. Model clean speech.
- If the user just told you their name, use it from now on. Include their name in the "user_name" field of your response.
- After the name, ask about what they do and what kind of speaking situations they're in.
- After 3-5 exchanges, you should have enough. Wrap up warmly.

Respond in JSON:
{
    "echo": "Brief acknowledgment only. 'Got it.' or 'Okay.' or one short sentence max. Do NOT summarize what they said.",
    "next_question": "Your next question (1 sentence). Set to null if you have enough info and want to wrap up.",
    "should_wrap_up": false,
    "wrap_up_message": null,
    "user_name": null
}

Set user_name to the user's FIRST name only when they tell you (e.g., if they say "Joseph Kim", set user_name to "Joseph"). Leave null if they haven't said their name yet.
When should_wrap_up is true, set next_question to null and set wrap_up_message to your closing words. Use their name in the wrap-up if you know it."""


COACH_FOLLOWUP_SESSION_SYSTEM = """You are a direct, encouraging speech coach in a follow-up practice session. You know the user already. Your job is ACTIVE COACHING through a structured loop.

## Session structure (you manage this):

1. Ask a practice question (something they'd encounter at work).
2. Listen to their answer.
3. If they had disfluencies (um, uh, like, you know, sort of, hedging, repetition, false starts):
   - Point out the SPECIFIC issues: "I caught two 'um's and a 'sort of' in there."
   - Tell them you'll ask the same question again: "Let me ask that again. This time, replace those pauses with silence."
   - Set retry=true in your response.
4. On the retry: if improved, say so briefly and move to a NEW question. If still issues, acknowledge the effort and move on anyway. Never dwell on the same question more than once.
5. If their answer was clean (no disfluencies), praise briefly and move to the next question.
6. After 3-4 questions (including retries), wrap up with a one-sentence summary.

## Rules:
- Keep ALL responses to 1-2 sentences. No lectures.
- Name the exact filler words you heard. "I heard 'um' and 'like'" not "you had some fillers."
- Be warm but direct. Like a sports coach, not a therapist.
- Never use filler words yourself.
- Questions should be work-relevant: "Walk me through a recent project update", "Explain a decision you made this week", "Pitch an idea you've been thinking about."

Respond in JSON:
{
    "echo": "Your feedback on what they said. Be specific. (1-2 sentences)",
    "next_question": "Your next question or 'Let me ask that again' for retry. Null to wrap up.",
    "should_wrap_up": false,
    "wrap_up_message": null,
    "retry": false
}

Set retry=true when asking them to repeat the same question. Set should_wrap_up=true after 3-4 questions."""


def coach_conversation_turn(params: dict, progress_callback: Callable) -> dict:
    """Generate the coach's response in a conversation turn.

    Params:
        conversation_history: List of {role: "coach"|"user", text: str}
        user_text: The user's latest transcribed speech
        is_first_session: Whether this is the first ever session (for voice enrollment)

    Returns:
        {"echo": str, "next_question": str|null, "should_wrap_up": bool, "wrap_up_message": str|null}
    """
    conversation_history = params.get("conversation_history", [])
    user_text = params.get("user_text", "")
    is_first_session = params.get("is_first_session", True)

    progress_callback({"type": "progress", "stage": "thinking", "percent": 30})

    client = _get_client()

    # Build conversation for Claude
    messages = []
    for turn in conversation_history:
        role = "assistant" if turn["role"] == "coach" else "user"
        messages.append({"role": role, "content": turn["text"]})

    # Add the current user turn
    if user_text:
        messages.append({"role": "user", "content": user_text})

    # If no messages at all, send a starter
    if not messages:
        messages.append({"role": "user", "content": "[Session started. The user is ready. Ask your first question.]"})

    system_prompt = COACH_FIRST_SESSION_SYSTEM if is_first_session else COACH_FOLLOWUP_SESSION_SYSTEM

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=300,
        system=system_prompt,
        messages=messages,
    )

    progress_callback({"type": "progress", "stage": "thinking", "percent": 80})

    response_text = response.content[0].text
    json_text = response_text
    if "```json" in json_text:
        json_text = json_text.split("```json")[1].split("```")[0]
    elif "```" in json_text:
        json_text = json_text.split("```")[1].split("```")[0]

    try:
        result = json.loads(json_text.strip())
    except json.JSONDecodeError:
        # Fallback if Claude doesn't return valid JSON
        result = {
            "echo": response_text[:200],
            "next_question": "Tell me more about the kind of speaking you do.",
            "should_wrap_up": False,
            "wrap_up_message": None,
        }

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    return {
        "echo": result.get("echo", ""),
        "next_question": result.get("next_question"),
        "should_wrap_up": result.get("should_wrap_up", False),
        "wrap_up_message": result.get("wrap_up_message"),
        "user_name": result.get("user_name"),
    }


def generate_first_impression(params: dict, progress_callback: Callable) -> dict:
    """Generate the Coach's First Impression summary card.

    Params:
        conversation_text: Full transcript of the first session conversation
        metrics: {filler_rate, pace_wpm, hedging_rate, pause_count, word_count, duration}

    Returns:
        {"summary": str, "focus_area": str, "strengths": [str], "patterns": [str]}
    """
    conversation_text = params.get("conversation_text", "")
    metrics = params.get("metrics", {})

    progress_callback({"type": "progress", "stage": "analyzing", "percent": 30})

    client = _get_client()

    user_prompt = f"""Here is the transcript from a first coaching session:

{conversation_text[:6000]}

Speech metrics from this session:
- Filler rate: {metrics.get('filler_rate', 0):.1f} per minute
- Pace: {metrics.get('pace_wpm', 0):.0f} words per minute
- Hedging rate: {metrics.get('hedging_rate', 0):.1f} per minute
- Pause count: {metrics.get('pause_count', 0)}
- Total words: {metrics.get('word_count', 0)}
- Duration: {metrics.get('duration', 0):.0f} seconds

Write a Coach's First Impression. Be warm, direct, specific. Reference their actual words. This is the anchor for their entire coaching journey.

Respond in JSON:
{{
    "summary": "3-4 sentence overall first impression. Lead with something positive and specific. Then name the #1 pattern to work on. End with encouragement.",
    "focus_area": "The single most impactful thing to work on first (1 sentence)",
    "strengths": ["2-3 specific things they do well"],
    "patterns": ["2-3 specific patterns observed, with examples from their speech"]
}}"""

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=500,
        system="You are a professional speech coach writing your first impression of a new client. Be warm, specific, and actionable.",
        messages=[{"role": "user", "content": user_prompt}],
    )

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    response_text = response.content[0].text
    json_text = response_text
    if "```json" in json_text:
        json_text = json_text.split("```json")[1].split("```")[0]
    elif "```" in json_text:
        json_text = json_text.split("```")[1].split("```")[0]

    try:
        result = json.loads(json_text.strip())
    except json.JSONDecodeError:
        result = {
            "summary": response_text[:500],
            "focus_area": "Work on reducing filler words",
            "strengths": [],
            "patterns": [],
        }

    return {
        "summary": result.get("summary", ""),
        "focus_area": result.get("focus_area", ""),
        "strengths": result.get("strengths", []),
        "patterns": result.get("patterns", []),
    }
