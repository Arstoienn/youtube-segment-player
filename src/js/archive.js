/**
 * Archive loading and parsing.
 *
 * Turns a folder of JSON playlists into the flat + grouped model the rest of
 * the player reads:
 *
 *   { folders, playlists, clips, clipsById, clipsByShareId }
 *
 * `folders` drives the tree UI, `clips` is the linear play order, and the two
 * maps back the tree selection and ?clip= deep links respectively.
 *
 * See docs/DATA-FORMAT.md for the JSON this expects.
 */
(function () {
  const ClipPlayer = (window.ClipPlayer = window.ClipPlayer || {});

  /**
   * Fetches every playlist listed in index.json and builds the model.
   * @param {object} config - a merged ClipPlayer config (needs `dataUrl`).
   * @returns {Promise<object>} the archive model.
   */
  ClipPlayer.loadArchive = async function loadArchive(config) {
    const dataUrl = new URL(config.dataUrl, window.location.href);
    const index = await fetchJson(new URL("index.json", dataUrl));
    const entries = normalizeIndex(index);

    if (!entries.length) {
      throw new Error("Clip archive index is empty.");
    }

    // One request per playlist, all in flight at once. Playlists are small and
    // immutable in practice, so `force-cache` makes repeat visits free.
    const files = entries.flatMap(entry => entry.files);
    const loaded = await Promise.all(
      files.map(async filename => [filename, await fetchJson(new URL(encodeURIComponent(filename), dataUrl))])
    );

    return buildModel(entries, Object.fromEntries(loaded), config);
  };

  async function fetchJson(url) {
    const response = await fetch(url.href, { cache: "force-cache" });

    if (!response.ok) {
      throw new Error(`Clip archive request failed (${response.status}): ${url.href}`);
    }

    return response.json();
  }

  /**
   * index.json comes in two shapes:
   *
   *   ["0 First stream.json", "1 Second stream.json"]        // auto-grouped
   *   { "folders": [{ "label": "2024", "files": [...] }] }   // explicit
   *
   * Both normalize to [{ label, files }]. The array form buckets files by the
   * leading number in their filename ("0-10", "11-20", …) so a long archive
   * does not render as one endless list.
   */
  function normalizeIndex(index) {
    if (index && Array.isArray(index.folders)) {
      return index.folders
        .filter(folder => folder && Array.isArray(folder.files) && folder.files.length)
        .map((folder, position) => ({
          label: String(folder.label ?? `Folder ${position + 1}`),
          files: folder.files.filter(file => typeof file === "string"),
        }));
    }

    if (!Array.isArray(index)) return [];

    const files = sortPlaylistFiles(index.filter(file => typeof file === "string"));
    const buckets = new Map();

    files.forEach(filename => {
      const label = buildRangeLabel(playlistOrder(filename));
      if (!buckets.has(label)) buckets.set(label, { label, files: [] });
      buckets.get(label).files.push(filename);
    });

    return [...buckets.values()];
  }

  function buildModel(entries, rawPlaylists, config) {
    const folders = [];
    const playlists = [];
    const clips = [];
    const clipsById = new Map();
    const clipsByShareId = new Map();

    entries.forEach((entry, folderIndex) => {
      const folder = {
        id: `folder:${folderIndex}:${entry.label}`,
        label: entry.label,
        playlists: [],
      };

      entry.files.forEach(filename => {
        const order = playlistOrder(filename);
        const playlist = {
          id: `playlist:${filename}`,
          filename,
          order,
          folderId: folder.id,
          label: playlistLabel(filename),
          clips: [],
        };

        const { header, items } = normalizePlaylist(rawPlaylists[filename]);
        playlist.clips = items.map((item, index) =>
          buildClip({ ...header, ...item }, playlist, index, config)
        );

        playlist.clips.forEach(clip => {
          clips.push(clip);
          clipsById.set(clip.id, clip);
          registerShareId(clip, clipsByShareId);
        });

        playlists.push(playlist);
        folder.playlists.push(playlist);
      });

      folders.push(folder);
    });

    return { folders, playlists, clips, clipsById, clipsByShareId };
  }

  /**
   * Accepts the structured per-video form `{ youtubeUrl, date, clips: [...] }`
   * and the flat form `[{ title, youtubeUrl, start, end }, ...]`. In the
   * structured form the top-level fields are defaults every clip may override,
   * which is what makes "one long stream, many clips" cheap to author.
   */
  function normalizePlaylist(raw) {
    if (Array.isArray(raw)) {
      return { header: {}, items: raw };
    }

    // `songs` is accepted as an alias so archives written against the original
    // music-archive schema load unchanged.
    const items = raw && (raw.clips || raw.songs);
    if (Array.isArray(items)) {
      const { clips, songs, ...header } = raw;
      return { header, items };
    }

    return { header: {}, items: [] };
  }

  function buildClip(item, playlist, index, config) {
    const parsed = parseClipTitle(item.title || "", config);
    const playback = buildPlayback(item);
    const thumbnail = typeof item.thumbnail === "string" ? item.thumbnail.trim() : "";

    // Stable share identity: a clip is "this video at this start time", which
    // survives renaming or reordering the JSON files (the array-index id does
    // not). Clips with no video fall back to file + title + artist.
    const shareKey =
      playback.type === "youtube"
        ? `yt:${playback.videoId}:${playback.startSeconds}`
        : `ns:${playlist.filename}:${parsed.title}:${parsed.artist}`;

    return {
      id: `${playlist.id}::${index}`,
      shareKey,
      shareId: shortHash(shareKey),
      title: parsed.title,
      artist: parsed.artist,
      date: normalizeDate(item.date) || parsed.date,
      source: playlist.label,
      playback,
      thumbnail: thumbnail || buildYouTubeThumbnail(playback.videoId),
      hasSource: playback.type === "youtube",
      playlistId: playlist.id,
      folderId: playlist.folderId,
      label: parsed.artist ? `${parsed.title} by ${parsed.artist}` : parsed.title,
    };
  }

  function buildPlayback(item) {
    const sourceUrl = typeof item.youtubeUrl === "string" ? item.youtubeUrl.trim() : "";
    const videoId = extractYouTubeId(sourceUrl);

    if (!videoId) {
      return { type: "none", sourceUrl: "", videoId: "", startSeconds: 0, endSeconds: null };
    }

    return {
      type: "youtube",
      sourceUrl,
      videoId,
      startSeconds: parseTimecode(item.start) ?? 0,
      endSeconds: parseTimecode(item.end),
    };
  }

  // --- share ids -------------------------------------------------------------

  // 32-bit FNV-1a as 8 hex chars. Synchronous and dependency-free (unlike
  // crypto.subtle, which is async and secure-context only) so share links work
  // identically on file://, http and https.
  function shortHash(input) {
    let value = 2166136261;

    for (let index = 0; index < input.length; index += 1) {
      value ^= input.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }

    return (value >>> 0).toString(16).padStart(8, "0");
  }

  function registerShareId(clip, clipsByShareId) {
    let shareId = clip.shareId;
    let salt = 1;

    // Vanishingly unlikely at archive scale, but keep ids unique if two clips
    // hash alike by re-hashing with a salt until a free slot is found.
    while (clipsByShareId.has(shareId)) {
      shareId = shortHash(`${clip.shareKey}#${salt}`);
      salt += 1;
    }

    clip.shareId = shareId;
    clipsByShareId.set(shareId, clip);
  }

  // --- filename / title parsing ---------------------------------------------

  function playlistOrder(filename) {
    const match = filename.match(/^(\d+(?:\.\d+)?)/);
    return match ? Number.parseFloat(match[1]) : -1;
  }

  function sortPlaylistFiles(files) {
    return [...files].sort((left, right) => {
      const difference = playlistOrder(left) - playlistOrder(right);
      return difference || left.localeCompare(right);
    });
  }

  function playlistLabel(filename) {
    return filename.replace(/\.json$/i, "").trim();
  }

  function buildRangeLabel(order) {
    if (order < 0) return "Other";
    if (order <= 10) return "0-10";
    const start = Math.floor((order - 1) / 10) * 10 + 1;
    return `${start}-${start + 9}`;
  }

  /**
   * Splits "Some Title by Some Artist (3/14/25)" into its parts. Both the
   * " by " separator and the trailing date are optional; anything unrecognised
   * stays in the title. Override `config.parseTitle` for a different scheme.
   */
  function parseClipTitle(rawTitle, config) {
    if (typeof config.parseTitle === "function") {
      const custom = config.parseTitle(rawTitle) || {};
      return {
        title: custom.title || config.strings.untitled,
        artist: custom.artist || "",
        date: normalizeDate(custom.date) || "",
      };
    }

    const normalized = String(rawTitle || "").trim();
    const extracted = extractDateFromTitle(normalized);
    const markerIndex = extracted.cleaned.toLowerCase().lastIndexOf(" by ");

    if (markerIndex === -1) {
      return { title: extracted.cleaned || config.strings.untitled, artist: "", date: extracted.date };
    }

    return {
      title: extracted.cleaned.slice(0, markerIndex).trim() || config.strings.untitled,
      artist: extracted.cleaned.slice(markerIndex + 4).trim(),
      date: extracted.date,
    };
  }

  function extractDateFromTitle(rawTitle) {
    if (!rawTitle) return { cleaned: "", date: "" };

    const parenDate = rawTitle.match(/\((\d{1,2}\s*[,/.-]\s*\d{1,2}\s*[,/.-]\s*\d{2,4})\)\s*$/);
    if (parenDate) {
      return { cleaned: rawTitle.slice(0, parenDate.index).trim(), date: normalizeDate(parenDate[1]) };
    }

    const plainDate = rawTitle.match(/(\d{1,2}\s*[,/.-]\s*\d{1,2}\s*[,/.-]\s*\d{2,4})\s*$/);
    if (plainDate) {
      return { cleaned: rawTitle.slice(0, plainDate.index).trim(), date: normalizeDate(plainDate[1]) };
    }

    return { cleaned: rawTitle.trim(), date: "" };
  }

  /** Normalises the accepted date spellings to `YYYY.MM.DD`. */
  function normalizeDate(rawDate) {
    if (!rawDate || typeof rawDate !== "string") return "";

    const value = rawDate.trim();

    const isoMatch = value.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
    if (isoMatch) {
      const [, year, month, day] = isoMatch;
      return `${year}.${month.padStart(2, "0")}.${day.padStart(2, "0")}`;
    }

    // M/D/YY and M/D/YYYY, the form that shows up inside clip titles.
    const shortMatch = value.match(/(\d{1,2})\s*[,/.-]\s*(\d{1,2})\s*[,/.-]\s*(\d{2,4})/);
    if (shortMatch) {
      let [, month, day, year] = shortMatch;
      if (year.length === 2) year = `20${year}`;
      return `${year}.${month.padStart(2, "0")}.${day.padStart(2, "0")}`;
    }

    return "";
  }

  /** Accepts `90`, `"1:30"` and `"1:02:03"`; returns seconds, or null. */
  function parseTimecode(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, value);
    }

    if (typeof value !== "string") return null;

    const parts = value.trim().split(":").map(part => Number.parseInt(part, 10));
    if (!parts.length || parts.some(Number.isNaN)) return null;

    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  /** Pulls the video id out of watch, youtu.be, /live/ and /embed/ URLs. */
  function extractYouTubeId(url) {
    if (!url || typeof url !== "string") return "";

    try {
      const parsed = new URL(url);

      if (parsed.hostname === "youtu.be") {
        return parsed.pathname.replace("/", "");
      }

      if (parsed.searchParams.has("v")) {
        return parsed.searchParams.get("v") || "";
      }

      const liveMatch = parsed.pathname.match(/\/live\/([^/]+)/);
      if (liveMatch) return liveMatch[1];

      const embedMatch = parsed.pathname.match(/\/embed\/([^/]+)/);
      if (embedMatch) return embedMatch[1];
    } catch (error) {
      return "";
    }

    return "";
  }

  function buildYouTubeThumbnail(videoId) {
    return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
  }

  // Exposed for tests and for hosts that want to reuse the parsing rules.
  ClipPlayer.parse = { parseTimecode, extractYouTubeId, normalizeDate, shortHash };
})();
