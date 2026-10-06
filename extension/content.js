// Content script: reads the current track info through the site adapter (see adapters/), asks the background for synced lyrics,
// and shows them as a "single-line subtitle" in a Document Picture-in-Picture (always-on-top mini window).
(function () {
  'use strict';

  const U = window.LrcUtil;
  const POLL_MS = 250;
  const MIN_FS = 12; // smallest font size to shrink to when a line does not fit

  let track = null; // { key, title, artist, album, duration }
  let pending = null; // a track change counts only after two consecutive identical readings
  let lines = [];
  let status = 'idle'; // idle | loading | ok | none | instrumental | error
  let offset = 0; // seconds; positive = lyrics appear earlier
  let reqId = 0;

  let pip = null;
  let ui = null;
  let pipTimer = null;
  let lastDrawKey = '';

  // Appearance settings (remembered)
  const settings = { fs: 30, theme: 'black' };
  const THEMES = ['black', 'graphite', 'light'];

  // ---------- Read playback info (delegated to the site adapter) ----------
  const adapter = (window.LrcAdapters || []).filter(function (a) {
    return a.matches(location);
  })[0];
  if (!adapter) return; // no adapter for this site
  const readTrack = adapter.readTrack;

  // ---------- Storage ----------
  function storageGet(key) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(key, function (r) {
          resolve(r ? r[key] : undefined);
        });
      } catch (e) {
        resolve(undefined);
      }
    });
  }
  function storageSet(key, value) {
    try {
      const o = {};
      o[key] = value;
      chrome.storage.local.set(o);
    } catch (e) {
      /* ignore */
    }
  }
  function saveOffset() {
    if (track) storageSet('offset:' + track.key, offset);
  }
  function saveSettings() {
    storageSet('ui', { fs: settings.fs, theme: settings.theme });
  }
  async function loadSettings() {
    const s = await storageGet('ui');
    if (s && Number.isFinite(s.fs)) settings.fs = Math.max(14, Math.min(72, s.fs));
    if (s && THEMES.indexOf(s.theme) >= 0) settings.theme = s.theme;
  }

  // ---------- Track change -> fetch lyrics ----------
  function onTrackChange(t) {
    const myReq = ++reqId;
    track = t;
    lines = [];
    status = 'loading';
    offset = 0;
    lastDrawKey = '';
    storageGet('offset:' + t.key).then(function (v) {
      if (myReq === reqId) offset = Number(v) || 0;
    });
    chrome.runtime.sendMessage(
      {
        type: 'lookup',
        q: { title: t.title, artist: t.artist, album: t.album, duration: t.duration },
      },
      function (res) {
        if (myReq !== reqId) return; // the track has already changed
        if (chrome.runtime.lastError || !res || !res.ok) {
          status = 'error';
        } else if (res.instrumental) {
          status = 'instrumental';
        } else if (!res.synced) {
          status = 'none';
        } else {
          lines = U.parseLrc(res.synced);
          status = lines.length ? 'ok' : 'none';
        }
        lastDrawKey = '';
      }
    );
  }

  // ---------- Every tick ----------
  function tick() {
    const cur = readTrack();
    if (cur.title && Number.isFinite(cur.duration) && cur.duration > 0) {
      const key = cur.title + '|' + cur.artist + '|' + Math.round(cur.duration);
      if (!track || track.key !== key) {
        if (pending === key) {
          pending = null;
          onTrackChange({
            key: key,
            title: cur.title,
            artist: cur.artist,
            album: cur.album,
            duration: cur.duration,
          });
        } else {
          pending = key; // seen for the first time; confirm on the next tick
        }
      } else {
        pending = null;
      }
    }
    draw(cur);
    pushOverlay(cur, false);
  }

  // ---------- Push to the desktop subtitle app (optional; silently ignored when it is not running)----------
  // Instead of pushing line by line, hand the app the "full lyrics + playback position + timestamp",
  // and let the app compute the current line at high frequency, so it is unaffected by the page's timers being throttled.
  let lastPushKey = '';
  let lastPushAt = 0;
  function pushOverlay(cur, force) {
    const now = Date.now();
    let pkt;
    let key;
    if (status === 'ok' && cur.video && lines.length) {
      key = 'sync|' + (track ? track.key : '') + '|' + lines.length + '|' + offset;
      pkt = {
        mode: 'sync',
        lines: lines,
        pos: cur.video.currentTime,
        rate: cur.video.playbackRate || 1,
        paused: !!cur.video.paused,
        offset: offset,
        sentAt: Date.now(),
      };
    } else {
      const m = computeMain(cur);
      key = 'text|' + m.main;
      pkt = { mode: 'text', text: m.main, dim: m.dim };
    }
    if (!force && key === lastPushKey && now - lastPushAt < 1000) return;
    lastPushKey = key;
    lastPushAt = now;
    try {
      chrome.runtime.sendMessage({ type: 'overlay', pkt: pkt }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      /* may be invalidated right after the extension updates; ignore */
    }
  }

  // Video play/pause/seek events are not affected by timer throttling; use them to recalibrate promptly
  let boundVideo = null;
  function bindVideo() {
    const v = adapter.getMedia();
    if (!v || v === boundVideo) return;
    boundVideo = v;
    ['play', 'pause', 'seeked', 'ratechange'].forEach(function (ev) {
      v.addEventListener(ev, function () {
        pushOverlay(readTrack(), true);
      });
    });
    v.addEventListener('timeupdate', function () {
      pushOverlay(readTrack(), false);
    });
  }

  // ---------- Rendering ----------
  // Single-line display: start with the configured font size, and shrink step by step until the whole line fits.
  function fit() {
    if (!ui) return;
    let size = settings.fs;
    const el = ui.cur;
    el.style.fontSize = size + 'px';
    let guard = 0;
    while (el.scrollWidth > el.clientWidth && size > MIN_FS && guard++ < 80) {
      size -= 0.5;
      el.style.fontSize = size + 'px';
    }
  }

  function computeMain(cur) {
    let main = '';
    let dim = false;

    if (status === 'ok') {
      const t = (cur.video ? cur.video.currentTime : 0) + offset;
      const idx = U.findIndex(lines, t);
      const text = idx >= 0 ? lines[idx].text : '';
      main = text || '♪';
      dim = !text;
    } else if (status === 'loading') {
      main = 'Loading lyrics…';
      dim = true;
    } else if (status === 'none') {
      main = 'No synced lyrics found';
      dim = true;
    } else if (status === 'instrumental') {
      main = '♪ Instrumental';
      dim = true;
    } else if (status === 'error') {
      main = 'Lyrics service unavailable';
      dim = true;
    } else {
      main = 'Play a song to begin';
      dim = true;
    }
    return { main: main, dim: dim };
  }

  function draw(cur) {
    updateDebugAttrs();
    if (!ui) return;

    const m = computeMain(cur);
    const main = m.main;
    const dim = m.dim;

    const key = [status, main, offset, settings.fs, settings.theme].join('\u0001');
    if (key === lastDrawKey) return;
    const changedText = !lastDrawKey || lastDrawKey.split('\u0001')[1] !== main;
    lastDrawKey = key;

    ui.doc.documentElement.setAttribute('data-theme', settings.theme);
    ui.cur.textContent = main;
    ui.cur.classList.toggle('dim', dim);
    ui.offsetLabel.textContent = (offset >= 0 ? '+' : '') + offset.toFixed(1) + 's';
    fit();
    if (changedText) {
      // slight fade-in on line change, subtle and unobtrusive
      ui.cur.classList.remove('in');
      void ui.cur.offsetWidth;
      ui.cur.classList.add('in');
    }
  }

  // For debugging: write the state to the button's data attribute
  function updateDebugAttrs() {
    const b = document.getElementById('ytm-fl-btn');
    if (!b) return;
    b.dataset.status = status;
    b.dataset.lines = String(lines.length);
    b.dataset.track = track ? track.title + ' | ' + track.artist + ' | ' + Math.round(track.duration) : '';
  }

  // ---------- Floating window UI ----------
  const CSS =
    ':root{--bg:#000;--fg:#fff;--dim:rgba(255,255,255,.45);--glass:rgba(255,255,255,.14);--glass2:rgba(255,255,255,.26)}' +
    ':root[data-theme=graphite]{--bg:#1c1c1e;--fg:#f5f5f7;--dim:rgba(245,245,247,.45);--glass:rgba(255,255,255,.12);--glass2:rgba(255,255,255,.24)}' +
    ':root[data-theme=light]{--bg:#f5f5f7;--fg:#1d1d1f;--dim:rgba(0,0,0,.4);--glass:rgba(0,0,0,.07);--glass2:rgba(0,0,0,.14)}' +
    '*{box-sizing:border-box}' +
    'html,body{margin:0;height:100%;background:var(--bg);overflow:hidden}' +
    "body{display:flex;align-items:center;justify-content:center;padding:0 10px;-webkit-font-smoothing:antialiased;" +
    "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Hiragino Sans','PingFang SC','Apple SD Gothic Neo',sans-serif;user-select:none}" +
    '.cur{width:100%;margin:0;color:var(--fg);font-weight:600;letter-spacing:-.011em;line-height:1.2;text-align:center;' +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 2px}' +
    '.cur.dim{color:var(--dim);font-weight:500}' +
    '.cur.in{animation:in .26s ease-out}' +
    '@keyframes in{from{opacity:.0;transform:translateY(3px)}to{opacity:1;transform:none}}' +
    '.bar{position:fixed;top:4px;right:6px;display:flex;gap:3px;align-items:center;opacity:0;transition:opacity .18s;' +
    'padding:2px;border-radius:9px;background:var(--bg)}' +
    'body:hover .bar{opacity:1}' +
    '.bar button{background:var(--glass);color:var(--fg);border:0;border-radius:6px;height:20px;padding:0 7px;font:500 11px/20px inherit;font-family:inherit;cursor:pointer}' +
    '.bar button:hover{background:var(--glass2)}' +
    '.bar span{font-size:11px;color:var(--dim);min-width:36px;text-align:center;font-variant-numeric:tabular-nums}';

  function buildUi(win) {
    const doc = win.document;
    const style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.appendChild(style);

    const cur = doc.createElement('div');
    cur.className = 'cur';

    const bar = doc.createElement('div');
    bar.className = 'bar';
    function btn(label, title, fn) {
      const b = doc.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    }
    const offsetLabel = doc.createElement('span');
    bar.appendChild(
      btn('−0.5', 'Lyrics later (−0.5s)', function () {
        offset -= 0.5;
        saveOffset();
        lastDrawKey = '';
      })
    );
    bar.appendChild(offsetLabel);
    bar.appendChild(
      btn('+0.5', 'Lyrics earlier (+0.5s)', function () {
        offset += 0.5;
        saveOffset();
        lastDrawKey = '';
      })
    );
    bar.appendChild(
      btn('A−', 'Smaller', function () {
        settings.fs = Math.max(14, settings.fs - 2);
        saveSettings();
        lastDrawKey = '';
      })
    );
    bar.appendChild(
      btn('A+', 'Larger', function () {
        settings.fs = Math.min(72, settings.fs + 2);
        saveSettings();
        lastDrawKey = '';
      })
    );
    bar.appendChild(
      btn('◐', 'Theme: black / graphite / light', function () {
        settings.theme = THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length];
        saveSettings();
        lastDrawKey = '';
      })
    );

    doc.body.appendChild(cur);
    doc.body.appendChild(bar);
    doc.documentElement.setAttribute('data-theme', settings.theme);

    ui = { doc: doc, cur: cur, offsetLabel: offsetLabel };
    win.addEventListener('resize', function () {
      lastDrawKey = '';
    });
  }

  async function togglePip() {
    if (pip) {
      pip.close();
      return;
    }
    if (!('documentPictureInPicture' in window)) {
      toast('This Chrome version has no floating window support (needs Chrome 116+).');
      return;
    }
    // Wide and short: about 80% of the screen width, with height for just one line of subtitle
    const w = Math.round(Math.min(1500, Math.max(640, (screen.availWidth || 1200) * 0.8)));
    try {
      pip = await window.documentPictureInPicture.requestWindow({ width: w, height: 64 });
    } catch (e) {
      toast('Could not open the floating window: ' + (e && e.message ? e.message : e));
      return;
    }
    await loadSettings();
    buildUi(pip);
    lastDrawKey = '';
    // Timers inside the floating window are not throttled like background tabs, so use one to drive refreshes
    pipTimer = pip.setInterval(tick, 150);
    pip.addEventListener('pagehide', function () {
      if (pipTimer) pip.clearInterval(pipTimer);
      pipTimer = null;
      pip = null;
      ui = null;
    });
    tick();
  }

  // ---------- Button on the page ----------
  function toast(msg) {
    const d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText =
      'position:fixed;right:20px;bottom:150px;z-index:2147483647;background:#222;color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.4)';
    document.body.appendChild(d);
    setTimeout(function () {
      d.remove();
    }, 4000);
  }

  function injectButton() {
    if (document.getElementById('ytm-fl-btn') || !document.body) return;
    const b = document.createElement('button');
    b.id = 'ytm-fl-btn';
    b.textContent = '♪ Floating lrc';
    b.style.cssText =
      'position:fixed;right:20px;bottom:96px;z-index:2147483646;background:#fff;color:#111;border:0;border-radius:999px;padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35)';
    b.addEventListener('click', togglePip);
    document.body.appendChild(b);
  }

  function start() {
    chrome.runtime.onMessage.addListener(function (m) {
      if (m && m.type === 'offsetDelta' && Number.isFinite(m.delta)) {
        offset = Math.round((offset + m.delta) * 10) / 10;
        saveOffset();
        lastDrawKey = '';
        if (track) pushOverlay(readTrack(), true);
      }
    });
    injectButton();
    setInterval(function () {
      injectButton(); // the page is a single-page app; re-add the button if it gets redrawn away
      bindVideo();
      tick();
    }, POLL_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
