# Resolve scripting: what works, how, and the traps

Tested through the bridge on **free DaVinci Resolve 21.1** (Windows, and Linux in a container, 2026-11-05). The full typed API is `DaVinciResolveScript.pyi` next to Resolve's scripting README (`C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\`); grep it for a call's exact name and arguments. Python names there are the same in Lua (`obj:Method(...)`, Python lists → Lua `{ ... }`, dicts → `{ Key = value }`).

## Finding things

- Project: `pm:GetProjectListInCurrentFolder()`, `pm:LoadProject(name)`, `project:GetName()`. `pm:SaveProject()` saves the current project (Ctrl+S).
- Timeline: `project:GetTimelineCount()`, `project:GetTimelineByIndex(i)`, `project:SetCurrentTimeline(tl)`; settings with `timeline:GetSetting("timelineFrameRate")`, `"timelineResolutionWidth"`/`"Height"`.
- Clips on a track: `timeline:GetItemListInTrack("video"|"audio"|"subtitle", n)`; each item `:GetName()`, `:GetStart()`, `:GetEnd()`, `:GetDuration()`, `:GetMediaPoolItem()`. Track counts: `timeline:GetTrackCount("video")`.
- **The clip under the playhead**: `timeline:SetCurrentTimecode("01:00:30:00")` then `timeline:GetCurrentVideoItem()`. Pick the item you mean this way (or by name and start), never as "the first item of V1": a title or a cut may be first.
- Media pool: `mediaPool:GetRootFolder():GetClipList()`, `clip:GetClipProperty("File Path"|"Type"|"FPS"|"Resolution"|"Video Codec")`.
- Pages: `resolve:GetCurrentPage()`, `resolve:OpenPage("edit"|"color"|"fusion"|"deliver"|…)`.

## Seeing the picture

`project:ExportCurrentFrameAsStill(path .. ".png")` writes the frame under the playhead as the viewer shows it, grade included (a 1920×1080 PNG of the timeline). It works from the Color page (`resolve:OpenPage("color")` first; on the Deliver page it returns `false`). Read it to check a grade, a title or a cut by eye. Downscale big ones before reading.

## Linux (the notebook): ffmpeg in, ffmpeg out

Resolve runs there in the `davincibox` toolbox container (tested 2026-11-05 on the AMD iGPU, 21.1.0.17 like the PC). Free Resolve on Linux reads no H.264/H.265 and no AAC: a phone clip imports as **audio only**. Its renders offer ProRes and DNxHR in `.mov`, no H.264/H.265.

- **In:** convert first, then import the converted file: `ffmpeg -i clip.mp4 -c:v dnxhd -profile:v dnxhr_sq -pix_fmt yuv422p -c:a pcm_s16le "clip (Resolve).mov"` next to the original (about 1.1 GB per minute at 1080p30; 10 s took 3.7 s). Say how big they'll get before converting a lot.
- **Out:** render with the "ProRes 422 HQ" preset (or a DNxHR codec), then `ffmpeg -i render.mov -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart render.mp4`.
- **Where:** renders go to `~/Videos/Harv` (a render into `~/.harv/…` was refused with "render path inaccessible", a dialog the user had to close).
- The client starts Resolve through the container and types the Console line with KWin and a virtual keyboard (`console_linux.py`); the first start shows a welcome screen only the user clicks through.

## Editing (tested)

