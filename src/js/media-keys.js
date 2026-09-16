/**
 * Hardware media-key + OS media-control bridge.
 *
 * The problem: the audio is playing inside a cross-origin YouTube iframe, so
 * the OS attributes the media session to YouTube, not to this page. Pressing
 * ⏭ on a keyboard or headset does nothing useful, and the page never appears in
 * the system now-playing widget.
 *
 * The fix, in two parts:
 *
 *  1. A silent, looping <audio> element generated in-page (a 3-second WAV built
 *     as a Blob — no asset to ship). Because the page is now itself an audio
 *     source, the browser hands it the media session, and Media Session action
 *     handlers registered here start receiving the key presses.
 *
 *  2. A position guard. Some platforms deliver "next/previous" not as discrete
 *     actions but as a seek on the current media. The anchor is therefore
 *     parked at t=1s in its 3-second timeline: a seek backwards past 0.45s
 *     reads as "previous", a seek forwards past 1.55s reads as "next", and the
 *     playhead is then snapped back to 1s, ready for the next gesture.
 *
 * The bridge never plays audible sound; it only exists so the OS has something
 * of ours to talk to.
 */
(function () {
  const ClipPlayer = (window.ClipPlayer = window.ClipPlayer || {});

  const ANCHOR_PARK_SECONDS = 1;
  const ANCHOR_PREV_THRESHOLD = 0.45;
  const ANCHOR_NEXT_THRESHOLD = 1.55;
  const ANCHOR_DURATION_SECONDS = 3;

  /**
   * @param {object} options
   * @param {object} options.commands - { next, previous, play, pause, toggle }.
   *   `next`/`previous` return true if they actually changed clip.
   * @param {() => boolean} [options.isDisposed] - stop reacting once true.
   * @returns {object} bridge controls, or a no-op stub if unsupported.
   */
  ClipPlayer.createMediaKeyBridge = function createMediaKeyBridge(options) {
    const commands = options.commands;
    const isDisposed = options.isDisposed || (() => false);

    let anchor = null;
    const reapplyTimeoutIds = new Set();

    const actionHandlers = {
      nexttrack: handleNext,
      previoustrack: handlePrevious,
      seekforward: handleNext,
      seekbackward: handlePrevious,
      seekto: handleSeekTo,
      play: commands.play,
      pause: commands.pause,
      stop: commands.pause,
    };

    window.addEventListener("keydown", handleKeydown);
    scheduleHandlerRefresh();

    return {
      activate,
      release: destroyAnchor,
      destroy,
      setMetadata,
      setPlaybackState,
      syncPhase,
      syncHandlers: scheduleHandlerRefresh,
      resetPosition: resetAnchorPosition,
    };

    // --- media session wiring --------------------------------------------------

    function applyActionHandlers() {
      if (!("mediaSession" in navigator)) return;

      Object.entries(actionHandlers).forEach(([action, handler]) => {
        try {
          navigator.mediaSession.setActionHandler(action, handler);
        } catch (error) {
          // Browsers expose different subsets of the Media Session action set.
        }
      });
    }

    /**
     * Handlers are re-applied on a short schedule because creating or reloading
     * the YouTube iframe can hand the media session back to YouTube; the
     * staggered retries reclaim it without a visible gap.
     */
    function scheduleHandlerRefresh() {
      clearReapplyTimers();
      applyActionHandlers();

      [250, 1000, 2500].forEach(delay => {
        const timeoutId = window.setTimeout(() => {
          reapplyTimeoutIds.delete(timeoutId);
          applyActionHandlers();
        }, delay);
        reapplyTimeoutIds.add(timeoutId);
      });
    }

    function clearReapplyTimers() {
      reapplyTimeoutIds.forEach(timeoutId => window.clearTimeout(timeoutId));
      reapplyTimeoutIds.clear();
    }

    function setMetadata(clip, playerPhase = "playing", fallbackArtist = "") {
      if (!("mediaSession" in navigator) || !clip) return;

      try {
        if (typeof MediaMetadata === "function") {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: clip.title,
            artist: clip.artist || fallbackArtist,
            album: clip.source || "",
            artwork: clip.thumbnail
              ? [{ src: clip.thumbnail, sizes: "480x360", type: "image/jpeg" }]
              : [],
          });
        }

        setPlaybackState(playerPhase, clip);
        publishPositionState();
      } catch (error) {
        // Metadata is best-effort; the key handlers work without it.
      }
    }

    function setPlaybackState(playerPhase, clip) {
      if (!("mediaSession" in navigator)) return;

      try {
        navigator.mediaSession.playbackState = clip?.hasSource
          ? mapPhaseToPlaybackState(playerPhase)
          : "none";
      } catch (error) {
        // Some browsers expose metadata without a writable playback state.
      }
    }

    function mapPhaseToPlaybackState(playerPhase) {
      if (playerPhase === "paused") return "paused";
      if (["blocked", "ended", "none", "no-source", "ready"].includes(playerPhase)) return "none";
      return "playing";
    }

    /**
     * Mirrors the anchor's tiny timeline to the OS. The numbers are deliberate,
     * not a real duration: they are what makes a scrub gesture land outside the
     * park window so it can be read as next/previous.
     */
    function publishPositionState() {
      if (!("mediaSession" in navigator)) return;
      if (typeof navigator.mediaSession.setPositionState !== "function") return;

      try {
        navigator.mediaSession.setPositionState({
          duration: ANCHOR_DURATION_SECONDS,
          playbackRate: 1,
          position: ANCHOR_PARK_SECONDS,
        });
      } catch (error) {
        // Position state is only a hint to the media controls.
      }
    }

    // --- commands --------------------------------------------------------------

    function handleNext() {
      const handled = commands.next();
      if (!handled) resetAnchorPosition();
      return handled;
    }

    function handlePrevious() {
      const handled = commands.previous();
      if (!handled) resetAnchorPosition();
      return handled;
    }

    function handleSeekTo(details = {}) {
      const seekTime = Number(details.seekTime);

      if (Number.isFinite(seekTime)) {
        if (seekTime < ANCHOR_PREV_THRESHOLD + 0.3) return handlePrevious();
        if (seekTime > ANCHOR_NEXT_THRESHOLD - 0.3) return handleNext();
      }

      resetAnchorPosition();
      return false;
    }

    function handleKeydown(event) {
      // Never swallow media keys typed into a field.
      if (event.target?.matches?.("input, textarea, select, [contenteditable='true']")) return;

      const key = event.key;
      if (!key?.startsWith("Media")) return;

      if (key === "MediaTrackNext") {
        event.preventDefault();
        handleNext();
      } else if (key === "MediaTrackPrevious") {
        event.preventDefault();
        handlePrevious();
      } else if (key === "MediaPlayPause") {
        event.preventDefault();
        activate();
        commands.toggle();
      } else if (key === "MediaStop") {
        event.preventDefault();
        commands.pause();
      }
    }

    // --- the silent anchor -----------------------------------------------------

    function activate() {
      if (isDisposed()) return;

      if (anchor) {
        resumeAnchor();
        return;
      }

      try {
        const audio = document.createElement("audio");
        audio.src = createSilentAudioUrl();
        audio.loop = true;
        audio.playsInline = true;
        audio.preload = "auto";
        audio.style.cssText =
          "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
        document.body.appendChild(audio);

        anchor = {
          audio,
          objectUrl: audio.src,
          guardTimerId: 0,
          // Set while we move the playhead ourselves, so our own writes are not
          // mistaken for the user's seek gestures.
          resetting: false,
          suppressPause: false,
          suppressPlay: false,
        };

        bindAnchorEvents();
        audio.load();
        resumeAnchor();
        scheduleHandlerRefresh();
      } catch (error) {
        destroyAnchor();
      }
    }

    /** Builds a silent 8kHz mono WAV in memory and returns a blob URL. */
    function createSilentAudioUrl() {
      const sampleRate = 8000;
      const samples = sampleRate * ANCHOR_DURATION_SECONDS;
      const bytesPerSample = 2;
      const dataSize = samples * bytesPerSample;
      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);

      writeAscii(view, 0, "RIFF");
      view.setUint32(4, 36 + dataSize, true);
      writeAscii(view, 8, "WAVE");
      writeAscii(view, 12, "fmt ");
      view.setUint32(16, 16, true); // fmt chunk size
      view.setUint16(20, 1, true); // PCM
      view.setUint16(22, 1, true); // mono
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * bytesPerSample, true);
      view.setUint16(32, bytesPerSample, true);
      view.setUint16(34, 8 * bytesPerSample, true);
      writeAscii(view, 36, "data");
      view.setUint32(40, dataSize, true);
      // Sample data is left as zeroes — that is the silence.

      return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
    }

    function writeAscii(view, offset, value) {
      for (let index = 0; index < value.length; index += 1) {
        view.setUint8(offset + index, value.charCodeAt(index));
      }
    }

    function bindAnchorEvents() {
      const current = anchor;
      if (!current) return;

      current.audio.addEventListener("loadedmetadata", () => {
        resetAnchorPosition();
        resumeAnchor();
      });

      current.audio.addEventListener("seeked", handleAnchorPosition);
      current.audio.addEventListener("timeupdate", guardAnchorPosition);

      // Reaching the end means ~2s elapsed without us parking it — treat it the
      // same as a forward gesture rather than silently looping.
      current.audio.addEventListener("ended", () => {
        if (!current.resetting) handleNext();
        resetAnchorPosition();
        resumeAnchor();
      });

      current.audio.addEventListener("pause", () => {
        if (current.suppressPause || isDisposed()) return;
        commands.pause();
      });

      current.audio.addEventListener("play", () => {
        if (current.suppressPlay || isDisposed()) return;
        commands.play();
      });

      // timeupdate can fire as rarely as every 250ms; poll at the same rate so
      // a gesture is never missed.
      current.guardTimerId = window.setInterval(guardAnchorPosition, 250);
    }

    function handleAnchorPosition() {
      const current = anchor;
      if (!current || current.resetting || isDisposed()) return;

      const time = current.audio.currentTime;
      if (!Number.isFinite(time)) return;

      if (time < ANCHOR_PREV_THRESHOLD) {
        handlePrevious();
        return;
      }

      if (time > ANCHOR_NEXT_THRESHOLD) {
        handleNext();
        return;
      }

      resetAnchorPosition();
    }

    function guardAnchorPosition() {
      const current = anchor;
      if (!current || current.resetting || isDisposed() || current.audio.paused) return;

      const time = current.audio.currentTime;
      if (!Number.isFinite(time)) return;

      if (time < ANCHOR_PREV_THRESHOLD || time > ANCHOR_NEXT_THRESHOLD) {
        handleAnchorPosition();
      } else if (time < ANCHOR_PARK_SECONDS - 0.1 || time > ANCHOR_PARK_SECONDS + 0.1) {
        // Ordinary drift from playback: re-park without firing a command.
        resetAnchorPosition();
      }
    }

    function resetAnchorPosition() {
      const current = anchor;
      if (!current) return;

      current.resetting = true;

      try {
        if (current.audio.readyState > 0) {
          current.audio.currentTime = ANCHOR_PARK_SECONDS;
        }
        publishPositionState();
      } catch (error) {
        // Some browsers reject currentTime writes before metadata is ready.
      }

      // Long enough for the resulting `seeked` event to arrive and be ignored.
      window.setTimeout(() => {
        if (anchor === current) current.resetting = false;
      }, 80);
    }

    function resumeAnchor() {
      const current = anchor;
      if (!current) return;

      resetAnchorPosition();
      if (!current.audio.paused) return;

      current.suppressPlay = true;
      const clearSuppressPlay = () => {
        if (anchor === current) current.suppressPlay = false;
      };

      current.audio.play?.().catch(() => {}).finally(clearSuppressPlay);
      window.setTimeout(clearSuppressPlay, 500);
    }

    function pauseAnchor() {
      const current = anchor;
      if (!current || current.audio.paused) return;

      current.suppressPause = true;
      current.audio.pause();
      window.setTimeout(() => {
        if (anchor === current) current.suppressPause = false;
      }, 120);
    }

    /** Keeps the anchor's play state in step with the real player's phase. */
    function syncPhase(playerPhase) {
      if (!anchor) return;

      if (["blocked", "ended", "no-source", "ready"].includes(playerPhase)) {
        destroyAnchor();
      } else if (playerPhase === "paused") {
        pauseAnchor();
      } else {
        resumeAnchor();
      }
    }

    function destroyAnchor() {
      if (!anchor) return;

      window.clearInterval(anchor.guardTimerId);
      anchor.audio.remove();
      if (anchor.objectUrl) URL.revokeObjectURL(anchor.objectUrl);
      anchor = null;
    }

    function destroy() {
      window.removeEventListener("keydown", handleKeydown);
      clearReapplyTimers();
      destroyAnchor();

      if (!("mediaSession" in navigator)) return;

      Object.keys(actionHandlers).forEach(action => {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch (error) {
          // Ignore cleanup differences across implementations.
        }
      });
    }
  };
})();
