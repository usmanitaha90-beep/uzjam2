import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const offscreenCode = await readFile(new URL("../offscreen.js", import.meta.url), "utf8");
const backgroundCode = await readFile(new URL("../background.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function stream() {
  const track = { stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ channelCount: 2 }), addEventListener() {} };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}

function offscreen(t, options = {}) {
  const statuses = [], contexts = [], sockets = [], nodes = [];
  const timers = new Set();
  class Socket extends EventTarget {
    static OPEN = 1;
    constructor() { super(); this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); queueMicrotask(() => { if (this.readyState === 3) return; this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
    send(data) { this.sent.push(data); if (typeof data === "string" && JSON.parse(data).type === "hello") queueMicrotask(() => { if (this.readyState === 1) this.message({ type: "ready", protocol: 1 }); }); }
    message(value) { const event = new Event("message"); event.data = JSON.stringify(value); this.dispatchEvent(event); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const makeNode = () => ({ connect() { return this; }, disconnect() {}, gain: { value: 1 } });
  class Context {
    constructor() { contexts.push(this); this.sampleRate = 48_000; this.destination = {}; this.closed = false; this.audioWorklet = { addModule: () => options.moduleGate?.promise || Promise.resolve() }; }
    createMediaStreamSource() { return makeNode(); }
    createGain() { return makeNode(); }
    resume() { return options.resumeGate?.promise || Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
  }
  const value = options.stream || stream();
  let mediaCalls = 0;
  const context = vm.createContext({
    chrome: { runtime: { sendMessage: async message => { statuses.push(message.status); }, onMessage: { addListener() {} } } },
    navigator: { mediaDevices: { getUserMedia: () => options.mediaGate?.promise || Promise.resolve(mediaCalls++ === 0 ? value : stream()) } },
    AudioContext: Context, WebSocket: Socket, AudioWorkletNode: class { constructor() { Object.assign(this, makeNode()); this.port = {}; nodes.push(this); } },
    setTimeout(callback, delay) { const id = setTimeout(() => { timers.delete(id); callback(); }, delay); timers.add(id); return id; },
    clearTimeout(id) { timers.delete(id); clearTimeout(id); }
  });
  vm.runInContext(offscreenCode, context);
  t.after(async () => { await context.stopCapture(false); timers.forEach(clearTimeout); });
  return { context, statuses, contexts, sockets, nodes, stream: value, start: () => context.startCapture({ pairingCode: "AABBCCDDEE", streamId: "id", tabTitle: "Music" }) };
}

test("Stop while permission is pending closes the eventual stream without starting audio", async t => {
  const gate = deferred();
  const app = offscreen(t, { mediaGate: gate });
  const pending = app.start();
  await tick();
  await app.context.stopCapture();
  gate.resolve(app.stream);
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(app.stream.track.stopped, true);
  assert.equal(app.contexts.length, 0);
  assert.equal(app.sockets.length, 0);
  assert.equal(app.statuses.at(-1).state, "idle");
});

test("Stop during worklet loading disposes the provisional connection and never reports streaming", async t => {
  const gate = deferred();
  const app = offscreen(t, { moduleGate: gate });
  const pending = app.start();
  await tick(); await tick();
  await app.context.stopCapture();
  gate.resolve();
  assert.equal((await pending).cancelled, true);
  assert.equal(app.stream.track.stopped, true);
  assert.equal(app.contexts[0].closed, true);
  assert.equal(app.sockets[0].readyState, 3);
  assert.equal(app.statuses.some(status => status.state === "streaming"), false);
});

test("a stalled desktop transport stops capture rather than queueing stale PCM", async t => {
  const app = offscreen(t);
  assert.equal((await app.start()).ok, true);
  const socket = app.sockets[0];
  socket.bufferedAmount = 80_000;
  app.nodes[0].port.onmessage({ data: new ArrayBuffer(4096) });
  await tick();
  assert.equal(socket.sent.filter(data => typeof data !== "string").length, 0);
  assert.equal(app.stream.track.stopped, true);
  assert.equal(app.contexts[0].closed, true);
  assert.equal(app.statuses.at(-1).state, "error");
  assert.match(app.statuses.at(-1).message, /fell behind/);
});

test("old socket events cannot stop a newer capture", async t => {
  const app = offscreen(t);
  assert.equal((await app.start()).ok, true);
  const old = app.sockets[0];
  assert.equal((await app.start()).ok, true);
  old.message({ type: "error", message: "Old failure" });
  old.dispatchEvent(new Event("close"));
  await tick();
  assert.equal(app.statuses.at(-1).state, "streaming");
  assert.equal(app.sockets[1].readyState, 1);
  assert.equal(app.contexts[1].closed, false);
});

test("a connection lost during worklet loading never reports successful capture", async t => {
  const gate = deferred();
  const app = offscreen(t, { moduleGate: gate });
  const pending = app.start();
  await tick(); await tick();
  app.sockets[0].close();
  gate.resolve();
  assert.equal((await pending).ok, false);
  assert.equal(app.statuses.some(status => status.state === "streaming"), false);
  assert.equal(app.stream.track.stopped, true);
  assert.equal(app.contexts[0].closed, true);
});

function background(options = {}) {
  let listener;
  const sent = [], captured = [];
  let creates = 0;
  const chrome = {
    runtime: { getURL: p => p, getContexts: async () => [], sendMessage: async message => { sent.push(message); return { ok: true }; }, onMessage: { addListener(fn) { listener = fn; } }, onInstalled: { addListener() {} } },
    tabs: { query: async () => [{ id: 7 }] },
    tabCapture: { getMediaStreamId: async input => { captured.push(input.targetTabId); return options.streamGate?.promise || "stream-id"; } },
    offscreen: { createDocument: async () => { creates += 1; if (options.creationGate) await options.creationGate.promise; } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    storage: { session: { set: async () => {} } }
  };
  vm.runInNewContext(backgroundCode, { chrome });
  return { sent, captured, creates: () => creates, message: input => new Promise(resolve => listener(input, {}, resolve)) };
}

test("background rejects a tab without the current invocation grant", async () => {
  const app = background();
  const result = await app.message({ type: "START_CAPTURE", tabId: 8 });
  assert.equal(result.ok, false);
  assert.match(result.error, /on the tab/);
  assert.deepEqual(app.captured, []);
});

test("background Stop cancels pending startup and serializes offscreen creation", async () => {
  const gate = deferred();
  const app = background({ creationGate: gate });
  const start = app.message({ type: "START_CAPTURE", tabId: 7 });
  await tick();
  const stop = app.message({ type: "STOP_CAPTURE" });
  await tick();
  assert.equal(app.creates(), 1);
  gate.resolve();
  assert.equal((await start).cancelled, true);
  assert.equal((await stop).ok, true);
  assert.deepEqual(app.sent.map(message => message.type), ["STOP_CAPTURE"]);
});
