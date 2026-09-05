# Video-analysis runtime

ChannelGate's conversation image supplies this capability organization-wide:

- `ffmpeg` and `ffprobe` for probing, audio, and targeted frame extraction;
- Python 3.11+;
- pinned `opencv-python-headless` for scene-change analysis, frame extraction, and contact sheets;
- pinned `faster-whisper` with a pre-cached Whisper `small` model for local timestamped speech
  recognition (`int8` on CPU, voice-activity filtering enabled).

Use `small` for routine Romanian/English screen recordings. Use `medium` only when the accuracy
gain matters enough to justify extra latency. The analyzer still produces visual artifacts when
faster-whisper is unavailable and records why transcription was skipped. If OpenCV is unavailable,
stop and report the missing image dependency rather than pretending to inspect the video.

Dependencies belong in the versioned ChannelGate container image, never in a channel's user
directory. Repair them through the gateway image build/update process. Do not install packages
inside a conversation merely to work around a broken image.
