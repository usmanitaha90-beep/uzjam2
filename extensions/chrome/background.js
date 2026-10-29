const OFFSCREEN_PATH = "offscreen.html";

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Capture the user-selected Chrome tab and stream PCM to the local UZjam desktop app."
  });
}

async function updateBadge(status) {
  const live = status && status.state === "streaming";
  const attention = status && status.state === "error";
  await chrome.action.setBadgeText({ text: live ? "EQ" : attention ? "!" : "" });
  if (live || attention) {
    await chrome.action.setBadgeBackgroundColor({ color: live ? "#7C5CFF" : "#D85872" });
  }
  await chrome.storage.session.set({ captureStatus: status || { state: "idle" } });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target === "offscreen") return false;
  if (message.type === "START_CAPTURE") {
    (async () => {
      try {
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId });
        await ensureOffscreenDocument();
        const response = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "START_CAPTURE",
          streamId,
          pairingCode: message.pairingCode,
          tabTitle: message.tabTitle
        });
        sendResponse(response || { ok: true });
      } catch (error) {
        const status = { state: "error", message: error.message || String(error) };
        await updateBadge(status);
        sendResponse({ ok: false, error: status.message });
      }
    })();
    return true;
  }

  if (message.type === "STOP_CAPTURE") {
    (async () => {
      await ensureOffscreenDocument();
      const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_CAPTURE" });
      await updateBadge({ state: "idle" });
      sendResponse(response || { ok: true });
    })();
    return true;
  }

  if (message.type === "CAPTURE_STATUS") {
    updateBadge(message.status).catch(() => {});
    return false;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  updateBadge({ state: "idle" }).catch(() => {});
});
