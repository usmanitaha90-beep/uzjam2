const pairingInput = document.querySelector("#pairingCode");
const pairingPanel = document.querySelector("#pairingPanel");
const statusPanel = document.querySelector("#statusPanel");
const statusTitle = document.querySelector("#statusTitle");
const statusText = document.querySelector("#statusText");
const stopButton = document.querySelector("#stopCapture");
const tabList = document.querySelector("#tabList");

function normalizeCode(value) {
  return String(value || "").replace(/[^a-f0-9]/gi, "").toUpperCase().slice(0, 10);
}

function showStatus(status) {
  status = status || { state: "idle" };
  statusPanel.dataset.state = status.state;
  if (status.state === "streaming") {
    statusTitle.textContent = "Playing through UZjam";
    statusText.textContent = status.tabTitle || "Chrome tab connected";
    stopButton.hidden = false;
  } else if (status.state === "connecting") {
    statusTitle.textContent = "Connecting to UZjam…";
    statusText.textContent = status.tabTitle || "Keep the desktop app open.";
    stopButton.hidden = true;
  } else if (status.state === "error") {
    statusTitle.textContent = "Needs attention";
    statusText.textContent = status.message || "Open UZjam and check the pairing code.";
    stopButton.hidden = true;
  } else {
    statusTitle.textContent = "Ready to connect";
    statusText.textContent = "Choose a Chrome tab below.";
    stopButton.hidden = true;
  }
}

function displayHost(url) {
  try { return new URL(url).hostname || new URL(url).protocol.replace(":", ""); }
  catch (_error) { return "Chrome"; }
}

async function renderTabs() {
  const tabs = await chrome.tabs.query({ windowType: "normal" });
  const available = tabs
    .filter((tab) => tab.id && tab.url && /^(https?|file):/i.test(tab.url))
    .sort((left, right) => Number(right.audible) - Number(left.audible));
  tabList.textContent = "";
  if (!available.length) {
    tabList.innerHTML = '<p class="empty">No capturable tabs are open.</p>';
    return;
  }
  for (const tab of available) {
    const row = document.createElement("div");
    row.className = "tab-item";
    const copy = document.createElement("div");
    copy.className = "tab-copy";
    const title = document.createElement("strong");
    if (tab.audible) {
      const audible = document.createElement("i");
      audible.className = "audible";
      title.appendChild(audible);
    }
    title.append(document.createTextNode(tab.title || "Untitled tab"));
    const host = document.createElement("span");
    host.textContent = displayHost(tab.url);
    copy.append(title, host);
    const connect = document.createElement("button");
    connect.textContent = tab.audible ? "Use audio" : "Connect";
    connect.addEventListener("click", async () => {
      const pairingCode = normalizeCode(pairingInput.value);
      if (pairingCode.length !== 10) {
        pairingInput.focus();
        showStatus({ state: "error", message: "Enter the pairing code shown in UZjam first." });
        return;
      }
      await chrome.storage.local.set({ pairingCode });
      showStatus({ state: "connecting", tabTitle: tab.title });
      const response = await chrome.runtime.sendMessage({
        type: "START_CAPTURE",
        tabId: tab.id,
        tabTitle: tab.title || "Chrome tab",
        pairingCode
      });
      if (!response || !response.ok) {
        showStatus({ state: "error", message: response?.error || "Chrome could not capture that tab." });
      }
    });
    row.append(copy, connect);
    tabList.appendChild(row);
  }
}

document.querySelector("#saveCode").addEventListener("click", async () => {
  const pairingCode = normalizeCode(pairingInput.value);
  pairingInput.value = pairingCode;
  if (pairingCode.length !== 10) {
    showStatus({ state: "error", message: "The UZjam code contains 10 letters and numbers." });
    return;
  }
  await chrome.storage.local.set({ pairingCode });
  pairingPanel.classList.add("paired");
  showStatus({ state: "idle" });
});

pairingInput.addEventListener("input", () => {
  pairingInput.value = normalizeCode(pairingInput.value);
});

stopButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
  showStatus({ state: "idle" });
});
document.querySelector("#refreshTabs").addEventListener("click", renderTabs);

chrome.storage.local.get("pairingCode").then(({ pairingCode }) => {
  pairingInput.value = normalizeCode(pairingCode);
  if (pairingInput.value.length === 10) pairingPanel.classList.add("paired");
});
chrome.storage.session.get("captureStatus").then(({ captureStatus }) => showStatus(captureStatus));
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CAPTURE_STATUS") showStatus(message.status);
});
renderTabs();