- Import: `mediaPool:ImportMedia({ path, … })` → list of media pool items (an `.srt` comes in as type `Subtitle`).
- New timeline from clips: `mediaPool:CreateTimelineFromClips(name, { clip, … })`.
- Append: `mediaPool:AppendToTimeline({ clip, … })` (the plain form).
- Copy a timeline: `timeline:DuplicateTimeline(name)`, then `project:SetCurrentTimeline(original)` so the work goes on in the original.
- Tracks: `timeline:AddTrack("video"|"audio"|"subtitle")`.
- Markers: `timeline:AddMarker(frame, "Blue", name, note, duration)` (frame relative to the timeline start); `item:SetClipColor("Orange")`.
- Export the edit: `timeline:Export(path, resolve.EXPORT_FCPXML_1_10, resolve.EXPORT_NONE)` (also EDL, AAF, OTIO; see the README's Export section).
- Not tested yet: cutting by in/out (`AppendToTimeline` with `{ mediaPoolItem, startFrame, endFrame }`), `timeline:DeleteClips`, `DetectSceneCuts`. Test such a call on a "(before Harv)" copy and check by reading the track back.

## Subtitles

- From an `.srt`: `ImportMedia` it, then `AppendToTimeline({ srtItem })` with the timeline current: the lines land on the subtitle track at their times (read back with `GetItemListInTrack("subtitle", 1)`; each item's name is its text). Write the `.srt` yourself (UTF-8, `HH:MM:SS,mmm --> HH:MM:SS,mmm`) from the user's text or a transcript (the `video` skill makes transcripts of online videos).
- Automatic subtitles from the audio (`CreateSubtitlesFromAudio`) are **Studio only** (see below).

## Color (tested)

- CDL on a node: `item:SetCDL({ NodeIndex = "1", Slope = "r g b", Offset = "r g b", Power = "r g b", Saturation = "s" })` (strings; slope 1 / offset 0 / power 1 / saturation 1 = neutral). Shows in the exported still.
- LUT on a node: `item:SetLUT(1, "Blackmagic Design/<name>.cube")`, a path relative to Resolve's LUT folder (`C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\LUT`, list it to pick); `item:GetNodeGraph():GetLUT(1)` reads it back. In one test the exported still didn't change after a LUT: check LUTs with a still before reporting them done.
- Grades from a still: `item:ApplyGradeFromDRX(path, mode)` (not tested).

## Effects and titles (tested)

- A Fusion comp on a clip: `local comp = item:AddFusionComp()`, then tools like `comp:AddTool("TextPlus")` and inputs as fields (`tool.StyledText = "…"`). Connect a new tool into the flow (`tool.Input = other.Output` style, see Fusion's scripting docs) or it doesn't show.
- `timeline:InsertFusionTitleIntoTimeline("Text+")` puts the title **on V1 at the playhead and overwrites what's there** (it replaced the first 3 s of a clip in the test). Before using it, add a video track and make the place free, or put the title in a Fusion comp instead.

## Rendering (tested)

1. `project:LoadRenderPreset("H.264 Master")` (list: `project:GetRenderPresetList()`; YouTube/TikTok/Vimeo 720p–2160p, ProRes, Audio Only…).
2. `project:SetRenderSettings({ TargetDir = dir, CustomName = name, MarkIn = f1, MarkOut = f2 })` with `dir` = the user's `Videos/Harv` folder unless they name another (leave MarkIn/Out out for the whole timeline). A new `CustomName` each time: renders never overwrite.
3. `local job = project:AddRenderJob()`, then `project:StartRendering({ job }, false)`. Return right away.
4. Check from outside in later requests: `project:IsRenderingInProgress()`, `project:GetRenderJobStatus(job)` → `{ JobStatus = "Complete", CompletionPercentage = 100 }`. Then the file in `TargetDir` exists (H.264 Master writes `.mov`).
5. `project:DeleteRenderJob(job)` to keep the user's render queue clean.

Free renders are limited to UHD and 60 fps; more needs Studio.

## Studio only (each opens a blocking "limitation" dialog in free)

`CreateSubtitlesFromAudio` (auto captions), the AI tools (magic mask, voice isolation, noise reduction, super scale, smart reframe), renders above UHD or 60 fps. While that dialog is open every call returns nothing; the user clicks **Not Yet**. Offer the free route: an `.srt` Harv writes, a plain render size.

## Crash patterns (avoid)

One request crashed free 21.1 (`0xc0000409` in ucrtbase). It did two things never used since: `AppendToTimeline` with a clip-info table carrying `mediaType = 0` for a subtitle item, and a `while project:IsRenderingInProgress() do bmd.wait(0.5) end` loop inside the request. Use the plain append form and check renders from outside (steps above).
