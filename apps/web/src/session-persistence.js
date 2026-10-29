import {
  STORAGE_KEYS,
  clearPersistedState,
  loadPersistedState,
  savePersistedState,
} from "./persistence.js";

/**
 * Owns persistence timing and lifecycle flushing without knowing the shape of
 * the application state. `snapshot` must return a JSON-serializable object.
 */
export function createSessionPersistence(options) {
  var storage = options.storage;
  var snapshot = options.snapshot;
  var keys = options.keys || STORAGE_KEYS;
  var debounceMs = Math.max(0, Number(options.debounceMs) || 250);
  var onError = typeof options.onError === "function" ? options.onError : function () {};
  var timer = 0;
  var disposed = false;
  var shutdownStarted = false;
  var unbindLifecycle = null;

  function load() {
    return loadPersistedState(storage, keys);
  }

  function flush() {
    if (disposed) return false;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    try {
      savePersistedState(storage, snapshot(), keys);
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  }

  function schedule() {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = 0;
      flush();
    }, debounceMs);
  }

  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    try {
      clearPersistedState(storage, keys);
      // Clearing is terminal for this page instance. Otherwise pagehide would
      // immediately recreate the state the user just removed.
      disposed = true;
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  }

  /**
   * Commits imported/replacement state and prevents the old in-memory snapshot
   * from overwriting it while the page reloads.
   */
  function replaceAndSuspend(nextState) {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    try {
      savePersistedState(storage, nextState, keys);
      disposed = true;
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  }

  function bindLifecycle(target, documentTarget, onShutdown) {
    if (unbindLifecycle) unbindLifecycle();
    var shutdown = typeof onShutdown === "function" ? onShutdown : function () {};

    function persistWhenHidden() {
      if (!documentTarget || documentTarget.visibilityState === "hidden") flush();
    }

    function prepareForExit(event) {
      flush();
      // A bfcache navigation is a suspension, not a terminal shutdown.
      if (event && event.type === "pagehide" && event.persisted) return;
      if (shutdownStarted) return;
      shutdownStarted = true;
      try {
        shutdown();
      } catch (error) {
        onError(error);
      }
    }

    function resumeFromCache() {
      shutdownStarted = false;
    }

    target.addEventListener("pagehide", prepareForExit);
    target.addEventListener("beforeunload", prepareForExit);
    target.addEventListener("pageshow", resumeFromCache);
    if (documentTarget) documentTarget.addEventListener("visibilitychange", persistWhenHidden);

    unbindLifecycle = function () {
      target.removeEventListener("pagehide", prepareForExit);
      target.removeEventListener("beforeunload", prepareForExit);
      target.removeEventListener("pageshow", resumeFromCache);
      if (documentTarget) documentTarget.removeEventListener("visibilitychange", persistWhenHidden);
      unbindLifecycle = null;
    };
    return unbindLifecycle;
  }

  function shutdown(onShutdown) {
    var saved = flush();
    if (!shutdownStarted) shutdownStarted = true;
    if (typeof onShutdown === "function") {
      try {
        onShutdown();
      } catch (error) {
        onError(error);
      }
    }
    return saved;
  }

  function dispose() {
    if (unbindLifecycle) unbindLifecycle();
    if (timer) clearTimeout(timer);
    timer = 0;
    disposed = true;
  }

  return { load, schedule, flush, clear, replaceAndSuspend, bindLifecycle, shutdown, dispose };
}
