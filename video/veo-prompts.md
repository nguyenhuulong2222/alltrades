# Veo prompts (max 2 clips: intro + outro)

Final clips were made by hand in Google Flow (no API). The intro clip was rejected (readable "OPEN" sign), so shot 01 uses a cropped still from it with a slow zoom (`video/ai/intro-still.mp4`); shot 08 uses the Flow outro clip.
Rules: no people, no logos or brand marks, no readable text or numbers, no screens, terminals, dashboards, phones or charts. Products are shown only in real screen recordings.

## veo-intro (shot 01, 6 s)

```
Slow cinematic dolly shot along a quiet small-town main street in Hawaii at sunrise. Low wooden storefronts with blank, unpainted signboards, a closed roll-up shutter on a small repair garage, potted plants and a bicycle leaning on a railing. Warm golden light, long soft shadows, light breeze moving palm fronds, distant green mountains under a pale sky. The street is completely empty. Calm, hopeful mood, shallow depth of field, natural colors, 35mm film look, steady camera, no cuts.
```

## veo-outro (shot 08, 6 s)

```
Slow aerial shot drifting over a calm turquoise ocean toward a green island coastline at golden hour, small houses with warm lit windows along the shore as dusk begins. Gentle waves, soft clouds glowing orange and pink, a single paper lantern floating on the water in the foreground. Peaceful, warm, hopeful mood, natural colors, 35mm film look, smooth steady camera, no cuts.
```

## Negative prompt (both)

```
people, person, human, face, hands, crowd, silhouette, text, letters, words, numbers, logo, brand, signage text, watermark, screen, monitor, laptop, phone, terminal, dashboard, chart, graph, user interface, money, banknotes, coins, credit card, cryptocurrency symbol
```

## Review before use
- Watch both clips frame by frame: any readable text, logo, face or screen → reject and regenerate (each retry costs again).
- The Veo clip is decoration only; the voice-over over it makes no product claims.
