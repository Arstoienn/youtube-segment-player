/**
 * Public entry point: `ClipPlayer.mount(options)`.
 *
 * Owns the player's state (what is selected, what is expanded, the shuffle
 * path) and wires the other modules together.
 *
 * The container may already hold markup carrying the `data-clip-*` hooks below,
 * in which case that markup is used untouched. An empty container is filled
 * with a default copy of the same structure.
 *
 *   const player = ClipPlayer.mount({ el: "#player", dataUrl: "data/" });
 *   player.destroy();
 */
(function () {
  const ClipPlayer = (window.ClipPlayer = window.ClipPlayer || {});

  const UI_SELECTORS = {
    nowTitle: "[data-clip-now-title]",
    nowArtist: "[data-clip-now-artist]",
    nowMeta: "[data-clip-now-meta]",
    flowIndicator: "[data-clip-flow-indicator]",
    flowText: "[data-clip-flow-text]",
    prevButton: "[data-clip-prev]",
    nextButton: "[data-clip-next]",
    playerMount: "[data-clip-player-mount]",
    playerPoster: "[data-clip-player-poster]",
    panel: ".clip-preview-panel",
    tree: "[data-clip-tree]",
  };

  const REQUIRED_UI = Object.keys(UI_SELECTORS);

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  /**
   * @param {object} [options] - overrides deep-merged over `ClipPlayer.defaults`.
   * @param {HTMLElement|string} options.el - container element or selector.
   * @returns {object} controls: { destroy, next, previous, selectClip, getState, element }.
   */
  ClipPlayer.mount = function mount(options = {}) {
    const { el, ...overrides } = options;
    const config = ClipPlayer.mergeConfig(ClipPlayer.defaults, overrides);

    const root = typeof el === "string" ? document.querySelector(el) : el;
    if (!root) throw new Error("ClipPlayer.mount: no container element found.");

    const defaultDocumentTitle = document.title;
    // Only markup we generated is ours to tear down; a host's own stays put.
    const ownsMarkup = !root.querySelector("[data-clip-tree]");
    const ui = resolveUi(root, config);

    const state = {
      folders: [],
      playlists: [],
      clips: [],
      clipsById: new Map(),
      clipsByShareId: new Map(),
      activeClipId: null,
      expandedFolders: new Set(),
      expandedPlaylists: new Set(),
      shuffleEnabled: false,
      // Fixed per mount, so a shuffle order is stable while the page is open
      // but differs between visits.
      shuffleSeed: Date.now().toString(36),
      shufflePath: [],
      shuffleIndex: -1,
      searchQuery: "",
    };

    let disposed = false;
    let shareFeedbackTimer = 0;

    // The bridge is built first: creating the playback controller immediately
    // fires `onStateChange`, and that handler talks to `mediaKeys`. Its own
    // commands only reach `playback` from inside callbacks, so the reverse
    // dependency resolves lazily.
    const mediaKeys = config.features.mediaKeys
      ? ClipPlayer.createMediaKeyBridge({
          isDisposed: () => disposed,
          commands: {
            next: () => playNextClip({ forceLoad: true }),
            previous: () => playPreviousClip(),
            play: commandPlay,
            pause: commandPause,
            toggle: () => playback.togglePlayback?.(),
          },
        })
      : null;

    const playback = ClipPlayer.createPlaybackController(ui, config, {
      onAutoAdvance: handleAutoAdvance,
      onStateChange: handlePlaybackStateChange,
    });

    const treeView = ClipPlayer.createTreeView(
      ui.tree,
      {
        onSelectClip: clipId => selectClipById(clipId, { forceLoad: true, revealPath: true }),
        onToggleFolder: toggleFolder,
        onTogglePlaylist: togglePlaylist,
      },
      config.strings
    );

    bindControls();
    const disposeFocusGuard = bindPlayerFocusGuard();
    window.addEventListener("pagehide", destroy, { once: true });

    init();

    return {
      destroy,
      element: root,
      next: () => playNextClip({ forceLoad: true }),
      previous: () => playPreviousClip(),
      selectClip: clipId => selectClipById(clipId, { forceLoad: true, revealPath: true }),
      getState: () => ({
        activeClip: getClip(state.activeClipId),
        shuffleEnabled: state.shuffleEnabled,
        clipCount: state.clips.length,
      }),
    };

    // --- startup ---------------------------------------------------------------

    async function init() {
      let archive;

      try {
        archive = await ClipPlayer.loadArchive(config);
      } catch (error) {
        if (disposed) return;
        console.error("[ClipPlayer]", error);
        treeView.renderMessage(config.strings.archiveLoadFailed);
        return;
      }

      if (disposed) return;

      state.folders = archive.folders;
      state.playlists = archive.playlists;
      state.clips = archive.clips;
      state.clipsById = archive.clipsById;
      state.clipsByShareId = archive.clipsByShareId;
      // Top-level folders start open; playlists start closed.
      state.folders.forEach(folder => state.expandedFolders.add(folder.id));

      renderTree();
      syncTransport();
      mediaKeys?.syncHandlers();

      const initialClip = resolveInitialClip();
      if (initialClip) {
        selectClipById(initialClip.id, { forceLoad: true, revealPath: true });
        clearShareUrl();
      } else {
        playback.reset();
      }
    }

    function resolveInitialClip() {
      if (!config.features.deepLinks) return null;

      try {
        const shareId = new URL(location.href).searchParams.get(config.deepLinkParam);
        return shareId ? state.clipsByShareId.get(shareId) || null : null;
      } catch (error) {
        return null;
      }
    }

    // --- markup ----------------------------------------------------------------

    /**
     * Finds the elements the player drives.
     *
     * Write the markup yourself and it is used as-is; leave the container empty
     * and `defaultMarkup` fills it in first. Either way there is one wiring
     * path, and the structure is readable as HTML rather than buried in
     * createElement calls.
     */
    function resolveUi(container, cfg) {
      container.classList.add("clip-player");

      if (!container.querySelector("[data-clip-tree]")) {
        container.innerHTML = defaultMarkup(cfg);
      }

      const find = selector => container.querySelector(selector);
      const resolved = {
        nowTitle: find("[data-clip-now-title]"),
        nowArtist: find("[data-clip-now-artist]"),
        nowMeta: find("[data-clip-now-meta]"),
        flowIndicator: find("[data-clip-flow-indicator]"),
        flowText: find("[data-clip-flow-text]"),
        prevButton: find("[data-clip-prev]"),
        nextButton: find("[data-clip-next]"),
        playerMount: find("[data-clip-player-mount]"),
        playerPoster: find("[data-clip-player-poster]"),
        panel: find(".clip-preview-panel"),
        tree: find("[data-clip-tree]"),

        // Optional: absent when the matching feature is off, or when a host's
        // own markup simply leaves the control out.
        shuffleButton: find("[data-clip-shuffle]"),
        shareButton: find("[data-clip-share]"),
        searchInput: find("[data-clip-search]"),
      };

      const missing = REQUIRED_UI.filter(key => !resolved[key]);
      if (missing.length) {
        throw new Error(
          `ClipPlayer.mount: markup is missing ${missing
            .map(key => UI_SELECTORS[key])
            .join(", ")}`
        );
      }

      return resolved;
    }

    function defaultMarkup(cfg) {
      const s = cfg.strings;

      return `
<section class="clip-player-shell">
  <div class="clip-now">
    <p class="clip-player-label">${esc(s.nowPlayingLabel)}</p>
    <h2 class="clip-player-title" data-clip-now-title>${esc(s.standbyTitle)}</h2>
    <p class="clip-player-artist" data-clip-now-artist>${esc(s.standbyArtist)}</p>
    <p class="clip-player-meta" data-clip-now-meta>${esc(s.standbyMeta)}</p>

    <div class="clip-flow-indicator" data-clip-flow-indicator data-mode="auto" hidden>
      <span class="clip-flow-icon" aria-hidden="true"></span>
      <span class="clip-flow-text" data-clip-flow-text>${esc(s.autoNext)}</span>
    </div>

    <div class="clip-transport">
      ${transportButton("prev", s.prevLabel, { disabled: true })}
      ${transportButton("next", s.nextLabel, { disabled: true })}
      ${cfg.features.shuffle ? transportButton("shuffle", s.shuffleLabel, { pressed: true }) : ""}
      ${cfg.features.share ? transportButton("share", s.shareLabel, { disabled: true }) : ""}
    </div>
  </div>

  <div class="clip-preview-panel">
    <div class="clip-player-mount" data-clip-player-mount></div>
    <img class="clip-player-poster" data-clip-player-poster alt="" hidden />
  </div>
</section>

<section class="clip-library">
  <div class="clip-library-head">
    <div>
      <h2>${esc(s.libraryTitle)}</h2>
      <p>${esc(s.librarySubtitle)}</p>
    </div>
    ${
      cfg.features.search
        ? `<div class="clip-search">
      <input type="search" class="clip-search-input" data-clip-search
             placeholder="${esc(s.searchPlaceholder)}" aria-label="${esc(s.searchPlaceholder)}"
             autocomplete="off" />
    </div>`
        : ""
    }
  </div>

  <div class="clip-tree" data-clip-tree></div>
</section>`;
    }

    function transportButton(name, label, { disabled = false, pressed = false } = {}) {
      return `<button type="button" class="clip-transport-button clip-transport-button--${name}"
              data-clip-${name} aria-label="${esc(label)}"${pressed ? ' aria-pressed="false"' : ""}${
        disabled ? " disabled" : ""
      }>
        <span class="clip-transport-icon" aria-hidden="true"></span>
      </button>`;
    }

    function esc(value) {
      return String(value ?? "").replace(
        /[&<>"']/g,
        char => ESCAPES[char]
      );
    }

    // --- controls --------------------------------------------------------------

    function bindControls() {
      ui.prevButton.addEventListener("click", () => {
        mediaKeys?.activate();
        playPreviousClip();
      });

      ui.nextButton.addEventListener("click", () => {
        mediaKeys?.activate();
        playNextClip({ forceLoad: true });
      });

      ui.shuffleButton?.addEventListener("click", () => {
        state.shuffleEnabled = !state.shuffleEnabled;

        // Turning shuffle on from standby starts things off with a random clip;
        // selecting it rebuilds the path, so auto-advance keeps shuffling.
        if (state.shuffleEnabled && !getClip(state.activeClipId)) {
          const randomClip = pickRandomPlayableClip();
          if (randomClip) {
            selectClipById(randomClip.id, { forceLoad: true, revealPath: true });
            return;
          }
        }

        syncShufflePath(state.activeClipId);
        syncTransport();
      });

      ui.shareButton?.addEventListener("click", shareCurrentClip);

      ui.searchInput?.addEventListener("input", () => {
        state.searchQuery = ui.searchInput.value;
        renderTree();
      });

      ui.searchInput?.addEventListener("keydown", event => {
        if (event.key !== "Escape" || !ui.searchInput.value) return;
        ui.searchInput.value = "";
        state.searchQuery = "";
        renderTree();
      });
    }

    /**
     * YouTube keeps its own controls pinned open while the iframe holds focus,
     * even after the pointer leaves. Dropping that focus on leave, scroll and
     * outside-click lets YouTube's auto-hide behave normally.
     */
    function bindPlayerFocusGuard() {
      const blurPlayer = () => {
        const active = document.activeElement;
        if (active?.tagName === "IFRAME" && ui.playerMount.contains(active)) {
          active.blur();
          window.focus();
        }
      };

      const onPointerDown = event => {
        if (!ui.playerMount.contains(event.target)) blurPlayer();
      };

      ui.panel.addEventListener("mouseleave", blurPlayer);
      window.addEventListener("scroll", blurPlayer, { passive: true });
      document.addEventListener("pointerdown", onPointerDown, true);

      return () => {
        ui.panel.removeEventListener("mouseleave", blurPlayer);
        window.removeEventListener("scroll", blurPlayer);
        document.removeEventListener("pointerdown", onPointerDown, true);
      };
    }

    // --- playback state --------------------------------------------------------

    function handlePlaybackStateChange(playbackState) {
      const clip = playbackState?.currentClip || null;
      updateDocumentTitle(clip);

      if (clip) {
        mediaKeys?.setMetadata(clip, playbackState.playerPhase, config.defaultArtist);
      } else {
        mediaKeys?.setPlaybackState("none", null);
      }

      mediaKeys?.syncPhase(playbackState?.playerPhase || "ready");
      mediaKeys?.syncHandlers();
    }

    function handleAutoAdvance() {
      if (playNextClip({ forceLoad: false })) return true;

      syncTransport();
      return false;
    }

    function commandPlay() {
      if (!getClip(state.activeClipId)?.hasSource) return;
      mediaKeys?.activate();
      mediaKeys?.setPlaybackState("playing", getClip(state.activeClipId));
      playback.play?.();
    }

    function commandPause() {
      mediaKeys?.setPlaybackState("paused", getClip(state.activeClipId));
      playback.pause?.();
    }

    function playPreviousClip() {
      const previousClipId = getPreviousClipId(state.activeClipId);
      if (!previousClipId) return false;

      selectClipById(previousClipId, { forceLoad: true, revealPath: false, keepShufflePath: true });
      return true;
    }

    function playNextClip(options = {}) {
      const nextClip = getNextPlayableClip();
      if (!nextClip) return false;

      selectClipById(nextClip.id, {
        forceLoad: options.forceLoad === true,
        revealPath: false,
        keepShufflePath: true,
      });
      return true;
    }

    function selectClipById(clipId, options = {}) {
      const clip = getClip(clipId);
      if (!clip) return;

      state.activeClipId = clip.id;

      if (clip.hasSource) mediaKeys?.activate();
      else mediaKeys?.release();

      // A direct pick starts a new shuffle order from that clip; stepping
      // through with next/previous keeps the existing one.
      if (state.shuffleEnabled && options.keepShufflePath !== true) {
        createShufflePath(clip.id);
      }

      if (options.revealPath) {
        state.expandedFolders.add(clip.folderId);
        state.expandedPlaylists.add(clip.playlistId);
      }

      renderTree();
      syncTransport();
      updateDocumentTitle(clip);
      mediaKeys?.setMetadata(clip, "playing", config.defaultArtist);
      mediaKeys?.syncHandlers();
      playback.selectClip(clip, { forceLoad: options.forceLoad !== false });
    }

    function getClip(clipId) {
      return clipId ? state.clipsById.get(clipId) || null : null;
    }

    function getClipIndex(clipId) {
      return state.clips.findIndex(clip => clip.id === clipId);
    }

    function getPreviousClipId(clipId) {
      if (state.shuffleEnabled) {
        syncShufflePath(clipId);
        return state.shufflePath[state.shuffleIndex - 1] || null;
      }

      for (let index = getClipIndex(clipId) - 1; index >= 0; index -= 1) {
        if (state.clips[index].hasSource) return state.clips[index].id;
      }

      return null;
    }

    function getNextPlayableClip() {
      const playableClips = state.clips.filter(clip => clip.hasSource);
      if (!playableClips.length) return null;

      if (state.shuffleEnabled) {
        syncShufflePath(state.activeClipId || playableClips[0].id);
        return getClip(state.shufflePath[state.shuffleIndex + 1]);
      }

      if (!state.activeClipId) return playableClips[0];

      const currentIndex = getClipIndex(state.activeClipId);
      if (currentIndex === -1) return playableClips[0];

      for (let index = currentIndex + 1; index < state.clips.length; index += 1) {
        if (state.clips[index].hasSource) return state.clips[index];
      }

      return null;
    }

    // --- shuffle ---------------------------------------------------------------
    //
    // Shuffle is a precomputed path rather than a random pick per advance, so
    // "previous" is meaningful and no clip repeats before the list is exhausted.

    function syncShufflePath(anchorClipId) {
      if (!state.shuffleEnabled) return;

      if (!state.shufflePath.length || !state.shufflePath.includes(anchorClipId)) {
        createShufflePath(anchorClipId);
        return;
      }

      state.shuffleIndex = state.shufflePath.indexOf(anchorClipId);
    }

    function createShufflePath(anchorClipId) {
      const playableClips = state.clips.filter(clip => clip.hasSource);
      const anchorClip = getClip(anchorClipId) || playableClips[0] || null;

      if (!anchorClip) {
        state.shufflePath = [];
        state.shuffleIndex = -1;
        return;
      }

      const random = seededRandom(`${state.shuffleSeed}:${anchorClip.id}`);
      const rest = playableClips
        .filter(clip => clip.id !== anchorClip.id)
        .map(clip => ({ clip, rank: random() }))
        .sort((left, right) => left.rank - right.rank)
        .map(entry => entry.clip.id);

      state.shufflePath = [anchorClip.id, ...rest];
      state.shuffleIndex = 0;
    }

    /** Small deterministic PRNG (FNV-1a seed + mulberry32). */
    function seededRandom(seed) {
      let value = 2166136261;

      for (let index = 0; index < seed.length; index += 1) {
        value ^= seed.charCodeAt(index);
        value = Math.imul(value, 16777619);
      }

      return () => {
        value += 0x6d2b79f5;
        let next = value;
        next = Math.imul(next ^ (next >>> 15), next | 1);
        next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
        return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
      };
    }

    function pickRandomPlayableClip() {
      const playableClips = state.clips.filter(clip => clip.hasSource);
      if (!playableClips.length) return null;
      return playableClips[Math.floor(Math.random() * playableClips.length)];
    }

    // --- sharing ---------------------------------------------------------------

    /**
     * The address bar stays clean during normal browsing and auto-advance; a
     * deep link is only produced on demand, here.
     */
    function buildShareUrl(clip) {
      const url = new URL(location.href);
      url.searchParams.set(config.deepLinkParam, clip.shareId);
      return url.href;
    }

    /** Drops `?clip=` once consumed on load, so the URL returns to its plain form. */
    function clearShareUrl() {
      try {
        const url = new URL(location.href);
        if (!url.searchParams.has(config.deepLinkParam)) return;
        url.searchParams.delete(config.deepLinkParam);
        history.replaceState({ ...(history.state || {}) }, "", url.href);
      } catch (error) {
        // Some embedded contexts block history writes; deep-linking is optional.
      }
    }

    async function shareCurrentClip() {
      const clip = getClip(state.activeClipId);
      if (!clip || !ui.shareButton) return;

      const shareUrl = buildShareUrl(clip);
      let copied = false;

      try {
        await navigator.clipboard.writeText(shareUrl);
        copied = true;
      } catch (error) {
        // The Clipboard API needs a secure context and can be blocked outright;
        // fall back so sharing still works on http:// and file://.
        copied = legacyCopyText(shareUrl);
      }

      flashShareFeedback(copied ? config.strings.shareCopied : config.strings.shareFailed);
    }

    function legacyCopyText(text) {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        return copied;
      } catch (error) {
        return false;
      }
    }

    function flashShareFeedback(message) {
      ui.shareButton.dataset.shareMessage = message;
      ui.shareButton.classList.add("is-share-flash");
      window.clearTimeout(shareFeedbackTimer);
      shareFeedbackTimer = window.setTimeout(() => {
        if (disposed) return;
        ui.shareButton.classList.remove("is-share-flash");
      }, 1600);
    }

    // --- tree ------------------------------------------------------------------

    function renderTree() {
      if (disposed) return;

      if (!state.folders.length) {
        treeView.renderMessage(config.strings.emptyArchive);
        return;
      }

      const query = state.searchQuery.trim().toLowerCase();

      if (query) {
        const folders = getFilteredFolders(query);

        if (!folders.length) {
          treeView.renderMessage(config.strings.searchNoResults(state.searchQuery.trim()));
          return;
        }

        // While searching, force every matching folder open so results are
        // visible without manual expansion. The user's real expand state is
        // untouched and comes back when the query is cleared.
        const expandedPlaylists = new Set();
        folders.forEach(folder =>
          folder.playlists.forEach(playlist => expandedPlaylists.add(playlist.id))
        );

        treeView.render({
          folders,
          activeClipId: state.activeClipId,
          expandedFolders: new Set(folders.map(folder => folder.id)),
          expandedPlaylists,
        });
        return;
      }

      treeView.render({
        folders: state.folders,
        activeClipId: state.activeClipId,
        expandedFolders: state.expandedFolders,
        expandedPlaylists: state.expandedPlaylists,
      });
    }

    function getFilteredFolders(query) {
      const folders = [];

      state.folders.forEach(folder => {
        const playlists = [];

        folder.playlists.forEach(playlist => {
          const clips = playlist.clips.filter(clip => clipMatchesQuery(clip, query));
          if (clips.length) playlists.push({ ...playlist, clips });
        });

        if (playlists.length) folders.push({ ...folder, playlists });
      });

      return folders;
    }

    function clipMatchesQuery(clip, query) {
      return (
        clip.title.toLowerCase().includes(query) ||
        clip.artist.toLowerCase().includes(query) ||
        clip.source.toLowerCase().includes(query)
      );
    }

    function toggleFolder(folderId) {
      if (state.expandedFolders.has(folderId)) {
        state.expandedFolders.delete(folderId);
        // Collapse the playlists inside too, so reopening starts tidy.
        state.playlists.forEach(playlist => {
          if (playlist.folderId === folderId) state.expandedPlaylists.delete(playlist.id);
        });
      } else {
        state.expandedFolders.add(folderId);
      }

      renderTree();
    }

    function togglePlaylist(playlistId) {
      if (state.expandedPlaylists.has(playlistId)) state.expandedPlaylists.delete(playlistId);
      else state.expandedPlaylists.add(playlistId);

      renderTree();
    }

    // --- misc ------------------------------------------------------------------

    function syncTransport() {
      const activeClip = getClip(state.activeClipId);

      ui.prevButton.disabled = !activeClip || !getPreviousClipId(activeClip.id);
      ui.nextButton.disabled = !getNextPlayableClip();

      if (ui.shuffleButton) {
        ui.shuffleButton.classList.toggle("is-active", state.shuffleEnabled);
        ui.shuffleButton.setAttribute("aria-pressed", state.shuffleEnabled ? "true" : "false");
      }

      if (ui.shareButton) ui.shareButton.disabled = !activeClip;
    }

    function updateDocumentTitle(clip) {
      if (!config.documentTitleSuffix) return;
      document.title = clip ? `${clip.title} - ${config.documentTitleSuffix}` : defaultDocumentTitle;
    }

    function destroy() {
      if (disposed) return;
      disposed = true;

      document.title = defaultDocumentTitle;
      window.clearTimeout(shareFeedbackTimer);
      disposeFocusGuard?.();
      mediaKeys?.destroy();
      playback.destroy?.();
      if (ownsMarkup) root.replaceChildren();
    }
  };
})();
