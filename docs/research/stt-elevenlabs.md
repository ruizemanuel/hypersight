# ElevenLabs realtime speech-to-text (Scribe v2 Realtime) — reference

Fetched 2026-11-20 from the official docs (AsyncAPI reference + server-side streaming guide + commit strategies guide):
- https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime.md
- https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/server-side-streaming.md
- https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies.md

**Why ElevenLabs:** the builder already has an account; it accepts the G2 mic format natively (`pcm_16000` = 16 kHz s16le mono) and its **manual commit** maps exactly onto push-to-talk (commit on release → final transcript). Deepgram (nova-3) remains a drop-in fallback behind the same `SttStream` interface.

## Connection

- URL: `wss://api.elevenlabs.io/v1/speech-to-text/realtime`
- Query we use: `model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=manual&language_code=en` (+ `keyterms`, see below). `model_id` enum: `scribe_v2_realtime` (default), `scribe_v3_live` (guide examples use v3; `turn_prediction` commit strategy is v3-only).
- Server-side auth: header **`xi-api-key: <ELEVENLABS_API_KEY>`** on the handshake (`ws` `headers` option). Client-side alternative: `token` query param from the single-use token endpoint (not needed; key stays on our server).
- Other params (unused for now): `secondary_languages`, `vad_threshold`, `vad_silence_threshold_secs` (0.192–3.0), `min_speech_duration_ms`, `min_silence_duration_ms`, `include_timestamps`, `include_language_detection`, `no_verbatim`, `multilang_mode`, `diarize`, `entity_detection`, `entity_redaction`, `filter_background_audio` (not with timestamps), `keepalive_interval_ms` (500–10000), `enable_logging` (false = enterprise only).

## Client → server

Only `input_audio_chunk` (required: `message_type`, `audio_base_64`, `commit`, `sample_rate`; optional `previous_text` on the first chunk only, ≤ ~50 chars):

```json
{"message_type":"input_audio_chunk","audio_base_64":"<base64 PCM>","commit":false,"sample_rate":16000}
```

Manual commit at end of speech (empty chunk):

```json
{"message_type":"input_audio_chunk","audio_base_64":"","commit":true,"sample_rate":16000}
```

- Recommended chunk length **0.1–1 s** (16 kHz s16le: 3,200–32,000 bytes). Re-chunk G2 frames to ≥ 100 ms.
- Wait for `session_started` before sending audio (buffer meanwhile).
- Close: just close the socket (no close message documented).
- A commit clears the accumulated segment; many commits in quick succession degrade quality. Manual mode auto-commits after ~36 s of audio.

## Server → client

- `session_started` `{session_id, config{…echo…}}` — first message.
- `partial_transcript` `{text}` — also used as keepalive (empty or repeated text).
- `committed_transcript` `{text}` — the final for a commit.
- `committed_transcript_with_timestamps` (only with `include_timestamps=true`).
- Errors, all shaped `{"message_type":"<type>","error":"…"}`: `error`, `auth_error`, `quota_exceeded`, `commit_throttled`, `unaccepted_terms`, `rate_limited`, `queue_overflow`, `resource_exhausted`, `session_time_limit_exceeded`, `input_error`, `invalid_request`, `chunk_size_exceeded`, `insufficient_audio_activity`, `transcriber_error`. Warning: `{"message_type":"warning","warning":"…"}`. Handle any `error`-bearing message generically.

## Limits and unknowns

- **"Transcript processing starts after the first 2 seconds of audio."** Risk for 1–2 s commands: live partials may appear late; the committed final should still arrive after the commit. **Spike:** measure release → `committed_transcript` latency and partial timing for short commands; if poor, switch to the Deepgram fallback.
- With `keepalive_interval_ms` set and no client messages, the server closes after 15 s (not configurable).
- `keyterms`: supported (query array, echoed in `session_started.config`); max count/length and the exact query encoding are UNKNOWN (third-party tables say ≤ 50 terms × 20 chars for realtime; a 20% price premium is mentioned for keyterms). **Spike:** try repeated `keyterms=ETH&keyterms=BTC`.
- Max session duration, rate limits, pricing and free-plan availability: UNKNOWN on these pages ("all audio you stream is billed"). The builder must confirm their plan has STT credits; expected usage is well under an hour in total.
