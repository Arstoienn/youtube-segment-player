# youtube-segment-player

Play start/end segments of long YouTube videos as a playlist.

You write JSON listing timestamps. You get a browsable library where each entry
plays just its stretch of video, then advances to the next one.

**[Live demo](https://arstoienn.github.io/youtube-segment-player/)** · no
dependencies, no build step

---

## Use it

```html
<link rel="stylesheet" href="src/css/clip-player.css" />

<div id="player"></div>

<script src="src/js/config.js"></script>
<script src="src/js/archive.js"></script>
<script src="src/js/tree-view.js"></script>
<script src="src/js/playback.js"></script>
<script src="src/js/media-keys.js"></script>
<script src="src/js/player.js"></script>
<script>
  ClipPlayer.mount({ el: "#player", dataUrl: "data/" });
</script>
```

An empty container gets a default copy of the markup. To control the structure
yourself, put the `data-clip-*` hooks in your own HTML and `mount()` uses it
untouched — [`index.html`](index.html) does exactly that, and is the reference
for which hooks exist.

`mount()` returns `{ destroy, next, previous, selectClip, getState }`.

---

## Your data

```jsonc
// data/index.json
{ "folders": [{ "label": "Season 1", "files": ["Episode 1.json"] }] }
```

```jsonc
// data/Episode 1.json — one video, many segments
{
  "youtubeUrl": "https://www.youtube.com/watch?v=TLkA0RELQ1g",
  "date": "2006.03.24",
  "clips": [
    { "title": "Opening remarks", "start": "3:35",    "end": "7:12" },
    { "title": "Q&A",             "start": "1:02:10", "end": "1:14:00" }
  ]
}
```

`start` and `end` accept `"1:02:10"`, `"3:35"` or a plain number of seconds.
Top-level fields are defaults every segment inherits.

Full reference → **[docs/DATA-FORMAT.md](docs/DATA-FORMAT.md)**

---

## Options

All optional; pass only what you're changing.

| Option | Default | |
|---|---|---|
| `el` | — | Container element or selector |
| `dataUrl` | `"data/"` | Folder holding `index.json` |
| `defaultArtist` | `"Uncredited"` | Shown when a title has no ` by ` part |
| `documentTitleSuffix` | `""` | `""` leaves `document.title` alone |
| `deepLinkParam` | `"clip"` | Share links look like `?clip=1a2b3c4d` |
| `features` | all `true` | `search`, `shuffle`, `share`, `mediaKeys`, `deepLinks` |
| `strings` | English | Every user-facing string — see `src/js/config.js` |
| `timing` | — | Four tuning knobs → [docs/TUNING.md](docs/TUNING.md) |
| `posters` | inline SVG | Standby and loading images |
| `parseTitle` | `null` | `title => { title, artist, date }` |

Colours are CSS custom properties on `:root` in `src/css/clip-player.css` —
redefine any of them after importing to re-theme. Markup is scoped under
`.clip-*`.

---

## Files

| | |
|---|---|
| `src/js/config.js` | Defaults, strings, posters, config merge |
| `src/js/archive.js` | JSON → segment model; timecodes, share ids |
| `src/js/tree-view.js` | Folder tree renderer |
| `src/js/playback.js` | Embed, segment ends, manual-seek detection, fallbacks |
| `src/js/media-keys.js` | Media-key bridge |
| `src/js/player.js` | `mount()`: state, shuffle, search, sharing |
| `src/css/clip-player.css` | All styles |

---

## Docs

- **[Data format](docs/DATA-FORMAT.md)** — index, playlists, timecodes, title parsing
- **[How it works](docs/HOW-IT-WORKS.md)** — segment ends, manual-seek detection, media keys
- **[Tuning](docs/TUNING.md)** — what the four timing constants guard against

---

## Notes

In the code and data, a segment is called a **clip** — `ClipPlayer.mount()`,
`"clips": [...]`, `.clip-*` classes.

Media keys need the [Media Session
API](https://developer.mozilla.org/docs/Web/API/Media_Session_API) (Chrome,
Edge, Safari; partial in Firefox) and are skipped silently elsewhere. If the
YouTube IFrame API never initialises, playback falls back to a plain iframe with
the bounds in the URL — segments still play, only auto-advance is lost.

Demo footage: Blender Foundation open movies, [CC BY
3.0](https://creativecommons.org/licenses/by/3.0/), embedded from their official
channels. Clip titles and timings are this repo's own.

MIT — see [LICENSE](LICENSE).
