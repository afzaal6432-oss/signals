/**
 * errors.js — the one place every fetch() failure in the web client
 * should pass through before anything reaches the screen.
 *
 * WHY THIS EXISTS: before this file, every catch block in index.html
 * wrote its own ad-hoc message, and a few of them did it by echoing
 * infrastructure straight at the user — e.g. "Couldn't load plans —
 * check BACKEND_URL / that the server is running." That's a debugging
 * note a developer would want, not something a paying customer should
 * ever see. This file draws one line: technical detail goes to
 * console.error() (a developer surface — anyone who opens devtools,
 * same as on any site) and to the backend's own error log (already
 * viewable in the admin dashboard's Diagnostics tab via
 * /admin/system/error-logs — see clients/web/admin.html — which this
 * file does not duplicate or replace); the SCREEN only ever gets a
 * short, calm, professional sentence.
 *
 * USAGE
 *   AppErrors.friendly('plans', err)              // fetch() itself threw (network/CORS/DNS)
 *   AppErrors.friendly('plans', null, res.status)  // got a response, but !res.ok
 *   AppErrors.friendly('plans', null, res.status, data.detail) // + a backend-provided detail
 *
 * The backend's `detail` field is often already a genuine, safe,
 * human-written validation message (e.g. "That key isn't valid",
 * "Please choose a plan") — those are shown as-is rather than replaced,
 * since replacing them with something generic would make the app LESS
 * helpful, not more professional. isSafeDetail() below is the one
 * guard against a regression on the backend ever leaking something it
 * shouldn't (a stack trace, an internal path, a raw exception message)
 * through that same field.
 */
(function () {
  "use strict";

  // One canned, professional sentence per situation. Every one of these
  // follows the same shape on purpose: say what happened, say what to
  // do about it. None of them apologize or speculate about the cause.
  const MESSAGES = {
    network: "We're having trouble reaching the server. Check your connection and try again.",
    server: "Something went wrong on our end. Please try again in a moment.",
    unauthorized: "You need to sign in again to continue.",
    session_expired: "Your session has expired. Please sign in again.",
    register: "We couldn't create your account right now. Please try again in a moment.",
    login: "We couldn't sign you in right now. Please try again in a moment.",
    withdrawal_request: "We couldn't submit your withdrawal request right now. Please try again in a moment.",

    plans: "We couldn't load the subscription plans right now. Please try again in a moment.",
    payment_settings: "We couldn't load payment details right now. Please try again in a moment.",
    payment_submit: "We couldn't submit your payment request right now. Please try again in a moment.",
    payment_status: "We couldn't check that request's status right now. Please try again in a moment.",
    license_check: "We couldn't verify your license key right now. Please try again in a moment.",
    signals: "Signal data isn't available right now. Please try again in a moment.",
    assets: "We couldn't confirm the live asset list — showing the standard list instead.",
    dashboard: "We couldn't refresh your account status right now.",
    notice: "", // the site-notice banner is optional by design — silence on failure is correct, not a gap
    support_chat: "We couldn't reach support chat right now. Please try again in a moment.",
    ws_disconnected: "Connection lost. Trying to reconnect…",
    ws_reconnecting: "Reconnecting…",

    generic: "Something unexpected happened. Please try again.",
  };

  // Red flags that mark a string as a raw technical/backend error rather
  // than something written for a customer to read. This is a safety net,
  // not the primary defense — the primary defense is that call sites pass
  // a context key and get a pre-written professional fallback. This just
  // stops a backend regression (an unhandled exception's str(), a path, a
  // stray env var name) from reaching the screen even if some future code
  // path forgets to route through here properly.
  const UNSAFE_PATTERNS = [
    /backend_url/i, /localhost/i, /127\.0\.0\.1/, /0\.0\.0\.0/,
    /traceback/i, /\bfile "/i, /\bat 0x/i, /stack trace/i,
    /sqlite3?\b/i, /\bredis\b/i, /\bturso\b/i, /\bjwt\b/i,
    /env(ironment)? ?variable/i, /api[_ ]?key/i, /auth[_ ]?token/i,
    /internal server error/i, /connection refused/i, /econnrefused/i,
    /enotfound/i, /\.py"|\.py:/i, /\bnull\b.*exception/i,
    /^\s*<!doctype/i, /^\s*<html/i, // an error page's raw HTML leaking through
  ];

  function isSafeDetail(text) {
    if (!text || typeof text !== "string") return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (trimmed.length > 200) return false; // real user-facing copy is short; a 200+ char "detail" is a dump, not a message
    return !UNSAFE_PATTERNS.some((re) => re.test(trimmed));
  }

  /**
   * context: one of the keys in MESSAGES above (unknown keys fall back
   *          to MESSAGES.generic rather than throwing, so a typo here
   *          degrades gracefully instead of breaking the error path
   *          itself).
   * err: the caught exception from a failed fetch() (network/CORS/DNS
   *      failure) — pass this branch when fetch() itself rejected.
   *      Always resolves to a generic connectivity message: on a real
   *      network failure we don't actually know anything more specific
   *      (e.g. whether a record "wasn't found" vs. simply unreachable),
   *      so guessing here would be actively misleading.
   * backendDetail: a `detail` (or similar) string from a successfully
   *      received but non-ok response body. Shown as-is if it passes
   *      isSafeDetail(), otherwise falls back to localFallback (if
   *      given) or MESSAGES[context].
   * localFallback: an optional, call-site-specific message to use
   *      instead of the generic MESSAGES[context] when backendDetail is
   *      missing/unsafe — for cases where the calling code already had
   *      a good, specific, already-safe message (e.g. "Couldn't find
   *      that request") that's more helpful than the generic one and
   *      is worth keeping.
   */
  function friendly(context, err, backendDetail, localFallback) {
    const fallback = Object.prototype.hasOwnProperty.call(MESSAGES, context)
      ? MESSAGES[context]
      : MESSAGES.generic;

    if (err) {
      console.error(`[${context}] request failed:`, err);
      return fallback;
    }
    if (isSafeDetail(backendDetail)) {
      return backendDetail;
    }
    if (backendDetail) {
      console.error(`[${context}] backend detail withheld from UI (failed safety check):`, backendDetail);
    }
    return localFallback || fallback;
  }

  /**
   * For code that wraps a failure in its own Error and re-throws (e.g.
   * affiliate.html's api() helper): produces an Error whose .message is
   * already a safe, friendly string, tagged so a later catch block knows
   * not to re-run it through isSafeDetail() as if it might be a raw
   * backend value — it's already been checked once here.
   */
  function makeError(context, backendDetail, localFallback) {
    const err = new Error(friendly(context, null, backendDetail, localFallback));
    err.isFriendlyError = true;
    return err;
  }

  /**
   * The counterpart to makeError(): call this from a catch block on
   * something that might be either (a) an Error produced by makeError()
   * above — already safe, shown as-is — or (b) a raw, unprocessed
   * exception (a network failure, a CORS block, anything fetch() itself
   * threw) — which must NOT be shown as-is (e.g. a raw "Failed to fetch"
   * is browser-internal phrasing, not something written for a user) and
   * instead goes through the normal network-failure fallback.
   */
  function fromCaught(context, e, localFallback) {
    if (e && e.isFriendlyError) {
      return e.message;
    }
    return friendly(context, e, undefined, localFallback);
  }

  window.AppErrors = { friendly, makeError, fromCaught, MESSAGES, isSafeDetail };
})();
