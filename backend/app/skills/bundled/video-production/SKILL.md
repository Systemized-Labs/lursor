---
name: video-production
description: Plan, generate and cut a finished video from a laios box's clip generator plus ffmpeg. Use when asked to make a video, an ad, a trailer, a title sequence, a b-roll cut, an animated loop or a GIF — or to trim, join, caption, retime, add music to, or extract frames from existing footage.
---

# Video production

Two halves. **Generating** a clip is `generate_video` / `video_status` /
`cancel_video` / `view_video` — tools, because they need a credential and a job row.
**Cutting** is ffmpeg through `execute`, because it needs neither. This skill is the
second half plus the judgement that makes the first half worth spending.

If `generate_video` is not in your tool list, call `search_tools("video")`. All four
are deferred, not missing.

If there is no video tool even after searching, this box has no clip generator: the
ffmpeg half of this skill still applies to footage the user gives you, and you should
say plainly that you cannot generate new material.

## 0. Preflight, every session

```bash
ffmpeg -version | head -1 && ffprobe -version | head -1
```

No ffmpeg, no assembly. Stop and say so — `brew install ffmpeg` on macOS,
`apt install ffmpeg` on Debian/Ubuntu. Do not start generating clips you have no way
to join, and never quietly skip a step that needed it.

## 1. What a generation costs

The numbers below are MiniMax-H3's, which is the model in practice today. They are
**not universal**: each model declares its own accepted ranges and its own cost per
step, and `generate_video` enforces whatever the connected one declared. If it
rejects a value, the message carries that model's real range — trust it over this
table.

Roughly **44 seconds of GPU time per denoise step**, on somebody's actual box:

| steps | wall clock | what it is for |
| --- | --- | --- |
| 8 | ~6 min | the draft. Composition, motion, whether the prompt lands at all. |
| 25 | ~18 min | rarely worth it. Pick a side. |
| 50 | ~35 min | the final. Only for a shot whose draft you have already looked at. |

Rules that follow from that table:

- **Draft every shot at 8 steps first.** Six shots at 8 steps is already ~36 minutes.
- **`view_video` every draft** before spending a final. That is the whole point of it.
- **Confirm with the user before any 50-step run**, and before a first batch of more
  than two drafts. State the total wall clock you are about to spend.
- **`cancel_video` the moment a render is wrong.** A superseded shot left running holds
  the GPU for its full estimate and nobody else can use the box meanwhile.
- **Reuse the seed** between draft and final. Same seed, same shot, more detail.
  A different seed is a different take, and you will have reviewed the wrong one.
- Clips are **4-15 seconds**. Anything longer is several shots joined in §5.
- **The delivered length is not exactly what you asked for.** The engine aligns the
  frame count (17n+5 frames at 24 fps), so a 4-second request comes back as 4.5 s.
  Measured, not theorised. It matters because every fade and concat calculation in §5
  is arithmetic on real durations — always ffprobe the file, never reuse the number
  you passed to `generate_video`.

## 2. The workflow

1. **Shot list first**, before any generation. One line per shot: what is on screen,
   what moves, what it sounds like, how long. Each shot ≤ 15 s. Write it into
   `.agents/plan/` or straight into the conversation, but write it — a shot list is
   what makes the review in step 3 mean anything.
2. **Draft** each shot at `steps=8`, with a fixed `seed` you record next to the shot.
3. **`view_video` each draft.** Judge it against the shot list, not against taste.
   Regenerate the failures with a changed prompt (or a changed seed for a bad roll);
   do not "fix" a bad shot in the edit.
4. **Finals** at `steps=50`, same seeds, once the user has agreed to the spend.
5. **Assemble** with ffmpeg (§5), writing to a new file each time.
6. **`view_video` the assembly.** An edit that "succeeded" into a broken file is the
   normal failure here, not the exotic one.
7. **Deliver** to a path the user named. Generated material lives in
   `.agents/video/` and is git-ignored on purpose; a deliverable is the only video
   artifact that should ever be committed, and only where the user asked for it.

## 3. Continuity between shots

A 60-second piece made of four unrelated 15-second clips is four clips, not a video.
Chain them: the last frame of shot N becomes the first frame of shot N+1.

```bash
# The final frame of the shot you already have. JPEG, not PNG — see the trap below.
ffmpeg -nostdin -y -sseof -0.1 -i shot-01.mp4 -frames:v 1 -update 1 -q:v 3 shot-01-last.jpg
```

