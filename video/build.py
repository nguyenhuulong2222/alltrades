#!/usr/bin/env python3
"""Assemble the AllTrades demo video with ffmpeg (no paid API calls).

  python3 video/build.py            # check inputs, print plan (dry run, default)
  python3 video/build.py --render   # build video/out/alltrades-demo.mp4 + .srt

Inputs:  video/shots.tsv, video/vo.tsv, video/raw/*, video/ai/*, video/audio/<cue>.wav
Needs:   ffmpeg/ffprobe, ImageMagick (`magick`). This ffmpeg has no libass/drawtext,
         so the label and subtitles are rendered as PNGs and overlaid.
"""
import argparse, os, re, subprocess, sys, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
TMP = os.path.join(OUT, "tmp")
W, H, FPS, MAX_TOTAL = 1920, 1080, 30, 120.0
LABEL = "NEAR testnet · simulated clients · not a money transmission service"
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"  # has Vietnamese glyphs


def rows(name):
    out = []
    with open(os.path.join(HERE, name), encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if line.strip() and not line.startswith("#"):
                out.append(line.split("\t"))
    return out


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"FAILED: {' '.join(cmd[:6])} ...\n{r.stderr[-1500:]}")
    return r.stdout


def duration(path):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                      "-of", "default=nw=1:nk=1", path]).strip())


def load():
    shots, t = [], 0.0
    for r in rows("shots.tsv"):
        sid, dur, typ, src, ss, speed = r[:6]
        shots.append(dict(id=sid, start=t, dur=float(dur), type=typ,
                          src=os.path.join(HERE, src), ss=float(ss), speed=float(speed)))
        t += float(dur)
    by_id = {s["id"]: s for s in shots}
    cues = []
    for r in rows("vo.tsv"):
        cue, shot, off, lang, text = r[:5]
        sub = r[5] if len(r) > 5 and r[5] else text
        cues.append(dict(id=cue, shot=by_id[shot], start=by_id[shot]["start"] + float(off),
                         lang=lang, text=text, sub=sub,
                         wav=os.path.join(HERE, "audio", f"{cue}.wav")))
    return shots, cues, t


def check(shots, cues, total):
    problems = []
    print(f"Total {total:.1f}s (max {MAX_TOTAL:.0f}s)")
    if total > MAX_TOTAL:
        problems.append(f"total {total:.1f}s > {MAX_TOTAL:.0f}s")
    ai = [s for s in shots if s["type"] == "ai"]
    if len(ai) > 2 or any(s not in (shots[0], shots[-1], shots[1], shots[-2]) for s in ai):
        problems.append("Veo clips: max 2, only at the start or end")
    for s in shots:
        ok = os.path.exists(s["src"])
        info = ""
        if ok and s["type"] != "still":
            have = duration(s["src"]) - s["ss"]
            need = s["dur"] * s["speed"]
            info = f" source {have:.1f}s / need {need:.1f}s"
            if have + 0.05 < need:
                problems.append(f"shot {s['id']}: source too short ({have:.1f}s < {need:.1f}s)")
        elif not ok:
            problems.append(f"missing {os.path.relpath(s['src'], HERE)}")
        print(f"  {s['id']} {s['start']:6.1f}-{s['start'] + s['dur']:6.1f} {s['type']:5} "
              f"{'OK ' if ok else 'MISSING'} {os.path.relpath(s['src'], HERE)}{info}")
    for i, c in enumerate(cues):
        if not os.path.exists(c["wav"]):
            problems.append(f"missing audio/{c['id']}.wav")
            continue
        c["len"] = duration(c["wav"])
        end = c["start"] + c["len"]
        nxt = cues[i + 1]["start"] if i + 1 < len(cues) else total
        shot_end = c["shot"]["start"] + c["shot"]["dur"]
        if end > nxt + 0.05:
            problems.append(f"cue {c['id']} ends {end:.1f}s, overlaps next cue at {nxt:.1f}s")
        elif end > shot_end + 0.05 and c["shot"]["type"] == "real":
            print(f"  note: cue {c['id']} runs {end - shot_end:.1f}s into the next shot")
    return problems


def chunks(text, n_lines=2, width=42):
    """Split a cue into subtitle chunks of at most 2 lines x 42 chars."""
    lines = textwrap.wrap(text, width)
    return ["\n".join(lines[i:i + n_lines]) for i in range(0, len(lines), n_lines)]


def subtitle_events(cues):
    ev = []
    for c in cues:
        parts = chunks(c["sub"]) if c["lang"] == "en" else [c["sub"]]
        total_chars = sum(len(p) for p in parts)
        t = c["start"]
        dur = max(c["len"], 2.0) if c["lang"] != "en" else c["len"]
        for p in parts:
            d = dur * len(p) / total_chars
            ev.append((t, t + d, p))
            t += d
    return ev


