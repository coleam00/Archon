"""Turn Cartesia word timings into karaoke-style ASS captions.

Words are grouped into short chunks; every word gets its own event showing the
whole chunk with the active word highlighted. That is the read-along look
short-form viewers expect, and it comes straight from the TTS timings.

Reads  : words.json, brief.json (optional caption_style)
Writes : captions.ass
"""

from __future__ import annotations

import re

from _common import read_json, work_dir

PLAY_W, PLAY_H = 1080, 1920
FONT = "Arial Black"
FONT_SIZE = 82
MARGIN_V = 520          # distance up from the bottom edge
MAX_WORDS_PER_CHUNK = 3
MAX_CHARS_PER_CHUNK = 18   # ~940px safe area at 82px Arial Black

WHITE = "&HFFFFFF&"
HIGHLIGHT = "&H00FFFF&"  # ASS inline colour is &HBBGGRR& -> this is yellow

HEADER = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {PLAY_W}
PlayResY: {PLAY_H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{FONT},{FONT_SIZE},&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,7,4,2,70,70,{MARGIN_V},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def fmt_time(seconds: float) -> str:
    """ASS timestamps are H:MM:SS.cc (centiseconds)."""
    seconds = max(0.0, seconds)
    cs = int(round(seconds * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def chunk_words(words: list[dict]) -> list[list[dict]]:
    """Group words into short, readable phrases that break on punctuation."""
    chunks: list[list[dict]] = []
    current: list[dict] = []
    length = 0
    for w in words:
        text = w["word"]
        if current and (
            len(current) >= MAX_WORDS_PER_CHUNK or length + len(text) + 1 > MAX_CHARS_PER_CHUNK
        ):
            chunks.append(current)
            current, length = [], 0
        current.append(w)
        length += len(text) + 1
        if re.search(r"[.!?,;:]$", text):
            chunks.append(current)
            current, length = [], 0
    if current:
        chunks.append(current)
    return chunks


def escape(text: str) -> str:
    return text.replace("\\", "").replace("{", "").replace("}", "")


def main() -> None:
    data = read_json("words.json")
    words = data["words"]
    if not words:
        raise SystemExit("words.json contains no timings")

    lines: list[str] = []
    chunks = chunk_words(words)
    for c, chunk in enumerate(chunks):
        # Never let a chunk's last word bleed past the next chunk's first word:
        # overlapping ASS events render stacked on top of each other.
        next_start = chunks[c + 1][0]["start"] if c + 1 < len(chunks) else None
        for i, active in enumerate(chunk):
            rendered = " ".join(
                (
                    f"{{\\c{HIGHLIGHT}}}{escape(w['word'].upper())}{{\\c{WHITE}}}"
                    if j == i
                    else escape(w["word"].upper())
                )
                for j, w in enumerate(chunk)
            )
            start = active["start"]
            if i + 1 < len(chunk):
                end = chunk[i + 1]["start"]
            else:
                # Hold the final word a beat so it doesn't flash away, but stop
                # before the next chunk appears.
                end = active["end"] + 0.12
                if next_start is not None:
                    end = min(end, next_start)
            if end <= start:
                end = start + 0.08
            lines.append(
                f"Dialogue: 0,{fmt_time(start)},{fmt_time(end)},Cap,,0,0,0,,{rendered}"
            )

    path = work_dir() / "captions.ass"
    path.write_text(HEADER + "\n".join(lines) + "\n")
    print(f"wrote {len(lines)} caption events")


if __name__ == "__main__":
    main()