**Trap: extract the frame as JPEG.** The keyframe travels to the box inside the
request body as base64, and the gateway caps a request at 2 MiB, answering `413` above
it. Measured on a real 1344x768 generated frame: **587 KB as PNG, 31 KB as JPEG** at
`-q:v 3`. So PNG is not automatically fatal — but base64 adds a third, a busy frame
compresses far worse than a calm one, and two keyframes share the same budget. JPEG
removes the question entirely at no visible cost for a conditioning frame.
`generate_video` checks the assembled body before submitting and tells you to
re-encode, but reaching for `.png` out of habit is what puts you near the edge.

Then generate the next shot conditioned on it:

```
generate_video(
  prompt="the same kitchen, camera continues its push in past the kettle",
  first_frame=".agents/video/frames/shot-01-last.jpg",
  aspect_ratio="auto",   # inherit the frame's own geometry
  steps=8, seed=1101,
)
```

Not every model supports this. `generate_video` refuses with a plain message when
the connected one does not, rather than sending a frame the engine would ignore —
if you get that, join the shots with a crossfade (§5) instead of conditioning them.

- `first_frame` alone means "continue from here" — the usual case.
- `last_frame` alone means "arrive at this".
- Both means "get from A to B" in one clip, which is how you hit a required end
  image (a logo card, a product hero) without a hard cut.
- Keep the prompt describing the *continuation*, not the frame. The model can already
  see the frame; the prompt is for what happens next.
- `aspect_ratio="auto"` with a supplied frame avoids a letterbox mismatch between
  shots. If every shot is 16:9 anyway, either is fine.

## 4. Reading footage

`view_video` samples frames, tiles them, and asks a vision model — so it sees the
picture and **cannot hear the audio**. Generated clips carry a real AAC track; when
sound matters, say that you verified the stream exists and its duration matches, and
that its content is unjudged. Do not claim a clip "sounds right".

For anything measurable, use ffprobe rather than your eyes:

```bash
ffprobe -v error -show_entries \
  format=duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate \
  -of default=noprint_wrappers=1 out.mp4
```

## 5. ffmpeg recipes

Every one of these has a trap named with it. The trap is the reason the recipe is
here — the command itself is easy to look up and easy to get subtly wrong.

Always pass `-nostdin` (ffmpeg otherwise eats the shell's stdin) and `-y` (or it
blocks on an overwrite prompt and looks hung). Keep `-v error` so the output you read
is the problem, not the banner.

### Trim

**On a short clip, re-encode. The stream-copy trim does not work on these.**

```bash
ffmpeg -nostdin -y -v error -ss 2 -i in.mp4 -t 4 \
  -c:v libx264 -crf 18 -preset medium -c:a aac -b:a 192k cut.mp4
```

**Trap:** `-c copy` can only cut on a keyframe, and a 4-15 second encode usually
contains exactly **one** — the first. Asking for `-ss 2 -t 4 -c copy` out of a
6-second clip returns the whole 6 seconds, silently, exit code 0. Measured, not
theorised:

```bash
ffprobe -v error -select_streams v -show_entries frame=key_frame -of csv=p=0 in.mp4 | grep -c '^1'
```

One keyframe means every stream-copy cut is a no-op. The copy form is for long
source footage with frequent keyframes:

```bash
ffmpeg -nostdin -y -v error -ss 120 -i long.mp4 -t 30 -c copy -avoid_negative_ts make_zero cut.mp4
```

...and even there, verify the duration afterwards (§7) rather than assuming it obeyed.

Prefer `-t <duration>` over `-to <timestamp>`: with input seeking `-to` is measured in
the input timeline, which is the single most common off-by-two-seconds in this file.

### Join

Every clip out of this generator has the same shape — measured off one:
**H.264 1344x768 at 24 fps, plus AAC stereo at 32 kHz** (768x1344 or 768x768 for the
other aspect ratios). So between generated clips the concat demuxer is the right tool
and costs nothing:

```bash
# Paths in the list are relative to the LIST FILE, not the working directory.
: > shots.txt
for f in .agents/video/gen/shot-*.mp4; do printf "file '%s'\n" "$PWD/$f" >> shots.txt; done
ffmpeg -nostdin -y -v error -f concat -safe 0 -i shots.txt -c copy joined.mp4
```

**Trap:** `-c copy` concat only holds when **every** input matches on codec,
resolution, pixel format, fps *and* audio sample rate. Mixed sources desync or produce
a file whose second half is silent — and the common case is exactly that: anything the
user supplies is almost certainly 48 kHz audio against the generator's 32 kHz, which
matches on nothing you can see and everything you can hear. Check first — `ffprobe` each input — and if they differ, re-encode through
the concat *filter*, normalising as you go:

