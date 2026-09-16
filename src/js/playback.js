/**
 * YouTube segment playback.
 *
 * This is the part that makes a long video behave like a playlist. It wraps the
 * YouTube IFrame API and adds the three things that API does not give you:
 *
 *   1. Reliable segment ends. `endSeconds` fires an ENDED event only sometimes;
 *      a timer plus a polling watchdog catch the cases where it does not.
 *   2. Manual-seek detection. If the viewer scrubs the YouTube scrubber, the
 *      controller drops out of "auto next" instead of yanking them to the next
 *      clip mid-thought. See `detectManualSeek`.
 *   3. A plain-iframe fallback for contexts where the JS API never initialises
 *      (some embedded webviews, strict extension sandboxes). Playback still
 *      works there; only auto-advance is lost.
 *
 * Phases the controller moves through, exposed via `onStateChange`:
 *   ready | loading | playing | paused | manual | ended | blocked | no-source
 */
(function () {
  const ClipPlayer = (window.ClipPlayer = window.ClipPlayer || {});

  /**
   * @param {object} ui - resolved DOM refs from player.js.
   * @param {object} config - merged config.
   * @param {object} hooks - { onAutoAdvance, onStateChange }.
   */
  ClipPlayer.createPlaybackController = function createPlaybackController(ui, config, hooks = {}) {
    if (!ui) return null;

    const timing = config.timing;
    const strings = config.strings;

    const state = {
      apiReady: false,
      apiRequested: false,
      playerReady: false,
      playerStateCode: -1,
      player: null,
      currentClip: null,
      currentVideoId: "",
      // "auto" = will advance at endSeconds; "manual" = viewer took the wheel.
      flowMode: null,
      playerPhase: "ready",
      userPaused: false,
      monitorId: 0,
      apiPollId: 0,
      segmentTimeoutId: 0,
      loadingTimeoutId: 0,
      lastKnownTime: 0,
      lastCheckAt: 0,
      bufferSnapshot: null,
      everPlayed: false,
    };

    startMonitor();
    reset();

    return { reset, selectClip, play, pause, togglePlayback, destroy };

    // --- YouTube IFrame API bootstrap -----------------------------------------

    function ensureApi() {
      if (window.YT && typeof window.YT.Player === "function") {
        handleApiReady();
        return;
      }

      if (state.apiRequested) {
        pollForApi();
        return;
      }
      state.apiRequested = true;

      // The API only ever calls one global callback, so chain rather than
      // clobber — another script on the page may be waiting on it too.
      const previousReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof previousReady === "function") previousReady();
        handleApiReady();
      };

      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        document.body.appendChild(script);
      }

      // Belt and braces: if something else on the page loaded the API first,
      // our callback may already have been consumed.
      pollForApi();
    }

    function handleApiReady() {
      state.apiReady = true;
      clearApiPoll();

      if (state.currentClip?.hasSource && !state.player) {
        createPlayer(state.currentClip);
      }
    }

    function pollForApi() {
      if (state.apiPollId) return;

      state.apiPollId = window.setInterval(() => {
        if (window.YT && typeof window.YT.Player === "function") handleApiReady();
      }, 120);
    }

    function clearApiPoll() {
      if (!state.apiPollId) return;
      window.clearInterval(state.apiPollId);
      state.apiPollId = 0;
    }

    function createPlayer(clip) {
      if (!window.YT || typeof window.YT.Player !== "function" || !clip?.playback) return;

      const slot = document.createElement("div");
      slot.className = "clip-player-frame";
      ui.playerMount.replaceChildren(slot);

      state.currentVideoId = clip.playback.videoId;
      state.player = new window.YT.Player(slot, {
        host: "https://www.youtube.com",
        videoId: clip.playback.videoId,
        playerVars: buildPlayerVars(clip.playback),
        events: {
          onReady: handlePlayerReady,
          onStateChange: handlePlayerStateChange,
          onError: () => renderEmbeddedError(),
        },
      });
    }

    function buildPlayerVars(playback) {
      const vars = {
        autoplay: 1,
        controls: 1,
        modestbranding: 1,
        rel: 0,
        iv_load_policy: 3,
        // Keyboard control is disabled so arrow keys don't scrub the video out
        // from under the segment logic.
        disablekb: 1,
        fs: 1,
        playsinline: 1,
        cc_load_policy: 0,
      };

      const pageOrigin = getPageOrigin();
      if (pageOrigin) {
        vars.origin = pageOrigin;
        vars.widget_referrer = window.location.href;
      }

      if (typeof playback?.startSeconds === "number") vars.start = playback.startSeconds;
      if (typeof playback?.endSeconds === "number") vars.end = playback.endSeconds;

      return vars;
    }

    // `origin` must be omitted on file:// — YouTube rejects the literal "null".
    function getPageOrigin() {
      if (!/^https?:$/.test(window.location.protocol)) return "";
      if (!window.location.origin || window.location.origin === "null") return "";
      return window.location.origin;
    }

    // --- player events ---------------------------------------------------------

    function handlePlayerReady() {
      state.playerReady = true;

      if (state.currentClip?.hasSource) {
        loadClipIntoPlayer(state.currentClip, true);
        return;
      }

      state.playerPhase = "ready";
      renderControllerState();
    }

    function handlePlayerStateChange(event) {
      state.playerStateCode = event.data;
      const YTState = window.YT?.PlayerState;
      if (!YTState || !state.currentClip?.hasSource) return;

      applyPlayerCover(event.data);

      if (event.data === YTState.BUFFERING) {
        // Buffering desynchronises playback time from wall-clock time, which is
        // exactly the signal manual-seek detection keys on. Snapshot where we
        // were so the drift can be judged fairly once playback resumes.
        if (["playing", "paused", "manual"].includes(state.playerPhase)) {
          state.bufferSnapshot = {
            time: state.lastKnownTime || safeCurrentTime(),
            wallAt: state.lastCheckAt || Date.now(),
          };
          return;
        }

        if (state.playerPhase === "loading") renderControllerState();
        return;
      }

      if (event.data === YTState.PLAYING) {
        state.userPaused = false;
        clearLoadingTimeout();
        resolveBufferedSeek();
        syncPlaybackWindow();
        renderControllerState();
        return;
      }

      if (event.data === YTState.PAUSED) {
        state.userPaused = true;
        clearLoadingTimeout();

        if (state.playerPhase !== "manual") {
          state.playerPhase = "paused";
          state.bufferSnapshot = null;
          clearSegmentTimeout();
          renderControllerState();
        }
        return;
      }

      if (event.data === YTState.ENDED) {
        clearSegmentTimeout();

        if (state.flowMode === "auto") {
          requestAdvance();
        } else {
          state.playerPhase = "ended";
          renderControllerState();
        }
      }
    }

    /**
     * Decides whether the buffering we just came out of was a stall (keep
     * playing) or a scrub (switch to manual), using a looser drift tolerance
     * than the live watchdog because buffering legitimately loses time.
     */
    function resolveBufferedSeek() {
      if (state.bufferSnapshot && state.flowMode === "auto") {
        const now = Date.now();
        const deltaTime = safeCurrentTime() - state.bufferSnapshot.time;
        const deltaWall = (now - state.bufferSnapshot.wallAt) / 1000;

        if (Math.abs(deltaTime - deltaWall) > timing.bufferedSeekDriftSeconds) {
          state.flowMode = "manual";
          state.playerPhase = "manual";
          clearSegmentTimeout();
        } else {
          state.playerPhase = "playing";
        }

        state.bufferSnapshot = null;
        return;
      }

      state.playerPhase = state.flowMode === "manual" ? "manual" : "playing";
    }

    // --- loading a clip --------------------------------------------------------

    function loadClipIntoPlayer(clip, forceLoad) {
      if (!state.playerReady || !state.player || !clip?.playback) return;

      const playback = clip.playback;
      const startSeconds = playback.startSeconds || 0;
      // Two clips cut from the same stream only need a seek, which is far
      // faster (and less flickery) than reloading the same video.
      const sameVideo = !forceLoad && state.currentVideoId === playback.videoId;

      state.currentClip = clip;
      state.currentVideoId = playback.videoId;
      state.playerPhase = "loading";
      state.userPaused = false;
      state.lastKnownTime = startSeconds;
      state.lastCheckAt = Date.now();
      state.bufferSnapshot = null;
      clearSegmentTimeout();
      clearLoadingTimeout();
      setPoster(config.posters.loading);
      renderControllerState();
      scheduleLoadingFallback(clip);

      try {
        if (sameVideo) {
          state.player.seekTo(startSeconds, true);
          state.player.playVideo();
        } else {
          state.player.loadVideoById({
            videoId: playback.videoId,
            startSeconds,
            endSeconds: typeof playback.endSeconds === "number" ? playback.endSeconds : undefined,
          });
        }
      } catch (error) {
        renderStaticEmbed(clip);
      }
    }

    function scheduleLoadingFallback(clip) {
      clearLoadingTimeout();
      state.loadingTimeoutId = window.setTimeout(() => {
        state.loadingTimeoutId = 0;
        if (state.currentClip?.id !== clip.id || state.playerPhase !== "loading") return;
        renderStaticEmbed(clip);
      }, timing.loadingFallbackMs);
    }

    function clearLoadingTimeout() {
      if (!state.loadingTimeoutId) return;
      window.clearTimeout(state.loadingTimeoutId);
      state.loadingTimeoutId = 0;
    }

    // --- segment end detection -------------------------------------------------

    function syncPlaybackWindow() {
      if (!state.currentClip?.playback) return;

      const currentTime = safeCurrentTime();
      state.lastKnownTime = currentTime;
      state.lastCheckAt = Date.now();
      scheduleSegmentAdvance(state.currentClip, currentTime);
    }

    /**
     * Primary end-of-segment trigger: a single timer set for the remaining
     * segment length. The 300ms watchdog below is the backstop for when this
     * timer fires late (background tab throttling) or not at all.
     */
    function scheduleSegmentAdvance(clip, currentTime) {
      clearSegmentTimeout();
      if (state.flowMode !== "auto") return;

      const endSeconds = clip.playback?.endSeconds;
      if (typeof endSeconds !== "number") return;

      const remainingSeconds = Math.max(0, endSeconds - currentTime);

      state.segmentTimeoutId = window.setTimeout(() => {
        if (state.flowMode !== "auto" || state.currentClip?.id !== clip.id) return;
        if (isUserPaused()) return;
        if (state.playerStateCode !== window.YT?.PlayerState?.PLAYING) return;

        if (safeCurrentTime() >= endSeconds - 0.35) requestAdvance();
      }, remainingSeconds * 1000 + 140);
    }

    function clearSegmentTimeout() {
      if (!state.segmentTimeoutId) return;
      window.clearTimeout(state.segmentTimeoutId);
      state.segmentTimeoutId = 0;
    }

    function startMonitor() {
      state.monitorId = window.setInterval(() => {
        if (!state.playerReady || !state.currentClip?.hasSource) return;

        const now = Date.now();
        const currentTime = safeCurrentTime();
        if (!Number.isFinite(currentTime)) return;

        if (state.playerStateCode !== window.YT?.PlayerState?.PLAYING) {
          state.lastKnownTime = currentTime;
          state.lastCheckAt = now;
          return;
        }

        detectManualSeek(currentTime, now);

        if (
          state.flowMode === "auto" &&
          typeof state.currentClip.playback?.endSeconds === "number" &&
          currentTime >= state.currentClip.playback.endSeconds - 0.25
        ) {
          requestAdvance();
          return;
        }

        state.lastKnownTime = currentTime;
        state.lastCheckAt = now;
      }, timing.monitorIntervalMs);
    }

    /**
     * While playing normally, playback time advances in step with wall-clock
     * time. A scrub breaks that relationship immediately, so comparing the two
     * deltas detects a manual seek without hooking anything inside the iframe
     * (which cross-origin rules forbid).
     */
    function detectManualSeek(currentTime, now) {
      if (state.flowMode !== "auto" || ["loading", "paused"].includes(state.playerPhase)) return;

      if (!state.lastCheckAt) {
        state.lastKnownTime = currentTime;
        state.lastCheckAt = now;
        return;
      }

      const deltaTime = currentTime - state.lastKnownTime;
      const deltaWall = (now - state.lastCheckAt) / 1000;
      const drift = Math.abs(deltaTime - deltaWall);
      const jumpedFar = Math.abs(deltaTime) > 1.25;

      if (drift > timing.manualSeekDriftSeconds || jumpedFar) {
        state.flowMode = "manual";
        state.playerPhase = "manual";
        clearSegmentTimeout();
        renderControllerState();
      }

      state.lastKnownTime = currentTime;
      state.lastCheckAt = now;
    }

    function requestAdvance() {
      if (isUserPaused()) return;

      // The host returns true if it actually moved to another clip; false at
      // the end of the archive, where we just stop.
      if (hooks.onAutoAdvance?.() === true) return;

      state.playerPhase = "ended";
      clearSegmentTimeout();
      renderControllerState();
    }

    // --- transport -------------------------------------------------------------

    function play() {
      state.userPaused = false;
      try {
        state.player?.playVideo?.();
      } catch (error) {
        // Hardware media keys can arrive while the iframe is still attaching.
      }
    }

    function pause() {
      state.userPaused = true;
      state.playerPhase = "paused";
      state.bufferSnapshot = null;
      clearSegmentTimeout();
      clearLoadingTimeout();
      setPoster(state.everPlayed ? "" : config.posters.loading);
      renderControllerState();

      try {
        state.player?.pauseVideo?.();
      } catch (error) {
        // As above.
      }
    }

    function togglePlayback() {
      if (state.playerStateCode === window.YT?.PlayerState?.PLAYING) pause();
      else play();
    }

    function selectClip(clip, options = {}) {
      const forceLoad = options.forceLoad !== false;
      state.currentClip = clip || null;
      state.userPaused = false;
      state.everPlayed = false;

      if (!clip) {
        reset();
        return;
      }

      if (!clip.hasSource) {
        state.flowMode = null;
        state.playerPhase = "no-source";
        clearSegmentTimeout();
        clearLoadingTimeout();
        destroyPlayer();
        ui.playerMount?.replaceChildren();
        setPoster(config.posters.standby);
        renderControllerState();
        return;
      }

      state.flowMode = "auto";
      state.playerPhase = "loading";
      clearLoadingTimeout();
      setPoster(config.posters.loading);
      renderControllerState();
      scheduleLoadingFallback(clip);
      ensureApi();

      if (state.apiReady && !state.player) {
        createPlayer(clip);
        return;
      }

      if (state.apiReady && state.playerReady) {
        loadClipIntoPlayer(clip, forceLoad);
      }
    }

    function reset() {
      state.flowMode = null;
      state.playerPhase = "ready";
      state.userPaused = false;
      state.everPlayed = false;
      state.currentClip = null;
      destroyPlayer();
      ui.playerMount?.replaceChildren();
      clearSegmentTimeout();
      clearLoadingTimeout();
      setPoster(config.posters.standby);
      renderControllerState();
    }

    function destroy() {
      clearSegmentTimeout();
      clearLoadingTimeout();
      clearApiPoll();

      if (state.monitorId) {
        window.clearInterval(state.monitorId);
        state.monitorId = 0;
      }

      destroyPlayer();
      state.currentClip = null;
      ui.playerMount?.replaceChildren();
    }

    function destroyPlayer() {
      if (state.player) {
        try {
          state.player.stopVideo?.();
          state.player.destroy?.();
        } catch (error) {
          // Ignore teardown errors from already-detached embeds.
        }
      }

      state.player = null;
      state.playerReady = false;
      state.playerStateCode = -1;
      state.currentVideoId = "";
    }

    function safeCurrentTime() {
      try {
        return state.player?.getCurrentTime?.() ?? 0;
      } catch (error) {
        return 0;
      }
    }

    function isUserPaused() {
      return (
        state.userPaused ||
        state.playerPhase === "paused" ||
        state.playerStateCode === window.YT?.PlayerState?.PAUSED
      );
    }

    // --- rendering -------------------------------------------------------------

    function renderControllerState() {
      const clip = state.currentClip;

      if (!clip) {
        ui.nowTitle.textContent = strings.standbyTitle;
        ui.nowArtist.textContent = strings.standbyArtist;
        ui.nowMeta.textContent = strings.standbyMeta;
        setFlowIndicator(null);
      } else {
        ui.nowTitle.textContent = clip.title;
        ui.nowArtist.textContent = clip.artist || config.defaultArtist;
        ui.nowMeta.textContent = [clip.source, clip.date].filter(Boolean).join(" · ");

        const canShowFlow = clip.hasSource && !["blocked", "no-source"].includes(state.playerPhase);
        setFlowIndicator(canShowFlow ? state.flowMode || "auto" : null);
      }

      hooks.onStateChange?.({ currentClip: state.currentClip, playerPhase: state.playerPhase });
    }

    function setFlowIndicator(mode) {
      if (!ui.flowIndicator || !ui.flowText) return;

      if (!mode) {
        ui.flowIndicator.hidden = true;
        ui.flowIndicator.dataset.mode = "auto";
        ui.flowText.textContent = strings.autoNext;
        return;
      }

      ui.flowIndicator.hidden = false;
      ui.flowIndicator.dataset.mode = mode;
      ui.flowText.textContent = mode === "manual" ? strings.manual : strings.autoNext;
    }

    function setPoster(src) {
      if (!ui.playerPoster) return;

      if (!src) {
        ui.playerPoster.hidden = true;
        ui.playerPoster.removeAttribute("src");
        return;
      }

      ui.playerPoster.hidden = false;
      ui.playerPoster.src = src;
    }

    /**
     * The loading poster covers the embed only until the video has played once.
     * After that the player is left uncovered so pause and end show YouTube's
     * own frame rather than a stale placeholder.
     */
    function applyPlayerCover(stateCode) {
      const YTState = window.YT?.PlayerState;
      if (!YTState) return;

      if (stateCode === YTState.PLAYING) {
        state.everPlayed = true;
        setPoster("");
      } else {
        setPoster(state.everPlayed ? "" : config.posters.loading);
      }
    }

    // --- fallbacks -------------------------------------------------------------

    /** The JS API reported an error; keep the embed, drop auto-advance. */
    function renderEmbeddedError() {
      state.playerPhase = "blocked";
      state.flowMode = null;
      clearLoadingTimeout();
      clearSegmentTimeout();
      setPoster("");
      renderControllerState();
    }

    /**
     * Last resort: swap the API-controlled player for a plain iframe with
     * start/end in the URL. The clip still plays with the right bounds; we
     * simply lose the events auto-advance needs.
     */
    function renderStaticEmbed(clip) {
      if (!clip?.hasSource) {
        state.playerPhase = "no-source";
        clearLoadingTimeout();
        clearSegmentTimeout();
        destroyPlayer();
        ui.playerMount?.replaceChildren();
        setPoster(config.posters.standby);
        renderControllerState();
        return;
      }

      state.playerPhase = "blocked";
      state.flowMode = null;
      clearLoadingTimeout();
      clearSegmentTimeout();
      destroyPlayer();
      renderStaticIframe(clip);
      setPoster("");
      renderControllerState();
    }

    function renderStaticIframe(clip) {
      if (!ui.playerMount || !clip?.playback?.videoId) return;

      const iframe = document.createElement("iframe");
      iframe.className = "clip-player-frame";
      iframe.src = buildEmbedUrl(clip.playback);
      iframe.title = `YouTube player - ${clip.label || clip.title || strings.untitled}`;
      iframe.allow =
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      iframe.allowFullscreen = true;
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      ui.playerMount.replaceChildren(iframe);
    }

    function buildEmbedUrl(playback) {
      const url = new URL(`https://www.youtube.com/embed/${encodeURIComponent(playback.videoId)}`);
      url.searchParams.set("autoplay", "1");
      url.searchParams.set("controls", "1");
      url.searchParams.set("rel", "0");
      url.searchParams.set("modestbranding", "1");
      url.searchParams.set("playsinline", "1");

      const pageOrigin = getPageOrigin();
      if (pageOrigin) url.searchParams.set("origin", pageOrigin);

      if (typeof playback.startSeconds === "number" && playback.startSeconds > 0) {
        url.searchParams.set("start", `${Math.floor(playback.startSeconds)}`);
      }

      if (typeof playback.endSeconds === "number") {
        url.searchParams.set("end", `${Math.floor(playback.endSeconds)}`);
      }

      return url.href;
    }
  };
})();
