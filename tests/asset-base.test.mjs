import assert from "node:assert/strict";
import test from "node:test";

import { resolveAssetBase } from "../src/asset-base.ts";

const cdn = "https://cdn.jsdelivr.net/npm/midi-realplayer@1.2.3/dist/";

test("a dist file finds its assets next to itself", () => {
  assert.equal(
    resolveAssetBase("https://cdn.jsdelivr.net/npm/midi-realplayer@1.2.3/dist/midi-realplayer.js", "1.2.3"),
    cdn
  );
  assert.equal(
    resolveAssetBase("https://lab.example.org/static/mrp/midi-realplayer.iife.js", "1.2.3"),
    "https://lab.example.org/static/mrp/"
  );
  assert.equal(
    resolveAssetBase("https://unpkg.com/midi-realplayer@1.2.3/dist/midi-realplayer.js", "1.2.3"),
    "https://unpkg.com/midi-realplayer@1.2.3/dist/"
  );
});

test("bare CDN URLs and bundler output use the same version on jsDelivr", () => {
  for (const url of [
    "https://cdn.jsdelivr.net/npm/midi-realplayer",
    "https://cdn.jsdelivr.net/npm/midi-realplayer@1.2.3",
    "https://my.site/assets/index-3f2a9c.js",
    "http://localhost:5173/node_modules/.vite/deps/midi-realplayer.js",
    "not a url",
    undefined
  ]) {
    assert.equal(resolveAssetBase(url, "1.2.3"), cdn, String(url));
  }
});
