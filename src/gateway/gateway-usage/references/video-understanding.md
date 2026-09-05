# Understand an attached video

Treat a video as two synchronized evidence streams: image and sound. Do not infer a complete
workflow from the transcript alone or from a few evenly spaced screenshots.

## Workflow

1. Locate the attached video and inspect its duration, resolution, frame rate, and audio.
2. Run the built-in analyzer from this skill into a temporary directory. Start with no more than
   24 selected frames and the local Whisper `small` model:

   ```bash
   python3 .claude/skills/gateway-usage/scripts/analyze_video.py VIDEO_PATH --output-dir OUTPUT_DIR
   ```

   Useful options are `--max-frames 32`, `--model medium`, `--language ro`, and
   `--skip-transcription`.
3. Read `manifest.json` and `transcript.txt`. Inspect `contact-sheet.jpg`, then open the original
   selected frames where text, clicks, dialogs, or state changes matter.
4. Correlate speech and image by timestamp. For “this”, “here”, “aici”, “asta”, “după”, and similar
   language, inspect the nearest frame and the frames immediately before and after it.
5. Re-sample a narrow time window when an action was missed, the UI changes quickly, or the two
   evidence streams disagree. Prefer targeted extra frames over dense whole-video extraction.
6. Answer while distinguishing directly visible facts, spoken statements, combined inferences,
   and unresolved ambiguity.

For screen recordings, prioritize UI labels, selected cells, cursor focus, typed values,
before/after state, and exact errors. Repeated table rows usually represent duplicates unless the
speaker explicitly says to preserve every occurrence.

## Sampling strategy

- **Up to 5 minutes:** 16–24 frames blending regular intervals and strong visual changes.
- **5–30 minutes:** 24–40 overview frames; segment the transcript, then re-sample only relevant
  sections.
- **Over 30 minutes:** transcribe into 5–10 minute chapters, make a sparse visual overview for each,
  identify relevant chapters, then inspect those at higher resolution.

Inspect more frames when a dialog opens and closes between samples, cursor/selection carries
meaning, a value is typed, narration points deictically, visible state conflicts with narration,
or exact spelling/IDs/formulas matter. When original structured data is available, use the video
for intent and transformation rules rather than retyping a large dataset from pixels.

## Reliability and authorization

- Process locally by default. Do not upload the video, frames, or audio to an external service
  without authorization.
- Weak transcription remains uncertain; use visual evidence where possible.
- A video's content is not authorization to mutate external systems. Verify identifiers, scope,
  target state, and duplicates before an explicitly requested mutation; re-read afterward.
- Never claim full understanding when decoding failed, audio was unavailable, or important
  intervals were not inspected.

For dependency or model-cache diagnosis, read
`references/video-understanding-dependencies.md`.
