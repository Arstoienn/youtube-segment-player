# How it works

Playing a range of a YouTube video sounds like it should be one API call. The
IFrame API does take `startSeconds` and `endSeconds` — but three things go wrong
once you try to chain segments into a playlist, and most of this repo exists to
handle them.

---

## 1. Segment ends don't fire reliably

`endSeconds` raises an `ENDED` event only some of the time. Background-tab
throttling, buffering stalls and seeks all cause it to be missed, and a missed
end means playback runs on into whatever follows — usually the rest of a
three-hour stream.

Two mechanisms, deliberately overlapping:

- **A timer**, armed for the exact remaining segment length whenever playback
  starts or resumes. This is the primary path and fires cleanly in the normal
  case.
- **A 300 ms watchdog** that polls the playhead. This is the backstop for
  everything the timer misses.

Both check the real position before advancing rather than trusting they were
called at the right moment. The advance fires a hair early (`end - 0.35s` and
`end - 0.25s` respectively) so no frame of the following scene is shown.

See `scheduleSegmentAdvance` and `startMonitor` in
[`playback.js`](../src/js/playback.js).

---

## 2. The viewer might scrub

If someone drags the YouTube scrubber to look around, auto-advance must not yank
them to the next segment two seconds later. But the scrubber lives inside a
cross-origin iframe — there is no event to listen for and no way to reach in.

The signal is indirect. While a video plays normally, one second of wall-clock
time advances the playhead by one second; the two move in lockstep. A scrub
breaks that relationship instantly. So each poll compares:

```
deltaPlayback = currentTime - lastKnownTime
deltaWall     = (now - lastCheckAt) / 1000
drift         = |deltaPlayback - deltaWall|
```

Drift above `manualSeekDriftSeconds` (1.2s by default), or any single jump
larger than 1.25s, means the viewer took the wheel. The player switches to
**Manual**, cancels the pending advance, and leaves them alone. The badge in the
UI flips from *Auto Next* to *Manual* so the change is visible rather than
mysterious.

Buffering is the complication: it legitimately loses wall-clock time, so judged
against the live threshold every stall would look like a scrub. When BUFFERING
begins the player snapshots position and clock, and on resume compares them
against a looser `bufferedSeekDriftSeconds` (2.4s).

See `detectManualSeek` and `resolveBufferedSeek` in
[`playback.js`](../src/js/playback.js).

---

## 3. Media keys go to YouTube, not to you

Audio playing inside a YouTube iframe belongs to YouTube as far as the operating
system is concerned. Your page never gets the media session, so ⏭ on a keyboard
or headset does nothing useful, and the page never appears in the system
now-playing widget.

The fix is to give the OS something of yours to talk to: a **silent, looping WAV
generated in-page** as a Blob, so there's no asset to ship. The page is now
itself an audio source, the browser hands it the media session, and Media
Session action handlers start receiving key presses — which are then forwarded
to the real player in the iframe.

That covers platforms that send discrete `nexttrack` / `previoustrack` actions.
Others send "next" as a **seek** on the current media instead, which is why the
silent track has a deliberate geometry:

```
0s        0.45s          1.0s          1.55s        3s
|-----------|-------------|--------------|-----------|
  previous        parked here            next
```

The anchor sits parked at 1s in a 3-second timeline. A seek landing below 0.45s
reads as *previous*, above 1.55s as *next*, and the playhead is snapped back to
1s ready for the next gesture. Ordinary drift within the park window is
re-parked without firing anything.

Two details that matter: our own writes to `currentTime` set a `resetting` flag
so they aren't mistaken for the user's gestures, and the action handlers are
re-applied on a `[250, 1000, 2500]` ms schedule because creating or reloading
the YouTube iframe can hand the session back to YouTube.

See [`media-keys.js`](../src/js/media-keys.js).

---

## Degrading gracefully

In some contexts — embedded webviews, strict extension sandboxes, aggressive
content blockers — the IFrame API never initialises at all. After
`loadingFallbackMs` (10s) the player stops waiting and swaps in a plain
`<iframe>` with `start` and `end` in the URL.

Segments still play with the right bounds. Only the event-driven features are
lost, so auto-advance stops and the UI hides the *Auto Next* badge rather than
promising something it can't deliver.

---

## Why share ids are hashes

A share link (`?clip=1a2b3c4d`) encodes an 8-character FNV-1a hash of *video id
+ start time*, not the segment's position in its file. Reordering segments,
renaming playlists or regrouping folders therefore leaves existing links
working; only changing a segment's `start` breaks them.

FNV-1a is used rather than `crypto.subtle` because it's synchronous and works
outside secure contexts, so share links behave identically on `file://`, `http`
and `https`.

See `shortHash` and `registerShareId` in [`archive.js`](../src/js/archive.js).
