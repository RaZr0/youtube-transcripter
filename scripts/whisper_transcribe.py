#!/usr/bin/env python3
"""Transcribe one audio file with faster-whisper and print the result as JSON on stdout.

Called by the app for videos that have no YouTube captions. Progress goes to stderr.

    python3 scripts/whisper_transcribe.py audio.m4a --model auto --device auto
"""

import argparse
import json
import sys


def pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import ctranslate2

        return "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    except Exception:
        return "cpu"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", default="auto", help="auto, tiny, base, small, medium, large-v3, large-v3-turbo, ...")
    parser.add_argument("--device", default="auto", help="auto, cpu or cuda")
    parser.add_argument("--language", default=None, help="ISO 639-1 code; omit to auto-detect")
    parser.add_argument("--model-dir", default=None, help="where models are downloaded/cached")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed (pip install faster-whisper)", file=sys.stderr)
        return 3

    device = pick_device(args.device)
    # A GPU makes the most accurate model fast; on CPU "small" is the best speed/accuracy trade-off.
    model_name = args.model if args.model != "auto" else ("large-v3-turbo" if device == "cuda" else "small")
    compute_type = "float16" if device == "cuda" else "int8"

    print(f"loading {model_name} on {device} ({compute_type})", file=sys.stderr, flush=True)
    model = WhisperModel(model_name, device=device, compute_type=compute_type, download_root=args.model_dir)

    language = (args.language or "").split("-")[0] or None
    segments, info = model.transcribe(args.audio, language=language, vad_filter=True, beam_size=5)

    out = []
    for segment in segments:  # a generator: transcription happens while iterating
        out.append({"start": round(segment.start, 2), "end": round(segment.end, 2), "text": segment.text.strip()})
        if info.duration:
            print(f"progress {min(100, round(segment.end / info.duration * 100))}%", file=sys.stderr, flush=True)

    json.dump({"language": info.language, "model": model_name, "duration": info.duration, "segments": out}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
