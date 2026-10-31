import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildSync } from "esbuild";

// Exercise the actual application entry point and DOM event bindings, rather
// than reproducing its private editor functions in a unit test.
const bundle = buildSync({
  entryPoints: [new URL("../src/app.js", import.meta.url).pathname],
  bundle: true, write: false, format: "iife", platform: "browser", target: "es2020",
}).outputFiles[0].text;
const html = readFileSync(new URL("../../../dist/index.html", import.meta.url), "utf8");

function openApp(t, saved) {
  const dom = new JSDOM(html, { url: "https://uzjam.test", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLMediaElement.prototype.load = function () {};
  w.HTMLMediaElement.prototype.pause = function () {};
  w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  w.requestAnimationFrame = () => 0;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let sequence = 0;
  w.URL.createObjectURL = () => `blob:https://uzjam.test/${++sequence}`;
  w.URL.revokeObjectURL = () => {};
  const audioContexts = [];
  const parameter = () => ({ value: 0, setTargetAtTime(value) { this.value = value; } });
  const node = () => ({ connect() {}, disconnect() {}, gain: parameter(), frequency: parameter(), Q: parameter() });
  w.AudioContext = class {
    constructor() { this.sampleRate = 48_000; this.currentTime = 0; this.destination = node(); this.filters = []; this.gains = []; audioContexts.push(this); }
    resume() { return Promise.resolve(); }
    createMediaElementSource() { return node(); }
    createGain() { const result = node(); this.gains.push(result); return result; }
    createChannelSplitter() { return node(); }
    createChannelMerger() { return node(); }
    createAnalyser() { return { ...node(), frequencyBinCount: 1024 }; }
    createBiquadFilter() { const result = node(); this.filters.push(result); return result; }
  };
  if (saved) w.localStorage.setItem("uzjam-v2-state", JSON.stringify(saved));
  w.eval(bundle);
  const flush = () => w.dispatchEvent(new w.Event("pagehide"));
  const snapshot = () => { flush(); return JSON.parse(w.localStorage.getItem("uzjam-v2-state")); };
  return { w, document: w.document, snapshot, audioContexts };
}

function change(app, element, value) {
  element.value = value;
  element.dispatchEvent(new app.w.Event("input", { bubbles: true }));
  element.dispatchEvent(new app.w.Event("change", { bubbles: true }));
}

function importAudio(app, name = "test.wav") {
  const input = app.document.querySelector("#audioFileInput");
  Object.defineProperty(input, "files", { configurable: true, value: [new app.w.File(["test audio"], name, { type: "audio/wav" })] });
  input.dispatchEvent(new app.w.Event("change", { bubbles: true }));
}

test("fader and preamp events immediately update analysis, canonical state and reload", t => {
  const app = openApp(t);
  app.document.querySelector('[data-editor-style="faders"]').click();
  importAudio(app);
  app.document.querySelector("#playButton").click();
  const context = app.audioContexts[0];
  assert.ok(context, "play must construct the application's audio graph");
  const before = app.document.querySelector("#responsePath")?.getAttribute("d");
  change(app, app.document.querySelector('[data-fader-id="tone-sub"] .vertical-fader'), "6");
  change(app, app.document.querySelector('[data-fader-id="preamp"] .vertical-fader'), "-3");
  const saved = app.snapshot();
  assert.equal(saved.uzjamProfile.filters.find(f => f.id === "tone-sub").gainDb, 6);
  assert.equal(saved.uzjamProfile.dsp.preampDb, -3);
  // The graph's two physical channel chains receive the edited gain, and
  // protection is sent to the actual preamp AudioParam (using a Web Audio fake).
  assert.equal(context.filters.filter(filter => filter.frequency.value === 55 && filter.gain.value === 6).length, 2);
  assert.ok(context.gains[1].gain.value < 10 ** (-3 / 20));
  assert.notEqual(app.document.querySelector("#responsePath")?.getAttribute("d"), before);
  const reloaded = openApp(t, saved);
  assert.equal(reloaded.document.querySelector('[data-fader-id="tone-sub"] .vertical-fader').value, "6");
  assert.equal(reloaded.snapshot().uzjamProfile.dsp.preampDb, -3);
});

test("reselecting a local file after restart reconnects queue without duplicates", t => {
  const first = openApp(t);
  importAudio(first);
  const saved = first.snapshot();
  const libraryCount = saved.library.length;
  const queueIds = saved.queue.map(track => track.id);
  const reloaded = openApp(t, saved);
  importAudio(reloaded);
  const next = reloaded.snapshot();
  assert.equal(next.library.length, libraryCount);
  assert.deepEqual(next.queue.map(track => track.id), queueIds);
  assert.match(reloaded.document.querySelector("#audioElement").src, /^blob:/);
  assert.match(reloaded.document.querySelector("#toastStack").textContent, /Reconnected 1 track/);
  importAudio(reloaded);
  assert.equal(reloaded.snapshot().queue.length, queueIds.length);
});

test("Cancel and Close never save a profile, with empty or filled names", t => {
  const app = openApp(t);
  const count = app.snapshot().profiles.length;
  for (const name of ["", "Do not save"]) {
    for (const selector of ['button[value="cancel"].subtle', '.dialog-close']) {
      app.document.querySelector("#newProfileButton").click();
      app.document.querySelector("#newProfileName").value = name;
      app.document.querySelector(`#newProfileForm ${selector}`).click();
      assert.equal(app.document.querySelector("#newProfileDialog").open, false);
      assert.equal(app.snapshot().profiles.length, count);
    }
  }
  app.document.querySelector("#newProfileButton").click();
  app.document.querySelector("#newProfileName").value = "Keep this tuning";
  app.document.querySelector('#newProfileForm button[value="default"]').click();
  assert.equal(app.snapshot().profiles.length, count + 1);
});
