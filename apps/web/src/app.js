import { migrateCurrentV2State } from "@uzjam/contract";
import { BrowserUzjamEngineClient, serializeUzjamPresetFile, uzjamPresetFilename } from "@uzjam/engine-client";
import {
  APP_STATE_SCHEMA_VERSION,
  clearPersistedState,
  createSettingsBackup,
  loadPersistedState,
  readSettingsBackup,
  savePersistedState
} from "./persistence.js";
import { createSessionPersistence } from "./session-persistence.js";

(function () {
  "use strict";

  var localStateWasLoaded = false;
  var stateRecovery = null;
  var SAMPLE_RATE_FALLBACK = 48000;
  var GRAPH = { left: 52, right: 978, top: 28, bottom: 432, zero: 230, width: 926, height: 404 };
  var AUDIO_EXTENSIONS = ["flac", "alac", "wav", "aiff", "aif", "mp3", "m4a", "aac", "ogg", "opus"];
  var VIEW_META = {
    studio: ["LISTENING PROFILE", "UZjam — EQ Studio"],
    library: ["LOCAL LIBRARY", "UZjam — Library"],
    queue: ["PLAYBACK QUEUE", "UZjam — Queue"],
    signal: ["AUDIO ROUTING", "UZjam — Signal Path"],
    settings: ["DEVICE PREFERENCES", "UZjam — Settings"]
  };
  var BANK_SPECS = {
    10: { label: "10-band Standard", note: "Fast tonal shaping · fully parametric", limit: 12, q: 1.414, frequencies: [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] },
    15: { label: "15-band Precision", note: "More focus with ⅔-octave spacing", limit: 12, q: 2.145, frequencies: [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000] },
    30: { label: "30-band PEQ", note: "Surgical control · frequency, gain and Q unlocked", limit: 18, q: 4.318, frequencies: [25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000] }
  };
  var TONE_META = {
    "tone-sub": { key: "subBass", label: "Sub-bass", short: "SUB", range: "Depth & weight below 60 Hz" },
    "tone-punch": { key: "punch", label: "Punch", short: "PCH", range: "Kick & impact around 80–140 Hz" },
    "tone-warmth": { key: "warmth", label: "Warmth", short: "WARM", range: "Body & fullness around 150–350 Hz" },
    "tone-vocal": { key: "vocalFocus", label: "Vocal focus", short: "VOX", range: "Presence around 1.5–3.5 kHz" },
    "tone-energy": { key: "trebleEnergy", label: "Treble energy", short: "TREB", range: "Attack & brightness around 5–8 kHz" },
    "tone-air": { key: "air", label: "Air", short: "AIR", range: "Openness & shimmer above 10 kHz" }
  };

  function createStandardBands(count) {
    var spec = BANK_SPECS[count] || BANK_SPECS[10];
    return spec.frequencies.map(function (frequency, index) {
      return { id: "g" + count + "-" + (index + 1), type: "peaking", frequency: frequency, gain: 0, q: spec.q, channel: "both", enabled: true };
    });
  }

  function createToneBands() {
    return [
      { id: "tone-sub", type: "lowshelf", frequency: 55, gain: 0, q: .707, channel: "both", enabled: true },
      { id: "tone-punch", type: "peaking", frequency: 106, gain: 0, q: 1.7, channel: "both", enabled: true },
      { id: "tone-warmth", type: "peaking", frequency: 230, gain: 0, q: 1.15, channel: "both", enabled: true },
      { id: "tone-vocal", type: "peaking", frequency: 2300, gain: 0, q: 1.15, channel: "both", enabled: true },
      { id: "tone-energy", type: "peaking", frequency: 6300, gain: 0, q: 2.1, channel: "both", enabled: true },
      { id: "tone-air", type: "highshelf", frequency: 10500, gain: 0, q: .707, channel: "both", enabled: true }
    ];
  }

  function migrateToneBands(sourceBands) {
    var source = Array.isArray(sourceBands) ? sourceBands : [];
    var legacyFallbacks = {
      "tone-punch": "tone-bass",
      "tone-vocal": "tone-mids",
      "tone-energy": "tone-treble"
    };
    return createToneBands().map(function (band) {
      var match = source.find(function (item) { return item && item.id === band.id; });
      if (!match && legacyFallbacks[band.id]) {
        match = source.find(function (item) { return item && item.id === legacyFallbacks[band.id]; });
      }
      if (match && isFinite(Number(match.gain))) band.gain = clamp(Number(match.gain), -12, 12);
      return band;
    });
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uid(prefix) {
    return prefix + "-" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function round(value, places) {
    var power = Math.pow(10, places || 0);
    return Math.round(value * power) / power;
  }

  function formatSigned(value, places) {
    var amount = Number(value || 0).toFixed(places == null ? 1 : places);
    return (value > 0 ? "+" : value < 0 ? "−" : "") + Math.abs(Number(amount)).toFixed(places == null ? 1 : places);
  }

  function formatFrequency(value) {
    if (value >= 1000) {
      var scaled = value / 1000;
      return (scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)).replace(/\.0+$|(\.\d*[1-9])0+$/, "$1") + " kHz";
    }
    return Math.round(value) + " Hz";
  }

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return "0:00";
    var mins = Math.floor(seconds / 60);
    var secs = Math.floor(seconds % 60);
    return mins + ":" + String(secs).padStart(2, "0");
  }

  function titleFromFilename(name) {
    return String(name || "Untitled")
      .replace(/\.[^.]+$/, "")
      .replace(/^\d+[\s._-]+/, "")
      .replace(/[_]+/g, " ")
      .trim() || "Untitled";
  }

  function initials(text) {
    var parts = String(text || "UZ").trim().split(/\s+/).filter(Boolean);
    return (parts[0] ? parts[0][0] : "U") + (parts[1] ? parts[1][0] : parts[0] && parts[0][1] ? parts[0][1] : "Z");
  }

  var initialBands = [
    { id: "b1", type: "lowshelf", frequency: 62, gain: 5.0, q: 0.70, channel: "both", enabled: true },
    { id: "b2", type: "peaking", frequency: 125, gain: -1.2, q: 1.00, channel: "both", enabled: true },
    { id: "b3", type: "peaking", frequency: 250, gain: 0.8, q: 1.10, channel: "both", enabled: true },
    { id: "b4", type: "peaking", frequency: 500, gain: -1.4, q: 1.20, channel: "both", enabled: true },
    { id: "b5", type: "peaking", frequency: 1000, gain: 2.4, q: 1.10, channel: "both", enabled: true },
    { id: "b6", type: "peaking", frequency: 2000, gain: -0.7, q: 1.50, channel: "both", enabled: true },
    { id: "b7", type: "peaking", frequency: 4200, gain: -2.1, q: 2.00, channel: "both", enabled: true },
    { id: "b8", type: "peaking", frequency: 8000, gain: 1.1, q: 0.90, channel: "both", enabled: true },
    { id: "b9", type: "peaking", frequency: 12000, gain: 2.6, q: 0.80, channel: "both", enabled: true },
    { id: "b10", type: "highshelf", frequency: 16000, gain: 0.5, q: 0.70, channel: "both", enabled: true }
  ];

  var demoLibrary = [
    { id: "demo-1", title: "Paper Skies", artist: "Aiko Tan", album: "Afterimage", format: "FLAC 24/96", color: "#8b63ed", demo: true },
    { id: "demo-2", title: "Substrate", artist: "Boreal Systems", album: "Field Notes", format: "ALAC 24/48", color: "#367d89", demo: true },
    { id: "demo-3", title: "Mercury Room", artist: "Civic Ghost", album: "Silver Hours", format: "FLAC 16/44", color: "#a3485d", demo: true },
    { id: "demo-4", title: "Low Sun", artist: "Dusk Assembly", album: "Noon / Night", format: "WAV 24/96", color: "#bd743f", demo: true },
    { id: "demo-5", title: "Velvet Static", artist: "Ena Vale", album: "Soft Machines", format: "AIFF 24/48", color: "#715588", demo: true },
    { id: "demo-6", title: "Index of Light", artist: "Faint Signals", album: "Index", format: "FLAC 24/192", color: "#4c6a9b", demo: true },
    { id: "demo-7", title: "Greywater", artist: "Glass Harbour", album: "Undertow", format: "ALAC 16/44", color: "#547770", demo: true },
    { id: "demo-8", title: "Violet Arc", artist: "Hana Lune", album: "Arc Studies", format: "FLAC 24/96", color: "#7f55bd", demo: true },
    { id: "demo-9", title: "In Place", artist: "June Metric", album: "Small Hours", format: "AAC 256", color: "#8b6650", demo: true },
    { id: "demo-10", title: "The Quiet Engine", artist: "Kite Theory", album: "Motion", format: "FLAC 16/44", color: "#486c84", demo: true },
    { id: "demo-11", title: "Mica", artist: "North Vale", album: "Mineral", format: "WAV 24/48", color: "#6f6a73", demo: true },
    { id: "demo-12", title: "Receiver", artist: "Zero Gardens", album: "Open Circuit", format: "FLAC 24/96", color: "#866048", demo: true }
  ];

  var defaultProfiles = [
    { id: "profile-edition-xs", name: "HIFIMAN Edition XS", device: "Open-back planar", color: "#a77df5", bands: clone(initialBands), handling: "auto", manualHeadroom: 5.5, user: true },
    { id: "profile-night", name: "Late-night detail", device: "Low-level listening", color: "#507f9f", bands: clone(initialBands).map(function (band) { var copy = clone(band); copy.gain = round(copy.gain * 0.68, 1); return copy; }), handling: "auto", manualHeadroom: 4, user: true },
    { id: "profile-neutral", name: "Studio neutral", device: "Reference output", color: "#5f8c75", bands: clone(initialBands).map(function (band) { var copy = clone(band); copy.gain = 0; return copy; }), handling: "auto", manualHeadroom: 1, user: true }
  ];

  var starterProfiles = [
    { id: "starter-flat", name: "Flat", device: "No tonal shaping", color: "#858894", bands: clone(initialBands).map(function (band) { var copy = clone(band); copy.gain = 0; return copy; }), handling: "auto", manualHeadroom: 1, user: false },
    { id: "starter-warm", name: "Warm contour", device: "Broad low shelf", color: "#c07947", bands: [
      { id: "w1", type: "lowshelf", frequency: 95, gain: 3.2, q: .7, channel: "both", enabled: true },
      { id: "w2", type: "peaking", frequency: 280, gain: 1.2, q: .9, channel: "both", enabled: true },
      { id: "w3", type: "peaking", frequency: 2600, gain: -1.3, q: 1.1, channel: "both", enabled: true },
      { id: "w4", type: "highshelf", frequency: 9000, gain: -1.0, q: .7, channel: "both", enabled: true }
    ], handling: "auto", manualHeadroom: 4, user: false },
    { id: "starter-focus", name: "Vocal focus", device: "Midrange starting point", color: "#9a577d", bands: [
      { id: "v1", type: "lowshelf", frequency: 100, gain: -1.5, q: .7, channel: "both", enabled: true },
      { id: "v2", type: "peaking", frequency: 1600, gain: 2.0, q: .9, channel: "both", enabled: true },
      { id: "v3", type: "peaking", frequency: 3400, gain: 1.1, q: 1.4, channel: "both", enabled: true },
      { id: "v4", type: "highshelf", frequency: 11000, gain: .8, q: .7, channel: "both", enabled: true }
    ], handling: "auto", manualHeadroom: 3.5, user: false }
  ];

  var defaults = {
    schemaVersion: APP_STATE_SCHEMA_VERSION,
    view: "studio",
    mode: "basic",
    editorStyle: "curve",
    monitorMode: "vu",
    profileDockOpen: false,
    advancedBandCount: 10,
    eqEnabled: true,
    compareBypass: false,
    handling: "auto",
    headroomEnabled: true,
    manualHeadroom: 5.5,
    truePeakGuard: false,
    graphMode: "response",
    graphChannel: "both",
    selectedBandId: "b1",
    activeProfileId: "profile-edition-xs",
    activeProfileName: "HIFIMAN Edition XS",
    uzjamProfile: null,
    bands: clone(initialBands),
    toneBands: createToneBands(),
    preampDb: 0,
    bandBanks: { "10": clone(initialBands), "15": createStandardBands(15), "30": createStandardBands(30) },
    profiles: clone(defaultProfiles),
    library: clone(demoLibrary),
    queue: [],
    currentQueueIndex: -1,
    shuffled: false,
    repeat: false,
    clipLatched: false,
    librarySort: "recent",
    libraryDensity: 3,
    settings: {
      theme: "light",
      highContrast: false,
      reduceMotion: false,
      analyzer: true,
      nearbyBands: true,
      defaultMode: "basic",
      duplicateReport: true,
      resumePlayback: true,
      nativeInputDeviceId: "",
      nativeOutputDeviceId: "",
      nativeDirectOutputDeviceId: "",
      nativeDirectEnabled: false,
      nativeBufferFrames: 256,
      nativeAutoStart: false
    }
  };

  function loadState() {
    var loaded = loadPersistedState(localStorage);
    var stored = loaded.state;
    localStateWasLoaded = !!stored;
    stateRecovery = loaded.recovered ? loaded : null;
    var result = clone(defaults);
    var previousSchema = stored && Number(stored.schemaVersion) || 0;
    if (stored && typeof stored === "object") {
      Object.keys(stored).forEach(function (key) {
        if (key === "settings") return;
        if (Object.prototype.hasOwnProperty.call(result, key)) result[key] = stored[key];
      });
      result.settings = clone(defaults.settings);
      if (stored.settings && typeof stored.settings === "object") {
        Object.keys(defaults.settings).forEach(function (key) {
          if (Object.prototype.hasOwnProperty.call(stored.settings, key)) result.settings[key] = stored.settings[key];
        });
      }
    }
    if (previousSchema < 3) {
      result.settings.theme = "light";
      result.mode = "basic";
      result.editorStyle = "curve";
      result.monitorMode = "vu";
      result.advancedBandCount = 10;
      result.toneBands = createToneBands();
      result.preampDb = 0;
      result.bandBanks = { "10": clone(result.bands || initialBands), "15": createStandardBands(15), "30": createStandardBands(30) };
      if (result.view === "profiles") {
        result.view = "studio";
        result.profileDockOpen = true;
      }
    }
    if (previousSchema < 4) {
      result.toneBands = migrateToneBands(result.toneBands);
      result.schemaVersion = 4;
    }
    if (previousSchema < APP_STATE_SCHEMA_VERSION) result.schemaVersion = APP_STATE_SCHEMA_VERSION;
    if (!Array.isArray(result.bands) || !result.bands.length) result.bands = clone(initialBands);
    if (!Array.isArray(result.toneBands) || result.toneBands.length !== 6) result.toneBands = migrateToneBands(result.toneBands);
    result.editorStyle = result.editorStyle === "faders" ? "faders" : "curve";
    result.monitorMode = result.monitorMode === "spectrum" ? "spectrum" : "vu";
    result.graphMode = "response";
    result.compareBypass = false;
    result.preampDb = clamp(Number(result.preampDb) || 0, -24, 12);
    result.advancedBandCount = [10, 15, 30].indexOf(Number(result.advancedBandCount)) !== -1 ? Number(result.advancedBandCount) : 10;
    if (!result.bandBanks || typeof result.bandBanks !== "object") result.bandBanks = {};
    [10, 15, 30].forEach(function (count) {
      if (!Array.isArray(result.bandBanks[String(count)]) || !result.bandBanks[String(count)].length) result.bandBanks[String(count)] = createStandardBands(count);
    });
    result.bandBanks[String(result.advancedBandCount)] = clone(result.bands);
    if (!Array.isArray(result.library) || !result.library.length) result.library = clone(demoLibrary);
    if (!Array.isArray(result.profiles)) result.profiles = clone(defaultProfiles);
    if (!Array.isArray(result.queue)) result.queue = [];
    result.queue.forEach(function (track) { track.playable = false; delete track.url; });
    if (result.view === "profiles") { result.view = "studio"; result.profileDockOpen = true; }
    var editable = result.mode === "basic" ? result.toneBands : result.bands;
    if (!editable.some(function (band) { return band.id === result.selectedBandId; })) result.selectedBandId = editable[0].id;
    return result;
  }

  var state = loadState();
  var sessionPersistence = null;
  var persistenceSuppressed = false;
  var fileObjects = new Map();
  var history = [];
  var future = [];
  var dragSnapshot = null;
  var pendingUnsafeAction = null;
  var selectionMode = false;
  var librarySelection = new Set();
  var audioGraph = null;
  var localAudioSourceNode = null;
  var audioSourceNode = null;
  var audioContext = null;
  var analyzerFrame = 0;
  var lastMeterUpdate = 0;
  var controlSnapshot = null;
  var soloBandId = null;
  var meterState = { left: -100, right: -100, holdLeft: -100, holdRight: -100, holdUntilLeft: 0, holdUntilRight: 0 };
  var tabCapture = {
    status: "idle",
    requesting: false,
    stream: null,
    audioStream: null,
    sourceNode: null,
    label: "",
    startedAt: 0,
    generation: 0,
    requestId: 0,
    timer: 0,
    issueTitle: "",
    issueText: "",
    native: false
  };
  var nativeAudio = {
    available: false,
    backend: "WASAPI",
    running: false,
    starting: false,
    devices: null,
    status: null,
    pollTimer: 0,
    profileTimer: 0,
    persistTimer: 0,
    autoStartAttempted: false,
    recoveryTimer: 0,
    recoveryAttempts: 0,
    recovering: false,
    userStopped: false,
    direct: {
      status: null,
      applying: false
    },
    extension: {
      status: null
    }
  };

  function legacyBandFromCanonical(filter) {
    var kind = filter.kind === "lowShelf" ? "lowshelf" : filter.kind === "highShelf" ? "highshelf" : "peaking";
    return {
      id: filter.id,
      type: kind,
      frequency: filter.frequencyHz,
      gain: filter.gainDb,
      q: filter.q,
      channel: filter.channel === "stereo" ? "both" : filter.channel,
      enabled: filter.enabled
    };
  }

  function hydrateEditorFromProfile(profile) {
    if (!profile || profile.schemaVersion !== 1 || !Array.isArray(profile.filters)) return;
    var tone = profile.filters.filter(function (filter) { return !!TONE_META[filter.id]; }).map(legacyBandFromCanonical);
    var advanced = profile.filters.filter(function (filter) { return !TONE_META[filter.id]; }).map(legacyBandFromCanonical);
    if (tone.length) state.toneBands = migrateToneBands(tone);
    if (advanced.length) state.bands = advanced;
    state.eqEnabled = profile.dsp.enabled !== false;
    state.preampDb = Number(profile.dsp.preampDb) || 0;
    state.manualHeadroom = Math.max(0, Number(profile.dsp.manualHeadroomDb) || 0);
    state.truePeakGuard = profile.dsp.limiterEnabled === true || Number(profile.dsp.safetyMarginDb) >= .99;
    if (profile.dsp.clippingPolicy === "allowClipping" || profile.dsp.headroomMode === "off") state.handling = "clip";
    else if (profile.dsp.clippingPolicy === "smooth") state.handling = "smooth";
    else if (profile.dsp.clippingPolicy === "curve" || profile.dsp.headroomMode === "manual") state.handling = "curve";
    else state.handling = "auto";
    state.headroomEnabled = state.handling !== "clip";
    state.activeProfileId = profile.id;
    state.activeProfileName = profile.name;
    state.bandBanks[String(state.advancedBandCount)] = clone(state.bands);
  }

  if (state.uzjamProfile) hydrateEditorFromProfile(state.uzjamProfile);
  var hydratedEditor = state.mode === "basic" ? state.toneBands : state.bands;
  if (!hydratedEditor.some(function (band) { return band.id === state.selectedBandId; })) state.selectedBandId = hydratedEditor[0].id;
  var initialProfile = state.uzjamProfile || migrateCurrentV2State(state);
  var engineClient = new BrowserUzjamEngineClient(initialProfile);
  var engineAnalysis = null;

  function canonicalProfileFromEditor() {
    var current = state.uzjamProfile || engineClient.getProfileSync();
    var now = new Date().toISOString();
    var profile = migrateCurrentV2State(state, now);
    profile.metadata.createdAtUtc = current && current.metadata ? current.metadata.createdAtUtc : now;
    profile.metadata.modifiedAtUtc = now;
    profile.target = current ? current.target : null;
    profile.deviceBinding = current ? current.deviceBinding : null;
    return profile;
  }

  function syncEngineAnalysis() {
    var profile = engineClient.replaceProfileSync(canonicalProfileFromEditor());
    state.uzjamProfile = profile;
    engineAnalysis = engineClient.analyzeSync({
      sampleRateHz: audioContext ? audioContext.sampleRate : SAMPLE_RATE_FALLBACK,
      pointCount: 420,
      bypass: !!state.compareBypass,
      auditionFilterId: soloBandId
    });
    queueNativeProfile(profile);
    return engineAnalysis;
  }

  function currentHeadroom() {
    return (engineAnalysis || syncEngineAnalysis()).headroom;
  }

  function responseFromEngine(channel, effective) {
    var analysis = engineAnalysis || syncEngineAnalysis();
    var responseChannel = channel === "both" ? "stereo" : channel;
    var collection = effective ? analysis.effectiveResponse : analysis.requestedResponse;
    return collection[responseChannel].map(function (point) {
      return { frequency: point.frequencyHz, db: point.magnitudeDb };
    });
  }

  function effectiveGainForBand(band) {
    var analysis = engineAnalysis || syncEngineAnalysis();
    var effective = analysis.effectiveFilters.find(function (filter) { return filter.id === band.id; });
    return effective ? effective.gainDb : band.gain;
  }

  function persistedState() {
    state.bandBanks[String(state.advancedBandCount)] = clone(state.bands);
    state.uzjamProfile = engineClient.getProfileSync();
    var output = clone(state);
    output.compareBypass = false;
    output.queue = output.queue.map(function (track) {
      delete track.url;
      delete track.file;
      track.playable = false;
      return track;
    });
    return output;
  }

  function saveState() {
    if (persistenceSuppressed) return;
    var snapshot = persistedState();
    try {
      if (sessionPersistence) sessionPersistence.schedule();
      else savePersistedState(localStorage, snapshot);
    } catch (error) {
      showToast("Could not save locally", "Your browser blocked local preference storage.", "error");
    }
    queueNativeSnapshot(snapshot);
  }

  function nativeInvoker() {
    return window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function"
      ? window.__TAURI__.core.invoke
      : null;
  }

  function invokeNative(command, args) {
    var invoke = nativeInvoker();
    if (!invoke) return Promise.reject(new Error("The native audio host is unavailable."));
    return invoke(command, args || {});
  }

  function nativeErrorText(error) {
    if (!error) return "The audio engine returned an unknown error.";
    if (typeof error === "string") return error;
    if (error.message) return error.message;
    try { return JSON.stringify(error); } catch (jsonError) { return String(error); }
  }

  function queueNativeSnapshot(snapshot) {
    if (!nativeAudio.available) return;
    clearTimeout(nativeAudio.persistTimer);
    nativeAudio.persistTimer = setTimeout(function () {
      invokeNative("native_persist_state", { snapshot: snapshot }).catch(function () { });
    }, 180);
  }

  function profileForNative(profile) {
    var copy = clone(profile);
    if (copy && copy.dsp && state.compareBypass) copy.dsp.enabled = false;
    return copy;
  }

  function queueNativeProfile(profile) {
    if (!nativeAudio.available || (!nativeAudio.running && !state.settings.nativeDirectEnabled) || !profile) return;
    clearTimeout(nativeAudio.profileTimer);
    nativeAudio.profileTimer = setTimeout(function () {
      var nativeProfile = profileForNative(profile);
      if (nativeAudio.running) {
        invokeNative("native_audio_update_profile", { profile: nativeProfile }).catch(function (error) {
          setNativeAudioError(nativeErrorText(error));
        });
      }
      if (state.settings.nativeDirectEnabled) {
        invokeNative("native_direct_audio_apply", {
          profile: nativeProfile,
          outputDeviceId: state.settings.nativeDirectOutputDeviceId || null
        }).then(renderDirectAudioStatus).catch(function (error) {
          renderDirectAudioStatus(Object.assign({}, nativeAudio.direct.status || {}, { lastError: nativeErrorText(error) }));
        });
      }
    }, 32);
  }

  function nativeDeviceLists(inventory) {
    inventory = inventory || {};
    return {
      inputs: inventory.inputDevices || inventory.inputs || inventory.captureDevices || inventory.sourceDevices || [],
      outputs: inventory.outputDevices || inventory.outputs || inventory.renderDevices || []
    };
  }

  function fillNativeDeviceSelect(selector, devices, preferredId, defaultId, emptyLabel) {
    var select = $(selector);
    select.innerHTML = "";
    if (!devices.length) {
      var empty = document.createElement("option");
      empty.value = "";
      empty.textContent = emptyLabel;
      select.appendChild(empty);
      select.disabled = true;
      return { choice: "", exact: false };
    }
    select.disabled = nativeAudio.running || nativeAudio.starting;
    devices.forEach(function (device) {
      var option = document.createElement("option");
      option.value = device.id;
      var sourcePrefix = device.kind === "systemLoopback" ? "System mix · " : device.kind === "input" ? "Input · " : "";
      option.textContent = sourcePrefix + device.name + (device.isDefault ? " · Default" : "");
      select.appendChild(option);
    });
    var choice = preferredId && devices.some(function (device) { return device.id === preferredId; })
      ? preferredId
      : defaultId && devices.some(function (device) { return device.id === defaultId; })
        ? defaultId
        : devices[0].id;
    select.value = choice;
    return { choice: choice, exact: !!preferredId && choice === preferredId };
  }

  function setNativeAudioError(message) {
    var error = $("#nativeAudioError");
    nativeAudio.status = Object.assign({}, nativeAudio.status || {}, { lastError: message || "" });
    error.hidden = !message;
    error.textContent = message || "";
    $("#nativeAudioControls").classList.toggle("has-error", !!message);
  }

  function renderNativeAudioStatus(status) {
    status = status || nativeAudio.status || {};
    nativeAudio.status = status;
    nativeAudio.running = !!(status.running || status.state === "running");
    var controls = $("#nativeAudioControls");
    controls.classList.toggle("is-running", nativeAudio.running);
    controls.classList.toggle("is-starting", nativeAudio.starting);
    $("#nativeAudioStatus").textContent = nativeAudio.starting ? "Starting audio engine…" : nativeAudio.running ? "Processing in real time" : "Audio engine stopped";
    $("#nativeAudioStatusDetail").textContent = status.statusDetail || status.message || (nativeAudio.running ? "Rust DSP is inserted between the selected devices." : "Choose a source and listening output.");
    $("#nativeBackendBadge").textContent = String(status.backend || nativeAudio.backend || "WASAPI").toUpperCase();
    var sampleRate = Number(status.sampleRateHz || 0);
    var channels = Number(status.channels || 0);
    var format = status.sampleFormat || status.format || "";
    $("#nativeAudioFormat").textContent = sampleRate ? (sampleRate / 1000).toFixed(sampleRate % 1000 ? 1 : 0) + " kHz" + (channels ? " · " + channels + "ch" : "") + (format ? " · " + String(format).toUpperCase() : "") : "—";
    var latency = Number(status.estimatedLatencyMs || status.latencyMs || 0);
    $("#nativeAudioLatency").textContent = latency ? latency.toFixed(1) + " ms" : status.bufferFrames ? status.bufferFrames + " fr" : "—";
    $("#nativeAudioXruns").textContent = String(Number(status.xruns || status.xrunCount || 0));
    $("#nativeAudioClock").textContent = String(Number(status.clockAdjustments || 0)) + " adj";
    $("#nativeAudioClock").title = "Adaptive clock corrections · queue " + Number(status.queueFillFrames || 0) + "/" + Number(status.queueCapacityFrames || 0) + " frames";
    $("#nativeAudioToggle").textContent = nativeAudio.starting ? "Starting…" : nativeAudio.running ? "Stop processing" : "Start processing";
    $("#nativeAudioToggle").classList.toggle("danger-quiet", nativeAudio.running);
    $("#nativeAudioToggle").classList.toggle("primary", !nativeAudio.running);
    $("#nativeAudioToggle").disabled = nativeAudio.starting;
    $("#nativeRefreshDevices").disabled = nativeAudio.starting || nativeAudio.running;
    $("#nativeInputDevice").disabled = nativeAudio.starting || nativeAudio.running || !$("#nativeInputDevice").options.length;
    $("#nativeOutputDevice").disabled = nativeAudio.starting || nativeAudio.running || !$("#nativeOutputDevice").options.length;
    $("#nativeBufferFrames").disabled = nativeAudio.starting || nativeAudio.running;
    if (status.lastError) setNativeAudioError(status.lastError);
    else if (nativeAudio.running) setNativeAudioError("");
    var directActive = !!(nativeAudio.direct.status && nativeAudio.direct.status.active);
    var listeningDevice = directActive
      ? findNativeDevice(state.settings.nativeDirectOutputDeviceId, "output")
      : nativeAudio.running
        ? findNativeDevice(state.settings.nativeOutputDeviceId, "output")
        : null;
    $("#railOutput").textContent = listeningDevice ? listeningDevice.name : directActive || nativeAudio.running ? "Windows audio" : "Built-in audio";
    renderSignal();
  }

  function setDirectAudioError(message) {
    var error = $("#nativeDirectAudioError");
    if (!error) return;
    error.hidden = !message;
    error.textContent = message || "";
    $("#nativeDirectCard").classList.toggle("has-error", !!message);
  }

  function renderDirectAudioStatus(status) {
    status = status || nativeAudio.direct.status || {};
    nativeAudio.direct.status = status;
    var installed = !!status.installed;
    var active = !!status.active;
    var desired = !!state.settings.nativeDirectEnabled || active;
    var card = $("#nativeDirectCard");
    card.classList.toggle("is-active", active);
    card.classList.toggle("is-ready", installed && !active);
    card.classList.toggle("is-applying", nativeAudio.direct.applying);
    var title = nativeAudio.direct.applying
      ? "Updating direct audio…"
      : active
        ? "Direct Windows EQ is on"
        : installed
          ? "Direct component ready"
          : "Direct component required";
    $("#nativeDirectStatus").textContent = title;
    $("#nativeDirectStatusDetail").textContent = status.statusDetail || (installed
      ? "Enable it to process every app using this output."
      : "The signed endpoint component must be installed for this output device.");
    $("#nativeDirectBadge").textContent = installed ? "ENDPOINT APO" : "SETUP";
    $("#nativeDirectToggle").textContent = nativeAudio.direct.applying
      ? "Working…"
      : desired
        ? "Bypass direct EQ"
        : installed
          ? "Enable direct EQ"
          : "Component required";
    $("#nativeDirectToggle").disabled = nativeAudio.direct.applying || !installed;
    $("#nativeDirectRefresh").disabled = nativeAudio.direct.applying;
    $("#nativeDirectOutputDevice").disabled = nativeAudio.direct.applying;
    setDirectAudioError(status.lastError || "");
    var output = findNativeDevice(state.settings.nativeDirectOutputDeviceId, "output");
    $("#nativeDirectHint").textContent = active
      ? "Every app playing through “" + (output ? output.name : "this output") + "” is processed in place. No virtual cable and no duplicate playback device."
      : installed
        ? "Ready for system-wide EQ on “" + (output ? output.name : "the selected output") + "”."
        : "UZjam can use this output through the compatibility route now. Direct system-wide mode requires the signed endpoint package.";
    renderSignal();
  }

  function refreshDirectAudioStatus(options) {
    options = options || {};
    if (!nativeAudio.available) return Promise.resolve(null);
    var outputId = $("#nativeDirectOutputDevice").value || state.settings.nativeDirectOutputDeviceId || "";
    state.settings.nativeDirectOutputDeviceId = outputId;
    nativeAudio.direct.applying = true;
    renderDirectAudioStatus(nativeAudio.direct.status);
    return invokeNative("native_direct_audio_status", { outputDeviceId: outputId || null }).then(function (status) {
      nativeAudio.direct.applying = false;
      if (status.active) state.settings.nativeDirectEnabled = true;
      renderDirectAudioStatus(status);
      if (status.installed && state.settings.nativeDirectEnabled && !status.active) {
        return applyDirectAudio(true).then(function () { return status; });
      }
      if (!options.silent) showToast(status.installed ? "Direct audio is ready" : "Direct component not installed", status.statusDetail, status.installed ? undefined : "error");
      return status;
    }).catch(function (error) {
      nativeAudio.direct.applying = false;
      var message = nativeErrorText(error);
      renderDirectAudioStatus({ supported: true, installed: false, active: false, lastError: message, statusDetail: "Direct audio could not be checked." });
      if (!options.silent) showToast("Direct audio could not be checked", message, "error");
      return null;
    });
  }

  function applyDirectAudio(automatic) {
    var outputId = $("#nativeDirectOutputDevice").value || "";
    if (!outputId) {
      setDirectAudioError("Choose the output that should receive direct Windows EQ.");
      return Promise.resolve(false);
    }
    var currentlyEngaged = !!state.settings.nativeDirectEnabled || !!(nativeAudio.direct.status && nativeAudio.direct.status.active);
    var enabling = automatic ? true : !currentlyEngaged;
    var profile = profileForNative(engineClient.getProfileSync());
    if (!enabling && profile && profile.dsp) profile.dsp.enabled = false;
    nativeAudio.direct.applying = true;
    renderDirectAudioStatus(nativeAudio.direct.status);
    var stopFallback = enabling && nativeAudio.running ? stopNativeAudio({ silent: true }) : Promise.resolve(true);
    return stopFallback.then(function () {
      return invokeNative("native_direct_audio_apply", { profile: profile, outputDeviceId: outputId });
    }).then(function (status) {
      nativeAudio.direct.applying = false;
      state.settings.nativeDirectOutputDeviceId = outputId;
      state.settings.nativeDirectEnabled = enabling;
      renderDirectAudioStatus(status);
      saveState();
      if (!automatic) showToast(enabling ? "Direct Windows EQ enabled" : "Direct Windows EQ bypassed", enabling ? "All audio on the selected output now passes through UZjam." : "The endpoint remains ready, but EQ processing is bypassed.");
      return true;
    }).catch(function (error) {
      nativeAudio.direct.applying = false;
      var message = nativeErrorText(error);
      renderDirectAudioStatus(Object.assign({}, nativeAudio.direct.status || {}, { lastError: message }));
      if (!automatic) showToast("Direct audio could not be changed", message, "error");
      return false;
    });
  }

  function refreshNativeDevices(options) {
    options = options || {};
    if (!nativeAudio.available) return Promise.resolve(null);
    $("#nativeRefreshDevices").disabled = true;
    return invokeNative("native_audio_devices").then(function (inventory) {
      nativeAudio.devices = inventory || {};
      nativeAudio.backend = inventory.backend || "WASAPI";
      var lists = nativeDeviceLists(inventory);
      var savedInputId = state.settings.nativeInputDeviceId;
      var savedOutputId = state.settings.nativeOutputDeviceId;
      var inputSelection = fillNativeDeviceSelect(
        "#nativeInputDevice",
        lists.inputs,
        savedInputId,
        inventory.recommendedInputId || inventory.defaultInputId || inventory.defaultCaptureId || inventory.defaultSourceId,
        "No capture sources found"
      );
      var outputSelection = fillNativeDeviceSelect(
        "#nativeOutputDevice",
        lists.outputs,
        savedOutputId,
        inventory.defaultOutputId || inventory.defaultRenderId,
        "No outputs found"
      );
      var directOutputSelection = fillNativeDeviceSelect(
        "#nativeDirectOutputDevice",
        lists.outputs,
        state.settings.nativeDirectOutputDeviceId,
        inventory.defaultOutputId || inventory.defaultRenderId,
        "No outputs found"
      );
      state.settings.nativeDirectOutputDeviceId = directOutputSelection.choice;
      var exactSavedRoute = inputSelection.exact && outputSelection.exact;
      if (!state.settings.nativeAutoStart || exactSavedRoute) {
        state.settings.nativeInputDeviceId = inputSelection.choice;
        state.settings.nativeOutputDeviceId = outputSelection.choice;
        setNativeAudioError("");
      }
      renderNativeRouteHint();
      refreshDirectAudioStatus({ silent: true });
      if (!options.silent) showToast("Audio devices refreshed", lists.inputs.length + " sources and " + lists.outputs.length + " outputs found.");
      saveState();
      if (state.settings.nativeAutoStart && !nativeAudio.autoStartAttempted) {
        nativeAudio.autoStartAttempted = true;
        if (!savedInputId || !savedOutputId || !exactSavedRoute) {
          setNativeAudioError("The saved Windows audio route is incomplete or a device is disconnected. Confirm both devices, then start processing manually.");
        } else {
          return startNativeAudio(true).then(function () { return inventory; });
        }
      }
      return inventory;
    }).catch(function (error) {
      var message = nativeErrorText(error);
      setNativeAudioError(message);
      if (!options.silent) showToast("Devices could not be refreshed", message, "error");
      return null;
    }).finally(function () {
      $("#nativeRefreshDevices").disabled = nativeAudio.running || nativeAudio.starting;
    });
  }

  function findNativeDevice(id, direction) {
    var lists = nativeDeviceLists(nativeAudio.devices);
    var devices = direction === "input" ? lists.inputs : lists.outputs;
    return devices.find(function (device) { return device.id === id; }) || null;
  }

  function renderNativeRouteHint() {
    var hint = $("#nativeRouteHint");
    if (!hint) return;
    var source = findNativeDevice($("#nativeInputDevice").value, "input");
    var output = findNativeDevice($("#nativeOutputDevice").value, "output");
    hint.classList.remove("is-ready", "is-warning");
    if (!source || !output) {
      hint.textContent = "Choose a source and output to check the route.";
      return;
    }
    if (source.id === output.id) {
      hint.classList.add("is-warning");
      hint.textContent = "This route loops back into the same endpoint. Choose a different listening output.";
      return;
    }
    if (source.kind === "systemLoopback" && source.transport === "virtual") {
      hint.classList.add("is-ready");
      hint.textContent = "System-audio route ready: play Windows audio to “" + source.name + "”; UZjam sends the processed signal to “" + output.name + "”.";
      return;
    }
    if (source.kind === "systemLoopback") {
      hint.classList.add("is-warning");
      hint.textContent = "Loopback route selected. For silent system-wide routing, a virtual cable source is recommended.";
      return;
    }
    hint.classList.add("is-ready");
    hint.textContent = "Input-monitoring route ready: “" + source.name + "” → UZjam → “" + output.name + "”.";
  }

  function cancelNativeRecovery() {
    clearTimeout(nativeAudio.recoveryTimer);
    nativeAudio.recoveryTimer = 0;
    nativeAudio.recovering = false;
  }

  function attemptNativeRecovery() {
    nativeAudio.recoveryTimer = 0;
    if (!state.settings.nativeAutoStart || nativeAudio.userStopped || nativeAudio.running) return;
    nativeAudio.recovering = true;
    nativeAudio.starting = true;
    nativeAudio.recoveryAttempts += 1;
    renderNativeAudioStatus(nativeAudio.status);
    invokeNative("native_audio_recover").then(function (status) {
      nativeAudio.recovering = false;
      nativeAudio.starting = false;
      nativeAudio.recoveryAttempts = 0;
      renderNativeAudioStatus(status);
      setNativeAudioError("");
      showToast("Windows audio recovered", "The exact saved route is processing again.");
    }).catch(function (error) {
      nativeAudio.recovering = false;
      nativeAudio.starting = false;
      var message = nativeErrorText(error);
      if (nativeAudio.recoveryAttempts >= 5) {
        setNativeAudioError("Automatic recovery stopped after 5 attempts. " + message);
        renderNativeAudioStatus({ running: false, state: "failed", lastError: nativeAudio.status && nativeAudio.status.lastError });
        return;
      }
      setNativeAudioError("Waiting for the exact saved devices… recovery attempt " + nativeAudio.recoveryAttempts + " of 5.");
      nativeAudio.recoveryTimer = setTimeout(attemptNativeRecovery, Math.min(8000, 750 * Math.pow(2, nativeAudio.recoveryAttempts)));
    });
  }

  function maybeRecoverNativeAudio(status) {
    if (!status || status.sourceDeviceId === "uzjam-browser-extension" || status.state !== "failed" || !state.settings.nativeAutoStart || nativeAudio.userStopped || nativeAudio.recovering || nativeAudio.recoveryTimer || nativeAudio.recoveryAttempts >= 5) return;
    nativeAudio.recoveryTimer = setTimeout(attemptNativeRecovery, 750);
  }

  function startNativeAudio(automatic) {
    cancelNativeRecovery();
    nativeAudio.recoveryAttempts = 0;
    nativeAudio.userStopped = false;
    var sourceId = $("#nativeInputDevice").value;
    var outputId = $("#nativeOutputDevice").value;
    if (!sourceId || !outputId) {
      setNativeAudioError("Choose both a capture source and a listening output.");
      return Promise.resolve(false);
    }
    var source = findNativeDevice(sourceId, "input");
    if (sourceId === outputId && (!source || source.isLoopback !== false)) {
      setNativeAudioError("The source and output resolve to the same endpoint. Choose a different output to prevent feedback and doubled audio.");
      return Promise.resolve(false);
    }
    if (state.settings.nativeDirectEnabled) {
      state.settings.nativeDirectEnabled = false;
      var directProfile = profileForNative(engineClient.getProfileSync());
      if (directProfile && directProfile.dsp) directProfile.dsp.enabled = false;
      invokeNative("native_direct_audio_apply", {
        profile: directProfile,
        outputDeviceId: state.settings.nativeDirectOutputDeviceId || null
      }).then(renderDirectAudioStatus).catch(function () { });
    }
    nativeAudio.starting = true;
    setNativeAudioError("");
    renderNativeAudioStatus(nativeAudio.status);
    syncEngineAnalysis();
    var request = {
      sourceDeviceId: sourceId,
      outputDeviceId: outputId,
      preferredBufferFrames: Number($("#nativeBufferFrames").value) || 256,
      profile: profileForNative(engineClient.getProfileSync())
    };
    return invokeNative("native_audio_start", { request: request }).then(function (status) {
      nativeAudio.starting = false;
      state.settings.nativeInputDeviceId = sourceId;
      state.settings.nativeOutputDeviceId = outputId;
      state.settings.nativeBufferFrames = request.preferredBufferFrames;
      renderNativeAudioStatus(status);
      saveState();
      if (!automatic) showToast("Windows audio is live", "UZjam DSP is processing the selected route.");
      scheduleNativeStatusPoll(250);
      return true;
    }).catch(function (error) {
      nativeAudio.starting = false;
      var message = nativeErrorText(error);
      setNativeAudioError(message);
      renderNativeAudioStatus({ running: false, lastError: message });
      showToast(automatic ? "Audio did not reconnect" : "Audio could not start", message, "error");
      return false;
    });
  }

  function stopNativeAudio(options) {
    options = options || {};
    cancelNativeRecovery();
    nativeAudio.recoveryAttempts = 0;
    nativeAudio.userStopped = true;
    nativeAudio.starting = true;
    renderNativeAudioStatus(nativeAudio.status);
    return invokeNative("native_audio_stop").then(function (status) {
      nativeAudio.starting = false;
      nativeAudio.running = false;
      renderNativeAudioStatus(status || { running: false });
      if (!options.silent) showToast("Windows audio stopped", "The selected devices have been released.");
      return true;
    }).catch(function (error) {
      nativeAudio.starting = false;
      var message = nativeErrorText(error);
      setNativeAudioError(message);
      renderNativeAudioStatus(nativeAudio.status);
      if (!options.silent) showToast("Audio could not stop cleanly", message, "error");
      return false;
    });
  }

  function pollNativeStatus() {
    if (!nativeAudio.available) return;
    Promise.all([
      invokeNative("native_audio_status"),
      invokeNative("native_extension_bridge_status").catch(function () { return null; })
    ]).then(function (results) {
      renderNativeAudioStatus(results[0]);
      maybeRecoverNativeAudio(results[0]);
      if (results[1]) renderExtensionBridgeStatus(results[1]);
    }).catch(function (error) {
      setNativeAudioError(nativeErrorText(error));
    }).finally(function () {
      scheduleNativeStatusPoll(nativeAudio.running ? 1000 : 3000);
    });
  }

  function scheduleNativeStatusPoll(delay) {
    clearTimeout(nativeAudio.pollTimer);
    nativeAudio.pollTimer = setTimeout(pollNativeStatus, delay);
  }

  function initializeNativeAudio() {
    nativeAudio.available = !!nativeInvoker();
    $("#nativeAudioUnavailable").hidden = nativeAudio.available;
    $("#nativeAudioControls").hidden = !nativeAudio.available;
    if (!nativeAudio.available) return;
    $("#nativeBufferFrames").value = String(Number(state.settings.nativeBufferFrames) || 256);
    $("#nativeAutoStartInput").checked = !!state.settings.nativeAutoStart;
    var restore = Promise.resolve();
    if (!localStateWasLoaded && sessionStorage.getItem("uzjam-native-restore-attempt") !== "1") {
      sessionStorage.setItem("uzjam-native-restore-attempt", "1");
      restore = invokeNative("native_load_state").then(function (saved) {
        var snapshot = saved && saved.snapshot ? saved.snapshot : saved;
        if (snapshot && typeof snapshot === "object" && snapshot.schemaVersion) {
          var committed = sessionPersistence ? sessionPersistence.replaceAndSuspend(snapshot) : (savePersistedState(localStorage, snapshot), true);
          if (!committed) return false;
          persistenceSuppressed = true;
          window.location.reload();
          return true;
        }
        return false;
      }).catch(function () { return false; });
    }
    restore.then(function (reloaded) {
      if (reloaded) return;
      return Promise.all([
        invokeNative("native_audio_status").then(renderNativeAudioStatus).catch(function () { }),
        invokeNative("native_extension_bridge_status").then(renderExtensionBridgeStatus).catch(function () { }),
        refreshNativeDevices({ silent: true })
      ]).then(function () { scheduleNativeStatusPoll(1000); });
    });
  }

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function editorBands() {
    return state.mode === "basic" ? state.toneBands : state.bands;
  }

  function processingBands() {
    return state.toneBands.concat(state.bands);
  }

  function selectedBand() {
    var bands = editorBands();
    return bands.find(function (band) { return band.id === state.selectedBandId; }) || bands[0];
  }

  function isToneBand(band) {
    return !!(band && TONE_META[band.id]);
  }

  function bandGainLimit() {
    return state.mode === "basic" ? 12 : (BANK_SPECS[state.advancedBandCount] || BANK_SPECS[10]).limit;
  }

  function typeLabel(type) {
    if (type === "lowshelf") return "Low shelf";
    if (type === "highshelf") return "High shelf";
    return "Peak";
  }

  function frequencyToRatio(frequency) {
    return Math.log(clamp(frequency, 20, 20000) / 20) / Math.log(1000);
  }

  function ratioToFrequency(ratio) {
    return 20 * Math.pow(1000, clamp(ratio, 0, 1));
  }

  function frequencyToGraphX(frequency) {
    return GRAPH.left + frequencyToRatio(frequency) * GRAPH.width;
  }

  function graphXToFrequency(x) {
    return ratioToFrequency((x - GRAPH.left) / GRAPH.width);
  }

  function gainToGraphY(gain) {
    return GRAPH.top + (18 - clamp(gain, -18, 18)) / 36 * GRAPH.height;
  }

  function graphYToGain(y) {
    return clamp(18 - (y - GRAPH.top) / GRAPH.height * 36, -18, 18);
  }

  function frequencyToRange(frequency) {
    return Math.round(frequencyToRatio(frequency) * 1000);
  }

  function rangeToFrequency(value) {
    return ratioToFrequency(Number(value) / 1000);
  }

  function qToRange(q) {
    return Math.round(Math.log(clamp(q, .1, 24) / .1) / Math.log(240) * 1000);
  }

  function rangeToQ(value) {
    return .1 * Math.pow(240, Number(value) / 1000);
  }

  function channelIncludes(band, channel) {
    if (channel === "both") return true;
    return band.channel === "both" || band.channel === channel;
  }

  function eqSnapshot() {
    return {
      bands: clone(state.bands),
      toneBands: clone(state.toneBands),
      preampDb: state.preampDb,
      bandBanks: clone(state.bandBanks),
      advancedBandCount: state.advancedBandCount,
      handling: state.handling,
      headroomEnabled: state.headroomEnabled,
      manualHeadroom: state.manualHeadroom,
      truePeakGuard: state.truePeakGuard,
      selectedBandId: state.selectedBandId
    };
  }

  function pushHistory(snapshot) {
    history.push(snapshot || eqSnapshot());
    if (history.length > 60) history.shift();
    future = [];
    updateHistoryButtons();
  }

  function restoreSnapshot(snapshot) {
    state.bands = clone(snapshot.bands);
    if (snapshot.toneBands) state.toneBands = clone(snapshot.toneBands);
    if (snapshot.preampDb != null) state.preampDb = snapshot.preampDb;
    if (snapshot.bandBanks) state.bandBanks = clone(snapshot.bandBanks);
    if (snapshot.advancedBandCount) state.advancedBandCount = snapshot.advancedBandCount;
    state.handling = snapshot.handling;
    state.headroomEnabled = snapshot.headroomEnabled;
    state.manualHeadroom = snapshot.manualHeadroom;
    state.truePeakGuard = snapshot.truePeakGuard;
    state.selectedBandId = snapshot.selectedBandId;
    renderEq();
    saveState();
  }

  function updateHistoryButtons() {
    $("#undoButton").disabled = history.length === 0;
    $("#redoButton").disabled = future.length === 0;
  }

  function showToast(title, message, kind) {
    var stack = $("#toastStack");
    var toast = document.createElement("div");
    toast.className = "toast" + (kind === "error" ? " error" : "");
    toast.innerHTML = '<span class="toast-icon">' + (kind === "error" ? "!" : "✓") + '</span><div><strong></strong><p></p></div><button aria-label="Dismiss">×</button>';
    $("strong", toast).textContent = title;
    $("p", toast).textContent = message || "";
    $("button", toast).addEventListener("click", function () { toast.remove(); });
    stack.appendChild(toast);
    $("#liveRegion").textContent = title + (message ? ". " + message : "");
    setTimeout(function () {
      if (toast.isConnected) toast.remove();
    }, 4200);
  }

  function policyCopy(safety) {
    if (state.handling === "auto") return "UZjam measures the combined filter curve and applies only the static headroom needed to keep it below digital full scale.";
    if (state.handling === "curve") {
      if (safety.predictedOverDb > .05) return "Your exact curve is preserved, but the manual headroom is short by " + safety.predictedOverDb.toFixed(1) + " dB.";
      return "Your exact curve is preserved with the manual headroom you chose.";
    }
    if (state.handling === "smooth") {
      var amount = Math.round((1 - safety.smoothingFactor) * 100);
      return amount > 0
        ? "Positive boosts are softened by " + amount + "% so the curve fits your selected level budget. The requested curve stays visible as a guide."
        : "The requested curve already fits your level budget, so no smoothing is needed.";
    }
    return "No headroom or limiting is applied. Downstream output may clip by " + safety.predictedOverDb.toFixed(1) + " dB.";
  }

  function setRangeProgress(input, min, max, value) {
    var progress = (Number(value) - Number(min)) / (Number(max) - Number(min)) * 100;
    input.style.setProperty("--range-progress", clamp(progress, 0, 100) + "%");
  }

  function pathFromSeries(series) {
    return series.map(function (point, index) {
      var x = frequencyToGraphX(point.frequency);
      var y = gainToGraphY(point.db);
      return (index ? "L" : "M") + x.toFixed(2) + " " + y.toFixed(2);
    }).join(" ");
  }

  function navigate(view) {
    if (view === "profiles") {
      view = "studio";
      setProfileDockOpen(true);
    }
    if (!VIEW_META[view]) view = "studio";
    state.view = view;
    $$(".app-view").forEach(function (panel) { panel.classList.toggle("active", panel.dataset.viewPanel === view); });
    $$(".nav-item").forEach(function (button) {
      var active = button.dataset.view === view;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    $("#viewEyebrow").textContent = VIEW_META[view][0];
    document.title = VIEW_META[view][1];
    saveState();
    if (view === "library") renderLibrary();
    if (view === "queue") renderQueue();
    if (view === "signal") renderSignal();
  }

  function setMode(mode) {
    state.mode = mode === "advanced" ? "advanced" : "basic";
    document.body.dataset.mode = state.mode;
    $$(".mode-switch button").forEach(function (button) { button.classList.toggle("active", button.dataset.mode === state.mode); });
    if (!editorBands().some(function (band) { return band.id === state.selectedBandId; })) state.selectedBandId = editorBands()[0].id;
    $("#graphModeLabel").textContent = state.mode === "basic" ? "Six musical tone zones" : (BANK_SPECS[state.advancedBandCount] || BANK_SPECS[10]).label;
    saveState();
  }

  function setProfileDockOpen(open) {
    state.profileDockOpen = !!open;
    $("#profileDock").classList.toggle("open", state.profileDockOpen);
    $("#profileDockButton").setAttribute("aria-expanded", String(state.profileDockOpen));
    if (state.profileDockOpen) renderProfiles();
    saveState();
  }

  function setEditorStyle(style) {
    state.editorStyle = style === "faders" ? "faders" : "curve";
    $$('[data-editor-style]').forEach(function (button) {
      var active = button.dataset.editorStyle === state.editorStyle;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    $$('[data-editor-panel]').forEach(function (panel) { panel.classList.toggle("active", panel.dataset.editorPanel === state.editorStyle); });
    saveState();
  }

  function setMonitorMode(mode) {
    state.monitorMode = mode === "spectrum" ? "spectrum" : "vu";
    $$('[data-monitor]').forEach(function (button) {
      var active = button.dataset.monitor === state.monitorMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    $$('[data-monitor-panel]').forEach(function (panel) { panel.classList.toggle("active", panel.dataset.monitorPanel === state.monitorMode); });
    saveState();
  }

  function switchBandCount(count) {
    count = Number(count);
    if (!BANK_SPECS[count] || count === state.advancedBandCount) return;
    pushHistory();
    state.bandBanks[String(state.advancedBandCount)] = clone(state.bands);
    state.advancedBandCount = count;
    state.bands = clone(state.bandBanks[String(count)] || createStandardBands(count));
    state.selectedBandId = state.bands[0].id;
    soloBandId = null;
    renderEq();
    saveState();
    showToast(BANK_SPECS[count].label + " ready", "Your other EQ layouts are preserved exactly.");
  }

  function renderBandStrip() {
    var strip = $("#bandStrip");
    strip.innerHTML = "";
    state.bands.forEach(function (band, index) {
      var button = document.createElement("button");
      button.className = "band-chip" + (band.id === state.selectedBandId ? " selected" : "") + (!band.enabled ? " disabled" : "");
      button.dataset.bandId = band.id;
      button.setAttribute("aria-label", "Band " + (index + 1) + ", " + formatFrequency(band.frequency) + ", " + formatSigned(band.gain, 1) + " decibels");
      button.innerHTML = "<span>" + String(index + 1).padStart(2, "0") + "</span><strong>" + formatFrequency(band.frequency) + "</strong><small>" + formatSigned(band.gain, 1) + " dB · " + typeLabel(band.type) + "</small>";
      button.addEventListener("click", function () {
        state.selectedBandId = band.id;
        renderEq();
        saveState();
      });
      strip.appendChild(button);
    });
  }

  function renderBandHandles() {
    var handles = $("#bandHandles");
    handles.innerHTML = "";
    editorBands().forEach(function (band, index) {
      if (!band.enabled && state.mode === "basic") return;
      var button = document.createElement("button");
      var x = frequencyToGraphX(band.frequency) / 1000 * 100;
      var y = gainToGraphY(band.gain) / 460 * 100;
      button.className = "band-handle" + (band.id === state.selectedBandId ? " selected" : "") + (!band.enabled ? " disabled" : "") + (band.channel === "left" ? " channel-left" : band.channel === "right" ? " channel-right" : "");
      button.dataset.bandId = band.id;
      button.style.left = x + "%";
      button.style.top = y + "%";
      button.textContent = isToneBand(band) ? TONE_META[band.id].short : index + 1;
      button.setAttribute("role", "slider");
      button.setAttribute("aria-label", isToneBand(band) ? TONE_META[band.id].label + " tone control" : "Band " + (index + 1) + " frequency and gain");
      button.setAttribute("aria-valuetext", formatFrequency(band.frequency) + ", " + formatSigned(band.gain, 1) + " decibels");
      button.setAttribute("tabindex", "0");
      button.addEventListener("pointerdown", beginBandDrag);
      button.addEventListener("keydown", handleBandKey);
      button.addEventListener("click", function () {
        state.selectedBandId = band.id;
        renderEq();
      });
      handles.appendChild(button);
    });
  }

  function beginBandDrag(event) {
    event.preventDefault();
    var handle = event.currentTarget;
    state.selectedBandId = handle.dataset.bandId;
    dragSnapshot = eqSnapshot();
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener("pointermove", moveBandDrag);
    handle.addEventListener("pointerup", endBandDrag, { once: true });
    handle.addEventListener("pointercancel", endBandDrag, { once: true });
    updateBandFromPointer(event);
  }

  function moveBandDrag(event) {
    updateBandFromPointer(event);
  }

  function endBandDrag(event) {
    var handle = event.currentTarget;
    handle.removeEventListener("pointermove", moveBandDrag);
    if (dragSnapshot) pushHistory(dragSnapshot);
    dragSnapshot = null;
    saveState();
  }

  function updateBandFromPointer(event) {
    var plot = $("#eqPlot");
    var rect = plot.getBoundingClientRect();
    var x = (event.clientX - rect.left) / rect.width * 1000;
    var y = (event.clientY - rect.top) / rect.height * 460;
    var band = selectedBand();
    var fine = event.shiftKey ? .25 : 1;
    var nextFrequency = graphXToFrequency(x);
    var nextGain = graphYToGain(y);
    if (event.shiftKey) {
      nextFrequency = band.frequency + (nextFrequency - band.frequency) * fine;
      nextGain = band.gain + (nextGain - band.gain) * fine;
    }
    if (state.mode === "advanced") band.frequency = Math.round(clamp(nextFrequency, 20, 20000));
    band.gain = round(clamp(nextGain, -bandGainLimit(), bandGainLimit()), 1);
    renderEq({ lightweight: true });
  }

  function handleBandKey(event) {
    var band = editorBands().find(function (item) { return item.id === event.currentTarget.dataset.bandId; });
    if (!band) return;
    var before = eqSnapshot();
    var handled = true;
    var frequencyStep = event.shiftKey ? 1.005 : 1.03;
    var gainStep = event.shiftKey ? .1 : .5;
    if (state.mode === "basic" && (event.key === "ArrowLeft" || event.key === "ArrowDown")) band.gain = round(Math.max(-12, band.gain - gainStep), 1);
    else if (state.mode === "basic" && (event.key === "ArrowRight" || event.key === "ArrowUp")) band.gain = round(Math.min(12, band.gain + gainStep), 1);
    else if (event.key === "ArrowLeft") band.frequency = Math.max(20, Math.round(band.frequency / frequencyStep));
    else if (event.key === "ArrowRight") band.frequency = Math.min(20000, Math.round(band.frequency * frequencyStep));
    else if (event.key === "ArrowUp") band.gain = round(Math.min(bandGainLimit(), band.gain + gainStep), 1);
    else if (event.key === "ArrowDown") band.gain = round(Math.max(-bandGainLimit(), band.gain - gainStep), 1);
    else handled = false;
    if (handled) {
      event.preventDefault();
      state.selectedBandId = band.id;
      pushHistory(before);
      renderEq();
      saveState();
    }
  }

  function renderGraph(preserveHandles) {
    var safety = currentHeadroom();
    var channel = state.graphChannel;
    var effective = responseFromEngine(channel, true);
    var requested = responseFromEngine(channel, false);
    var path = pathFromSeries(effective);
    var firstX = frequencyToGraphX(effective[0].frequency);
    var lastX = frequencyToGraphX(effective[effective.length - 1].frequency);
    $("#responsePath").setAttribute("d", path);
    $("#responsePath").classList.toggle("clipping", safety.predictedOverDb > .05);
    $("#responseArea").setAttribute("d", path + " L" + lastX.toFixed(2) + " " + GRAPH.zero + " L" + firstX.toFixed(2) + " " + GRAPH.zero + " Z");
    $("#requestedPath").setAttribute("d", state.handling === "smooth" && safety.smoothingFactor < .995 ? pathFromSeries(requested) : "");
    $(".requested-legend").hidden = !(state.handling === "smooth" && safety.smoothingFactor < .995);
    $("#spectrumPath").style.display = state.graphMode === "response" ? "none" : "";
    $("#responsePath").style.display = state.graphMode === "spectrum" ? "none" : "";
    $("#responseArea").style.display = state.graphMode === "spectrum" ? "none" : "";
    $("#requestedPath").style.display = state.graphMode === "spectrum" ? "none" : "";
    if (preserveHandles) {
      $$(".band-handle").forEach(function (handle) {
        var band = editorBands().find(function (item) { return item.id === handle.dataset.bandId; });
        if (!band) return;
        handle.style.left = frequencyToGraphX(band.frequency) / 1000 * 100 + "%";
        handle.style.top = gainToGraphY(band.gain) / 460 * 100 + "%";
        handle.classList.toggle("selected", band.id === state.selectedBandId);
        handle.setAttribute("aria-valuetext", formatFrequency(band.frequency) + ", " + formatSigned(band.gain, 1) + " decibels");
      });
    } else {
      renderBandHandles();
    }
  }

  function renderInspector() {
    var band = selectedBand();
    var index = state.bands.indexOf(band);
    $("#selectedBandTitle").textContent = String(index + 1).padStart(2, "0") + " · " + typeLabel(band.type);
    $("#bandEnabledInput").checked = band.enabled;
    $$(".filter-type-row button").forEach(function (button) { button.classList.toggle("active", button.dataset.filter === band.type); });
    $("#frequencyInput").value = Math.round(band.frequency);
    $("#frequencyRange").value = frequencyToRange(band.frequency);
    setRangeProgress($("#frequencyRange"), 0, 1000, $("#frequencyRange").value);
    $("#gainInput").value = Number(band.gain).toFixed(1);
    $("#gainRange").value = band.gain;
    setRangeProgress($("#gainRange"), -18, 18, band.gain);
    $("#qInput").value = Number(band.q).toFixed(2);
    $("#qRange").value = qToRange(band.q);
    setRangeProgress($("#qRange"), 0, 1000, $("#qRange").value);
    $("#bandChannelSelect").value = band.channel;
    $("#deleteBandButton").disabled = state.bands.length <= 1;
    var shelf = band.type === "lowshelf" || band.type === "highshelf";
    $("#qInput").disabled = shelf;
    $("#qRange").disabled = shelf;
    $(".q-control").classList.toggle("disabled-control", shelf);
  }

  function faderItems() {
    var preamp = { id: "preamp", label: "Preamp", short: "PRE", range: "Full range", gain: state.preampDb, preamp: true };
    var bands = editorBands().map(function (band, index) {
      var tone = TONE_META[band.id];
      return {
        id: band.id,
        label: tone ? tone.label : formatFrequency(band.frequency),
        short: tone ? tone.short : String(index + 1).padStart(2, "0"),
        range: tone ? tone.range : (state.advancedBandCount === 30 ? typeLabel(band.type) + " · Q " + Number(band.q).toFixed(2) : "Band " + (index + 1)),
        gain: band.gain,
        band: band
      };
    });
    return [preamp].concat(bands);
  }

  function setFaderValue(item, value, lightweight) {
    if (item.preamp) state.preampDb = round(clamp(Number(value) || 0, -24, 12), 1);
    else item.band.gain = round(clamp(Number(value) || 0, -bandGainLimit(), bandGainLimit()), 1);
    renderGraph(true);
    renderSafety();
    updateFaderValues();
    renderToneZoneRail();
    updateAudioParameters();
    if (!lightweight) saveState();
  }

  function renderLinearEq() {
    var rack = $("#linearEqRack");
    rack.innerHTML = "";
    var items = faderItems();
    $("#linearEqCount").textContent = (state.mode === "basic" ? "7 controls" : state.advancedBandCount + " bands + preamp");
    items.forEach(function (item) {
      var limit = item.preamp ? 24 : bandGainLimit();
      var min = item.preamp ? -24 : -limit;
      var max = item.preamp ? 12 : limit;
      var lane = document.createElement("div");
      lane.className = "fader-lane" + (item.band && item.band.id === state.selectedBandId ? " selected" : "");
      lane.dataset.faderId = item.id;
      lane.innerHTML = '<span class="fader-index">' + escapeHtml(item.short) + '</span><strong>' + escapeHtml(item.label) + '</strong>' +
        '<input class="vertical-fader" type="range" min="' + min + '" max="' + max + '" step=".1" value="' + item.gain + '" aria-label="' + escapeHtml(item.label) + ' gain">' +
        '<input class="fader-number" type="number" min="' + min + '" max="' + max + '" step=".1" value="' + Number(item.gain).toFixed(1) + '" aria-label="' + escapeHtml(item.label) + ' exact gain in decibels">' +
        '<small>' + escapeHtml(item.range) + '</small><button type="button">Reset</button>';
      var range = $(".vertical-fader", lane);
      var number = $(".fader-number", lane);
      range.addEventListener("pointerdown", beginControlEdit);
      range.addEventListener("keydown", beginControlEdit);
      number.addEventListener("focus", beginControlEdit);
      range.addEventListener("input", function () { number.value = Number(range.value).toFixed(1); setFaderValue(item, range.value, true); });
      number.addEventListener("input", function () { range.value = number.value; setFaderValue(item, number.value, true); });
      range.addEventListener("change", endControlEdit);
      number.addEventListener("change", endControlEdit);
      number.addEventListener("blur", function () { if (controlSnapshot) endControlEdit(); });
      $("button", lane).addEventListener("click", function () { pushHistory(); setFaderValue(item, 0, false); renderEq(); });
      if (item.band) {
        $("strong", lane).addEventListener("click", function () { state.selectedBandId = item.band.id; renderEq(); saveState(); });
      }
      rack.appendChild(lane);
    });
  }

  function updateFaderValues() {
    faderItems().forEach(function (item) {
      var lane = $('[data-fader-id="' + item.id + '"]');
      if (!lane) return;
      $(".vertical-fader", lane).value = item.preamp ? state.preampDb : item.band.gain;
      $(".fader-number", lane).value = Number(item.preamp ? state.preampDb : item.band.gain).toFixed(1);
      lane.classList.toggle("selected", !!item.band && item.band.id === state.selectedBandId);
    });
  }

  function renderToneZoneRail() {
    var rail = $("#toneZoneRail");
    if (!rail) return;
    rail.innerHTML = "";
    state.toneBands.forEach(function (band) {
      var tone = TONE_META[band.id];
      if (!tone) return;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "tone-zone" + (band.id === state.selectedBandId ? " selected" : "");
      button.title = tone.range + " · Double-click to reset";
      button.setAttribute("aria-pressed", String(band.id === state.selectedBandId));
      button.setAttribute("aria-label", tone.label + ", " + formatSigned(band.gain, 1) + " decibels. " + tone.range);
      button.innerHTML = "<span>" + escapeHtml(tone.label) + "</span><strong>" + formatSigned(band.gain, 1) + " <small>dB</small></strong>";
      button.addEventListener("click", function () {
        state.selectedBandId = band.id;
        renderEq();
        saveState();
      });
      button.addEventListener("dblclick", function () {
        pushHistory();
        band.gain = 0;
        renderEq();
        saveState();
      });
      rail.appendChild(button);
    });
  }

  function renderEditorChrome() {
    $$('[data-band-count]').forEach(function (button) { button.classList.toggle("active", Number(button.dataset.bandCount) === state.advancedBandCount); });
    $("#resolutionNote").textContent = BANK_SPECS[state.advancedBandCount].note;
    $("#graphModeLabel").textContent = state.mode === "basic" ? "Six musical tone zones" : BANK_SPECS[state.advancedBandCount].label;
    $$('[data-editor-style]').forEach(function (button) {
      var active = button.dataset.editorStyle === state.editorStyle;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    $$('[data-editor-panel]').forEach(function (panel) { panel.classList.toggle("active", panel.dataset.editorPanel === state.editorStyle); });
  }

  function renderSafety() {
    var safety = currentHeadroom();
    var status = safety.predictedOverDb > .05 ? "clipping" : safety.remainingMarginDb < .5 && state.handling !== "auto" ? "risk" : "safe";
    var label = status === "clipping" ? "Clipping +" + safety.predictedOverDb.toFixed(1) : status === "risk" ? "Near ceiling" : "Protected";
    if (!state.eqEnabled || state.compareBypass) {
      status = "safe";
      label = state.compareBypass ? "Comparing" : "Bypassed";
    }

    $("#curvePeakMetric").innerHTML = formatSigned(safety.requestedCurvePeakDb, 1) + ' <small>dB</small>';
    $("#headroomMetric").innerHTML = "−" + safety.appliedHeadroomDb.toFixed(1) + ' <small>dB</small>';
    $("#headroomModeMetric").textContent = state.handling === "auto" ? "Auto" : state.handling === "curve" ? "Manual" : state.handling === "smooth" ? "Smoothed" : "Off";
    $("#outputMarginMetric").innerHTML = formatSigned(safety.remainingMarginDb, 1) + ' <small>dB</small>';
    $("#outputStatusMetric").textContent = label;
    $("#outputStatusMetric").className = status;

    $("#policyStatusPill").textContent = label;
    $("#policyStatusPill").className = "status-pill " + status;
    $("#boostBudget").textContent = "+" + safety.effectiveCurvePeakDb.toFixed(1) + " dB";
    $("#headroomBudget").textContent = "−" + safety.appliedHeadroomDb.toFixed(1) + " dB";
    $("#policyExplanation").textContent = policyCopy(safety);
    var normalizedBoost = clamp(safety.effectiveCurvePeakDb / Math.max(safety.effectiveCurvePeakDb, safety.appliedHeadroomDb, 1) * 100, 0, 100);
    var normalizedRisk = safety.predictedOverDb > 0 ? clamp(safety.predictedOverDb / Math.max(safety.effectiveCurvePeakDb, 1) * 100, 2, 100) : 0;
    $("#budgetUsed").style.width = normalizedBoost + "%";
    $("#budgetRisk").style.width = normalizedRisk + "%";

    $$(".policy-card").forEach(function (button) {
      var active = button.dataset.policy === state.handling;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", String(active));
    });

    $("#headroomEnabledInput").checked = state.headroomEnabled;
    $("#headroomToggleLabel").textContent = state.headroomEnabled ? "Enabled" : "Disabled";
    $("#headroomInput").value = Number(state.manualHeadroom).toFixed(1);
    $("#headroomRange").value = state.manualHeadroom;
    $("#headroomInput").disabled = state.handling === "auto" || state.handling === "clip";
    $("#headroomRange").disabled = state.handling === "auto" || state.handling === "clip";
    setRangeProgress($("#headroomRange"), 0, 24, state.manualHeadroom);
    $("#truePeakGuardInput").checked = state.truePeakGuard;
    $("#basicPreampValue").textContent = formatSigned(state.preampDb, 1) + " dB";
    $("#basicPreampRange").value = state.preampDb;
    setRangeProgress($("#basicPreampRange"), -24, 12, state.preampDb);
    $("#monitorStatus").textContent = status === "clipping" ? "Clipping risk" : state.eqEnabled ? "Protected" : "Bypassed";
    $(".monitor-footer .safe-dot").style.background = status === "clipping" ? "var(--red)" : status === "risk" ? "var(--amber)" : "var(--green)";

    $("#signalHeadroomTitle").textContent = state.handling === "auto" ? "Auto headroom" : state.handling === "curve" ? "Manual headroom" : state.handling === "smooth" ? "Curve smoothing" : "No protection";
    $("#signalHeadroomMeta").textContent = formatSigned(safety.effectivePreampDb, 1) + " dB net pre-EQ gain";
    $("#signalHeadroomState").textContent = safety.predictedOverDb > .05 ? "Risk" : "Safe";
    $("#signalHeadroomState").className = safety.predictedOverDb > .05 ? "danger" : "safe";
    $("#signalPolicyTitle").textContent = state.handling === "auto" ? "Auto" : state.handling === "curve" ? "Lower curve" : state.handling === "smooth" ? "Smooth peaks" : "Allow clipping";
    $("#signalPolicyMeta").textContent = state.handling === "smooth" ? "Effective boosts regularized" : state.handling === "clip" ? "Exact curve, zero attenuation" : "Exact curve preserved";
    $("#signalPolicyState").textContent = safety.predictedOverDb > .05 ? "+" + safety.predictedOverDb.toFixed(1) + " dB" : "Protected";
    $("#signalPolicyState").className = safety.predictedOverDb > .05 ? "danger" : "safe";
    $("#curvePeakLabel").textContent = "+" + safety.effectiveCurvePeakDb.toFixed(1) + " dB peak";
    $("#telemetryCurvePeak").textContent = "+" + safety.effectiveCurvePeakDb.toFixed(1) + " dB";
    $("#telemetryHeadroom").textContent = "−" + safety.appliedHeadroomDb.toFixed(1) + " dB";
    $("#telemetryMargin").textContent = formatSigned(safety.remainingMarginDb, 1) + " dB";
    $("#clipLatchValue").textContent = state.clipLatched ? "CLIPPED" : "Clear";
    $("#clipLatchValue").style.color = state.clipLatched ? "var(--red)" : "";
  }

  function renderEq(options) {
    options = options || {};
    syncEngineAnalysis();
    $("#activeProfileName").textContent = state.activeProfileName;
    $("#eqPowerButton").classList.toggle("active", state.eqEnabled);
    $("#eqPowerButton").setAttribute("aria-pressed", String(state.eqEnabled));
    $("#eqPowerButton span:last-child").textContent = state.eqEnabled ? "EQ ON" : "EQ OFF";
    $("#miniEqButton").classList.toggle("active", state.eqEnabled);
    $("#compareButton").classList.toggle("active", state.compareBypass);
    $("#compareButton").setAttribute("aria-pressed", String(state.compareBypass));
    $("#compareButton").textContent = state.compareBypass ? "B · Original" : "A/B Compare";
    renderGraph(!!options.lightweight);
    renderSafety();
    renderToneZoneRail();
    if (options.lightweight) {
      updateFaderValues();
      updateAudioParameters();
      return;
    }
    renderBandStrip();
    if (state.mode === "advanced") renderInspector();
    renderLinearEq();
    renderEditorChrome();
    updateHistoryButtons();
    rebuildAudioGraph();
  }

  function renderLibrary() {
    var query = ($("#librarySearch").value || "").trim().toLowerCase();
    var items = state.library.filter(function (item) {
      return !query || [item.title, item.artist, item.album, item.format].join(" ").toLowerCase().indexOf(query) !== -1;
    });
    items.sort(function (a, b) {
      if (state.librarySort === "artist") return a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album);
      if (state.librarySort === "album") return a.album.localeCompare(b.album) || a.artist.localeCompare(b.artist);
      if (state.librarySort === "title") return a.title.localeCompare(b.title);
      return state.library.indexOf(b) - state.library.indexOf(a);
    });

    $("#libraryCount").textContent = state.library.length + (state.library.length === 1 ? " track" : " tracks");
    $("#librarySort").value = state.librarySort;
    var grid = $("#albumGrid");
    grid.className = "album-grid density-" + state.libraryDensity;
    grid.innerHTML = "";
    items.forEach(function (item) {
      var article = document.createElement("article");
      article.className = "album-card";
      article.dataset.itemId = item.id;
      article.style.setProperty("--art-color", item.color || "#7355a8");
      article.innerHTML =
        '<label class="album-select"><input type="checkbox" aria-label="Select ' + escapeHtml(item.album) + '"></label>' +
        '<div class="album-art"><span>' + escapeHtml(initials(item.album)) + '</span><button class="album-play" aria-label="Play ' + escapeHtml(item.title) + '"><svg><use href="#i-play"/></svg></button></div>' +
        '<div class="album-meta"><strong>' + escapeHtml(item.album) + '</strong><span>' + escapeHtml(item.artist) + ' · ' + escapeHtml(item.format || "Local audio") + '</span></div>';
      var checkbox = $("input", article);
      checkbox.checked = librarySelection.has(item.id);
      checkbox.addEventListener("change", function () {
        if (checkbox.checked) librarySelection.add(item.id);
        else librarySelection.delete(item.id);
        renderBulkBar();
      });
      $(".album-play", article).addEventListener("click", function () {
        if (item.demo || !fileObjects.has(item.id)) {
          showToast("Choose the local file", "The library examples show layout only. Load your copy to hear it through UZjam.");
          $("#audioFileInput").click();
          return;
        }
        var queueTrack = libraryItemToQueueTrack(item);
        state.queue = [queueTrack];
        state.currentQueueIndex = 0;
        loadTrack(0, true);
        renderQueue();
      });
      grid.appendChild(article);
    });
    $("#libraryEmpty").hidden = items.length > 0;
    grid.hidden = items.length === 0;
    renderAlphabet(items);
    renderBulkBar();
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderAlphabet(items) {
    var nav = $("#alphabetScrubber");
    var letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    var available = new Set(items.map(function (item) { return (item.artist || "#").charAt(0).toUpperCase(); }));
    nav.innerHTML = "";
    letters.forEach(function (letter) {
      var button = document.createElement("button");
      button.textContent = letter;
      button.disabled = !available.has(letter);
      button.classList.toggle("available", available.has(letter));
      button.addEventListener("click", function () {
        var match = items.find(function (item) { return item.artist.charAt(0).toUpperCase() === letter; });
        if (!match) return;
        var card = $('.album-card[data-item-id="' + CSS.escape(match.id) + '"]');
        if (card) card.scrollIntoView({ behavior: state.settings.reduceMotion ? "auto" : "smooth", block: "center" });
      });
      nav.appendChild(button);
    });
  }

  function renderBulkBar() {
    $("#bulkBar").hidden = !selectionMode;
    $("#selectionCount").textContent = librarySelection.size;
    $(".library-view").classList.toggle("selecting", selectionMode);
  }

  function libraryItemToQueueTrack(item) {
    var file = fileObjects.get(item.id);
    return {
      id: uid("track"),
      libraryId: item.id,
      title: item.title,
      artist: item.artist || "Local file",
      album: item.album || "Imported",
      format: item.format || "Local audio",
      color: item.color || "#7355a8",
      duration: item.duration || 0,
      playable: !!file,
      url: file ? URL.createObjectURL(file) : null
    };
  }

  function profileCard(profile, starter) {
    var article = document.createElement("article");
    var active = profile.id === state.activeProfileId;
    article.className = "profile-card" + (active ? " active" : "");
    article.style.setProperty("--profile-color", profile.color || "#8b63ed");
    article.dataset.profileId = profile.id;
    var profileBands = profile.uzjamProfile
      ? profile.uzjamProfile.filters
      : Array.isArray(profile.bands) ? profile.bands : profile.bandBanks && profile.bandBanks[String(profile.advancedBandCount || 10)] || [];
    var profileHandling = profile.uzjamProfile
      ? profile.uzjamProfile.dsp.clippingPolicy
      : profile.handling;
    article.innerHTML =
      '<header><span class="profile-badge">' + escapeHtml(initials(profile.name)) + '</span>' + (active ? '<span class="active-label">ACTIVE</span>' : '<span></span>') + '</header>' +
      '<h3>' + escapeHtml(profile.name) + '</h3><p>' + escapeHtml(profile.device || "Custom output") + '</p>' +
      '<footer><span>' + profileBands.filter(function (band) { return band.enabled; }).length + ' bands · ' + (profileHandling === "auto" ? "Auto" : profileHandling) + '</span><button>' + (active ? "Open" : starter ? "Use template" : "Apply") + '</button></footer>';
    $("button", article).addEventListener("click", function () {
      applyProfile(profile, starter);
    });
    return article;
  }

  function renderProfiles() {
    var query = ($("#profileSearch").value || "").trim().toLowerCase();
    var own = state.profiles.filter(function (profile) { return !query || (profile.name + " " + profile.device).toLowerCase().indexOf(query) !== -1; });
    var starters = starterProfiles.filter(function (profile) { return !query || (profile.name + " " + profile.device).toLowerCase().indexOf(query) !== -1; });
    var ownGrid = $("#profileGrid");
    var starterGrid = $("#starterProfileGrid");
    ownGrid.innerHTML = "";
    starterGrid.innerHTML = "";
    own.forEach(function (profile) { ownGrid.appendChild(profileCard(profile, false)); });
    starters.forEach(function (profile) { starterGrid.appendChild(profileCard(profile, true)); });
  }

  function applyProfile(profile, starter) {
    pushHistory();
    if (profile.uzjamProfile) {
      hydrateEditorFromProfile(profile.uzjamProfile);
      state.uzjamProfile = clone(profile.uzjamProfile);
      state.activeProfileId = starter ? uid("starter-session") : profile.id;
      state.activeProfileName = profile.name;
      state.selectedBandId = (state.mode === "basic" ? state.toneBands[0] : state.bands[0]).id;
      soloBandId = null;
      setProfileDockOpen(false);
      renderEq();
      saveState();
      showToast("Profile applied", profile.name + " is now active.");
      return;
    }
    var sourceBands = Array.isArray(profile.bands) ? profile.bands : profile.bandBanks && profile.bandBanks[String(profile.advancedBandCount || 10)] || initialBands;
    state.advancedBandCount = [10, 15, 30].indexOf(Number(profile.advancedBandCount)) !== -1 ? Number(profile.advancedBandCount) : 10;
    state.bands = clone(sourceBands).map(function (band) {
      var copy = clone(band);
      return copy;
    });
    state.bandBanks = profile.bandBanks ? clone(profile.bandBanks) : { "10": clone(state.advancedBandCount === 10 ? state.bands : createStandardBands(10)), "15": createStandardBands(15), "30": clone(state.advancedBandCount === 30 ? state.bands : createStandardBands(30)) };
    state.bandBanks[String(state.advancedBandCount)] = clone(state.bands);
    state.toneBands = migrateToneBands(profile.toneBands);
    state.preampDb = profile.preampDb == null ? 0 : clamp(Number(profile.preampDb), -24, 12);
    state.handling = profile.handling || "auto";
    state.headroomEnabled = state.handling !== "clip";
    state.manualHeadroom = Number(profile.manualHeadroom == null ? 4 : profile.manualHeadroom);
    state.activeProfileId = starter ? uid("starter-session") : profile.id;
    state.activeProfileName = profile.name;
    state.selectedBandId = (state.mode === "basic" ? state.toneBands[0] : state.bands[0]).id;
    renderEq();
    renderProfiles();
    saveState();
    navigate("studio");
    setProfileDockOpen(false);
    showToast("Profile applied", profile.name + " is now active.");
  }

  function renderQueue() {
    var list = $("#queueList");
    list.innerHTML = "";
    state.queue.forEach(function (track, index) {
      var item = document.createElement("li");
      item.className = "queue-item" + (index === state.currentQueueIndex ? " playing" : "");
      item.style.setProperty("--track-color", track.color || "#7355a8");
      item.innerHTML =
        '<span class="queue-index">' + (index === state.currentQueueIndex && !isTabCaptureActive() && !$("#audioElement").paused ? "▶" : String(index + 1).padStart(2, "0")) + '</span>' +
        '<button class="queue-thumb" aria-label="Play ' + escapeHtml(track.title) + '">' + escapeHtml(initials(track.title)) + '</button>' +
        '<div class="queue-track"><strong>' + escapeHtml(track.title) + '</strong><span>' + escapeHtml(track.artist || "Local file") + '</span></div>' +
        '<span class="queue-album">' + escapeHtml(track.album || "Imported") + '</span>' +
        '<span class="queue-duration">' + (track.duration ? formatTime(track.duration) : "—") + '</span>' +
        '<div class="queue-actions"><button data-action="up" aria-label="Move up">↑</button><button data-action="down" aria-label="Move down">↓</button><button data-action="remove" aria-label="Remove">×</button></div>';
      $(".queue-thumb", item).addEventListener("click", function () { loadTrack(index, true); });
      $$(".queue-actions button", item).forEach(function (button) {
        button.addEventListener("click", function () { queueAction(index, button.dataset.action); });
      });
      list.appendChild(item);
    });
    $("#queueEmpty").hidden = state.queue.length > 0;
    list.hidden = state.queue.length === 0;
    $("#queueTrackCount").textContent = state.queue.length;
    var totalDuration = state.queue.reduce(function (sum, track) { return sum + (Number(track.duration) || 0); }, 0);
    $("#queueDuration").textContent = totalDuration ? formatTime(totalDuration) : "—";
    var current = state.queue[state.currentQueueIndex];
    $("#queueNowPlaying").textContent = current ? current.title + " — " + current.artist : "No local track loaded";
    $("#shuffleQueueButton").classList.toggle("active", state.shuffled);
    $("#shuffleQueueButton").setAttribute("aria-pressed", String(state.shuffled));
  }

  function queueAction(index, action) {
    if (action === "remove") {
      var removedCurrent = index === state.currentQueueIndex;
      state.queue.splice(index, 1);
      if (removedCurrent) {
        $("#audioElement").pause();
        state.currentQueueIndex = Math.min(index, state.queue.length - 1);
        if (state.currentQueueIndex >= 0) loadTrack(state.currentQueueIndex, false);
        else clearPlayer();
      } else if (index < state.currentQueueIndex) {
        state.currentQueueIndex -= 1;
      }
    } else {
      var target = action === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= state.queue.length) return;
      var temp = state.queue[index];
      state.queue[index] = state.queue[target];
      state.queue[target] = temp;
      if (state.currentQueueIndex === index) state.currentQueueIndex = target;
      else if (state.currentQueueIndex === target) state.currentQueueIndex = index;
    }
    renderQueue();
    saveState();
  }

  function renderSignal() {
    var activeBands = processingBands().filter(function (band) { return band.enabled; }).length;
    $("#signalEqTitle").textContent = activeBands + (activeBands === 1 ? " active band" : " active bands");
    $("#signalEqState").textContent = state.eqEnabled ? "On" : "Bypassed";
    $("#signalEqState").className = state.eqEnabled ? "violet" : "neutral";
    var current = state.queue[state.currentQueueIndex];
    var nativeSource = nativeAudio.running ? findNativeDevice(state.settings.nativeInputDeviceId, "input") : null;
    var nativeOutput = nativeAudio.running ? findNativeDevice(state.settings.nativeOutputDeviceId, "output") : null;
    var directActive = !!(nativeAudio.direct.status && nativeAudio.direct.status.active);
    var directOutput = directActive ? findNativeDevice(state.settings.nativeDirectOutputDeviceId, "output") : null;
    if (directActive) {
      $("#signalSourceTitle").textContent = "Windows system playback";
      $("#signalSourceMeta").textContent = "All shared-mode apps on the selected endpoint";
      $("#signalSourceState").textContent = "Live";
      $("#signalSourceState").className = "safe";
    } else if (nativeAudio.running) {
      var browserExtensionRoute = nativeAudio.status && nativeAudio.status.sourceDeviceId === "uzjam-browser-extension";
      $("#signalSourceTitle").textContent = browserExtensionRoute ? (isTabCaptureActive() ? (tabCapture.label || "Chrome tab") : "Waiting for Chrome") : nativeSource ? nativeSource.name : "Windows capture source";
      $("#signalSourceMeta").textContent = browserExtensionRoute ? (isTabCaptureActive() ? "Chrome extension · Rust DSP" : "Choose a tab from the UZjam extension") : nativeSource && (nativeSource.kind === "systemLoopback" || nativeSource.isLoopback) ? "WASAPI system loopback" : "WASAPI capture endpoint";
      $("#signalSourceState").textContent = browserExtensionRoute && !isTabCaptureActive() ? "Connecting" : "Live";
      $("#signalSourceState").className = browserExtensionRoute && !isTabCaptureActive() ? "violet" : "safe";
    } else if (isTabCaptureActive()) {
      $("#signalSourceTitle").textContent = "Browser tab";
      $("#signalSourceMeta").textContent = (tabCapture.status === "muted" ? "Source quiet" : "Live capture") + " · " + ((audioContext ? audioContext.sampleRate : SAMPLE_RATE_FALLBACK) / 1000).toFixed(1).replace(".0", "") + " kHz";
      $("#signalSourceState").textContent = tabCapture.status === "muted" ? "Quiet" : "Connected";
      $("#signalSourceState").className = tabCapture.status === "muted" ? "neutral" : "safe";
    } else if (tabCapture.requesting) {
      $("#signalSourceTitle").textContent = "Waiting for browser";
      $("#signalSourceMeta").textContent = "Choose the tab playing audio";
      $("#signalSourceState").textContent = "Connecting";
      $("#signalSourceState").className = "violet";
    } else if (tabCapture.status === "error") {
      $("#signalSourceTitle").textContent = tabCapture.issueTitle || "Browser tab unavailable";
      $("#signalSourceMeta").textContent = tabCapture.issueText || "Choose another source";
      $("#signalSourceState").textContent = "Attention";
      $("#signalSourceState").className = "danger";
    } else {
      $("#signalSourceTitle").textContent = current ? current.title : "Choose a source";
      $("#signalSourceMeta").textContent = current ? (current.format || "Local file") + " · " + (current.artist || "Unknown artist") : "Local files or a browser tab";
      $("#signalSourceState").textContent = current ? "Local" : "Ready";
      $("#signalSourceState").className = current ? "safe" : "neutral";
    }
    var activeSampleRate = nativeAudio.running && nativeAudio.status && nativeAudio.status.sampleRateHz ? nativeAudio.status.sampleRateHz : audioContext ? audioContext.sampleRate : SAMPLE_RATE_FALLBACK;
    $("#sampleRateValue").textContent = directActive ? "Device rate" : (activeSampleRate / 1000).toFixed(activeSampleRate % 1000 ? 1 : 0).replace(".0", "") + " kHz";
    if (directActive) {
      $("#signalOutputTitle").textContent = directOutput ? directOutput.name : "Windows direct output";
      $("#signalOutputMeta").textContent = "Rust DSP → endpoint APO · device mix format";
      $("#signalOutputState").textContent = "System-wide";
      $("#signalOutputState").className = "safe";
    } else if (nativeAudio.running) {
      $("#signalOutputTitle").textContent = nativeOutput ? nativeOutput.name : "Windows listening output";
      $("#signalOutputMeta").textContent = "Rust DSP → WASAPI · " + $("#sampleRateValue").textContent;
      $("#signalOutputState").textContent = "Live";
      $("#signalOutputState").className = "safe";
    } else {
      $("#signalOutputTitle").textContent = isTabCaptureActive() ? "Processed browser output" : "Browser output";
      $("#signalOutputMeta").textContent = "Web Audio route · " + $("#sampleRateValue").textContent;
      $("#signalOutputState").textContent = "Local";
      $("#signalOutputState").className = "neutral";
    }
    renderSafety();
  }

  function applyAppearanceSettings() {
    document.documentElement.dataset.theme = state.settings.theme;
    $("meta[name='theme-color']").setAttribute("content", state.settings.theme === "dark" ? "#090a0d" : "#f4f5f8");
    document.documentElement.classList.toggle("high-contrast", !!state.settings.highContrast);
    document.documentElement.classList.toggle("reduce-motion", !!state.settings.reduceMotion);
    $("#themeSelect").value = state.settings.theme;
    $("#highContrastInput").checked = !!state.settings.highContrast;
    $("#reduceMotionInput").checked = !!state.settings.reduceMotion;
    $("#analyzerInput").checked = !!state.settings.analyzer;
    $("#nearbyBandsInput").checked = !!state.settings.nearbyBands;
    $("#defaultModeSelect").value = state.settings.defaultMode;
    $("#albumColumnsSelect").value = String(state.libraryDensity);
    $("#duplicateReportInput").checked = !!state.settings.duplicateReport;
    $("#resumePlaybackInput").checked = !!state.settings.resumePlayback;
    $("#nativeAutoStartInput").checked = !!state.settings.nativeAutoStart;
    $("#nativeBufferFrames").value = String(Number(state.settings.nativeBufferFrames) || 256);
  }

  function disconnectAudioGraph() {
    if (!audioGraph) return;
    audioGraph.nodes.forEach(function (node) {
      try { node.disconnect(); } catch (error) { }
    });
    audioGraph = null;
  }

  function ensureAudioContext() {
    if (audioContext) return audioContext;
    var Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) {
      showToast("Audio processing unavailable", "This browser does not expose the standard Web Audio API.", "error");
      return null;
    }
    try {
      audioContext = new Context({ latencyHint: "interactive" });
    } catch (error) {
      audioContext = new Context();
    }
    localAudioSourceNode = audioContext.createMediaElementSource($("#audioElement"));
    audioSourceNode = localAudioSourceNode;
    rebuildAudioGraph();
    return audioContext;
  }

  function switchAudioSource(node) {
    if (!node || node === audioSourceNode) return;
    if (audioSourceNode) {
      try { audioSourceNode.disconnect(); } catch (error) { }
    }
    audioSourceNode = node;
    rebuildAudioGraph();
  }

  function isTabCaptureActive() {
    return tabCapture.status === "active" || tabCapture.status === "muted";
  }

  function isPlaybackActive() {
    return isTabCaptureActive() || !$("#audioElement").paused;
  }

  function rebuildAudioGraph() {
    if (!audioContext || !audioSourceNode) return;
    syncEngineAnalysis();
    disconnectAudioGraph();
    try { audioSourceNode.disconnect(); } catch (error) { }

    var nodes = [];
    var safety = currentHeadroom();
    var inputGain = audioContext.createGain();
    var preGain = audioContext.createGain();
    var splitter = audioContext.createChannelSplitter(2);
    var merger = audioContext.createChannelMerger(2);
    var analyzer = audioContext.createAnalyser();
    var channelAnalyzers = [];
    var filterNodes = [];
    analyzer.fftSize = 8192;
    analyzer.minDecibels = -96;
    analyzer.maxDecibels = 0;
    analyzer.smoothingTimeConstant = .72;
    inputGain.channelCount = 2;
    inputGain.channelCountMode = "explicit";
    inputGain.channelInterpretation = "speakers";
    inputGain.gain.value = 1;
    preGain.gain.value = state.eqEnabled && !state.compareBypass ? safety.effectivePreampLinear : 1;
    nodes.push(inputGain, preGain, splitter, merger, analyzer);
    audioSourceNode.connect(inputGain);
    inputGain.connect(preGain);
    preGain.connect(splitter);

    ["left", "right"].forEach(function (channel, channelIndex) {
      var channelGain = audioContext.createGain();
      channelGain.gain.value = 1;
      nodes.push(channelGain);
      var channelAnalyzer = audioContext.createAnalyser();
      channelAnalyzer.fftSize = 2048;
      channelAnalyzer.smoothingTimeConstant = .45;
      channelAnalyzers.push(channelAnalyzer);
      nodes.push(channelAnalyzer);
      var activeBands = state.eqEnabled && !state.compareBypass
        ? processingBands().filter(function (band) { return band.enabled && channelIncludes(band, channel) && (!soloBandId || band.id === soloBandId); })
        : [];
      var firstNode = null;
      var previous = null;
      activeBands.forEach(function (band) {
        var filter = audioContext.createBiquadFilter();
        filter.type = band.type;
        filter.frequency.value = clamp(band.frequency, 20, audioContext.sampleRate * .45);
        filter.gain.value = effectiveGainForBand(band);
        filter.Q.value = clamp(band.q, .1, 24);
        nodes.push(filter);
        filterNodes.push({ bandId: band.id, channel: channel, node: filter });
        if (!firstNode) firstNode = filter;
        if (previous) previous.connect(filter);
        previous = filter;
      });
      if (firstNode) {
        splitter.connect(firstNode, channelIndex, 0);
        previous.connect(channelGain);
      } else {
        splitter.connect(channelGain, channelIndex, 0);
      }
      channelGain.connect(channelAnalyzer);
      channelAnalyzer.connect(merger, 0, channelIndex);
    });

    merger.connect(analyzer);
    analyzer.connect(audioContext.destination);
    audioGraph = {
      nodes: nodes,
      inputGain: inputGain,
      preGain: preGain,
      analyzer: analyzer,
      channelAnalyzers: channelAnalyzers,
      filterNodes: filterNodes,
      timeBuffers: channelAnalyzers.map(function (node) { return new Float32Array(node.fftSize); }),
      spectrumBuffer: new Float32Array(analyzer.frequencyBinCount),
      safety: safety
    };
    if (isPlaybackActive()) startAnalyzer();
  }

  function updateAudioParameters() {
    if (!audioContext || !audioGraph) return;
    var safety = currentHeadroom();
    var now = audioContext.currentTime;
    var totalPreampLinear = state.eqEnabled && !state.compareBypass ? safety.effectivePreampLinear : 1;
    audioGraph.preGain.gain.setTargetAtTime(totalPreampLinear, now, .012);
    var allBands = processingBands();
    audioGraph.filterNodes.forEach(function (entry) {
      var band = allBands.find(function (item) { return item.id === entry.bandId; });
      if (!band) return;
      entry.node.frequency.setTargetAtTime(clamp(band.frequency, 20, audioContext.sampleRate * .45), now, .012);
      entry.node.gain.setTargetAtTime(effectiveGainForBand(band), now, .012);
      entry.node.Q.setTargetAtTime(clamp(band.q, .1, 24), now, .012);
    });
    audioGraph.safety = safety;
  }

  function meterStats(analyzer, buffer) {
    analyzer.getFloatTimeDomainData(buffer);
    var sum = 0;
    var peak = 0;
    for (var i = 0; i < buffer.length; i += 1) {
      var value = Math.abs(buffer[i]);
      sum += value * value;
      if (value > peak) peak = value;
    }
    var rms = Math.sqrt(sum / Math.max(1, buffer.length));
    return { rmsDb: rms > 0 ? 20 * Math.log10(rms) : -100, peakDb: peak > 0 ? 20 * Math.log10(peak) : -100, peak: peak };
  }

  function paintVu(side, stats, timestamp) {
    var key = side === "L" ? "left" : "right";
    var holdKey = side === "L" ? "holdLeft" : "holdRight";
    var untilKey = side === "L" ? "holdUntilLeft" : "holdUntilRight";
    var current = meterState[key];
    var amount = stats.rmsDb > current ? .34 : .075;
    meterState[key] = current + (stats.rmsDb - current) * amount;
    if (stats.peakDb >= meterState[holdKey]) {
      meterState[holdKey] = stats.peakDb;
      meterState[untilKey] = timestamp + 1200;
    } else if (timestamp > meterState[untilKey]) {
      meterState[holdKey] += (-100 - meterState[holdKey]) * .035;
    }
    var percent = clamp((meterState[key] + 60) / 60 * 100, 0, 100);
    var holdPercent = clamp((meterState[holdKey] + 60) / 60 * 100, 0, 100);
    $(side === "L" ? "#vuLFill" : "#vuRFill").style.height = percent + "%";
    $(side === "L" ? "#vuLFill" : "#vuRFill").nextElementSibling.style.bottom = holdPercent + "%";
    $(side === "L" ? "#vuLValue" : "#vuRValue").textContent = meterState[key] > -99 ? meterState[key].toFixed(1) : "−∞";
    var micro = $(side === "L" ? "#meterL" : "#meterR");
    micro.style.width = clamp((stats.peakDb + 48) / 48 * 100, 0, 100) + "%";
    micro.style.background = stats.peakDb > -1 ? "var(--red)" : stats.peakDb > -6 ? "var(--amber)" : "var(--green)";
  }

  function startAnalyzer() {
    cancelAnimationFrame(analyzerFrame);
    function tick(timestamp) {
      if (!audioGraph || !audioGraph.analyzer) return;
      var leftStats = meterStats(audioGraph.channelAnalyzers[0], audioGraph.timeBuffers[0]);
      var rightStats = meterStats(audioGraph.channelAnalyzers[1], audioGraph.timeBuffers[1]);
      var peak = Math.max(leftStats.peak, rightStats.peak);
      var peakDb = Math.max(leftStats.peakDb, rightStats.peakDb);
      if (peak >= .999) {
        state.clipLatched = true;
        $("#clipLatchValue").textContent = "CLIPPED";
        $("#clipLatchValue").style.color = "var(--red)";
      }
      if (timestamp - lastMeterUpdate > 60) {
        paintVu("L", leftStats, timestamp);
        paintVu("R", rightStats, timestamp);
        var meterPercent = clamp((peakDb + 48) / 48 * 100, 0, 100);
        $("#telemetryBar").style.width = meterPercent + "%";
        $("#telemetryBar").style.background = peakDb > -1 ? "var(--red)" : peakDb > -6 ? "var(--amber)" : "var(--green)";
        $("#inputLevelLabel").textContent = peakDb > -99 ? peakDb.toFixed(1) + " dBFS" : "−∞ dBFS";
        $("#outputLevelLabel").textContent = peakDb > -99 ? peakDb.toFixed(1) + " dBFS" : "−∞ dBFS";
        if (state.settings.analyzer && (state.monitorMode === "spectrum" || state.graphMode !== "response")) drawSpectrum(audioGraph.analyzer);
        lastMeterUpdate = timestamp;
      }
      if (isPlaybackActive()) analyzerFrame = requestAnimationFrame(tick);
    }
    analyzerFrame = requestAnimationFrame(tick);
  }

  function stopAnalyzer(reset) {
    cancelAnimationFrame(analyzerFrame);
    analyzerFrame = 0;
    if (!reset) return;
    meterState = { left: -100, right: -100, holdLeft: -100, holdRight: -100, holdUntilLeft: 0, holdUntilRight: 0 };
    ["L", "R"].forEach(function (side) {
      var fill = $(side === "L" ? "#vuLFill" : "#vuRFill");
      var micro = $(side === "L" ? "#meterL" : "#meterR");
      var value = $(side === "L" ? "#vuLValue" : "#vuRValue");
      if (fill) fill.style.height = "0%";
      if (fill && fill.nextElementSibling) fill.nextElementSibling.style.bottom = "0%";
      if (micro) micro.style.width = "0%";
      if (value) value.textContent = "−∞";
    });
    $("#telemetryBar").style.width = "0%";
    $("#inputLevelLabel").textContent = "−∞ dBFS";
    $("#outputLevelLabel").textContent = "−∞ dBFS";
  }

  function drawSpectrum(analyzer) {
    var bins = audioGraph && audioGraph.spectrumBuffer && audioGraph.spectrumBuffer.length === analyzer.frequencyBinCount ? audioGraph.spectrumBuffer : new Float32Array(analyzer.frequencyBinCount);
    analyzer.getFloatFrequencyData(bins);
    var sampleRate = audioContext ? audioContext.sampleRate : SAMPLE_RATE_FALLBACK;
    var graphPath = "";
    var monitorPath = "";
    for (var i = 0; i < 96; i += 1) {
      var ratio = i / 95;
      var frequency = ratioToFrequency(ratio);
      var bin = Math.round(frequency / (sampleRate / 2) * (bins.length - 1));
      var nextFrequency = ratioToFrequency(Math.min(1, (i + 1) / 95));
      var nextBin = Math.max(bin, Math.round(nextFrequency / (sampleRate / 2) * (bins.length - 1)));
      var totalPower = 0;
      var samples = 0;
      for (var b = clamp(bin, 0, bins.length - 1); b <= clamp(nextBin, 0, bins.length - 1); b += 1) {
        totalPower += Math.pow(10, bins[b] / 10);
        samples += 1;
      }
      var db = samples ? 10 * Math.log10(Math.max(1e-10, totalPower / samples)) : -96;
      var level = clamp((db + 96) / 96, 0, 1);
      var x = frequencyToGraphX(frequency);
      var y = GRAPH.bottom - level * (GRAPH.bottom - GRAPH.top) * .72;
      graphPath += (i ? " L" : "M") + x.toFixed(2) + " " + y.toFixed(2);
      var mx = 18 + ratio * 286;
      var my = 232 - level * 208;
      monitorPath += (i ? " L" : "M") + mx.toFixed(2) + " " + my.toFixed(2);
    }
    $("#spectrumPath").setAttribute("d", graphPath);
    $("#monitorSpectrumPath").setAttribute("d", monitorPath);
    $("#monitorSpectrumArea").setAttribute("d", monitorPath + " L304 232 L18 232 Z");
  }

  function randomColor(seed) {
    var colors = ["#795fb0", "#477c88", "#9a5b62", "#a16c45", "#556f9a", "#657d62", "#8b537e"];
    var total = String(seed || "").split("").reduce(function (sum, char) { return sum + char.charCodeAt(0); }, 0);
    return colors[total % colors.length];
  }

  function isAudioFile(file) {
    var extension = String(file.name || "").split(".").pop().toLowerCase();
    return (file.type && file.type.indexOf("audio/") === 0) || AUDIO_EXTENSIONS.indexOf(extension) !== -1;
  }

  function addAudioFiles(fileList, sourceLabel) {
    var files = Array.prototype.slice.call(fileList || []).filter(isAudioFile);
    if (!files.length) {
      showToast("No supported audio found", "Choose FLAC, ALAC, WAV, AIFF, MP3, M4A, AAC, OGG, or Opus files.", "error");
      return [];
    }
    var existingKeys = new Set(state.library.map(function (item) { return (item.filename || item.title) + ":" + (item.size || 0); }));
    var duplicates = 0;
    var addedItems = [];
    files.forEach(function (file) {
      var key = file.name + ":" + file.size;
      if (existingKeys.has(key)) {
        duplicates += 1;
        return;
      }
      existingKeys.add(key);
      var extension = file.name.split(".").pop().toUpperCase();
      var item = {
        id: uid("local"),
        title: titleFromFilename(file.name),
        artist: "Local file",
        album: sourceLabel || "Imported",
        filename: file.name,
        size: file.size,
        format: extension,
        color: randomColor(file.name),
        demo: false
      };
      fileObjects.set(item.id, file);
      state.library.push(item);
      addedItems.push(item);
    });

    if (addedItems.length) {
      var tracks = addedItems.map(libraryItemToQueueTrack);
      state.queue = state.queue.concat(tracks);
      if (state.currentQueueIndex < 0) state.currentQueueIndex = 0;
      loadTrack(state.currentQueueIndex, false);
      renderLibrary();
      renderQueue();
      saveState();
      showToast("Added " + addedItems.length + (addedItems.length === 1 ? " track" : " tracks"), "Ready in your library and queue.");
    }
    if (duplicates && state.settings.duplicateReport) showToast("Skipped " + duplicates + (duplicates === 1 ? " duplicate" : " duplicates"), "Existing files were left unchanged.");
    return addedItems;
  }

  function tabCaptureSupport() {
    if (nativeAudio.available) {
      var bridge = nativeAudio.extension.status;
      if (bridge && bridge.available === false) return { supported: false, reason: bridge.lastError || "The Chrome extension bridge could not start." };
      if (bridge && bridge.pairingCode) return { supported: true, reason: "Chrome extension pairing code: " + bridge.pairingCode };
      return { supported: true, reason: "UZjam is starting its private Chrome extension bridge." };
    }
    var mediaDevices = navigator.mediaDevices;
    var ua = navigator.userAgent || "";
    var brands = navigator.userAgentData && Array.isArray(navigator.userAgentData.brands)
      ? navigator.userAgentData.brands.map(function (brand) { return brand.brand; }).join(" ")
      : "";
    var mobile = !!(navigator.userAgentData && navigator.userAgentData.mobile) || /Android|iPhone|iPad|iPod|Mobi/i.test(ua);
    var chromium = /Chrome\/|Chromium\/|Edg\//i.test(ua) || /Chromium|Google Chrome|Microsoft Edge/i.test(brands);
    if (!window.isSecureContext) return { supported: false, reason: "Browser Tab mode needs UZjam's secure website." };
    if (mobile) return { supported: false, reason: "Browser Tab mode is available in desktop Chrome and Edge. Local files still work here." };
    if (!mediaDevices || typeof mediaDevices.getDisplayMedia !== "function") return { supported: false, reason: "This browser cannot share tab audio. Open UZjam in desktop Chrome or Edge." };
    if (!(window.AudioContext || window.webkitAudioContext)) return { supported: false, reason: "This browser does not provide the audio engine UZjam needs." };
    if (!chromium) return { supported: false, reason: "Browser Tab mode is tuned for desktop Chrome and Edge. Local files still work in this browser." };
    return { supported: true, reason: "Only the tab you choose is heard. Nothing is uploaded or recorded." };
  }

  function announceCapture(message) {
    var live = $("#captureAnnouncement");
    live.textContent = "";
    window.setTimeout(function () { live.textContent = message; }, 20);
  }

  function stopMediaStream(stream) {
    if (!stream) return;
    stream.getTracks().forEach(function (track) {
      try { track.stop(); } catch (error) { }
    });
  }

  function captureLabel(track) {
    var label = String(track && track.label || "Live browser audio")
      .replace(/^(Chrome|Chromium|Microsoft Edge|Edge)\s+Tab\s*[-–—:]?\s*/i, "")
      .trim();
    return (label || "Live browser audio").slice(0, 80);
  }

  function renderLocalPlayerChrome() {
    var current = state.queue[state.currentQueueIndex];
    var available = current && current.playable && current.url;
    if (available) {
      $("#playerTrackTitle").textContent = current.title;
      $("#playerTrackArtist").textContent = current.artist || "Local file";
      $("#trackArtLetters").textContent = initials(current.album || current.title);
      $("#trackArtLetters").parentElement.style.background = "radial-gradient(circle at 35% 30%, " + current.color + "66, transparent 38%), linear-gradient(145deg, " + current.color + "33, var(--bg-raised))";
      $("#formatChip").textContent = current.format || "LOCAL AUDIO";
    } else {
      $("#playerTrackTitle").textContent = "Choose an audio source";
      $("#playerTrackArtist").textContent = "Local files or a browser tab";
      $("#trackArtLetters").textContent = "UZ";
      $("#trackArtLetters").parentElement.style.background = "radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--violet) 34%, transparent), transparent 38%), linear-gradient(145deg, #191724, #0d0e12)";
      $("#formatChip").textContent = "LOCAL PCM";
    }
    $("#sourceButton span").textContent = "Source";
  }

  function renderCaptureClock() {
    if (!isTabCaptureActive() || !tabCapture.startedAt) {
      $("#captureElapsed").textContent = "0:00";
      return;
    }
    $("#captureElapsed").textContent = formatTime((Date.now() - tabCapture.startedAt) / 1000);
  }

  function renderCaptureState() {
    var support = tabCaptureSupport();
    var option = $("#chooseTabSource");
    var optionAction = $(".source-option-action", option);
    var supportText = $("#tabCaptureSupportNote span");
    option.disabled = !support.supported;
    option.setAttribute("aria-disabled", String(!support.supported));
    option.classList.toggle("is-unsupported", !support.supported);
    optionAction.textContent = support.supported ? (isTabCaptureActive() ? "Change tab" : nativeAudio.available ? "Use extension" : "Choose a tab") : "Desktop only";
    supportText.textContent = support.reason;
    var optionDescription = $(".source-option-copy small", option);
    if (optionDescription) optionDescription.textContent = nativeAudio.available
      ? "Select your exact tab from the UZjam Chrome extension. Audio returns here for Rust DSP, headroom protection, and your chosen DAC."
      : "Choose Browser Tab, select the tab playing audio, and keep Share tab audio on. Choose the music tab—not this UZjam tab.";
    var copyCode = $("#copyPairingCode");
    if (copyCode) copyCode.hidden = !(nativeAudio.available && nativeAudio.extension.status && nativeAudio.extension.status.pairingCode);

    var active = isTabCaptureActive();
    var displayState = tabCapture.requesting ? "requesting" : tabCapture.status;
    var statusBar = $("#captureStatusBar");
    var statusAction = $("#captureStatusAction");
    statusBar.hidden = displayState === "idle";
    statusBar.dataset.state = displayState;
    statusAction.disabled = false;

    if (tabCapture.requesting) {
      $("#captureStatusTitle").textContent = active ? "Choose another browser tab" : nativeAudio.available ? "Waiting for the Chrome extension" : "Waiting for your browser";
      $("#captureStatusText").textContent = active ? "Your current tab keeps playing until a replacement is connected." : nativeAudio.available ? "Click the UZjam extension in Chrome, then choose the exact tab you want to hear." : "Select Browser Tab, choose the music tab, and keep Share tab audio on.";
      statusAction.textContent = active || tabCapture.native ? "Stop" : "Waiting…";
      statusAction.disabled = !active && !tabCapture.native;
    } else if (tabCapture.status === "active") {
      $("#captureStatusTitle").textContent = "Browser tab connected";
      $("#captureStatusText").textContent = tabCapture.label + " · Processed through " + state.activeProfileName + ".";
      statusAction.textContent = "Stop";
    } else if (tabCapture.status === "muted") {
      $("#captureStatusTitle").textContent = "Source is quiet";
      $("#captureStatusText").textContent = "The shared tab may be paused or muted. UZjam will resume automatically with it.";
      statusAction.textContent = "Stop";
    } else if (tabCapture.status === "error") {
      $("#captureStatusTitle").textContent = tabCapture.issueTitle || "Browser tab unavailable";
      $("#captureStatusText").textContent = tabCapture.issueText || "Choose another source or try again.";
      statusAction.textContent = support.supported ? "Try again" : "Choose local";
    }

    $(".player-bar").classList.toggle("capture-active", active);
    $(".player-bar").classList.toggle("capture-muted", tabCapture.status === "muted");
    if (active) {
      $("#playerTrackTitle").textContent = tabCapture.status === "muted" ? "Browser tab · Quiet" : "Browser tab · Live";
      $("#playerTrackArtist").textContent = tabCapture.label || "Live audio through UZjam";
      $("#trackArtLetters").textContent = "TAB";
      $("#trackArtLetters").parentElement.style.background = "radial-gradient(circle at 35% 25%, rgba(255,255,255,.28), transparent 30%), linear-gradient(145deg, var(--violet), var(--violet-strong))";
      $("#formatChip").textContent = "TAB LIVE";
      $("#sourceButton span").textContent = "Change";
      window.clearInterval(tabCapture.timer);
      renderCaptureClock();
      tabCapture.timer = window.setInterval(renderCaptureClock, 1000);
    } else {
      window.clearInterval(tabCapture.timer);
      tabCapture.timer = 0;
      renderCaptureClock();
      renderLocalPlayerChrome();
    }
  }

  function openSourceDialog() {
    renderCaptureState();
    var dialog = $("#sourceDialog");
    if (!dialog.open) dialog.showModal();
    window.setTimeout(function () {
      var target = tabCaptureSupport().supported ? $("#chooseTabSource") : $("#chooseLocalSource");
      target.focus();
    }, 30);
  }

  function captureErrorDetails(error) {
    var code = error && error.captureCode;
    if (code === "wrong-surface") return { title: "Choose a browser tab", text: "Window and entire-screen audio can create feedback. Choose Browser Tab and try again." };
    if (code === "no-audio") return { title: "No tab audio was shared", text: "Choose it again and keep Share tab audio on." };
    if (code === "unsuppressed") return { title: "Original tab audio could not be silenced", text: "Mute the source tab, then choose it again in current Chrome or Edge." };
    if (error && (error.name === "NotAllowedError" || error.name === "AbortError")) return { title: "No tab selected", text: "Nothing changed. Try again when you are ready." };
    if (error && error.name === "InvalidStateError") return { title: "UZjam needs a direct click", text: "Return to this tab and choose Browser Tab again." };
    if (error && error.name === "NotFoundError") return { title: "No browser tab available", text: "Open the music in another tab, then try again." };
    if (error && error.name === "NotReadableError") return { title: "That tab could not be opened", text: "Another browser setting may be blocking tab audio. Try a different tab." };
    if (error && error.name === "TypeError") return { title: "Tab audio is unavailable here", text: "Open the published UZjam site in current desktop Chrome or Edge." };
    return { title: "Browser tab could not connect", text: "Try another tab or use a local audio file." };
  }

  function releaseCaptureResources(restoreLocal) {
    var oldSource = tabCapture.sourceNode;
    var oldStream = tabCapture.stream;
    tabCapture.generation += 1;
    tabCapture.sourceNode = null;
    tabCapture.stream = null;
    tabCapture.audioStream = null;
    tabCapture.label = "";
    tabCapture.startedAt = 0;
    tabCapture.native = false;
    if (oldSource) {
      try { oldSource.disconnect(); } catch (error) { }
    }
    stopMediaStream(oldStream);
    if (restoreLocal && localAudioSourceNode && audioSourceNode !== localAudioSourceNode) switchAudioSource(localAudioSourceNode);
  }

  function stopTabCapture(options) {
    options = options || {};
    var wasNative = tabCapture.native || (nativeAudio.status && nativeAudio.status.sourceDeviceId === "uzjam-browser-extension");
    if (wasNative && nativeAudio.available) {
      invokeNative("native_extension_audio_stop").then(function (status) {
        nativeAudio.running = false;
        renderNativeAudioStatus(status);
      }).catch(function (error) {
        setNativeAudioError(nativeErrorText(error));
      });
    }
    tabCapture.requestId += 1;
    tabCapture.requesting = false;
    releaseCaptureResources(options.restoreLocal !== false);
    tabCapture.status = options.status || "idle";
    tabCapture.issueTitle = options.title || "";
    tabCapture.issueText = options.text || "";
    if (!isPlaybackActive()) stopAnalyzer(true);
    renderCaptureState();
    renderSignal();
    renderQueue();
    if (!options.silent) announceCapture(tabCapture.status === "error" ? tabCapture.issueTitle : "Browser tab audio stopped");
  }

  async function startTabCapture() {
    var support = tabCaptureSupport();
    if (!support.supported) {
      tabCapture.status = "error";
      tabCapture.issueTitle = "Browser Tab mode is unavailable";
      tabCapture.issueText = support.reason;
      tabCapture.requesting = false;
      renderCaptureState();
      renderSignal();
      announceCapture(tabCapture.issueTitle);
      return;
    }

    if (nativeAudio.available) {
      return startNativeTabCapture();
    }

    var replacing = isTabCaptureActive();
    var previousStatus = tabCapture.status;
    var requestId = ++tabCapture.requestId;
    tabCapture.requesting = true;
    if (!replacing) tabCapture.status = "idle";
    tabCapture.issueTitle = "";
    tabCapture.issueText = "";
    if ($("#sourceDialog").open) $("#sourceDialog").close();
    renderCaptureState();
    renderSignal();
    announceCapture(replacing ? "Choose another browser tab" : "Waiting for browser");

    var capturedStream = null;
    try {
      var capturePromise = navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" },
        audio: { suppressLocalAudioPlayback: true },
        preferCurrentTab: false,
        selfBrowserSurface: "exclude",
        monitorTypeSurfaces: "exclude",
        surfaceSwitching: "exclude",
        systemAudio: "exclude"
      });
      var context = ensureAudioContext();
      if (context && context.state === "suspended") context.resume().catch(function () { });
      capturedStream = await capturePromise;
      if (requestId !== tabCapture.requestId) {
        stopMediaStream(capturedStream);
        return;
      }
      if (!context) throw new Error("Web Audio unavailable");

      var videoTrack = capturedStream.getVideoTracks()[0];
      var audioTrack = capturedStream.getAudioTracks()[0];
      var displaySurface = videoTrack && videoTrack.getSettings ? videoTrack.getSettings().displaySurface : "";
      if (displaySurface && displaySurface !== "browser") {
        var wrongSurface = new Error("A browser tab is required.");
        wrongSurface.captureCode = "wrong-surface";
        throw wrongSurface;
      }
      if (!audioTrack) {
        var noAudio = new Error("No tab audio track.");
        noAudio.captureCode = "no-audio";
        throw noAudio;
      }
      var audioSettings = audioTrack.getSettings ? audioTrack.getSettings() : {};
      if (audioSettings.suppressLocalAudioPlayback === false) {
        var unsuppressed = new Error("The original tab audio remains audible.");
        unsuppressed.captureCode = "unsuppressed";
        throw unsuppressed;
      }

      var audioStream = new MediaStream([audioTrack]);
      var sourceNode = context.createMediaStreamSource(audioStream);
      var oldStream = tabCapture.stream;
      var oldSource = tabCapture.sourceNode;
      var generation = tabCapture.generation + 1;

      $("#audioElement").pause();
      tabCapture.generation = generation;
      tabCapture.requesting = false;
      tabCapture.stream = capturedStream;
      tabCapture.audioStream = audioStream;
      tabCapture.sourceNode = sourceNode;
      tabCapture.label = captureLabel(videoTrack);
      tabCapture.startedAt = Date.now();
      tabCapture.status = audioTrack.muted ? "muted" : "active";
      tabCapture.issueTitle = "";
      tabCapture.issueText = "";

      switchAudioSource(sourceNode);
      if (oldSource && oldSource !== sourceNode) {
        try { oldSource.disconnect(); } catch (error) { }
      }
      if (oldStream && oldStream !== capturedStream) stopMediaStream(oldStream);

      var onEnded = function () {
        if (generation !== tabCapture.generation) return;
        stopTabCapture({ status: "error", title: "Connection ended", text: "The tab closed or sharing stopped." });
      };
      if (videoTrack) videoTrack.addEventListener("ended", onEnded, { once: true });
      audioTrack.addEventListener("ended", onEnded, { once: true });
      audioTrack.addEventListener("mute", function () {
        if (generation !== tabCapture.generation) return;
        tabCapture.status = "muted";
        renderCaptureState();
        renderSignal();
        announceCapture("Browser tab source is quiet");
      });
      audioTrack.addEventListener("unmute", function () {
        if (generation !== tabCapture.generation) return;
        tabCapture.status = "active";
        renderCaptureState();
        renderSignal();
        announceCapture("Browser tab audio resumed");
      });

      if (context.state === "suspended") await context.resume();
      renderCaptureState();
      renderSignal();
      renderQueue();
      startAnalyzer();
      announceCapture("Browser tab connected");
      showToast("Browser tab connected", "UZjam is processing the shared tab locally.");
    } catch (error) {
      stopMediaStream(capturedStream);
      if (requestId !== tabCapture.requestId) return;
      tabCapture.requesting = false;
      var detail = captureErrorDetails(error);
      if (replacing && isTabCaptureActive()) {
        tabCapture.status = previousStatus;
        renderCaptureState();
        renderSignal();
        announceCapture("Source unchanged");
        showToast(detail.title, "Your current browser tab is still connected.", "error");
      } else {
        tabCapture.status = "error";
        tabCapture.issueTitle = detail.title;
        tabCapture.issueText = detail.text;
        renderCaptureState();
        renderSignal();
        announceCapture(detail.title);
        showToast(detail.title, detail.text, "error");
      }
    }
  }

  async function startNativeTabCapture() {
    var requestId = ++tabCapture.requestId;
    tabCapture.requesting = true;
    tabCapture.native = true;
    tabCapture.status = "idle";
    tabCapture.issueTitle = "";
    tabCapture.issueText = "";
    if ($("#sourceDialog").open) $("#sourceDialog").close();
    renderCaptureState();
    renderSignal();
    announceCapture("Waiting for the UZjam Chrome extension");
    try {
      if (!nativeAudio.devices) await refreshNativeDevices({ silent: true });
      var outputId = $("#nativeOutputDevice").value || state.settings.nativeOutputDeviceId;
      if (!outputId) throw new Error("Connect your DAC, then choose it as the Listening output in Settings.");
      if (state.settings.nativeDirectEnabled) {
        state.settings.nativeDirectEnabled = false;
        var bypass = profileForNative(engineClient.getProfileSync());
        if (bypass && bypass.dsp) bypass.dsp.enabled = false;
        invokeNative("native_direct_audio_apply", {
          profile: bypass,
          outputDeviceId: state.settings.nativeDirectOutputDeviceId || null
        }).then(renderDirectAudioStatus).catch(function () { });
      }
      var status = await invokeNative("native_extension_audio_start", { request: {
        outputDeviceId: outputId,
        preferredBufferFrames: Number($("#nativeBufferFrames").value) || 256,
        profile: profileForNative(engineClient.getProfileSync())
      } });
      if (requestId !== tabCapture.requestId) return;
      nativeAudio.userStopped = false;
      renderNativeAudioStatus(status);
      var bridge = await invokeNative("native_extension_bridge_status");
      renderExtensionBridgeStatus(bridge);
      renderCaptureState();
      showToast("Chrome bridge is ready", "Click the UZjam extension in Chrome and choose a tab.");
      scheduleNativeStatusPoll(250);
    } catch (error) {
      if (requestId !== tabCapture.requestId) return;
      tabCapture.requesting = false;
      tabCapture.native = false;
      tabCapture.status = "error";
      tabCapture.issueTitle = "Chrome bridge could not start";
      tabCapture.issueText = nativeErrorText(error);
      renderCaptureState();
      renderSignal();
      showToast(tabCapture.issueTitle, tabCapture.issueText, "error");
    }
  }

  function renderExtensionBridgeStatus(status) {
    nativeAudio.extension.status = status || null;
    if (!status) return;
    var extensionRoute = tabCapture.native || (nativeAudio.status && nativeAudio.status.sourceDeviceId === "uzjam-browser-extension");
    if (extensionRoute && status.streaming) {
      var newlyActive = !isTabCaptureActive();
      tabCapture.native = true;
      tabCapture.requesting = false;
      tabCapture.status = Date.now() - Number(status.lastPacketAtMs || 0) > 2500 ? "muted" : "active";
      tabCapture.label = status.tabTitle || "Chrome tab";
      if (!tabCapture.startedAt) tabCapture.startedAt = Date.now();
      tabCapture.issueTitle = "";
      tabCapture.issueText = "";
      if (newlyActive) showToast("Chrome tab connected", "Rust DSP is sending the processed signal to your selected output.");
    } else if (extensionRoute && status.connected) {
      tabCapture.native = true;
      tabCapture.requesting = true;
    } else if (extensionRoute && tabCapture.startedAt && !status.connected) {
      tabCapture.requesting = false;
      tabCapture.status = "error";
      tabCapture.issueTitle = "Chrome tab disconnected";
      tabCapture.issueText = status.lastError || "Click the UZjam extension and choose the tab again.";
    }
    renderCaptureState();
    renderSignal();
  }

  function loadTrack(index, autoplay) {
    if (isTabCaptureActive() || tabCapture.requesting || tabCapture.status === "error") stopTabCapture({ silent: true });
    var track = state.queue[index];
    if (!track) {
      clearPlayer();
      return;
    }
    state.currentQueueIndex = index;
    if (!track.url && track.libraryId && fileObjects.has(track.libraryId)) {
      track.url = URL.createObjectURL(fileObjects.get(track.libraryId));
      track.playable = true;
    }
    if (!track.playable || !track.url) {
      showToast("Select this file again", "Browsers cannot retain access to local audio after a restart.");
      $("#audioFileInput").click();
      renderQueue();
      return;
    }
    var audio = $("#audioElement");
    if (audio.src !== track.url) {
      audio.src = track.url;
      audio.load();
    }
    renderLocalPlayerChrome();
    renderQueue();
    renderSignal();
    saveState();
    if (autoplay) playAudio();
  }

  function clearPlayer() {
    if (isTabCaptureActive() || tabCapture.requesting || tabCapture.status === "error") stopTabCapture({ silent: true });
    var audio = $("#audioElement");
    audio.removeAttribute("src");
    audio.load();
    $("#elapsedTime").textContent = "0:00";
    $("#durationTime").textContent = "0:00";
    $("#seekRange").value = 0;
    state.currentQueueIndex = -1;
    renderLocalPlayerChrome();
    renderSignal();
    updatePlayButton();
  }

  function playAudio() {
    if (isTabCaptureActive() || tabCapture.requesting || tabCapture.status === "error") stopTabCapture({ silent: true });
    var audio = $("#audioElement");
    if (!state.queue.length) {
      $("#audioFileInput").click();
      return;
    }
    var track = state.queue[state.currentQueueIndex];
    if (!track || !track.playable) {
      if (track) loadTrack(state.currentQueueIndex, false);
      else $("#audioFileInput").click();
      return;
    }
    var context = ensureAudioContext();
    if (!context) return;
    context.resume().then(function () {
      return audio.play();
    }).then(function () {
      updatePlayButton();
      startAnalyzer();
    }).catch(function () {
      showToast("Playback needs a tap", "Press play again after the browser finishes loading the local file.", "error");
    });
  }

  function updatePlayButton() {
    var playing = !$("#audioElement").paused;
    $("#playButton").innerHTML = playing ? '<svg><use href="#i-pause"/></svg>' : '<svg><use href="#i-play"/></svg>';
    $("#playButton").setAttribute("aria-label", playing ? "Pause" : "Play");
    if (!playing && !isTabCaptureActive()) stopAnalyzer(true);
    renderQueue();
  }

  function nextTrack(direction) {
    if (!state.queue.length) return;
    var next = state.currentQueueIndex + (direction || 1);
    if (next >= state.queue.length) next = state.repeat ? 0 : state.queue.length - 1;
    if (next < 0) next = 0;
    loadTrack(next, true);
  }

  function parseM3U(file) {
    return file.text().then(function (text) {
      var entries = text.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(function (line) { return line && line.charAt(0) !== "#"; });
      if (!entries.length) {
        showToast("Playlist is empty", file.name + " did not contain any file entries.", "error");
        return;
      }
      var names = entries.map(function (entry) { return entry.split(/[\\/]/).pop().toLowerCase(); });
      var matches = state.library.filter(function (item) { return item.filename && names.indexOf(item.filename.toLowerCase()) !== -1 && fileObjects.has(item.id); });
      if (matches.length) {
        matches.sort(function (a, b) { return names.indexOf(a.filename.toLowerCase()) - names.indexOf(b.filename.toLowerCase()); });
        state.queue = matches.map(libraryItemToQueueTrack);
        state.currentQueueIndex = 0;
        loadTrack(0, false);
        renderQueue();
        saveState();
        showToast("Playlist rebuilt", matches.length + " local files matched " + file.name + ".");
      } else {
        showToast("Playlist read", entries.length + " entries found. Import the matching audio folder to connect them.");
      }
    }).catch(function () {
      showToast("Could not read playlist", "The M3U file may use an unsupported encoding.", "error");
    });
  }

  function validatePreset(data) {
    var candidate = data && Array.isArray(data.bands) ? data.bands : data && Array.isArray(data.filters) ? data.filters : null;
    var canonical = data && data.schemaVersion === 1 && data.dsp && Array.isArray(data.filters);
    if (!candidate || !candidate.length) throw new Error("No bands were found in this JSON file.");
    if (candidate.length > (canonical ? 64 : 30)) throw new Error("This profile contains too many filters for the current editor.");
    function normalizeBands(list) { return list.map(function (band, index) {
      var type = String(band.type || band.kind || band.filterType || "peaking").toLowerCase().replace(/[\s_-]/g, "");
      if (type === "peak" || type === "pk" || type === "bell") type = "peaking";
      if (type === "ls" || type === "lowshelf") type = "lowshelf";
      if (type === "hs" || type === "highshelf") type = "highshelf";
      if (["peaking", "lowshelf", "highshelf"].indexOf(type) === -1) type = "peaking";
      var frequency = Number(band.frequencyHz != null ? band.frequencyHz : band.frequency != null ? band.frequency : band.fc);
      var gain = Number(band.gainDb != null ? band.gainDb : band.gain);
      var q = Number(band.q != null ? band.q : band.Q);
      if (!isFinite(frequency) || !isFinite(gain)) throw new Error("Band " + (index + 1) + " is missing frequency or gain.");
      return {
        id: band.id || uid("band"),
        type: type,
        frequency: clamp(frequency, 20, 20000),
        gain: clamp(gain, -18, 18),
        q: isFinite(q) ? clamp(q, .1, 24) : .7,
        channel: band.channel === "stereo" ? "both" : ["left", "right", "both"].indexOf(band.channel) !== -1 ? band.channel : "both",
        enabled: band.enabled !== false
      };
    }); }
    var normalized = normalizeBands(candidate);
    var canonicalToneBands = canonical ? normalized.filter(function (band) { return !!TONE_META[band.id]; }) : [];
    var bands = canonical ? normalized.filter(function (band) { return !TONE_META[band.id]; }) : normalized;
    if (!bands.length) bands = createStandardBands(10);
    var count = [10, 15, 30].indexOf(Number(data.advancedBandCount)) !== -1 ? Number(data.advancedBandCount) : (bands.length === 15 ? 15 : bands.length >= 20 ? 30 : 10);
    var banks = { "10": createStandardBands(10), "15": createStandardBands(15), "30": createStandardBands(30) };
    if (data.bandBanks && typeof data.bandBanks === "object") {
      [10, 15, 30].forEach(function (bankCount) {
        var source = data.bandBanks[String(bankCount)];
        if (Array.isArray(source) && source.length && source.length <= 30) banks[String(bankCount)] = normalizeBands(source);
      });
    }
    banks[String(count)] = clone(bands);
    var toneBands = canonicalToneBands.length ? migrateToneBands(canonicalToneBands) : migrateToneBands(data.toneBands);
    var canonicalHandling = canonical
      ? data.dsp.clippingPolicy === "allowClipping" || data.dsp.headroomMode === "off" ? "clip"
        : data.dsp.clippingPolicy === "smooth" ? "smooth"
          : data.dsp.clippingPolicy === "curve" || data.dsp.headroomMode === "manual" ? "curve" : "auto"
      : null;
    return {
      name: data.name || data.profileName || "Imported profile",
      bands: bands,
      bandBanks: banks,
      advancedBandCount: count,
      toneBands: toneBands,
      preampDb: clamp(Number(canonical ? data.dsp.preampDb : data.preampDb == null ? 0 : data.preampDb), -24, 12),
      handling: canonicalHandling || (["auto", "curve", "smooth", "clip"].indexOf(data.handling) !== -1 ? data.handling : "auto"),
      manualHeadroom: clamp(Number(canonical ? data.dsp.manualHeadroomDb : data.manualHeadroom == null ? (data.preamp == null ? 4 : data.preamp) : data.manualHeadroom), 0, 24),
      truePeakGuard: canonical ? data.dsp.limiterEnabled === true || Number(data.dsp.safetyMarginDb) >= .99 : !!data.truePeakGuard
    };
  }

  function importPresetFile(file) {
    file.text().then(function (text) {
      var data = JSON.parse(text);
      var preset = validatePreset(data);
      pushHistory();
      state.bands = preset.bands;
      state.bandBanks = preset.bandBanks;
      state.advancedBandCount = preset.advancedBandCount;
      state.toneBands = preset.toneBands;
      state.preampDb = preset.preampDb;
      state.selectedBandId = (state.mode === "basic" ? state.toneBands[0] : state.bands[0]).id;
      state.handling = preset.handling;
      state.headroomEnabled = preset.handling !== "clip";
      state.manualHeadroom = preset.manualHeadroom;
      state.truePeakGuard = preset.truePeakGuard;
      state.activeProfileId = uid("import");
      state.activeProfileName = preset.name;
      renderEq();
      saveState();
      navigate("studio");
      showToast("Preset imported", preset.name + " loaded with " + preset.bands.length + " bands.");
    }).catch(function (error) {
      showToast("Preset could not be imported", error.message || "Check that the JSON contains EQ bands.", "error");
    });
  }

  function importSettingsBackup(file) {
    if (file.size > 16 * 1024 * 1024) {
      showToast("Backup is too large", "Choose a UZjam settings backup smaller than 16 MB.", "error");
      return;
    }
    file.text().then(function (text) {
      var restored = readSettingsBackup(JSON.parse(text));
      restored.schemaVersion = Number(restored.schemaVersion) || APP_STATE_SCHEMA_VERSION;
      var committed = sessionPersistence ? sessionPersistence.replaceAndSuspend(restored) : (savePersistedState(localStorage, restored), true);
      if (!committed) throw new Error("The restored settings could not be committed locally.");
      persistenceSuppressed = true;
      if (!nativeAudio.available) return null;
      return invokeNative("native_persist_state", { snapshot: restored }).catch(function () { return null; });
    }).then(function () {
      showToast("Settings restored", "UZjam is reloading your profiles and preferences.");
      setTimeout(function () { window.location.reload(); }, 250);
    }).catch(function (error) {
      showToast("Backup could not be restored", error.message || "Choose a valid UZjam settings backup.", "error");
    });
  }

  function downloadJson(filename, data) {
    var contents = typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n";
    var blob = new Blob([contents], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportPreset() {
    syncEngineAnalysis();
    var profile = engineClient.getProfileSync();
    downloadJson(uzjamPresetFilename(profile.name), serializeUzjamPresetFile(profile));
    showToast("Profile exported", "A canonical, portable UZjam profile is ready.");
  }

  function beginControlEdit() {
    if (!controlSnapshot) controlSnapshot = eqSnapshot();
  }

  function endControlEdit() {
    if (controlSnapshot) pushHistory(controlSnapshot);
    controlSnapshot = null;
    saveState();
  }

  function updateSelectedBand(property, value, lightweight) {
    var band = selectedBand();
    if (!band) return;
    if (property === "frequency") band.frequency = clamp(Number(value) || 20, 20, 20000);
    else if (property === "gain") band.gain = round(clamp(Number(value) || 0, -bandGainLimit(), bandGainLimit()), 1);
    else if (property === "q") band.q = round(clamp(Number(value) || .1, .1, 24), 2);
    renderEq({ lightweight: !!lightweight });
  }

  function addBandAt(frequency, gain) {
    pushHistory();
    var band = {
      id: uid("band"),
      type: "peaking",
      frequency: Math.round(clamp(frequency || 1000, 20, 20000)),
      gain: round(clamp(gain || 0, -bandGainLimit(), bandGainLimit()), 1),
      q: 1,
      channel: "both",
      enabled: true
    };
    state.bands.push(band);
    state.selectedBandId = band.id;
    renderEq();
    saveState();
    showToast("Band added", "Band " + state.bands.length + " is ready for precise tuning.");
  }

  function requestUnsafe(action) {
    pendingUnsafeAction = action;
    $("#clipAcknowledge").checked = false;
    $("#confirmClipButton").disabled = true;
    $("#clipDialog").showModal();
  }

  function applyUnsafeChoice() {
    pushHistory();
    state.handling = "clip";
    state.headroomEnabled = false;
    pendingUnsafeAction = null;
    renderEq();
    saveState();
    showToast("Protection disabled", "UZjam will keep the exact curve and show clipping risk without limiting it.");
  }

  function shuffleQueue() {
    if (state.queue.length < 2) return;
    var current = state.queue[state.currentQueueIndex];
    for (var i = state.queue.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var temp = state.queue[i];
      state.queue[i] = state.queue[j];
      state.queue[j] = temp;
    }
    state.currentQueueIndex = Math.max(0, state.queue.indexOf(current));
    state.shuffled = true;
    renderQueue();
    saveState();
    showToast("Queue shuffled", "The current track stays in place and the order is remembered.");
  }

  function copyText(text, successMessage) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { showToast(successMessage || "Copied", "Ready to paste."); }).catch(function () {
        showToast("Copy was blocked", "Your browser did not allow clipboard access.", "error");
      });
    } else {
      showToast("Clipboard unavailable", "Copy access is not available in this browser.", "error");
    }
  }

  function bindEvents() {
    $$(".nav-trigger, .nav-item").forEach(function (button) {
      button.addEventListener("click", function () { navigate(button.dataset.view); });
    });

    $("#profileDockButton").addEventListener("click", function () { setProfileDockOpen(!state.profileDockOpen); });

    $$('[data-editor-style]').forEach(function (button) {
      button.addEventListener("click", function () { setEditorStyle(button.dataset.editorStyle); });
    });

    $$('[data-band-count]').forEach(function (button) {
      button.addEventListener("click", function () { switchBandCount(button.dataset.bandCount); });
    });

    $$('[data-monitor]').forEach(function (button) {
      button.addEventListener("click", function () { setMonitorMode(button.dataset.monitor); });
    });

    $$(".mode-switch button").forEach(function (button) {
      button.addEventListener("click", function () { setMode(button.dataset.mode); renderEq(); });
    });

    $("#eqPowerButton").addEventListener("click", function () {
      state.eqEnabled = !state.eqEnabled;
      state.compareBypass = false;
      renderEq();
      saveState();
    });

    $("#compareButton").addEventListener("click", function () {
      state.compareBypass = !state.compareBypass;
      renderEq();
    });

    $("#undoButton").addEventListener("click", function () {
      if (!history.length) return;
      future.push(eqSnapshot());
      restoreSnapshot(history.pop());
      updateHistoryButtons();
    });

    $("#redoButton").addEventListener("click", function () {
      if (!future.length) return;
      history.push(eqSnapshot());
      restoreSnapshot(future.pop());
      updateHistoryButtons();
    });

    $("#addBandButton").addEventListener("click", function () { addBandAt(1000, 0); });
    $("#eqPlot").addEventListener("dblclick", function (event) {
      if (state.mode !== "advanced") return;
      if (event.target.closest(".band-handle")) return;
      var rect = event.currentTarget.getBoundingClientRect();
      var x = (event.clientX - rect.left) / rect.width * 1000;
      var y = (event.clientY - rect.top) / rect.height * 460;
      addBandAt(graphXToFrequency(x), graphYToGain(y));
    });

    $$(".graph-tabs button").forEach(function (button) {
      button.addEventListener("click", function () {
        state.graphMode = button.dataset.graph;
        $$(".graph-tabs button").forEach(function (item) { item.classList.toggle("active", item === button); });
        renderGraph();
        saveState();
      });
    });

    $$(".graph-channel button").forEach(function (button) {
      button.addEventListener("click", function () {
        state.graphChannel = button.dataset.graphChannel;
        $$(".graph-channel button").forEach(function (item) { item.classList.toggle("active", item === button); });
        renderGraph();
        saveState();
      });
    });

    $$(".filter-type-row button").forEach(function (button) {
      button.addEventListener("click", function () {
        pushHistory();
        selectedBand().type = button.dataset.filter;
        renderEq();
        saveState();
      });
    });

    $("#bandEnabledInput").addEventListener("change", function () {
      pushHistory();
      selectedBand().enabled = this.checked;
      renderEq();
      saveState();
    });

    $("#bandChannelSelect").addEventListener("change", function () {
      pushHistory();
      selectedBand().channel = this.value;
      renderEq();
      saveState();
    });

    [
      ["#frequencyRange", "frequency", function (value) { return rangeToFrequency(value); }],
      ["#gainRange", "gain", function (value) { return Number(value); }],
      ["#qRange", "q", function (value) { return rangeToQ(value); }]
    ].forEach(function (binding) {
      var input = $(binding[0]);
      input.addEventListener("pointerdown", beginControlEdit);
      input.addEventListener("keydown", beginControlEdit);
      input.addEventListener("input", function () { updateSelectedBand(binding[1], binding[2](input.value), true); });
      input.addEventListener("change", endControlEdit);
    });

    [
      ["#frequencyInput", "frequency"],
      ["#gainInput", "gain"],
      ["#qInput", "q"]
    ].forEach(function (binding) {
      var input = $(binding[0]);
      input.addEventListener("focus", beginControlEdit);
      input.addEventListener("input", function () { updateSelectedBand(binding[1], input.value, true); });
      input.addEventListener("change", endControlEdit);
      input.addEventListener("blur", function () {
        if (controlSnapshot) endControlEdit();
      });
    });

    $("#soloBandButton").addEventListener("click", function () {
      soloBandId = soloBandId === selectedBand().id ? null : selectedBand().id;
      this.textContent = soloBandId ? "Stop solo" : "Solo band";
      renderEq();
    });

    $("#resetBandButton").addEventListener("click", function () {
      pushHistory();
      var band = selectedBand();
      band.gain = 0;
      band.q = 1;
      band.enabled = true;
      renderEq();
      saveState();
    });

    $("#deleteBandButton").addEventListener("click", function () {
      if (state.bands.length <= 1) return;
      pushHistory();
      var index = state.bands.findIndex(function (band) { return band.id === state.selectedBandId; });
      state.bands.splice(index, 1);
      state.selectedBandId = state.bands[Math.max(0, index - 1)].id;
      soloBandId = null;
      renderEq();
      saveState();
    });

    $$(".policy-card").forEach(function (button) {
      button.addEventListener("click", function () {
        var policy = button.dataset.policy;
        if (policy === "clip") {
          requestUnsafe("clip");
          return;
        }
        pushHistory();
        state.handling = policy;
        state.headroomEnabled = true;
        renderEq();
        saveState();
      });
    });

    $("#headroomEnabledInput").addEventListener("change", function () {
      if (!this.checked) {
        this.checked = true;
        requestUnsafe("headroom");
      } else {
        pushHistory();
        state.headroomEnabled = true;
        if (state.handling === "clip") state.handling = "curve";
        renderEq();
        saveState();
      }
    });

    ["#headroomRange", "#headroomInput"].forEach(function (selector) {
      var input = $(selector);
      input.addEventListener("focus", beginControlEdit);
      input.addEventListener("pointerdown", beginControlEdit);
      input.addEventListener("input", function () {
        var value = clamp(Number(input.value) || 0, 0, 24);
        state.manualHeadroom = round(value, 1);
        if (state.handling === "auto" || state.handling === "clip") state.handling = "curve";
        state.headroomEnabled = true;
        renderEq({ lightweight: true });
      });
      input.addEventListener("change", endControlEdit);
    });

    $("#truePeakGuardInput").addEventListener("change", function () {
      pushHistory();
      state.truePeakGuard = this.checked;
      renderEq();
      saveState();
    });

    $("#basicPreampRange").addEventListener("pointerdown", beginControlEdit);
    $("#basicPreampRange").addEventListener("keydown", beginControlEdit);
    $("#basicPreampRange").addEventListener("input", function () {
      state.preampDb = round(clamp(Number(this.value) || 0, -24, 12), 1);
      renderEq({ lightweight: true });
    });
    $("#basicPreampRange").addEventListener("change", endControlEdit);

    $("#monitorResetButton").addEventListener("click", function () {
      meterState.holdLeft = meterState.left;
      meterState.holdRight = meterState.right;
      meterState.holdUntilLeft = 0;
      meterState.holdUntilRight = 0;
      state.clipLatched = false;
      renderSafety();
      saveState();
    });

    $("#clipAcknowledge").addEventListener("change", function () {
      $("#confirmClipButton").disabled = !this.checked;
    });
    $("#confirmClipButton").addEventListener("click", applyUnsafeChoice);
    $("#clipDialog").addEventListener("close", function () {
      pendingUnsafeAction = null;
      $("#clipAcknowledge").checked = false;
      $("#confirmClipButton").disabled = true;
      renderSafety();
    });

    $$(".preset-import-trigger").forEach(function (button) {
      button.addEventListener("click", function () { $("#presetInput").click(); });
    });
    $("#presetInput").addEventListener("change", function () {
      if (this.files[0]) importPresetFile(this.files[0]);
      this.value = "";
    });
    $("#exportPresetButton").addEventListener("click", exportPreset);

    $$(".source-trigger").forEach(function (button) {
      button.addEventListener("click", openSourceDialog);
    });
    $("#chooseTabSource").addEventListener("click", startTabCapture);
    $("#chooseLocalSource").addEventListener("click", function () {
      if ($("#sourceDialog").open) $("#sourceDialog").close();
      if (isTabCaptureActive() || tabCapture.requesting || tabCapture.status === "error") stopTabCapture({ silent: true });
      $("#audioFileInput").click();
    });
    $("#captureStatusAction").addEventListener("click", function () {
      if (isTabCaptureActive() || (tabCapture.requesting && tabCapture.native)) stopTabCapture();
      else if (tabCaptureSupport().supported) startTabCapture();
      else {
        tabCapture.status = "idle";
        renderCaptureState();
        $("#audioFileInput").click();
      }
    });
    $("#captureTransportStop").addEventListener("click", function () { stopTabCapture(); });
    $("#copyPairingCode").addEventListener("click", function () {
      var bridge = nativeAudio.extension.status;
      if (!bridge || !bridge.pairingCode) return;
      navigator.clipboard.writeText(bridge.pairingCode).then(function () {
        showToast("Pairing code copied", "Paste it into the UZjam Chrome extension once.");
      }).catch(function () {
        showToast("Pairing code", bridge.pairingCode);
      });
    });

    $$(".load-audio-trigger").forEach(function (button) {
      button.addEventListener("click", function () {
        if (isTabCaptureActive() || tabCapture.requesting || tabCapture.status === "error") stopTabCapture({ silent: true });
        $("#audioFileInput").click();
      });
    });
    $("#audioFileInput").addEventListener("change", function () {
      addAudioFiles(this.files, "Imported");
      this.value = "";
    });
    $("#importFolderButton").addEventListener("click", function () { $("#folderInput").click(); });
    $("#emptyImportButton").addEventListener("click", function () { $("#folderInput").click(); });
    $("#folderInput").addEventListener("change", function () {
      var files = Array.prototype.slice.call(this.files || []);
      var first = files[0];
      var folderName = first && first.webkitRelativePath ? first.webkitRelativePath.split("/")[0] : "Imported folder";
      addAudioFiles(files, folderName);
      files.filter(function (file) { return /\.(m3u8?)$/i.test(file.name); }).forEach(parseM3U);
      this.value = "";
    });
    $("#importPlaylistButton").addEventListener("click", function () { $("#playlistInput").click(); });
    $("#playlistInput").addEventListener("change", function () {
      if (this.files[0]) parseM3U(this.files[0]);
      this.value = "";
    });

    $("#librarySearch").addEventListener("input", renderLibrary);
    $("#librarySort").addEventListener("change", function () {
      state.librarySort = this.value;
      renderLibrary();
      saveState();
    });
    $$(".density-switch button").forEach(function (button) {
      button.addEventListener("click", function () {
        state.libraryDensity = Number(button.dataset.density);
        $$(".density-switch button").forEach(function (item) { item.classList.toggle("active", item === button); });
        renderLibrary();
        applyAppearanceSettings();
        saveState();
      });
    });
    $("#selectLibraryButton").addEventListener("click", function () {
      selectionMode = !selectionMode;
      if (!selectionMode) librarySelection.clear();
      this.textContent = selectionMode ? "Cancel" : "Select";
      renderLibrary();
    });
    $("#bulkDoneButton").addEventListener("click", function () {
      selectionMode = false;
      librarySelection.clear();
      $("#selectLibraryButton").textContent = "Select";
      renderLibrary();
    });
    $("#bulkPlaylistButton").addEventListener("click", function () {
      var items = state.library.filter(function (item) { return librarySelection.has(item.id) && fileObjects.has(item.id); });
      if (!items.length) {
        showToast("No playable files selected", "Load the local audio before adding it to the queue.");
        return;
      }
      state.queue = state.queue.concat(items.map(libraryItemToQueueTrack));
      if (state.currentQueueIndex < 0) state.currentQueueIndex = 0;
      renderQueue();
      saveState();
      showToast("Added to queue", items.length + (items.length === 1 ? " track" : " tracks") + " added.");
    });
    $("#bulkRemoveButton").addEventListener("click", function () {
      var count = librarySelection.size;
      state.library = state.library.filter(function (item) { return !librarySelection.has(item.id); });
      librarySelection.forEach(function (id) { fileObjects.delete(id); });
      librarySelection.clear();
      renderLibrary();
      saveState();
      showToast("Removed " + count + (count === 1 ? " item" : " items"), "This only changed UZjam's local library list.");
    });

    $("#profileSearch").addEventListener("input", renderProfiles);
    $("#newProfileButton").addEventListener("click", function () {
      $("#newProfileName").value = "";
      $("#newProfileDevice").value = "";
      $("#newProfileDialog").showModal();
      setTimeout(function () { $("#newProfileName").focus(); }, 40);
    });
    $("#newProfileForm").addEventListener("submit", function (event) {
      event.preventDefault();
      var name = $("#newProfileName").value.trim();
      if (!name) return;
      syncEngineAnalysis();
      var canonical = clone(engineClient.getProfileSync());
      canonical.id = uid("profile");
      canonical.name = name;
      canonical.metadata.createdAtUtc = new Date().toISOString();
      canonical.metadata.modifiedAtUtc = canonical.metadata.createdAtUtc;
      var profile = {
        id: canonical.id,
        name: name,
        device: $("#newProfileDevice").value.trim() || "Custom output",
        color: randomColor(name),
        uzjamProfile: canonical,
        user: true
      };
      state.profiles.unshift(profile);
      state.activeProfileId = profile.id;
      state.activeProfileName = profile.name;
      $("#newProfileDialog").close();
      renderProfiles();
      renderEq();
      saveState();
      showToast("Profile saved", name + " is available on this device.");
    });

    $("#shuffleQueueButton").addEventListener("click", shuffleQueue);
    $("#clearQueueButton").addEventListener("click", function () {
      $("#audioElement").pause();
      state.queue = [];
      state.currentQueueIndex = -1;
      clearPlayer();
      renderQueue();
      saveState();
    });

    $("#shuffleButton").addEventListener("click", function () {
      if (state.shuffled) {
        state.shuffled = false;
        this.classList.remove("active");
        this.setAttribute("aria-pressed", "false");
        showToast("Shuffle off", "Newly loaded tracks will stay in order.");
      } else {
        shuffleQueue();
        this.classList.add("active");
        this.setAttribute("aria-pressed", "true");
      }
      saveState();
    });
    $("#repeatButton").addEventListener("click", function () {
      state.repeat = !state.repeat;
      this.classList.toggle("active", state.repeat);
      this.setAttribute("aria-pressed", String(state.repeat));
      saveState();
    });
    $("#playButton").addEventListener("click", function () {
      if ($("#audioElement").paused) playAudio();
      else $("#audioElement").pause();
    });
    $("#previousButton").addEventListener("click", function () { nextTrack(-1); });
    $("#nextButton").addEventListener("click", function () { nextTrack(1); });
    $("#seekRange").addEventListener("input", function () {
      var audio = $("#audioElement");
      if (isFinite(audio.duration) && audio.duration > 0) audio.currentTime = Number(this.value) / 100 * audio.duration;
    });

    var audio = $("#audioElement");
    audio.addEventListener("play", updatePlayButton);
    audio.addEventListener("pause", updatePlayButton);
    audio.addEventListener("loadedmetadata", function () {
      $("#durationTime").textContent = formatTime(audio.duration);
      var current = state.queue[state.currentQueueIndex];
      if (current) current.duration = audio.duration;
      renderQueue();
      saveState();
    });
    audio.addEventListener("timeupdate", function () {
      $("#elapsedTime").textContent = formatTime(audio.currentTime);
      $("#durationTime").textContent = formatTime(audio.duration);
      $("#seekRange").value = isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration * 100 : 0;
    });
    audio.addEventListener("ended", function () {
      if (state.repeat) {
        audio.currentTime = 0;
        playAudio();
      } else if (state.currentQueueIndex < state.queue.length - 1) {
        nextTrack(1);
      } else {
        updatePlayButton();
      }
    });

    $("#copySignalButton").addEventListener("click", function () {
      var safety = currentHeadroom();
      var sourceSummary = isTabCaptureActive() ? "browser tab (live)" : "local audio";
      copyText(
        "UZjam signal path\nSource: " + sourceSummary + "\nPreamp: " + formatSigned(state.preampDb, 1) + " dB\nHeadroom: -" + safety.appliedHeadroomDb.toFixed(1) + " dB\nEQ: " + processingBands().filter(function (band) { return band.enabled; }).length + " active filters\nPeak handling: " + state.handling + "\nMaximum EQ transfer gain: +" + safety.maximumEqGainDb.toFixed(1) + " dB",
        "Signal path copied"
      );
    });
    $("#resetClipLatchButton").addEventListener("click", function () {
      state.clipLatched = false;
      renderSafety();
      saveState();
    });

    $("#themeSelect").addEventListener("change", function () { state.settings.theme = this.value; applyAppearanceSettings(); saveState(); });
    $("#highContrastInput").addEventListener("change", function () { state.settings.highContrast = this.checked; applyAppearanceSettings(); saveState(); });
    $("#reduceMotionInput").addEventListener("change", function () { state.settings.reduceMotion = this.checked; applyAppearanceSettings(); saveState(); });
    $("#analyzerInput").addEventListener("change", function () { state.settings.analyzer = this.checked; saveState(); });
    $("#nearbyBandsInput").addEventListener("change", function () { state.settings.nearbyBands = this.checked; saveState(); });
    $("#defaultModeSelect").addEventListener("change", function () { state.settings.defaultMode = this.value; saveState(); });
    $("#albumColumnsSelect").addEventListener("change", function () { state.libraryDensity = Number(this.value); renderLibrary(); saveState(); });
    $("#duplicateReportInput").addEventListener("change", function () { state.settings.duplicateReport = this.checked; saveState(); });
    $("#resumePlaybackInput").addEventListener("change", function () { state.settings.resumePlayback = this.checked; saveState(); });
    $("#nativeInputDevice").addEventListener("change", function () { state.settings.nativeInputDeviceId = this.value; renderNativeRouteHint(); saveState(); });
    $("#nativeOutputDevice").addEventListener("change", function () { state.settings.nativeOutputDeviceId = this.value; renderNativeRouteHint(); saveState(); });
    $("#nativeDirectOutputDevice").addEventListener("change", function () {
      state.settings.nativeDirectOutputDeviceId = this.value;
      state.settings.nativeDirectEnabled = false;
      saveState();
      refreshDirectAudioStatus({ silent: true });
    });
    $("#nativeBufferFrames").addEventListener("change", function () { state.settings.nativeBufferFrames = Number(this.value) || 256; saveState(); });
    $("#nativeAutoStartInput").addEventListener("change", function () {
      state.settings.nativeAutoStart = this.checked;
      if (!this.checked) {
        cancelNativeRecovery();
        nativeAudio.recoveryAttempts = 0;
      } else {
        nativeAudio.userStopped = false;
      }
      saveState();
      showToast(this.checked ? "Reconnect enabled" : "Reconnect disabled", this.checked ? "UZjam will retry the exact route at launch and after device resets." : "Windows audio will stay stopped after launch or a device reset.");
    });
    $("#nativeRefreshDevices").addEventListener("click", function () { refreshNativeDevices(); });
    $("#nativeDirectRefresh").addEventListener("click", function () { refreshDirectAudioStatus(); });
    $("#nativeDirectToggle").addEventListener("click", function () { applyDirectAudio(false); });
    $("#nativeAudioToggle").addEventListener("click", function () {
      if (nativeAudio.running) stopNativeAudio();
      else startNativeAudio(false);
    });
    $("#resetSettingsButton").addEventListener("click", function () {
      state.settings = clone(defaults.settings);
      state.libraryDensity = 3;
      setMode(state.settings.defaultMode);
      applyAppearanceSettings();
      renderLibrary();
      saveState();
      showToast("Defaults restored", "Your EQ profiles and library were not changed.");
    });
    $("#exportAllButton").addEventListener("click", function () {
      downloadJson("uzjam-settings-backup.json", createSettingsBackup(persistedState()));
      showToast("Settings exported", "Your profiles and preferences are ready.");
    });
    $("#importAllButton").addEventListener("click", function () { $("#settingsBackupInput").click(); });
    $("#settingsBackupInput").addEventListener("change", function () {
      if (this.files[0]) importSettingsBackup(this.files[0]);
      this.value = "";
    });
    $("#clearLocalDataButton").addEventListener("click", function () {
      persistenceSuppressed = true;
      if (sessionPersistence) {
        sessionPersistence.clear();
        sessionPersistence.dispose();
      }
      else clearPersistedState(localStorage);
      var clearedNative = nativeAudio.available
        ? (nativeAudio.running ? invokeNative("native_audio_stop").catch(function () { }) : Promise.resolve()).then(function () { return invokeNative("native_clear_state"); }).catch(function () { })
        : Promise.resolve();
      showToast("Local settings cleared", "Reload UZjam to return to the first-run state.");
      clearedNative.finally(function () { setTimeout(function () { window.location.reload(); }, 250); });
    });

    document.addEventListener("keydown", function (event) {
      var target = event.target;
      var typing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if (!typing && event.code === "Space" && !isTabCaptureActive() && !tabCapture.requesting) {
        event.preventDefault();
        if ($("#audioElement").paused) playAudio();
        else $("#audioElement").pause();
      }
      if (event.key === "Escape" && state.profileDockOpen) setProfileDockOpen(false);
      if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && /^Digit[1-5]$/.test(event.code)) {
        var views = ["studio", "library", "queue", "signal", "settings"];
        navigate(views[Number(event.code.slice(-1)) - 1]);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !typing) {
        event.preventDefault();
        if (event.shiftKey) $("#redoButton").click();
        else $("#undoButton").click();
      }
    });

    window.addEventListener("pagehide", function (event) {
      if (!persistenceSuppressed && sessionPersistence) sessionPersistence.flush();
      if (event.persisted) return;
      if (tabCapture.stream) stopTabCapture({ silent: true, restoreLocal: false });
      clearTimeout(nativeAudio.pollTimer);
      clearTimeout(nativeAudio.profileTimer);
      clearTimeout(nativeAudio.persistTimer);
      if (nativeAudio.available && !persistenceSuppressed) {
        invokeNative("native_prepare_shutdown", { snapshot: persistedState() }).catch(function () { });
      }
    });
    window.addEventListener("pageshow", function (event) {
      if (event.persisted && nativeAudio.available) scheduleNativeStatusPoll(0);
    });
  }

  function registerWebMcpTools() {
    var context = document.modelContext;
    if (!context || typeof context.registerTool !== "function") return;
    var lifecycle = new AbortController();

    function register(tool) {
      try {
        Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(function () { });
      } catch (error) { }
    }

    register({
      name: "read_uzjam_eq_state",
      title: "Read UZjam EQ",
      description: "Read the active UZjam profile, bands, peak-handling choice, and predicted gain safety without changing anything.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: function () {
        var safety = currentHeadroom();
        return {
          profile: state.activeProfileName,
          enabled: state.eqEnabled,
          editorMode: state.mode,
          audioSource: isTabCaptureActive() ? "browser-tab" : "local",
          captureStatus: tabCapture.requesting ? "requesting" : tabCapture.status,
          advancedBandCount: state.advancedBandCount,
          preampDb: state.preampDb,
          handling: state.handling,
          maximumEqGainDb: round(safety.maximumEqGainDb, 2),
          appliedHeadroomDb: round(safety.appliedHeadroomDb, 2),
          predictedCurvePeakDb: round(safety.effectiveCurvePeakDb, 2),
          predictedOverDb: round(safety.predictedOverDb, 2),
          bands: state.bands.map(function (band) {
            return { id: band.id, type: band.type, frequency: band.frequency, gain: band.gain, q: band.q, channel: band.channel, enabled: band.enabled };
          }),
          toneControls: state.toneBands.map(function (band) {
            return { id: band.id, name: TONE_META[band.id].label, gain: band.gain, range: TONE_META[band.id].range };
          })
        };
      }
    });

    register({
      name: "configure_uzjam_band",
      title: "Configure EQ band",
      description: "Update one existing UZjam parametric EQ band and refresh the visible graph and audio path.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          frequency: { type: "number", minimum: 20, maximum: 20000 },
          gain: { type: "number", minimum: -30, maximum: 30 },
          q: { type: "number", minimum: .1, maximum: 24 },
          type: { type: "string", enum: ["peaking", "lowshelf", "highshelf"] },
          channel: { type: "string", enum: ["both", "left", "right"] },
          enabled: { type: "boolean" }
        },
        required: ["id"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: function (input) {
        var band = processingBands().find(function (item) { return item.id === input.id; });
        if (!band) throw new Error("Unknown band id.");
        pushHistory();
        if (input.frequency != null) band.frequency = clamp(input.frequency, 20, 20000);
        if (input.gain != null) band.gain = clamp(input.gain, isToneBand(band) ? -12 : -18, isToneBand(band) ? 12 : 18);
        if (input.q != null) band.q = clamp(input.q, .1, 24);
        if (input.type) band.type = input.type;
        if (input.channel) band.channel = input.channel;
        if (input.enabled != null) band.enabled = input.enabled;
        state.selectedBandId = band.id;
        renderEq();
        saveState();
        return { updated: band.id, analysis: currentHeadroom() };
      }
    });

    register({
      name: "set_uzjam_peak_handling",
      title: "Set peak handling",
      description: "Choose Auto, manual curve headroom, smoothed boosts, or explicitly unprotected clipping for the active UZjam EQ.",
      inputSchema: {
        type: "object",
        properties: {
          handling: { type: "string", enum: ["auto", "curve", "smooth", "clip"] },
          manualHeadroomDb: { type: "number", minimum: 0, maximum: 24 },
          confirmUnprotectedClipping: { type: "boolean" }
        },
        required: ["handling"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: function (input) {
        if (input.handling === "clip" && input.confirmUnprotectedClipping !== true) throw new Error("confirmUnprotectedClipping must be true when selecting clip.");
        pushHistory();
        state.handling = input.handling;
        state.headroomEnabled = input.handling !== "clip";
        if (input.manualHeadroomDb != null) state.manualHeadroom = clamp(input.manualHeadroomDb, 0, 24);
        renderEq();
        saveState();
        var safety = currentHeadroom();
        return { handling: state.handling, appliedHeadroomDb: round(safety.appliedHeadroomDb, 2), predictedOverDb: round(safety.predictedOverDb, 2) };
      }
    });

    register({
      name: "navigate_uzjam",
      title: "Navigate UZjam",
      description: "Open one visible UZjam workspace view.",
      inputSchema: {
        type: "object",
        properties: { view: { type: "string", enum: ["studio", "library", "queue", "signal", "settings"] } },
        required: ["view"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: function (input) {
        navigate(input.view);
        return { view: state.view };
      }
    });
  }

  function initialize() {
    sessionPersistence = createSessionPersistence({
      storage: localStorage,
      snapshot: persistedState,
      debounceMs: 180,
      onError: function () { showToast("Could not save locally", "UZjam could not commit its local settings backup.", "error"); }
    });
    document.body.dataset.mode = state.mode;
    applyAppearanceSettings();
    bindEvents();
    setMode(state.mode);
    setEditorStyle(state.editorStyle);
    setMonitorMode(state.monitorMode);
    setProfileDockOpen(state.profileDockOpen);
    $$(".graph-tabs button").forEach(function (button) { button.classList.toggle("active", button.dataset.graph === state.graphMode); });
    $$(".graph-channel button").forEach(function (button) { button.classList.toggle("active", button.dataset.graphChannel === state.graphChannel); });
    $$(".density-switch button").forEach(function (button) { button.classList.toggle("active", Number(button.dataset.density) === state.libraryDensity); });
    $("#shuffleButton").classList.toggle("active", state.shuffled);
    $("#shuffleButton").setAttribute("aria-pressed", String(state.shuffled));
    $("#repeatButton").classList.toggle("active", state.repeat);
    $("#repeatButton").setAttribute("aria-pressed", String(state.repeat));
    renderEq();
    renderLibrary();
    renderProfiles();
    renderQueue();
    renderCaptureState();
    renderSignal();
    navigate(state.view);
    initializeNativeAudio();
    registerWebMcpTools();
    if (stateRecovery) {
      showToast("Settings recovered", stateRecovery.source === "pending" ? "UZjam recovered an interrupted save." : "UZjam restored the last known good settings backup.");
      sessionPersistence.flush();
    }
  }

  initialize();
})();
