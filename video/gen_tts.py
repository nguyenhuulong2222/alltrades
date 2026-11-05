#!/usr/bin/env python3
"""Generate voice-over cues with OpenAI TTS -> video/audio/<cue>.wav  (PAID API).

  python3 video/gen_tts.py                         # dry run: list cues + cost estimate, no API call
  uv run --env-file .env video/gen_tts.py --yes    # call the API (key read from env, never printed)
  ... --yes --only 07b                             # regenerate one cue

Pricing (developers.openai.com/api/docs/pricing, checked 2026-11-04):
  gpt-4o-mini-tts: $0.60 / 1M text tokens in, $12.00 / 1M audio tokens out.
"""
import argparse, json, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL, VOICE = "gpt-4o-mini-tts", "ash"
STYLE = {
    "en": "Calm, clear, confident product-demo narrator. Moderate pace, plain American English.",
    "vi": "Speak in natural Vietnamese, warm and casual, like a person asking a friend for help. Short and clear.",
}


def cues():
    with open(os.path.join(HERE, "vo.tsv"), encoding="utf-8") as f:
        for line in f:
            if line.strip() and not line.startswith("#"):
                r = line.rstrip("\n").split("\t")
                yield r[0], r[3], r[4]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true", help="really call the paid API")
    ap.add_argument("--only", nargs="*", help="cue ids to (re)generate")
    a = ap.parse_args()
    todo = [c for c in cues() if not a.only or c[0] in a.only]
    chars = sum(len(t) for _, _, t in todo)
    secs = chars / 15  # ~15 chars per spoken second
    # ~1,250 audio tokens per minute -> ~$0.015/min; text tokens are negligible
    est = secs / 60 * 1250 * 12 / 1e6 + chars / 4 * 0.6 / 1e6
    print(f"{len(todo)} cues, {chars} chars, ~{secs:.0f}s audio, est. ${est:.3f} per full pass")
    for cue, lang, text in todo:
        print(f"  {cue} [{lang}] {text}")
    if not a.yes:
        print("\nDry run. Add --yes to call the API.")
        return
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        sys.exit("OPENAI_API_KEY not set (run via: uv run --env-file .env video/gen_tts.py --yes)")
    os.makedirs(os.path.join(HERE, "audio"), exist_ok=True)
    for cue, lang, text in todo:
        body = json.dumps({"model": MODEL, "voice": VOICE, "input": text,
                           "instructions": STYLE[lang], "response_format": "wav"}).encode()
        req = urllib.request.Request("https://api.openai.com/v1/audio/speech", data=body,
                                     headers={"Authorization": f"Bearer {key}",
                                              "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
        out = os.path.join(HERE, "audio", f"{cue}.wav")
        with open(out, "wb") as f:
            f.write(data)
        print(f"  wrote audio/{cue}.wav ({len(data) // 1024} KB)")


if __name__ == "__main__":
    main()
