#!/usr/bin/env python3
"""Create a compact, timestamped visual/audio evidence pack from a video."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(2)


def timestamp(seconds: float) -> str:
    seconds = max(0.0, seconds)
    minutes, secs = divmod(seconds, 60)
    hours, minutes = divmod(int(minutes), 60)
    return f"{hours:02d}:{minutes:02d}:{secs:06.3f}"


def select_times(cv2, cap, duration: float, max_frames: int):
    if duration <= 0:
        return [(0.0, 0.0, "start")]

    scan_step = max(0.5, duration / 300.0)
    previous = None
    changes = []
    t = 0.0
    while t < duration:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            t += scan_step
            continue
        width = 320
        height = max(1, round(frame.shape[0] * width / frame.shape[1]))
        gray = cv2.cvtColor(cv2.resize(frame, (width, height)), cv2.COLOR_BGR2GRAY)
        score = 0.0 if previous is None else float(cv2.absdiff(gray, previous).mean())
        changes.append((score, t))
        previous = gray
        t += scan_step

    regular_slots = max(2, max_frames // 2)
    candidates = [(0.0, 0.0, "start")]
    for i in range(regular_slots):
        candidates.append((duration * i / max(1, regular_slots - 1), 0.0, "interval"))
    candidates.append((max(0.0, duration - 0.05), 0.0, "end"))
    for score, change_time in sorted(changes, reverse=True)[: max_frames * 2]:
        candidates.append((change_time, score, "visual-change"))

    min_gap = max(0.35, min(2.0, duration / (max_frames * 2)))
    chosen = []
    priority = {"start": 0, "interval": 1, "end": 1, "visual-change": 2}
    prioritized = sorted(candidates, key=lambda item: (priority[item[2]], -item[1]))
    for change_time, score, reason in prioritized:
        if all(abs(change_time - existing[0]) >= min_gap for existing in chosen):
            chosen.append((change_time, score, reason))
        if len(chosen) >= max_frames:
            break
    return sorted(chosen)


def extract_frames(cv2, cap, selected, frame_dir: Path):
    records, images = [], []
    for index, (seconds, score, reason) in enumerate(selected):
        cap.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
        ok, frame = cap.read()
        if not ok:
            continue
        name = f"frame-{index:03d}-{seconds:010.3f}s.jpg"
        target = frame_dir / name
        if not cv2.imwrite(str(target), frame, [cv2.IMWRITE_JPEG_QUALITY, 92]):
            fail(f"Could not write frame: {target}")
        records.append({
            "timestamp_seconds": round(seconds, 3),
            "timestamp": timestamp(seconds),
            "reason": reason,
            "visual_change_score": round(score, 3),
            "file": str(Path("frames") / name),
        })
        images.append(frame)
    return records, images


def write_contact_sheet(cv2, images, target: Path) -> None:
    if not images:
        return
    import numpy as np

    columns, cell_width = 3, 640
    thumbs = []
    for image in images:
        cell_height = max(1, round(image.shape[0] * cell_width / image.shape[1]))
        thumbs.append(cv2.resize(image, (cell_width, cell_height)))
    cell_height = max(image.shape[0] for image in thumbs)
    padded = []
    for image in thumbs:
        canvas = np.zeros((cell_height, cell_width, 3), dtype=np.uint8)
        canvas[: image.shape[0], : image.shape[1]] = image
        padded.append(canvas)
    while len(padded) % columns:
        padded.append(np.zeros_like(padded[0]))
    rows = [cv2.hconcat(padded[i : i + columns]) for i in range(0, len(padded), columns)]
    cv2.imwrite(str(target), cv2.vconcat(rows), [cv2.IMWRITE_JPEG_QUALITY, 88])


def transcribe(video: Path, model_name: str, language: str | None):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return {"status": "skipped", "reason": "faster-whisper is not installed", "segments": []}

    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        segments, info = model.transcribe(
            str(video), language=language, beam_size=5, vad_filter=True
        )
        items = [
            {"start": round(segment.start, 3), "end": round(segment.end, 3), "text": segment.text.strip()}
            for segment in segments
        ]
    except Exception as exc:
        return {"status": "skipped", "reason": f"transcription failed: {exc}", "segments": []}
    return {
        "status": "ok",
        "language": info.language,
        "language_probability": round(info.language_probability, 4),
        "segments": items,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--max-frames", type=int, default=24)
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default=None, help="ISO language code; auto-detect by default")
    parser.add_argument("--skip-transcription", action="store_true")
    args = parser.parse_args()

    if not args.video.is_file():
        fail(f"Video does not exist: {args.video}")
    if not 4 <= args.max_frames <= 100:
        fail("--max-frames must be between 4 and 100")
    try:
        import cv2
    except ImportError:
        fail("opencv-python-headless is required")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    frame_dir = args.output_dir / "frames"
    frame_dir.mkdir(exist_ok=True)

    cap = cv2.VideoCapture(str(args.video))
    if not cap.isOpened():
        fail(f"OpenCV could not decode: {args.video}")
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration = frame_count / fps if fps > 0 else 0.0

    selected = select_times(cv2, cap, duration, args.max_frames)
    frame_records, images = extract_frames(cv2, cap, selected, frame_dir)
    cap.release()
    write_contact_sheet(cv2, images, args.output_dir / "contact-sheet.jpg")

    transcript = (
        {"status": "skipped", "reason": "disabled by flag", "segments": []}
        if args.skip_transcription
        else transcribe(args.video, args.model, args.language)
    )
    (args.output_dir / "transcript.json").write_text(
        json.dumps(transcript, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    lines = [
        f"[{timestamp(item['start'])} - {timestamp(item['end'])}] {item['text']}"
        for item in transcript["segments"]
    ]
    (args.output_dir / "transcript.txt").write_text(
        "\n".join(lines) + ("\n" if lines else ""), encoding="utf-8"
    )

    manifest = {
        "source": str(args.video.resolve()),
        "duration_seconds": round(duration, 3),
        "fps": round(fps, 4),
        "frame_count": frame_count,
        "width": width,
        "height": height,
        "selected_frame_count": len(frame_records),
        "frames": frame_records,
        "transcription": {key: value for key, value in transcript.items() if key != "segments"},
    }
    (args.output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "output_dir": str(args.output_dir.resolve()),
        "duration_seconds": manifest["duration_seconds"],
        "selected_frames": len(frame_records),
        "transcription_status": transcript["status"],
        "transcript_segments": len(transcript["segments"]),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
