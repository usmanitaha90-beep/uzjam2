let capture = null;
let generation = 0;

function publish(status) {
  chrome.runtime.sendMessage({ type: "CAPTURE_STATUS", status }).catch(() => {});
}

function normalizeCode(value) {
  return String(value || "").replace(/[^a-f0-9]/gi, "").toUpperCase();
}

async function connectBridge(hello) {
  let lastError = null;
  for (let port = 39847; port <= 39857; port += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/uzjam-tab-audio`);
        socket.binaryType = "arraybuffer";
        const timeout = setTimeout(() => {
          socket.close();
          reject(new Error("Timed out while connecting to UZjam."));
        }, 700);
        socket.addEventListener("open", () => socket.send(JSON.stringify(hello)), { once: true });
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          let message;
          try { message = JSON.parse(event.data); } catch (_error) { return; }
          if (message.type === "ready") {
            clearTimeout(timeout);
            resolve(socket);
          } else if (message.type === "error") {
            clearTimeout(timeout);
            socket.close();
            reject(new Error(message.message || "UZjam rejected the connection."));
          }
        });
        socket.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("UZjam is not listening on this port."));
        }, { once: true });
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Open the UZjam desktop app, then try again.");
}

async function stopCapture(notifyDesktop = true) {
  const current = capture;
  capture = null;
  generation += 1;
  if (!current) {
    publish({ state: "idle" });
    return;
  }
  if (notifyDesktop && current.socket && current.socket.readyState === WebSocket.OPEN) {
    try { current.socket.send(JSON.stringify({ type: "stopped" })); } catch (_error) {}
  }
  try { current.node?.disconnect(); } catch (_error) {}
  try { current.silentGain?.disconnect(); } catch (_error) {}
  current.stream?.getTracks().forEach((track) => track.stop());
  try { current.socket?.close(); } catch (_error) {}
  try { await current.context?.close(); } catch (_error) {}
  publish({ state: "idle" });
}

async function startCapture(message) {
  await stopCapture();
  const currentGeneration = generation;
  const pairingCode = normalizeCode(message.pairingCode);
  if (pairingCode.length !== 10) throw new Error("Enter the 10-character pairing code shown in UZjam.");

  publish({ state: "connecting", tabTitle: message.tabTitle });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: message.streamId
      }
    },
    video: false
  });
  const context = new AudioContext({ latencyHint: "interactive" });
  const audioTrack = stream.getAudioTracks()[0];
  const settings = audioTrack?.getSettings ? audioTrack.getSettings() : {};
  const channels = Math.max(1, Math.min(2, Number(settings.channelCount) || 2));
  const hello = {
    type: "hello",
    protocol: 1,
    pairingCode,
    sampleRateHz: context.sampleRate,
    channels: 2,
    tabTitle: String(message.tabTitle || "Chrome tab").slice(0, 120),
    browser: "Google Chrome"
  };
  let socket;
  try {
    socket = await connectBridge(hello);
    await context.audioWorklet.addModule("pcm-worklet.js");
    if (currentGeneration !== generation) {
      socket.close();
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
      return;
    }
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "uzjam-pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: channels,
      channelCountMode: "explicit"
    });
    const silentGain = context.createGain();
    silentGain.gain.value = 0;
    node.port.onmessage = (event) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
    };
    source.connect(node);
    node.connect(silentGain).connect(context.destination);
    capture = { stream, context, source, node, silentGain, socket, tabTitle: hello.tabTitle };
    audioTrack.addEventListener("ended", () => stopCapture(false), { once: true });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        const control = JSON.parse(event.data);
        if (control.type === "stop") stopCapture(false);
        if (control.type === "error") {
          const message = control.message || "UZjam rejected the audio stream.";
          stopCapture(false).then(() => publish({ state: "error", message }));
        }
      } catch (_error) {}
    });
    socket.addEventListener("close", () => {
      if (capture && capture.socket === socket) {
        stopCapture(false);
        publish({ state: "error", message: "The UZjam desktop connection closed." });
      }
    });
    await context.resume();
    publish({ state: "streaming", tabTitle: hello.tabTitle, sampleRateHz: context.sampleRate });
  } catch (error) {
    try { socket?.close(); } catch (_closeError) {}
    stream.getTracks().forEach((track) => track.stop());
    try { await context.close(); } catch (_closeError) {}
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return false;
  if (message.type === "START_CAPTURE") {
    startCapture(message).then(() => sendResponse({ ok: true })).catch((error) => {
      const text = error.message || String(error);
      publish({ state: "error", message: text });
      sendResponse({ ok: false, error: text });
    });
    return true;
  }
  if (message.type === "STOP_CAPTURE") {
    stopCapture().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
