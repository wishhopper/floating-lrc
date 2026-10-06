// Background: fetches from LRCLIB on behalf of the page (avoids the page's cross-origin restrictions) and does simple caching.
importScripts('lrc.js');

const BASE = 'https://lrclib.net';
const cache = new Map();

async function fetchJson(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { 'Lrclib-Client': 'ytm-floating-lyrics v0.1.0 (personal extension)' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// Desktop subtitle app (local 127.0.0.1). Unreachable when it is not running; after consecutive failures, back off for a while.
let overlayDownUntil = 0;
function sendOverlay(msg, sender) {
  if (Date.now() < overlayDownUntil) return;
  fetch('http://127.0.0.1:38917/line', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(msg.pkt || {}),
  })
    .then(function (r) {
      return r.json();
    })
    .then(function (j) {
      // "Slower/Faster" was clicked on the desktop subtitle; forward the offset to the tab that sent the data
      if (j && j.offsetDelta && sender && sender.tab && sender.tab.id != null) {
        chrome.tabs.sendMessage(sender.tab.id, { type: 'offsetDelta', delta: j.offsetDelta }, function () {
          void chrome.runtime.lastError;
        });
      }
    })
    .catch(function () {
      overlayDownUntil = Date.now() + 5000;
    });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'overlay') {
    sendOverlay(msg, sender);
    return false;
  }
  if (!msg || msg.type !== 'lookup') return false;
  const key = JSON.stringify(msg.q);
  if (cache.has(key)) {
    sendResponse(cache.get(key));
    return false;
  }
  self.LrcUtil.lookup(fetchJson, msg.q)
    .then(function (r) {
      let out;
      if (!r) {
        out = { ok: true, synced: null };
      } else if (r.instrumental) {
        out = { ok: true, instrumental: true };
      } else {
        out = {
          ok: true,
          synced: r.item.syncedLyrics,
          how: r.how,
          matched: {
            artist: r.item.artistName,
            track: r.item.trackName,
            duration: r.item.duration,
          },
        };
      }
      cache.set(key, out);
      sendResponse(out);
    })
    .catch(function (e) {
      sendResponse({ ok: false, error: String(e) });
    });
  return true; // async reply
});