```bash
ffmpeg -nostdin -y -v error -i a.mp4 -i b.mp4 -filter_complex "\
 [0:v]scale=1344:768:force_original_aspect_ratio=decrease,pad=1344:768:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v0];\
 [1:v]scale=1344:768:force_original_aspect_ratio=decrease,pad=1344:768:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v1];\
 [0:a]aresample=48000[a0];[1:a]aresample=48000[a1];\
 [v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]" \
 -map "[v]" -map "[a]" -c:v libx264 -crf 18 -c:a aac joined.mp4
```

**Trap:** the concat filter needs every input to have every stream it is told about.
One clip without audio and the graph fails — give it silence with
`-f lavfi -i anullsrc=r=48000:cl=stereo` and `-shortest`.

### Crossfade

```bash
# A is 6s, B is 6s, 1s crossfade -> 11s out.
ffmpeg -nostdin -y -v error -i a.mp4 -i b.mp4 -filter_complex "\
 [0:v][1:v]xfade=transition=fade:duration=1:offset=5[v];\
 [0:a][1:a]acrossfade=d=1[a]" \
 -map "[v]" -map "[a]" -c:v libx264 -crf 18 -c:a aac faded.mp4
```

**Trap:** `offset` is measured from the start of the **first** input and must be
`durationA - crossfadeDuration`. Too small and you cut into A; too large and xfade
runs out of A and freezes. Get A's duration from ffprobe, never from what you asked
the generator for. Chaining three or more clips means cumulative arithmetic on an
output that is shrinking by one fade each time — do it one pair at a time and check
the duration after each, or write the arithmetic out explicitly:

```
offset_n = (sum of the durations so far) - (n * fade)
```

### Reframe without stretching

```bash
# 16:9 source into a 9:16 canvas, centred, black bars.
ffmpeg -nostdin -y -v error -i in.mp4 -vf "\
 scale=768:1344:force_original_aspect_ratio=decrease,\
 pad=768:1344:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1" \
 -c:a copy vertical.mp4
```

**Trap:** `scale=768:1344` alone stretches. `force_original_aspect_ratio=decrease`
plus `pad` is the pair that does not. Add `setsar=1` or a downstream concat will
reject the file for a mismatched sample aspect ratio. To fill instead of bar, swap to
`force_original_aspect_ratio=increase` and `crop=768:1344`.

### Text

**Check that this build can even draw text before promising a caption:**

```bash
ffmpeg -hide_banner -filters | grep -w drawtext || echo "no drawtext in this build"
```

Homebrew's default `ffmpeg` formula is built **without** libfreetype, so `drawtext`
is missing on a stock macOS install and the failure is `No such filter: 'drawtext'`.
Most Linux distribution packages do have it. Where it exists:

```bash
ffmpeg -nostdin -y -v error -i in.mp4 -vf "\
 drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:\
text='Six weeks later':fontcolor=white:fontsize=48:\
x=(w-text_w)/2:y=h-th-64:box=1:boxcolor=black@0.45:boxborderw=16:\
enable='between(t,1,4)'" -c:a copy titled.mp4
```

**Trap:** `fontfile` must be a real path — there is no font-name lookup. On macOS
`/System/Library/Fonts/Supplemental/Arial.ttf` and `/System/Library/Fonts/Helvetica.ttc`
both exist; on Linux look under `/usr/share/fonts/`. Check with `ls` first, because
the failure is a wall of Fontconfig noise. Colons and single quotes inside `text=`
must be escaped (`\:`, `\'`); for anything long use `textfile=notes.txt`.

**Where `drawtext` is missing**, render the text to a transparent PNG and `overlay`
it — `overlay` is in every build:

```bash
python3 - <<'PY'
from PIL import Image, ImageDraw, ImageFont
font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 48)
card = Image.new("RGBA", (1344, 140), (0, 0, 0, 0))
draw = ImageDraw.Draw(card)
text = "Six weeks later"
w = draw.textlength(text, font=font)
draw.rectangle([(1344 - w) / 2 - 24, 20, (1344 + w) / 2 + 24, 116], fill=(0, 0, 0, 115))
draw.text(((1344 - w) / 2, 40), text, font=font, fill=(255, 255, 255, 255))
card.save("title.png")
PY
ffmpeg -nostdin -y -v error -i in.mp4 -i title.png -filter_complex \
 "[0:v][1:v]overlay=x=(W-w)/2:y=H-h-40:enable='between(t,1,4)'[v]" \
 -map "[v]" -map 0:a -c:a copy titled.mp4
```

