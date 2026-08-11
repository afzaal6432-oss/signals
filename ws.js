/**
 * ws.js — WebSocket client for the live ticker feed.
 *
 * Talks to the backend's /ws endpoint (see app/ws/connection_manager.py
 * for the exact message protocol). Responsibilities kept here, on
 * purpose, so nothing else in the app has to know about sockets:
 *   - connect, and reconnect with exponential backoff on drop
 *   - reply to server pings so the server doesn't consider us stale
 *   - room subscribe/unsubscribe WITHOUT closing the connection
 *   - drop out-of-order/duplicate delta packets using sequence_id
 *   - write results into AppState so the rest of the app just reads
 *     AppState.market.ticker and doesn't touch the socket directly
 *
 * This does NOT replace the REST ticker poll in index.html — it's an
 * additive fast path. If the socket is down, refreshTicker()'s existing
 * REST polling keeps working exactly as it did before this file existed.
 */
(function () {
  "use strict";

  // 1s, 2s, 4s, 8s, 15s, 30s, then hold at 30s — matches the spec exactly
  // rather than a bare doubling series, which would blow past 30s.
  const BACKOFF_SCHEDULE_MS = [1000, 2000, 4000, 8000, 15000, 30000];

  function wsUrlFromBackend(backendUrl, licenseKey) {
    // BACKEND_URL is already an absolute http(s) URL (see index.html) —
    // swap the scheme and append /ws rather than requiring a second
    // constant to stay in sync with it. license_key is now REQUIRED by
    // the backend (see app/main.py's websocket_endpoint) — connecting
    // without one gets a clean 4401 close instead of room data, since
    // "premium" carries paid signal alerts that must be gated the same
    // way every other paid feature in this app is.
    const base = backendUrl.replace(/^http/, "ws") + "/ws";
    return base + "?license_key=" + encodeURIComponent(licenseKey || "");
  }

  function createWsClient(backendUrl, licenseKey) {
    let socket = null;
    let reconnectAttempt = 0;
    let reconnectTimer = null;
    let intentionalClose = false;
    let currentRoom = null;
    // Per-asset last-seen sequence_id, to reject a delta that arrives out
    // of order (e.g. a retried/delayed message from before a reconnect).
    // Keyed by asset since sequence_id only orders messages WITHIN one
    // room's stream, not globally.
    const lastSeqByAsset = {};

    function setStatus(status) {
      AppState.set("websocket.status", status);
    }

    function scheduleReconnect() {
      if (intentionalClose) return;
      const delay = BACKOFF_SCHEDULE_MS[Math.min(reconnectAttempt, BACKOFF_SCHEDULE_MS.length - 1)];
      reconnectAttempt += 1;
      setStatus("connecting");
      reconnectTimer = setTimeout(connect, delay);
    }

    const externalListeners = {}; // type -> array of callbacks, for message types this file doesn't own the meaning of

    function on(type, callback) {
      if (!externalListeners[type]) externalListeners[type] = [];
      externalListeners[type].push(callback);
    }

    function applyDelta(message) {
      const { market, sequence_id, data } = message;
      const lastSeq = lastSeqByAsset[market] || 0;
      if (sequence_id <= lastSeq) {
        // Stale or duplicate — a newer or equal packet already applied.
        return;
      }
      lastSeqByAsset[market] = sequence_id;

      const ticker = AppState.get("market.ticker") || [];
      const idx = ticker.findIndex((t) => t.asset === market);
      const updated = Object.assign({ asset: market }, data);
      const next = idx === -1 ? ticker.concat([updated]) : ticker.slice();
      if (idx !== -1) next[idx] = updated;
      AppState.set("market.ticker", next);
    }

    function handleMessage(event) {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (e) {
        return; // malformed frame — ignore rather than throw
      }
      switch (message.type) {
        case "ping":
          send({ type: "pong" });
          break;
        case "connected":
          reconnectAttempt = 0; // successful handshake resets backoff
          setStatus("open");
          if (currentRoom) send({ type: "subscribe", room: currentRoom });
          break;
        case "subscribed":
        case "unsubscribed":
          AppState.set("websocket.room", message.type === "subscribed" ? message.room : null);
          break;
        case "ticker_delta":
          // Ignore deltas for a room we're not (or no longer) subscribed
          // to — protects against a stale subscribe/unsubscribe race
          // where a message for the old room is already in flight.
          if (message.room === currentRoom) applyDelta(message);
          break;
        case "error":
          console.warn("[ws] server error:", message.detail);
          break;
        default:
          // Message types this file doesn't own the meaning of (e.g.
          // "premium_signal" from app/signals/premium_watcher.py) just
          // get handed to whoever registered interest via on(type, cb) —
          // keeps this file from needing to know about every feature
          // that ever rides over the same socket.
          (externalListeners[message.type] || []).forEach((cb) => cb(message));
      }
    }

    function send(payload) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    }

    function connect() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      intentionalClose = false;
      setStatus("connecting");
      try {
        socket = new WebSocket(wsUrlFromBackend(backendUrl, licenseKey));
      } catch (e) {
        scheduleReconnect();
        return;
      }
      AppState.set("websocket.socket", socket);

      socket.addEventListener("message", handleMessage);
      socket.addEventListener("close", () => {
        setStatus("closed");
        socket = null;
        scheduleReconnect();
      });
      socket.addEventListener("error", () => {
        // The subsequent 'close' event drives reconnect; this listener
        // only exists so an error doesn't surface as an uncaught event.
      });
    }

    function setRoom(room) {
      if (room === currentRoom) return;
      const previousRoom = currentRoom;
      currentRoom = room;
      AppState.set("currentMode", room);
      if (previousRoom) send({ type: "unsubscribe", room: previousRoom });
      if (room) send({ type: "subscribe", room: room });
    }

    function disconnect() {
      intentionalClose = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) socket.close(1000, "client disconnect");
      setStatus("disconnected");
    }

    return { connect, disconnect, setRoom, on };
  }

  window.createWsClient = createWsClient;
})();