def srt_time(t):
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"


def render(shots, cues, total):
    os.makedirs(TMP, exist_ok=True)
    # 1. normalise every shot to 1920x1080 / 30 fps / no audio
    parts = []
    for s in shots:
        dst = os.path.join(TMP, f"shot-{s['id']}.mp4")
        vf = (f"setpts=PTS/{s['speed']},scale={W}:{H}:force_original_aspect_ratio=decrease,"
              f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,fps={FPS},format=yuv420p")
        if s is shots[0]:
            vf += ",fade=t=in:st=0:d=0.8"
        if s is shots[-1]:
            vf += f",fade=t=out:st={s['dur'] - 0.8}:d=0.8"
        inp = (["-loop", "1", "-i", s["src"]] if s["type"] == "still"
               else ["-ss", str(s["ss"]), "-i", s["src"]])
        run(["ffmpeg", "-y", "-v", "error", *inp, "-vf", vf, "-t", str(s["dur"]), "-an",
             "-c:v", "libx264", "-crf", "16", "-preset", "medium", dst])
        parts.append(dst)
    lst = os.path.join(TMP, "concat.txt")
    with open(lst, "w") as f:
        f.writelines(f"file '{p}'\n" for p in parts)
    video = os.path.join(TMP, "video.mp4")
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", video])

    # 2. voice-over: each cue at its start time, then loudness-normalise
    ins, flt = [], []
    for i, c in enumerate(cues):
        ins += ["-i", c["wav"]]
        ms = int(c["start"] * 1000)
        flt.append(f"[{i}:a]aresample=48000,adelay={ms}|{ms}[a{i}]")
    flt.append("".join(f"[a{i}]" for i in range(len(cues)))
               + f"amix=inputs={len(cues)}:normalize=0,apad,atrim=0:{total},"
               "loudnorm=I=-16:TP=-1.5:LRA=11[out]")
    audio = os.path.join(TMP, "vo.wav")
    run(["ffmpeg", "-y", "-v", "error", *ins, "-filter_complex", ";".join(flt),
         "-map", "[out]", "-ar", "48000", audio])

    # 3. subtitles (.srt sidecar + soft track) and burned-in PNG overlays
    events = subtitle_events(cues)
    srt = os.path.join(OUT, "alltrades-demo.srt")
    with open(srt, "w", encoding="utf-8") as f:
        for n, (a, b, text) in enumerate(events, 1):
            f.write(f"{n}\n{srt_time(a)} --> {srt_time(b)}\n{text}\n\n")
    label = os.path.join(TMP, "label.png")
    run(["magick", "-background", "#000000A0", "-fill", "white", "-font", FONT,
         "-pointsize", "26", f"label:{LABEL}", "-bordercolor", "#000000A0", "-border", "14x8", label])
    pngs = []
    for n, (a, b, text) in enumerate(events):
        p = os.path.join(TMP, f"sub-{n:02}.png")
        run(["magick", "-background", "#000000B0", "-fill", "white", "-font", FONT,
             "-pointsize", "44", "-gravity", "center", f"label:{text}",
             "-bordercolor", "#000000B0", "-border", "20x10", p])
        pngs.append((a, b, p))

    ins = ["-i", video, "-i", audio, "-i", label] + sum((["-i", p] for _, _, p in pngs), [])
    chain = ["[0:v][2:v]overlay=W-w-28:28[v0]"]
    for k, (a, b, _) in enumerate(pngs):
        chain.append(f"[v{k}][{k + 3}:v]overlay=(W-w)/2:H-h-70:"
                     f"enable='between(t,{a:.3f},{b:.3f})'[v{k + 1}]")
    final = os.path.join(OUT, "alltrades-demo.mp4")
    run(["ffmpeg", "-y", "-v", "error", *ins, "-i", srt, "-filter_complex", ";".join(chain),
         "-map", f"[v{len(pngs)}]", "-map", "1:a", "-map", f"{len(pngs) + 3}:s",
         "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "192k", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng",
         "-t", str(total), "-movflags", "+faststart", final])
    print(f"Done: {final} ({duration(final):.1f}s)\n      {srt}")
    print("Now watch it fully: no 1Click, no .env, no key/token, label visible throughout.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--render", action="store_true", help="actually build (default: dry run)")
    args = ap.parse_args()
    shots, cues, total = load()
    problems = check(shots, cues, total)
    if problems:
        print("\nNot ready:\n  - " + "\n  - ".join(problems))
    if not args.render:
        print("\nDry run only. Use --render to build.")
        return
    if problems:
        sys.exit(1)
    render(shots, cues, total)


if __name__ == "__main__":
    main()
