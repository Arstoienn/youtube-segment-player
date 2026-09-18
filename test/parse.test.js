"use strict";

/**
 * The parsing rules an archive is written against.
 *
 * These are the functions a typo in someone's JSON lands on, and the ones whose
 * answers end up in a share link - so they are the ones where a quiet change of
 * behaviour costs the most: a share link that stops resolving is a broken URL
 * somebody else is holding.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./harness");

const { parseTimecode, extractYouTubeId, normalizeDate, shortHash } =
  load(["config.js", "archive.js"]).parse;

test("parseTimecode accepts the three spellings the docs promise", () => {
  assert.equal(parseTimecode(90), 90, "a plain number of seconds");
  assert.equal(parseTimecode("90"), 90, "the same as a string");
  assert.equal(parseTimecode("1:30"), 90, "minutes and seconds");
  assert.equal(parseTimecode("1:02:03"), 3723, "hours, minutes and seconds");
  assert.equal(parseTimecode(" 1:30 "), 90, "surrounding space");
  assert.equal(parseTimecode(0), 0, "zero is a time, not a missing one");
});

test("parseTimecode says null rather than guessing", () => {
  assert.equal(parseTimecode(undefined), null, "a field that is not there");
  assert.equal(parseTimecode(null), null, "an explicit null");
  assert.equal(parseTimecode("soon"), null, "a word");
  assert.equal(parseTimecode(""), null, "an empty string");
  assert.equal(parseTimecode({}), null, "the wrong type entirely");
  assert.equal(parseTimecode(Number.NaN), null, "NaN");
  assert.equal(parseTimecode(Number.POSITIVE_INFINITY), null, "infinity");
});

test("parseTimecode never returns a negative time", () => {
  assert.equal(parseTimecode(-5), 0, "seeking before the start of a video is not a thing");
});

test("extractYouTubeId handles every URL shape YouTube hands out", () => {
  const id = "TLkA0RELQ1g";
  assert.equal(extractYouTubeId(`https://www.youtube.com/watch?v=${id}`), id, "a watch URL");
  assert.equal(extractYouTubeId(`https://www.youtube.com/watch?v=${id}&t=90s`), id, "with a timestamp on it");
  assert.equal(extractYouTubeId(`https://youtu.be/${id}`), id, "a short link");
  assert.equal(extractYouTubeId(`https://www.youtube.com/live/${id}`), id, "a live stream");
  assert.equal(extractYouTubeId(`https://www.youtube.com/embed/${id}`), id, "an embed");
  assert.equal(extractYouTubeId(`https://m.youtube.com/watch?v=${id}`), id, "the mobile host");
});

test("extractYouTubeId returns an empty id rather than throwing", () => {
  assert.equal(extractYouTubeId("not a url"), "", "something that is not a URL at all");
  assert.equal(extractYouTubeId("https://example.com/video"), "", "a URL with no id in it");
  assert.equal(extractYouTubeId(""), "", "an empty string");
  assert.equal(extractYouTubeId(undefined), "", "a missing field");
  assert.equal(extractYouTubeId(42), "", "the wrong type");
});

test("normalizeDate settles on YYYY.MM.DD", () => {
  assert.equal(normalizeDate("2006.03.24"), "2006.03.24", "already in the target form");
  assert.equal(normalizeDate("2006-3-4"), "2006.03.04", "ISO-ish, single digits padded");
  assert.equal(normalizeDate("2006/03/24"), "2006.03.24", "slashes");
  assert.equal(normalizeDate("3/24/06"), "2006.03.24", "the short form that turns up in titles");
  assert.equal(normalizeDate("3/24/2006"), "2006.03.24", "and its four-digit year");
  assert.equal(normalizeDate("  2006.03.24  "), "2006.03.24", "surrounding space");
});

test("normalizeDate returns an empty string for anything it cannot read", () => {
  assert.equal(normalizeDate("last Tuesday"), "", "prose");
  assert.equal(normalizeDate(""), "", "an empty string");
  assert.equal(normalizeDate(undefined), "", "a missing field");
  assert.equal(normalizeDate(20060324), "", "a number, which is not one of the accepted spellings");
});

test("shortHash is a stable eight hex characters", () => {
  const key = "yt:TLkA0RELQ1g:215";
  assert.match(shortHash(key), /^[0-9a-f]{8}$/, "the shape of a share id");
  assert.equal(shortHash(key), shortHash(key), "the same key gives the same id");
  assert.notEqual(shortHash(key), shortHash("yt:TLkA0RELQ1g:216"), "a second later is a different clip");
  assert.equal(shortHash(""), "811c9dc5", "the FNV-1a offset basis, unchanged");
});
