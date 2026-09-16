/**
 * Default configuration for the clip player.
 *
 * Every user-facing string, asset path and tuning constant lives here so a host
 * page can re-theme or translate the player without touching module code.
 * `ClipPlayer.mount({ ... })` deep-merges your overrides over these defaults.
 */
(function () {
  const ClipPlayer = (window.ClipPlayer = window.ClipPlayer || {});

  // Inline SVG posters keep the default build image-free: no binary assets to
  // copy, and they inherit no branding from whoever forks this repo.
  const STANDBY_POSTER =
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
        <rect width="640" height="360" fill="#101820"/>
        <g fill="none" stroke="#3f5566" stroke-width="3" stroke-linecap="round">
          <circle cx="320" cy="168" r="44"/>
          <path d="M296 190l48-44"/>
        </g>
        <text x="320" y="258" fill="#5b7488" font-family="system-ui,sans-serif"
              font-size="19" text-anchor="middle">No playable source</text>
      </svg>`
    );

  const LOADING_POSTER =
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
        <rect width="640" height="360" fill="#0b1016"/>
        <g fill="#4d93b8">
          <circle cx="290" cy="180" r="11"><animate attributeName="opacity"
            values="0.25;1;0.25" dur="1.1s" repeatCount="indefinite" begin="0s"/></circle>
          <circle cx="320" cy="180" r="11"><animate attributeName="opacity"
            values="0.25;1;0.25" dur="1.1s" repeatCount="indefinite" begin="0.18s"/></circle>
          <circle cx="350" cy="180" r="11"><animate attributeName="opacity"
            values="0.25;1;0.25" dur="1.1s" repeatCount="indefinite" begin="0.36s"/></circle>
        </g>
      </svg>`
    );

  ClipPlayer.defaults = {
    /** Directory holding index.json and the playlist JSON files. */
    dataUrl: "data/",

    /** Fallback artist shown when a clip title carries no " by " marker. */
    defaultArtist: "Uncredited",

    /**
     * Suffix appended to document.title while a clip is selected, e.g.
     * "Big Buck Bunny - Clip Archive". Set to "" to leave the title alone.
     */
    documentTitleSuffix: "",

    /** Enable/disable optional subsystems. */
    features: {
      search: true,
      shuffle: true,
      share: true,
      mediaKeys: true,
      deepLinks: true,
    },

    /** Query parameter used by share links, e.g. `?clip=1a2b3c4d`. */
    deepLinkParam: "clip",

    /**
     * Optional `title => { title, artist, date }` override. Leave unset to use
     * the built-in "Title by Artist (M/D/YY)" parser.
     */
    parseTitle: null,

    posters: {
      standby: STANDBY_POSTER,
      loading: LOADING_POSTER,
    },

    /** Timing knobs; see docs/TUNING.md for what each one guards against. */
    timing: {
      // How long a clip may sit in "loading" before falling back to a plain
      // iframe embed (the JS API is blocked in some embedded contexts).
      loadingFallbackMs: 10000,
      // Poll interval for the playback position watchdog.
      monitorIntervalMs: 300,
      // Position drift (seconds) that counts as "the viewer scrubbed manually".
      manualSeekDriftSeconds: 1.2,
      // Larger tolerance applied after a buffering stall, which naturally
      // desynchronises wall-clock time from playback time.
      bufferedSeekDriftSeconds: 2.4,
    },

    strings: {
      standbyTitle: "Standby",
      standbyArtist: "Pick a clip to start",
      standbyMeta: "Source · Date",
      nowPlayingLabel: "Now Playing",
      libraryTitle: "Library",
      librarySubtitle: "Open a folder, then pick a clip.",
      autoNext: "Auto Next",
      manual: "Manual",
      untitled: "Untitled",
      emptyArchive: "No clips available.",
      emptyFolder: "No clips in this folder.",
      archiveLoadFailed: "Clip folders failed to load.",
      searchPlaceholder: "Search titles, artists, sources…",
      searchNoResults: query => `No clips match “${query}”.`,
      shareCopied: "Link copied",
      shareFailed: "Copy failed",
      prevLabel: "Previous clip",
      nextLabel: "Next clip",
      shuffleLabel: "Shuffle",
      shareLabel: "Copy share link",
    },
  };

  /**
   * Recursively merges `overrides` over `base` without mutating either.
   * Arrays and functions are replaced wholesale rather than merged.
   */
  ClipPlayer.mergeConfig = function mergeConfig(base, overrides) {
    if (!overrides) return { ...base };

    const result = { ...base };

    Object.keys(overrides).forEach(key => {
      const value = overrides[key];
      const current = result[key];

      if (isPlainObject(value) && isPlainObject(current)) {
        result[key] = mergeConfig(current, value);
      } else if (value !== undefined) {
        result[key] = value;
      }
    });

    return result;
  };

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
})();
