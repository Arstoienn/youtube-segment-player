"use strict";

/**
 * Loads the player's source files the way a browser does, so they can be tested
 * without being changed.
 *
 * The scripts are classic scripts, not modules: each is an IIFE that hangs its
 * exports off `window.ClipPlayer`. That is a deliberate choice - it is what lets
 * the player be embedded with six `<script src>` tags and opened straight off
 * the disk with no server and no build step - and a test suite is not a reason
 * to give it up. So instead of rewriting the source to suit Node, this runs it
 * in a `vm` context holding exactly the globals a browser would have provided,
 * and reads the same `ClipPlayer` object the page would get.
 *
 * Each call gets a fresh context, so one test cannot leave state behind for the
 * next one.
 *
 * One thing to know when writing assertions against what comes back: objects the
 * player makes belong to the vm's realm, not this file's, so they have a
 * different `Object.prototype`. `assert.deepStrictEqual` compares prototypes, so
 * comparing a returned object against one literal-ed out here fails for a reason
 * that has nothing to do with the player. Compare it against another object the
 * player made, or against its own fields.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "..", "src", "js");

/**
 * @param {string[]} files - script filenames under src/js, in load order.
 * @param {object} [browser] - extra globals: `fetch`, `location`, `document`…
 * @returns {object} the context's `window.ClipPlayer`.
 */
function load(files, browser = {}) {
  const window = {
    location: { href: "https://player.test/index.html" },
    addEventListener() {},
    removeEventListener() {},
    ...browser,
  };
  window.window = window;

  const context = vm.createContext({
    window,
    document: browser.document,
    fetch: browser.fetch,
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });

  for (const file of files) {
    const source = fs.readFileSync(path.join(SRC, file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }

  return context.window.ClipPlayer;
}

/**
 * A `fetch` that serves an object of `{ "index.json": {...}, … }` and 404s
 * anything else, so a test can describe an archive inline instead of writing
 * files to disk.
 */
function fakeFetch(files) {
  return async url => {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop());

    if (!Object.prototype.hasOwnProperty.call(files, name)) {
      return { ok: false, status: 404, async json() { throw new Error("no body"); } };
    }

    const body = files[name];
    return {
      ok: true,
      status: 200,
      async json() {
        if (typeof body === "string") return JSON.parse(body);   // lets a test send malformed JSON
        return body;
      },
    };
  };
}

/** The archive that ships in data/, loaded from disk. */
function realArchiveFiles() {
  const dir = path.join(__dirname, "..", "data");
  const files = {};
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".json")) files[name] = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  }
  return files;
}

module.exports = { load, fakeFetch, realArchiveFiles };
