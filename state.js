/**
 * state.js — centralized client state for the Quotex Signal web app.
 *
 * Why this exists: index.html previously kept its state as ~10 scattered
 * top-level `let`/`const` bindings inside one big inline <script> (session
 * token, license key, theme, chat history, last signal context, etc).
 * That works until two async things race — e.g. the user switches asset
 * and clicks Generate again before the first response lands, or a stale
 * ticker poll resolves after a newer one. This module gives every part of
 * the app one place to read/write state, and gives async flows a cheap way
 * to detect "am I still the most recent request" before touching the DOM.
 *
 * Design notes:
 * - No framework, no build step — this is a plain IIFE attached to
 *   `window.AppState`, loaded before the main script in index.html.
 * - Nested state, dotted-path get/set (`AppState.get('market.asset')`),
 *   because the shape mirrors what the spec calls out: user, currentMode,
 *   websocket, market, ui, subscription, referrals, streak, notifications,
 *   preferences.
 * - Persistence is opt-in per key (`persist: true`), backed by
 *   localStorage, and namespaced under `qx_` to match the keys this app
 *   already used (qx_session_token, qx_license_key, qx_bg_theme, ...) so
 *   upgrading doesn't log out or re-theme existing users.
 * - `subscribe(path, cb)` fires on exact-path changes and on changes to
 *   any ancestor/descendant path, so a listener on 'market' sees an
 *   'market.asset' update and a listener on 'market.asset' doesn't fire
 *   for an unrelated 'market.ticker' update.
 * - Sequence IDs: `beginRequest(lane)` hands back a token; before
 *   applying an async result, call `isCurrent(lane, token)` — if another
 *   call started in that lane since, the response is stale and should be
 *   dropped silently. This is the actual fix for the asset-switch race.
 */
(function () {
  "use strict";

  const STORAGE_PREFIX = "qx_";

  // Map of state-path -> localStorage key, for the subset of state that
  // should survive a reload. Everything else is in-memory only.
  const PERSISTED_PATHS = {
    "user.licenseKey": "license_key",
    "user.sessionToken": "session_token",
    "preferences.theme": "bg_theme",
    "preferences.customBackground": "bg_custom",
    "ui.installBannerDismissedAt": "install_dismissed_at",
  };

  function storageKeyFor(path) {
    const suffix = PERSISTED_PATHS[path];
    return suffix ? STORAGE_PREFIX + suffix : null;
  }

  function readPersisted(path) {
    const key = storageKeyFor(path);
    if (!key) return undefined;
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? undefined : raw;
    } catch (e) {
      // Storage disabled (private mode, quota, etc.) — degrade to memory-only.
      return undefined;
    }
  }

  function writePersisted(path, value) {
    const key = storageKeyFor(path);
    if (!key) return;
    try {
      if (value === null || value === undefined) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, String(value));
      }
    } catch (e) {
      // Ignore — non-critical, state still lives in memory for this session.
    }
  }

  function initialState() {
    return {
      user: {
        licenseKey: readPersisted("user.licenseKey") || null,
        sessionToken: readPersisted("user.sessionToken") || null,
        isValidated: false,
        licenseStatus: null, // set from /license/check response
      },
      // Only "quotex" exists in the UI today. The field is here so the
      // rest of the app (and a future forex-mode toggle) has a single
      // source of truth to read/write instead of adding another global
      // later — it is NOT wired to any mode-switch UI yet, since that
      // UI doesn't exist in this codebase.
      currentMode: "quotex",
      websocket: {
        socket: null,
        status: "disconnected", // "disconnected" | "connecting" | "open" | "closed"
        room: null,
      },
      market: {
        asset: null,
        duration_seconds: 60,
        lastSignal: null, // full SignalResponse from the backend
        ticker: [],
        // Monotonically increasing counters, one per "lane" of async
        // requests, used to detect and drop stale responses. See
        // beginRequest()/isCurrent() below.
        _requestSeq: { generateSignal: 0, ticker: 0, history: 0 },
      },
      ui: {
        screen: "loading",
        chatOpen: false,
        installBannerDismissedAt: readPersisted("ui.installBannerDismissedAt") || null,
      },
      subscription: {
        plan: null,
        expiresAt: null,
      },
      referrals: {},
      streak: {},
      notifications: [],
      preferences: {
        theme: readPersisted("preferences.theme") || "nebula",
        customBackground: readPersisted("preferences.customBackground") || null,
      },
      // Chat lives under ui since it's a UI-local concern (history is not
      // persisted server-side or across reloads in the current backend).
      chat: {
        history: [], // [{role: "user"|"model", text: "..."}]
        lastSignalContext: null,
      },
    };
  }

  const state = initialState();
  // path -> Set<callback>
  const listeners = new Map();

  function getIn(obj, parts) {
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  function setIn(obj, parts, value) {
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function notify(changedPath) {
    for (const [path, cbs] of listeners.entries()) {
      // Fire if the change is at this exact path, or at an ancestor of
      // it (e.g. subscribing to 'market' should hear a 'market.asset'
      // write), or at a descendant of it (subscribing to 'market.asset'
      // should hear a whole-object replace of 'market').
      if (
        path === changedPath ||
        changedPath.startsWith(path + ".") ||
        path.startsWith(changedPath + ".")
      ) {
        const value = get(path);
        for (const cb of cbs) {
          try {
            cb(value, changedPath);
          } catch (err) {
            console.error(`[AppState] listener for "${path}" threw:`, err);
          }
        }
      }
    }
  }

  /** Read state at a dotted path, e.g. get('market.asset'). Empty path returns everything. */
  function get(path) {
    if (!path) return state;
    return getIn(state, path.split("."));
  }

  /**
   * Write state at a dotted path and notify subscribers.
   * Pass persist:true only for paths listed in PERSISTED_PATHS — anything
   * else is a no-op for storage (by design: transient market data,
   * in-flight sockets, etc. should never hit localStorage).
   */
  function set(path, value) {
    if (!path) throw new Error("[AppState] set() requires a path");
    setIn(state, path.split("."), value);
    if (PERSISTED_PATHS[path]) writePersisted(path, value);
    notify(path);
    return value;
  }

  /** Shallow-merge an object into the state at a dotted path (for updating a few fields at once). */
  function merge(path, partial) {
    const current = get(path) || {};
    const next = Object.assign({}, current, partial);
    set(path, next);
    return next;
  }

  function subscribe(path, cb) {
    if (!listeners.has(path)) listeners.set(path, new Set());
    listeners.get(path).add(cb);
    return function unsubscribe() {
      const set_ = listeners.get(path);
      if (set_) set_.delete(cb);
    };
  }

  // ---------- race-condition guard ----------
  // Call beginRequest(lane) right before starting an async call. It bumps
  // that lane's counter and returns the new value as your token. When the
  // response comes back, call isCurrent(lane, token) — if false, a newer
  // request in the same lane has since started (e.g. the user switched
  // assets or clicked Generate again) and this response must be discarded
  // without touching the DOM or state.
  function beginRequest(lane) {
    const seq = state.market._requestSeq;
    if (!(lane in seq)) seq[lane] = 0;
    seq[lane] += 1;
    return seq[lane];
  }

  function isCurrent(lane, token) {
    return state.market._requestSeq[lane] === token;
  }

  window.AppState = {
    get,
    set,
    merge,
    subscribe,
    beginRequest,
    isCurrent,
  };
})();
