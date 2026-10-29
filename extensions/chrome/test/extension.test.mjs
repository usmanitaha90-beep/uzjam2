import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const root = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");

describe("UZjam Chrome extension package", () => {
  it("uses Manifest V3 and the minimum exact-tab permissions", async () => {
    const manifest = JSON.parse(await read("manifest.json"));
    assert.equal(manifest.manifest_version, 3);
    assert.ok(Number(manifest.minimum_chrome_version) >= 116);
    assert.deepEqual(
      [...manifest.permissions].sort(),
      ["offscreen", "storage", "tabCapture", "tabs"].sort()
    );
    assert.deepEqual(manifest.host_permissions, ["ws://127.0.0.1/*"]);
  });

  it("keeps the native bridge on loopback and requires a pairing code", async () => {
    const offscreen = await read("offscreen.js");
    assert.match(offscreen, /ws:\/\/127\.0\.0\.1:/);
    assert.match(offscreen, /pairingCode/);
    assert.doesNotMatch(offscreen, /wss?:\/\/(?!127\.0\.0\.1)/);
  });

  it("captures a selected tab in an offscreen document and emits stereo PCM", async () => {
    const background = await read("background.js");
    const worklet = await read("pcm-worklet.js");
    assert.match(background, /getMediaStreamId\(\{ targetTabId:/);
    assert.match(background, /USER_MEDIA/);
    assert.match(worklet, /new Float32Array\(left\.length \* 2\)/);
    assert.match(worklet, /postMessage\(interleaved\.buffer/);
  });
});
