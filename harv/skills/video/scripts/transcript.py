"""A video's transcript from its subtitles, saved as Markdown: title, channel, length, chapters
and the spoken text with [mm:ss] marks. No video is downloaded, nothing is logged in to.

Uses yt-dlp from ~/.harv/tools/yt-dlp (a venv: `python -m venv ~/.harv/tools/yt-dlp` then
`pip install yt-dlp` in it). One subtitle track is fetched: the video's own subtitles in the first
wanted language, else YouTube's automatic captions in the spoken language, else automatic ones
translated to the first wanted language. Fetching many tracks at once gets refused (HTTP 429).

  python transcript.py <url> [--lang sk,en] [--out-dir ~/.harv/workspace/videos]
Prints the saved file's path and its size; read the file for the text.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HOME = Path.home()
TOOL = HOME / ".harv" / "tools" / "yt-dlp" / ("Scripts/yt-dlp.exe" if os.name == "nt" else "bin/yt-dlp")


def run(args: list[str]) -> str:
    if not TOOL.exists():
        sys.exit(f"yt-dlp isn't installed at {TOOL}: make the venv and pip install yt-dlp there (ask the user once).")
    p = subprocess.run([str(TOOL), "--no-progress", "--no-warnings", *args], capture_output=True, text=True, encoding="utf-8")
    if p.returncode != 0:
        sys.exit(f"yt-dlp failed: {p.stderr.strip().splitlines()[-1] if p.stderr.strip() else p.returncode}")
    return p.stdout


def pick(info: dict, langs: list[str]) -> tuple[str, bool] | None:
    """(language code, automatic?) of the best track."""
    subs = {k: v for k, v in (info.get("subtitles") or {}).items() if k != "live_chat"}
    auto = info.get("automatic_captions") or {}
    for lang in langs:
        for code in subs:
            if code == lang or code.startswith(f"{lang}-"):
                return code, False
    if subs:
        return next(iter(subs)), False
    orig = next((c for c in auto if c.endswith("-orig")), None)
    if orig:
        return orig, True
    for lang in langs:
        if lang in auto:
            return lang, True
    return None


def clean_vtt(text: str) -> list[tuple[float, str]]:
    """Cues as (start seconds, text), with the rolling repeats of automatic captions removed."""
    out: list[tuple[float, str]] = []
    last = ""
    # Cues end at a truly empty line: automatic captions have lines of one space inside a cue.
    for block in re.split(r"\n\n+", text.replace("\r\n", "\n")):
        m = re.search(r"(\d+):(\d\d):(\d\d)\.\d+\s+-->", block)
        if not m:
            continue
        start = int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3])
        lines = block.split("\n")[1 + next(i for i, l in enumerate(block.split("\n")) if "-->" in l) :]
        for line in lines:
            line = html.unescape(re.sub(r"<[^>]+>", "", line)).strip()
            if line and line != last:
                out.append((start, line))
                last = line
    return out


def stamp(s: float) -> str:
    s = int(s)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url")
    ap.add_argument("--lang", default="sk,en", help="wanted languages, first is preferred")
    ap.add_argument("--out-dir", default=str(HOME / ".harv" / "workspace" / "videos"))
    args = ap.parse_args()
    langs = [l.strip() for l in args.lang.split(",") if l.strip()]

    info = json.loads(run(["-J", "--skip-download", args.url]))
    track = pick(info, langs)
    head = [
        f"# {info.get('title', 'Untitled')}",
        "",
        f"- Channel: {info.get('channel') or info.get('uploader') or '?'}",
        f"- Length: {stamp(info.get('duration') or 0)}",
        f"- Uploaded: {info.get('upload_date', '?')}",
        f"- Link: {info.get('webpage_url', args.url)}",
    ]
    chapters = info.get("chapters") or []
    if chapters:
        head += ["", "## Chapters", ""] + [f"- [{stamp(c['start_time'])}] {c.get('title', '')}" for c in chapters]
    if track is None:
        body = ["", "No subtitles or automatic captions on this video: a transcript needs listening to it (speech to text)."]
    else:
        code, automatic = track
        with tempfile.TemporaryDirectory() as tmp:
            run(["--skip-download", "--write-auto-subs" if automatic else "--write-subs", "--sub-langs", code, "--sub-format", "vtt",
                 "-o", os.path.join(tmp, "v.%(ext)s"), args.url])
            files = list(Path(tmp).glob("*.vtt"))
            if not files:
                sys.exit("yt-dlp fetched no subtitle file.")
            cues = clean_vtt(files[0].read_text(encoding="utf-8"))
        body = ["", f"## Transcript ({code}, {'automatic captions' if automatic else 'subtitles'})", ""]
        para, para_start = [], None
        for start, line in cues:
            if para_start is None:
                para_start = start
            para.append(line)
            if start - para_start >= 30 and line.endswith((".", "?", "!")) or start - para_start >= 60:
                body.append(f"[{stamp(para_start)}] {' '.join(para)}")
                para, para_start = [], None
        if para:
            body.append(f"[{stamp(para_start or 0)}] {' '.join(para)}")
    os.makedirs(args.out_dir, exist_ok=True)
    path = Path(args.out_dir) / f"{info.get('id', 'video')}.md"
    path.write_text("\n".join(head + body) + "\n", encoding="utf-8", newline="\n")
    words = sum(len(l.split()) for l in body)
    print(f"{path}  ({words} words{', ' + str(len(chapters)) + ' chapters' if chapters else ''})")


if __name__ == "__main__":
    main()
