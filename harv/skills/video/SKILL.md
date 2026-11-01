---
name: video
description: Get what a video says without watching it: summary, notes, key points with timestamps, or an answer from it. Use when the user shares a YouTube (or other video site) link, or asks about a video's content.
---

# Video

Most videos already carry their words: subtitles, or YouTube's automatic captions. Harv reads those, so a 40-minute video becomes a page of text in seconds, without downloading the video and without logging in anywhere.

Say in a few words that you're using it ("using video").

## 1. Get the transcript

`python <this skill>/scripts/transcript.py "<url>" --lang sk,en` (on Linux `python3`). `<this skill>` is the folder this file is in (`~/.claude/skills/video`).

- It saves `~/.harv/workspace/videos/<id>.md` (title, channel, length, upload date, chapters, the text in paragraphs with `[mm:ss]` marks) and prints its path and word count. Read that file.
- `--lang`: the languages wanted, first preferred. It takes the video's own subtitles in a wanted language, else the automatic captions in the language spoken, else automatic captions translated to the first wanted language. For a Slovak or Czech video put `sk` or `cs` first; for most others `en`.
- yt-dlp lives in `~/.harv/tools/yt-dlp` (a venv). If the script says it's missing, ask the user once whether to install it (`python -m venv ~/.harv/tools/yt-dlp` then its pip `install yt-dlp`): it's free and needs no account. If YouTube starts refusing (errors about sign-in, 429 "too many requests", a format change), update it with that venv's pip (`install -U yt-dlp`) and try again once; then say plainly what YouTube answered.
- No subtitles at all: say so. Listening to the audio (speech to text) isn't set up yet.

**Done when** the transcript file exists and you've read it all (for a long one, chapter by chapter).

## 2. Answer from it

Give what was asked, from the transcript only:

- **Summary**: what the video is about in two or three sentences, then the main points in order, each with its `[mm:ss]` so the user can jump there.
- **Notes or steps** (a tutorial, a recipe, a repair): the steps in order with the values said (amounts, settings, part numbers), and the timestamps of the parts worth seeing (where something is shown, not said).
- **A question about it**: the answer, with the timestamp where it's said; if the video doesn't say, say so.

Automatic captions mishear names, numbers and technical words: when one matters (a part number, a price, a dosage), flag that it comes from automatic captions and give the timestamp to check it. Opinions in the video are the speaker's: keep them apart from facts. Answer in the user's language whatever the video's language.

The file stays in the workspace, so a follow-up question reads it again instead of fetching the video again.
