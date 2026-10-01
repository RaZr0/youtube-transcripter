"""Stand-in for faster-whisper used by tests: returns fixed segments without loading a model."""
from types import SimpleNamespace


class WhisperModel:
    def __init__(self, name, device="cpu", compute_type="int8", download_root=None):
        self.name = name

    def transcribe(self, path, language=None, vad_filter=False, beam_size=5):
        segments = [
            SimpleNamespace(start=0.0, end=2.5, text=" Hello there."),
            SimpleNamespace(start=2.5, end=5.0, text=" Second line. "),
        ]
        return iter(segments), SimpleNamespace(language=language or "en", duration=5.0)
