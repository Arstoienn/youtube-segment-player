"use strict";

/**
 * `mergeConfig` is how a host page re-themes or translates the player, so what
 * matters about it is what it leaves alone: an override of one string must not
 * take the rest of that block with it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./harness");

const ClipPlayer = load(["config.js"]);
const { mergeConfig, defaults } = ClipPlayer;

test("an override reaches deep without flattening what it lands on", () => {
  const merged = mergeConfig(defaults, { strings: { nextLabel: "Nästa klipp" } });

  assert.equal(merged.strings.nextLabel, "Nästa klipp", "the string that was overridden");
  assert.equal(merged.strings.prevLabel, defaults.strings.prevLabel,
    "and every sibling it did not mention");
});

test("neither side is modified", () => {
  const overrides = { strings: { nextLabel: "changed" } };
  const before = defaults.strings.nextLabel;

  mergeConfig(defaults, overrides);

  assert.equal(defaults.strings.nextLabel, before, "the defaults are still the defaults");
  assert.deepEqual(overrides, { strings: { nextLabel: "changed" } }, "and the overrides are untouched");
});

test("no overrides at all is a copy of the defaults", () => {
  // Compared against `defaults` itself rather than a spread of it: both of those were made inside
  // the vm context, and deepStrictEqual checks prototypes, so a copy built out here would differ
  // for a reason that has nothing to do with the player. See test/harness.js.
  for (const nothing of [undefined, null, 0, ""]) {
    const merged = mergeConfig(defaults, nothing);
    assert.deepEqual(merged, defaults, `mergeConfig(defaults, ${JSON.stringify(nothing)})`);
    assert.notEqual(merged, defaults, "a copy, not the defaults themselves");
  }
});

test("undefined means \"leave it\", which is what an absent option looks like", () => {
  const merged = mergeConfig({ dataUrl: "data/", autoplay: true }, { dataUrl: undefined, autoplay: false });

  assert.equal(merged.dataUrl, "data/", "an option passed as undefined does not erase the default");
  assert.equal(merged.autoplay, false, "but false is a value, and replaces one");
});

test("arrays and functions are replaced whole rather than merged", () => {
  const handler = () => {};
  const merged = mergeConfig({ order: [1, 2, 3], onSelect: null }, { order: [9], onSelect: handler });

  assert.deepEqual(merged.order, [9], "an array override wins outright: merging indices would be nonsense");
  assert.equal(merged.onSelect, handler, "and a callback is a value");
});

test("a key the defaults have never heard of is kept", () => {
  const merged = mergeConfig(defaults, { mine: { nested: 1 } });
  assert.deepEqual(merged.mine, { nested: 1 }, "hosts may carry their own settings through");
});
