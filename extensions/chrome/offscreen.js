let capture = null;
let generation = 0;
const MAX_BUFFERED_AUDIO_SECONDS = 0.2;

function publish(status) {
  chrome.runtime.sendMessage({ type: "CAPTURE_STATUS", status }).catch(() => {});
}

function normalizeCode(value) {
  return String(value || "").replace(/[^a-f0-9]/gi, "").toUpperCase();
}

async function connectBridge(hello, current, isCurrent) {
  let lastError = null;
  for (let port = 39847; port <= 39857; port += 1) {
    if (!isCurrent()) throw new Error("Capture cancelled.");
    try {
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/uzjam-tab-audio`);
        current.socket = socket;
        socket.binaryType = "arraybuffer";
        const finish = (error) => {
          clearTimeout(timeout);
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("error", onError);
          socket.removeEventListener("close", onClose);
          if (error) {
            try { socket.close(); } catch (_error) {}
            reject(error);
          } else resolve(socket);
        };
        const onOpen = () => {
          if (!isCurrent()) return finish(new Error("Capture cancelled."));
          try { socket.send(JSON.stringify(hello)); } catch (error) { finish(error); }
        };
        const onMessage = (event) => {
          if (typeof event.data !== "string") return;
          let message;
          try { message = JSON.parse(event.data); } catch (_error) { return; }
          if (message.type === "ready" && message.protocol === 1) finish(isCurrent() ? null : new Error("Capture cancelled."));
          else if (message.type === "error") finish(new Error(message.message || "UZjam rejected the connection."));
        };
        const onError = () => finish(new Error("UZjam is not listening on this port."));
        const onClose = () => finish(new Error("The UZjam connection closed before it was ready."));
        const timeout = setTimeout(() => finish(new Error("Timed out while connecting to UZjam.")), 700);
        socket.addEventListener("open", onOpen);
        socket.addEventListener("message", onMessage);
        socket.addEventListener("error", onError);
        socket.addEventListener("close", onClose);
      });
    } catch (error) {
      if (!isCurrent()) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("Open the UZjam desktop app, then try again.");
}

async function disposeCapture(current, notifyDesktop) {
  if (!current || current.disposed) return;
  current.disposed = true;
  if (current.node) current.node.port.onmessage = null;
  if (notifyDesktop && current.socket?.readyState === WebSocket.OPEN) {
    try { current.socket.send(JSON.stringify({ type: "stopped" })); } catch (_error) {}
  }
  for (const node of [current.source, current.node, current.silentGain]) {
    try { node?.disconnect(); } catch (_error) {}
  }
  current.stream?.getTracks().forEach((track) => track.stop());
  try { current.socket?.close(); } catch (_error) {}
  try { await current.context?.close(); } catch (_error) {}
}

async function stopCapture(notifyDesktop = true, errorMessage = null) {
  const token = ++generation;
  const current = capture;
  capture = null;
  await disposeCapture(current, notifyDesktop);
  if (token === generation) publish(errorMessage ? { state: "error", message: errorMessage } : { state: "idle" });
}

async function startCapture(message) {
  const token = ++generation;
  const previous = capture;
  capture = null;
  await disposeCapture(previous, true);
  if (token !== generation) return { ok: false, cancelled: true };
  const current = { stream: null, context: null, socket: null, disposed: false };
  capture = current;
  const isCurrent = () => token === generation && capture === current && !current.disposed;
  try {
    const pairingCode = normalizeCode(message.pairingCode);
    if (pairingCode.length !== 10) throw new Error("Enter the 10-character pairing code shown in UZjam.");
    publish({ state: "connecting", tabTitle: message.tabTitle });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: message.streamId } },
      video: false
    });
    // Stop/new capture may have occurred while Chrome was granting access.
    if (!isCurrent()) {
      stream.getTracks().forEach((track) => track.stop());
      return { ok: false, cancelled: true };
    }
    current.stream = stream;
    const context = current.context = new AudioContext({ latencyHint: "interactive" });
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) throw new Error("Chrome did not provide tab audio.");
    const settings = audioTrack.getSettings ? audioTrack.getSettings() : {};
    const channels = Math.max(1, Math.min(2, Number(settings.channelCount) || 2));
    const hello = { type: "hello", protocol: 1, pairingCode, sampleRateHz: context.sampleRate, channels: 2,
      tabTitle: String(message.tabTitle || "Chrome tab").slice(0, 120), browser: "Google Chrome" };
    const socket = await connectBridge(hello, current, isCurrent);
    if (!isCurrent()) return { ok: false, cancelled: true };
    await context.audioWorklet.addModule("pcm-worklet.js");
    if (!isCurrent()) return { ok: false, cancelled: true };
    if (socket.readyState !== WebSocket.OPEN) throw new Error("The UZjam desktop connection closed while audio was starting.");
    const source = current.source = context.createMediaStreamSource(stream);
    const node = current.node = new AudioWorkletNode(context, "uzjam-pcm-capture", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: channels, channelCountMode: "explicit"
    });
    const silentGain = current.silentGain = context.createGain();
    silentGain.gain.value = 0;
    const maxQueuedBytes = context.sampleRate * 2 * Float32Array.BYTES_PER_ELEMENT * MAX_BUFFERED_AUDIO_SECONDS;
    node.port.onmessage = (event) => {
      if (!isCurrent() || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount + event.data.byteLength > maxQueuedBytes) {
        stopCapture(false, "The desktop connection fell behind. Reconnect the tab to resume live audio.");
        return;
      }
      try { socket.send(event.data); }
      catch (_error) { stopCapture(false, "The UZjam desktop connection could not receive audio."); }
    };
    source.connect(node);
    node.connect(silentGain).connect(context.destination);
    audioTrack.addEventListener("ended", () => { if (isCurrent()) stopCapture(false); }, { once: true });
    socket.addEventListener("message", (event) => {
      if (!isCurrent() || typeof event.data !== "string") return;
      try {
        const control = JSON.parse(event.data);
        if (control.type === "stop") stopCapture(false);
        if (control.type === "error") stopCapture(false, control.message || "UZjam rejected the audio stream.");
      } catch (_error) {}
    });
    socket.addEventListener("close", () => { if (isCurrent()) stopCapture(false, "The UZjam desktop connection closed."); });
    await context.resume();
    if (!isCurrent()) return { ok: false, cancelled: true };
    publish({ state: "streaming", tabTitle: hello.tabTitle, sampleRateHz: context.sampleRate });
    return { ok: true };
  } catch (error) {
    const active = isCurrent();
    if (active) capture = null;
    await disposeCapture(current, false);
    if (!active || token !== generation) return { ok: false, cancelled: true };
    const text = error.message || String(error);
    publish({ state: "error", message: text });
    return { ok: false, error: text };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return false;
  if (message.type === "START_CAPTURE") {
    startCapture(message).then(sendResponse);
    return true;
  }
  if (message.type === "STOP_CAPTURE") {
    stopCapture().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
