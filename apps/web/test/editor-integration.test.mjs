import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildSync } from "esbuild";
import { migrateCurrentV2State } from "@uzjam/contract";

// Exercise the actual application entry point and DOM event bindings, rather
// than reproducing its private editor functions in a unit test.
const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/app.js", import.meta.url))],
  bundle: true, write: false, format: "iife", platform: "browser", target: "es2020",
}).outputFiles[0].text;
const html = readFileSync(new URL("../../../dist/index.html", import.meta.url), "utf8");

function openApp(t, saved, sampleRate = 48_000) {
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
    constructor() { this.sampleRate = sampleRate; this.currentTime = 0; this.destination = node(); this.filters = []; this.gains = []; audioContexts.push(this); }
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

async function importPreset(app, profile) {
  const input = app.document.querySelector("#presetInput");
  Object.defineProperty(input, "files", { configurable: true, value: [{ text: async () => JSON.stringify(profile) }] });
  input.dispatchEvent(new app.w.Event("change", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
}

function sameProfile(actual, expected) {
  assert.deepEqual(actual.filters, expected.filters);
  assert.deepEqual(actual.dsp, expected.dsp);
  assert.deepEqual(actual.target, expected.target);
  assert.deepEqual(actual.deviceBinding, expected.deviceBinding);
  assert.equal(actual.id, expected.id);
  assert.equal(actual.name, expected.name);
  assert.equal(actual.metadata.createdAtUtc, expected.metadata.createdAtUtc);
  assert.equal(actual.metadata.source, expected.metadata.source);
}

test("canonical import preserves every filter kind, independent settings and metadata through reload", async t => {
  const app = openApp(t);
  const profile = migrateCurrentV2State({});
  profile.id = "imported-profile";
  profile.filters = ["lowPass", "highPass", "notch", "bandPass", "allPass", "peak", "lowShelf", "highShelf"].map((kind, index) => ({
    id: index === 3 ? "tone-sub" : "filter-" + index, kind,
    frequencyHz: 100 + index * 200, gainDb: index === 5 ? 25 : 0,
    q: 0.32 + index, channel: index % 2 ? "left" : "right", enabled: index !== 4,
  }));
  profile.dsp = { ...profile.dsp, enabled: false, preampDb: 17, manualHeadroomDb: 32, safetyMarginDb: 2.5, limiterEnabled: false };
  profile.target = { id: "reference", name: "Target", correctionStrength: 0.75 };
  profile.deviceBinding = { headphoneId: "he1000", outputDeviceId: "dac" };
  await importPreset(app, profile);
  const saved = app.snapshot();
  sameProfile(saved.uzjamProfile, profile);
  sameProfile(openApp(t, saved).snapshot().uzjamProfile, profile);
  app.document.querySelector("#undoButton").click();
  assert.notEqual(app.snapshot().uzjamProfile.id, profile.id);
  app.document.querySelector("#redoButton").click();
  sameProfile(app.snapshot().uzjamProfile, profile);
});

test("empty and tone-only canonical imports never retain the previous tuning", async t => {
  const app = openApp(t);
  for (const filters of [[], [{ id: "tone-sub", kind: "lowShelf", frequencyHz: 90, gainDb: 3, q: 1, enabled: true, channel: "right" }]]) {
    const profile = migrateCurrentV2State({});
    profile.filters = filters;
    await importPreset(app, profile);
    const saved = app.snapshot();
    sameProfile(saved.uzjamProfile, profile);
    sameProfile(openApp(t, saved).snapshot().uzjamProfile, profile);
  }
});

test("invalid or out-of-route canonical imports preserve the current profile", async t => {
  const app = openApp(t);
  const before = app.snapshot().uzjamProfile;
  const invalid = { ...before, schemaVersion: 999 };
  await importPreset(app, invalid);
  sameProfile(app.snapshot().uzjamProfile, before);
  const tooHigh = structuredClone(before);
  tooHigh.filters[0].frequencyHz = 48_000;
  await importPreset(app, tooHigh);
  sameProfile(app.snapshot().uzjamProfile, before);
  assert.match(app.document.querySelector("#toastStack").textContent, /could not be imported/);
});

test("pass filters use linear-to-decibel Q conversion in the Web Audio route", async t => {
  const app = openApp(t, null, 44_100);
  const profile = migrateCurrentV2State({});
  profile.filters = [{ id: "pass", kind: "lowPass", frequencyHz: 20_000, gainDb: 0, q: 0.707, enabled: true, channel: "stereo" }];
  await importPreset(app, profile);
  importAudio(app);
  app.document.querySelector("#playButton").click();
  const filters = app.audioContexts[0].filters.filter(f => f.type === "lowpass");
  assert.equal(filters.length, 2);
  for (const filter of filters) {
    assert.equal(filter.frequency.value, 20_000);
    assert.ok(Math.abs(filter.Q.value - 20 * Math.log10(0.707)) < 1e-10);
  }
});

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
