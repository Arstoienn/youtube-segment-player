# Data format

Everything the player shows comes from a folder of static JSON files — the one
you point `dataUrl` at. There is no database and no build step: add a file, list
it in `index.json`, reload.

```
data/
├── index.json          ← which playlists exist, and how they're grouped
├── Episode 1.json      ← one video, many clips
└── Episode 2.json
```

---

## `index.json`

Two accepted shapes.

### Explicit folders (recommended)

You name the folders and decide what goes in them:

```json
{
  "folders": [
    { "label": "Season 1", "files": ["Episode 1.json", "Episode 2.json"] },
    { "label": "Season 2", "files": ["Episode 3.json"] }
  ]
}
```

### Flat list (auto-grouped)

A plain array is bucketed by the number at the front of each filename, into
folders labelled `0-10`, `11-20`, and so on. Useful for a long, numbered archive
where hand-maintaining folders would be busywork:

```json
["0 First stream.json", "1 Second stream.json", "11 Eleventh stream.json"]
```

Files without a leading number land in a folder called `Other`.

Filenames may contain spaces and non-ASCII characters; they're URL-encoded when
fetched. A playlist's displayed label is its filename minus `.json`.

---

## A playlist file

One video, and the clips cut out of it:

```json
{
  "youtubeUrl": "https://www.youtube.com/watch?v=TLkA0RELQ1g",
  "date": "2006.03.24",
  "clips": [
    { "title": "The machine hall", "start": "0:50", "end": "2:20" },
    { "title": "Walking the wires", "start": "3:00", "end": "4:20" }
  ]
}
```

The top-level fields are **defaults that every clip inherits**, which is what
makes "one long stream, thirty clips" cheap to write. Any clip can override any
of them:

```json
{
  "youtubeUrl": "https://www.youtube.com/watch?v=TLkA0RELQ1g",
  "date": "2006.03.24",
  "clips": [
    { "title": "Inherits the video above", "start": "0:50", "end": "2:20" },
    {
      "title": "A clip from a different video entirely",
      "youtubeUrl": "https://youtu.be/YE7VzlLtp-4",
      "date": "2008.04.10",
      "start": "1:40",
      "end": "2:35"
    }
  ]
}
```

### Clip fields

| Field | Required | Notes |
|---|---|---|
| `title` | yes | See *Title parsing* below |
| `start` | no | Defaults to `0` — the beginning of the video |
| `end` | no | Omit to play to the end of the video (no auto-advance point) |
| `youtubeUrl` | inherited | Per-clip override |
| `date` | inherited | Per-clip override |
| `thumbnail` | no | Defaults to the video's YouTube thumbnail |

A clip whose `youtubeUrl` is missing or unparseable still appears in the tree,
greyed out, and is skipped by next/previous. That's deliberate: it lets an
archive record something that existed but has no playable source.

### Timecodes

`start` and `end` accept:

| Written as | Means |
|---|---|
| `"7:12"` | 7 minutes 12 seconds |
| `"1:02:10"` | 1 hour 2 minutes 10 seconds |
| `432` | 432 seconds |

### Accepted video URLs

`watch?v=…`, `youtu.be/…`, `/live/…` and `/embed/…` all work — paste whatever
YouTube gave you.

### Dates

`"2006.03.24"`, `"2006-03-24"` and `"3/24/06"` all normalise to `2006.03.24`.
Anything unrecognised is dropped rather than shown raw.

---

## Title parsing

By default a title is split on `" by "` and a trailing date:

| `title` | Title | Artist | Date |
|---|---|---|---|
| `"Opening remarks"` | Opening remarks | *(falls back to `defaultArtist`)* | — |
| `"Live Demo by Ada Lovelace"` | Live Demo | Ada Lovelace | — |
| `"Closing keynote (3/24/06)"` | Closing keynote | — | 2006.03.24 |

Both parts are optional, and anything that doesn't match stays in the title.

If that convention doesn't suit your archive, replace it entirely:

```js
ClipPlayer.mount({
  el: "#player",
  parseTitle(raw) {
    const [speaker, ...rest] = raw.split(" — ");
    return { title: rest.join(" — "), artist: speaker };
  },
});
```

---

## The legacy flat form

A playlist file may also be a bare array, with every clip carrying its own
video:

```json
[
  { "title": "A clip", "youtubeUrl": "https://youtu.be/YE7VzlLtp-4", "start": "1:40", "end": "2:35" }
]
```

`"songs"` is accepted as an alias for `"clips"`, so archives written against the
original music-archive schema this was extracted from load unchanged.

---

## Share ids

Share links (`?clip=1a2b3c4d`) use an 8-character hash of *video id + start
time*, not the clip's position in the file. Reordering clips, renaming files or
regrouping folders therefore leaves existing links working; changing a clip's
`start` is what breaks them.
