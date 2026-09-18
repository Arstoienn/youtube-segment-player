"use strict";

/**
 * Loading a folder of JSON into the model the rest of the player reads.
 *
 * Two things are worth pinning down here. One is the promise the docs make about
 * authoring: the structured form's top-level fields are defaults every clip
 * inherits, which is the whole reason "one long stream, many clips" is cheap to
 * write. The other is that a share id is "this video at this start time" and
 * survives renaming and reordering the files - because a share link is a URL
 * somebody else is holding, and it going stale is not a private failure.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeFetch, realArchiveFiles } = require("./harness");

const VIDEO = "https://www.youtube.com/watch?v=TLkA0RELQ1g";
const OTHER = "https://youtu.be/gEPmA3USJdI";

/** Load an inline archive and hand back its model. */
function archive(files, overrides) {
  const ClipPlayer = load(["config.js", "archive.js"], { fetch: fakeFetch(files) });
  return ClipPlayer.loadArchive(ClipPlayer.mergeConfig(ClipPlayer.defaults, overrides));
}

test("the structured form: top-level fields are defaults every clip inherits", async () => {
  const model = await archive({
    "index.json": { folders: [{ label: "Season 1", files: ["Episode 1.json"] }] },
    "Episode 1.json": {
      youtubeUrl: VIDEO,
      date: "2006.03.24",
      clips: [
        { title: "Opening remarks", start: "3:35", end: "7:12" },
        { title: "Q&A", start: "1:02:10", end: "1:14:00" },
        { title: "A different video", youtubeUrl: OTHER, start: 0 },
      ],
    },
  });

  assert.equal(model.clips.length, 3, "every clip is in the play order");
  assert.equal(model.folders[0].label, "Season 1", "the folder keeps its label");

  const [first, second, third] = model.clips;
  assert.equal(first.playback.videoId, "TLkA0RELQ1g", "the video comes from the top level");
  assert.equal(first.playback.startSeconds, 215, "3:35");
  assert.equal(first.playback.endSeconds, 432, "7:12");
  assert.equal(first.date, "2006.03.24", "and so does the date");
  assert.equal(second.playback.startSeconds, 3730, "1:02:10");
  assert.equal(third.playback.videoId, "gEPmA3USJdI", "a clip may override the default video");
});

test("the flat form loads too, so an archive written the old way still works", async () => {
  const model = await archive({
    "index.json": ["0 First.json"],
    "0 First.json": [{ title: "One", youtubeUrl: VIDEO, start: "0:10", end: "0:20" }],
  });

  assert.equal(model.clips.length, 1, "a bare array of clips");
  assert.equal(model.clips[0].playback.startSeconds, 10, "with its own times");
});

test("a clip with no usable video is kept, and marked as having no source", async () => {
  const model = await archive({
    "index.json": { folders: [{ label: "F", files: ["a.json"] }] },
    "a.json": { clips: [{ title: "No video here" }] },
  });

  const clip = model.clips[0];
  assert.equal(clip.hasSource, false, "the player must be able to skip it rather than crash on it");
  assert.equal(clip.playback.type, "none", "and know why");
  assert.equal(clip.title, "No video here", "it still shows in the tree");
});

test("share ids are the video and the start time, not the position in the file", async () => {
  const one = await archive({
    "index.json": { folders: [{ label: "F", files: ["a.json"] }] },
    "a.json": { youtubeUrl: VIDEO, clips: [{ title: "First", start: 10 }, { title: "Second", start: 20 }] },
  });

  // The same two clips, reordered, renamed, in a differently named file.
  const two = await archive({
    "index.json": { folders: [{ label: "Renamed", files: ["b.json"] }] },
    "b.json": { youtubeUrl: VIDEO, clips: [{ title: "Second, retitled", start: 20 }, { title: "First", start: 10 }] },
  });

  const byStart = model => new Map(model.clips.map(c => [c.playback.startSeconds, c.shareId]));
  const before = byStart(one);
  const after = byStart(two);

  assert.equal(after.get(10), before.get(10), "a share link survives the file being rewritten");
  assert.equal(after.get(20), before.get(20), "for every clip in it");
  assert.notEqual(before.get(10), before.get(20), "and two clips never share an id");
});

test("two clips that really are the same still get different ids", async () => {
  const model = await archive({
    "index.json": { folders: [{ label: "F", files: ["a.json"] }] },
    "a.json": { youtubeUrl: VIDEO, clips: [{ title: "Take one", start: 10 }, { title: "Take two", start: 10 }] },
  });

  const [a, b] = model.clips;
  assert.notEqual(a.shareId, b.shareId, "a deep link has to resolve to one clip");
  assert.equal(model.clipsByShareId.size, 2, "and both are reachable");
});

test("an index that names a file the archive does not have fails loudly", async () => {
  await assert.rejects(
    archive({ "index.json": { folders: [{ label: "F", files: ["missing.json"] }] } }),
    /404/,
    "a silent empty library would look like the player being broken",
  );
});

test("an empty index says so", async () => {
  await assert.rejects(archive({ "index.json": { folders: [] } }), /empty/i, "explicit but empty");
  await assert.rejects(archive({ "index.json": [] }), /empty/i, "the array form, empty");
});

test("malformed JSON is not swallowed", async () => {
  await assert.rejects(
    archive({ "index.json": "{ not json" }),
    "a typo in the archive should be reported, not rendered as no clips",
  );
});

test("the archive that ships in data/ loads", async () => {
  const model = await archive(realArchiveFiles());

  assert.ok(model.clips.length > 0, "there are clips");
  assert.ok(model.folders.length > 0, "in folders");
  assert.equal(model.clipsById.size, model.clips.length, "every clip is addressable by id");
  assert.equal(model.clipsByShareId.size, model.clips.length, "and by share id");

  for (const clip of model.clips) {
    assert.ok(clip.title, `every clip has a title (${clip.id})`);
    assert.match(clip.shareId, /^[0-9a-f]{8}$/, `and a well-formed share id (${clip.id})`);
    if (clip.hasSource) {
      assert.ok(clip.playback.videoId, `a clip with a source has a video id (${clip.id})`);
      assert.ok(
        clip.playback.endSeconds === null || clip.playback.endSeconds > clip.playback.startSeconds,
        `and ends after it starts (${clip.id})`,
      );
    }
  }
});
