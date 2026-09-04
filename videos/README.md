# How-to-use video assets

`index.html`'s "How to use" section (see `HOW_TO_VIDEOS` near the top
of its inline script) looks for six locally-hosted video files in this
folder. None of them exist yet — the UI is built to detect that
gracefully and show a polished "Video coming soon" state per card
instead of a broken player, so the section is safe to ship before any
real video exists.

Drop a file at each path below (matching filename exactly) and it
starts working immediately — no code changes needed.

| Filename | Covers |
|---|---|
| `getting-started.mp4` | Adding a license key, first login, orientation |
| `how-signals-work.mp4` | What the engine checks and how it scores a signal |
| `how-to-read-a-signal.mp4` | BUY/SELL/WAIT, confidence %, volatility badge |
| `how-to-use-the-platform.mp4` | Picking an asset/duration, the dashboard, Premium Signal alerts |
| `how-to-manage-your-subscription.mp4` | Viewing plan status, renewing, payment approval |
| `how-referral-links-work.mp4` | Sharing a referral link, tracking clicks/signups, requesting payout |

## Format recommendations

- **Container/codec:** `.mp4` (H.264 + AAC) as the primary file. A
  matching `.webm` (VP9) with the same base name is optional — the
  player uses it automatically if present, for smaller file size on
  browsers that support it.
- **Aspect ratio:** 16:9. The card is a fixed 56.25%-padding box, so
  anything else will letterbox rather than crop or stretch.
- **Length:** short and specific beats comprehensive — 60–120 seconds
  per topic is a reasonable target, not a hard limit.
- **Size:** keep each file well under 20MB if you can (compress with
  `ffmpeg -crf 28` or similar) — these are served directly from static
  hosting alongside the rest of `clients/web/`, with no CDN/transcoding
  step in front of them.

## Optional: durations

If you want the card to show a duration badge (e.g. "2:14"), add it to
the `HOW_TO_VIDEOS` array in `index.html` — each entry has a
`durationLabel` field that's simply omitted from the card when not
set. There's no automatic duration detection; the UI reflects whatever
you put there.
