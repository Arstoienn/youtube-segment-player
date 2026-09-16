# Tuning

The four numbers in `config.timing` each guard against a specific failure. The
defaults are what a real archive settled on; this page explains what moving them
costs, so you can adjust with intent rather than by trial and error.

```js
ClipPlayer.mount({
  el: "#player",
  timing: {
    loadingFallbackMs: 10000,
    monitorIntervalMs: 300,
    manualSeekDriftSeconds: 1.2,
    bufferedSeekDriftSeconds: 2.4,
  },
});
```

---

## `loadingFallbackMs` — default `10000`

How long a clip may sit in *loading* before the player gives up on the IFrame
API and swaps in a plain `<iframe>` with `start`/`end` in the URL.

**Guards against:** contexts where the JS API never initialises at all — some
embedded webviews, strict extension sandboxes, aggressive content blockers. Left
alone, the viewer would stare at the loading poster forever.

**Lower it** and slow connections get bumped into the fallback embed
unnecessarily, silently losing auto-advance. **Raise it** and genuinely broken
contexts stay blank for longer. 10s is comfortably past a normal cold start.

---

## `monitorIntervalMs` — default `300`

Poll interval for the watchdog that checks the playhead.

This is the backstop, not the primary mechanism. The segment end is normally hit
by a single `setTimeout` armed for the exact remaining length; the watchdog
catches the cases that timer misses — background-tab throttling, buffering
stalls, and seeks that invalidate the armed time.

**Also the resolution of manual-seek detection:** drift is measured between
consecutive polls, so this bounds how quickly a scrub is noticed.

**Raise it** past ~500 ms and segment ends start overshooting visibly. **Lower
it** below ~150 ms and you pay `getCurrentTime()` across an iframe boundary more
often than it's worth.

---

## `manualSeekDriftSeconds` — default `1.2`

How far playback time may diverge from wall-clock time, between two polls,
before the player concludes the viewer scrubbed and switches to *Manual*.

**The idea:** while a video plays normally, one second of wall-clock time
advances the playhead by one second. A scrub breaks that instantly. Comparing
the two deltas detects it without reaching into the cross-origin iframe, which
nothing is allowed to do.

A separate check catches any single jump larger than 1.25s, which covers scrubs
that happen to land near the expected position.

**Lower it** and ordinary jitter — a brief stall, a throttled timer — starts
reading as a deliberate seek, dropping people out of auto-advance for no reason.
**Raise it** and short scrubs go unnoticed, so the player yanks the viewer to
the next clip while they're still looking around. 1.2 s sits well above normal
jitter and below the smallest scrub anyone makes on purpose.

---

## `bufferedSeekDriftSeconds` — default `2.4`

The same comparison, applied once across a buffering pause instead of between
two polls.

Buffering legitimately loses wall-clock time — that's what buffering *is* — so
judging it against the live threshold would misread every stall as a scrub. When
BUFFERING begins the player snapshots the position and the clock; when playback
resumes it compares them against this looser tolerance.

Keep it meaningfully above `manualSeekDriftSeconds`. Bringing the two together
makes stalls on a weak connection silently disable auto-advance; pushing it much
higher lets a viewer scrub *through* a buffering pause undetected.

---

## Things deliberately not configurable

**`end - 0.35` and `end - 0.25` advance margins** (in `playback.js`). Firing a
hair early avoids showing a frame of the next scene. Tightening these to zero
makes the seam visible.

**The 250 ms media-key guard and `[250, 1000, 2500]` handler retries** (in
`media-keys.js`). Creating or reloading a YouTube iframe can hand the OS media
session back to YouTube; the staggered retries reclaim it. The values are paced
against how quickly an embed settles, and are not independent of each other.

**The silent anchor's 3-second timeline and its 0.45 / 1.55 thresholds.** These
aren't a duration — they're the geometry that lets a seek gesture be read as
next/previous. Changing one without the others breaks the gesture mapping. See
the comment at the top of [`media-keys.js`](../src/js/media-keys.js).