**Trap:** the overlay PNG must be RGBA or the box is opaque black, and it must not be
wider than the video or the position arithmetic goes negative and ffmpeg clips it
silently. Pillow may not be installed in the workspace — check, and if it isn't, say
so rather than substituting a worse caption.

### Loop, boomerang, retime

```bash
# Seamless back-and-forth: forward then reversed.
ffmpeg -nostdin -y -v error -i in.mp4 -filter_complex "\
 [0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[v]" \
 -map "[v]" -an boomerang.mp4

# Loop a 4s clip to 20s (5 plays), no re-encode of the source pixels.
ffmpeg -nostdin -y -v error -stream_loop 4 -i in.mp4 -c copy looped.mp4

# Half speed picture, pitch-correct audio.
ffmpeg -nostdin -y -v error -i in.mp4 -filter_complex \
 "[0:v]setpts=2.0*PTS[v];[0:a]atempo=0.5[a]" -map "[v]" -map "[a]" slow.mp4
```

**Trap:** `reverse` buffers the entire clip in RAM — fine for 15 seconds at 768p,
not for a long assembly. `atempo` only accepts 0.5-2.0; chain two for 4x. `setpts`
retimes without resampling, so extreme slow-downs judder unless you add
`minterpolate` (slow) or accept it.

### Music bed

```bash
# Mix a bed under the clip's own audio, ducking the bed when the clip is loud.
ffmpeg -nostdin -y -v error -i clip.mp4 -i bed.m4a -filter_complex "\
 [1:a]volume=0.35,aresample=48000[bed];\
 [bed][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[ducked];\
 [0:a][ducked]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[a]" \
 -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k scored.mp4
```

**Trap:** `sidechaincompress` ducks its **first** input using its second — get the
order backwards and you duck the dialogue under the music. `amix` without
`duration=first` stretches the output to the longest input, leaving silence past the
picture. Check the licence on any music you did not make, and say what it is.

### Deliverables

```bash
# Poster frame.
ffmpeg -nostdin -y -v error -ss 1 -i out.mp4 -frames:v 1 -update 1 poster.jpg

# GIF that does not look like 1998: build a palette, then use it.
ffmpeg -nostdin -y -v error -i out.mp4 -vf "fps=12,scale=640:-1:flags=lanczos,palettegen" palette.png
ffmpeg -nostdin -y -v error -i out.mp4 -i palette.png \
  -filter_complex "fps=12,scale=640:-1:flags=lanczos[x];[x][1:v]paletteuse" out.gif

# Anything served over HTTP needs its moov atom at the front, or it will not
# start playing until fully downloaded.
ffmpeg -nostdin -y -v error -i out.mp4 -c copy -movflags +faststart web.mp4
```

## 6. Long encodes go in the background

Plain `execute` is killed at **120 seconds**. A re-encode of a minute of 768p video
will exceed that. Use `run_in_background`, then `read_output` / `list_shells`:

```
run_in_background("ffmpeg -nostdin -y -v error -i ... final.mp4")
```

Stream copies (`-c copy` trims, concat, `+faststart`) are near-instant and are fine
in `execute`. Anything with `libx264` in it is not.

## 7. Verify every edit

After each ffmpeg command, before moving on:

1. **The file exists and is not empty.** `ls -l out.mp4`. A 0-byte output is the
   classic silent failure — ffmpeg exits 0 having written nothing useful when a
   filter graph produces no frames.
2. **The duration is what you intended.** Arithmetic on fades and concat is where
   this file's traps live; ffprobe is how you find out you were wrong.
3. **The streams are what you intended.** A dropped audio track from a `-map` you
   forgot is invisible until someone plays it.

```bash
ls -l out.mp4 && ffprobe -v error -show_entries \
  format=duration:stream=codec_type,codec_name -of compact out.mp4
```

Then `view_video` the result at the end of the assembly, and report the measured
duration and stream list — not the intended ones.

## 8. What not to do

- Do not edit a generation in place. `gen/` holds originals; every edit writes a new
  file. A re-render costs 6-35 minutes and you cannot undo an overwrite.
- Do not commit generated clips. `.agents/video/` self-ignores for that reason.
- Do not spend a 50-step render on an unreviewed shot, or a batch of drafts, without
  saying what it will cost and getting agreement.
- Do not describe audio you have not verified, or claim a shot "looks great" when
  `view_video` returned something vague. Quote what it actually said.
- Do not paper over a bad shot with a transition. Regenerate it.
