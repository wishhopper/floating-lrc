// Content script: reads the current track info through the site adapter (see adapters/), asks the background for synced lyrics,
// and shows them as a "single-line subtitle" in a Document Picture-in-Picture (always-on-top mini window).
(function () {
  'use strict';

  const U = window.LrcUtil;
  const POLL_MS = 250;
  const MIN_FS = 12; // smallest font size to shrink to when a line does not fit

  let track = null; // { key, title, artist, album, duration }
  let pending = null; // a track change counts only after three consecutive identical readings
  let pendingN = 0;
  let lines = [];
  let status = 'idle'; // idle | loading | ok | none | instrumental | error
  let offset = 0; // seconds; positive = lyrics appear earlier
  let reqId = 0;
  // YouTube Music plays consecutive tracks gaplessly inside ONE media stream, so after an auto-advance video.currentTime keeps
  // counting from the previous track's start. `base` is where the current song began on that clock.
  let base = 0;
  let sawTime = 0;

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
    base = track && sawTime > 3 ? Math.max(0, sawTime - 0.3) : 0; // first track of the page: nothing to subtract
    track = t;
    lines = [];
    status = 'loading';
    offset = 0;
    lastDrawKey = '';
    storageGet('offset:' + t.key).then(function (v) {
      if (myReq === reqId) offset = Number(v) || 0;
    });
    console.info('[floating-lrc] new track', t.key, '(req ' + myReq + ')', 'media elements:', document.querySelectorAll('video, audio').length, 'base:', base.toFixed(1), 'time:', (function () { const v = adapter.getMedia(); return v ? Math.round(v.currentTime) + 's paused=' + v.paused : 'none'; })());
    doLookup(t, myReq, 0);
  }

  // Look the lyrics up; when nothing comes back (or the service hiccups) while the same track is still playing, ask again a few
  // times with freshly read metadata - right after a track auto-advances, YouTube Music can briefly report half-updated info.
  const RETRY_MS = [2000, 5000, 12000];
  function doLookup(t, myReq, attempt) {
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
        console.info('[floating-lrc] lookup', attempt, '->', status, t.title + ' | ' + t.artist + ' | ' + Math.round(t.duration), '(req ' + myReq + ')');
        lastDrawKey = '';
        if ((status === 'none' || status === 'error') && attempt < RETRY_MS.length) {
          setTimeout(function () {
            if (myReq !== reqId) return;
            const cur = readTrack();
            const fresh = cur.title && Number.isFinite(cur.duration) && cur.duration > 0
              ? { key: t.key, title: cur.title, artist: cur.artist, album: cur.album, duration: cur.duration }
              : t;
            doLookup(fresh, myReq, attempt + 1);
          }, RETRY_MS[attempt]);
        }
      }
    );
  }

  function songTime(cur) {
    if (!cur.video) return 0;
    const ct = cur.video.currentTime;
    if (ct < base - 1) base = 0; // the clock was reset (a fresh start or a seek back): back to plain time
    return Math.max(0, ct - base);
  }

  // ---------- Every tick ----------
  function tick() {
    const cur = readTrack();
    if (cur.title && Number.isFinite(cur.duration) && cur.duration > 0) {
      const key = cur.title + '|' + cur.artist; // not the duration: YouTube Music's reported length can keep changing while a track loads
      if (!track || track.key !== key) {
        if (pending === key && ++pendingN >= 2) {
          pending = null;
          pendingN = 0;
          onTrackChange({
            key: key,
            title: cur.title,
            artist: cur.artist,
            album: cur.album,
            duration: cur.duration,
          });
        } else {
          if (pending !== key) { sawTime = cur.video ? cur.video.currentTime : 0; pendingN = 0; console.info('[floating-lrc] saw', key, Math.round(cur.duration), 'paused=' + (cur.video && cur.video.paused)); }
          pending = key; // seen for the first time; confirm on the next ticks
        }
      } else {
        pending = null;
        if (Number.isFinite(cur.duration) && cur.duration > 0) track.duration = cur.duration; // keep the latest length for retries
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
        pos: songTime(cur),
        rate: cur.video.playbackRate || 1,
        paused: !!cur.video.paused,
        offset: offset,
        sentAt: Date.now(),
      };
    } else {
      const m = computeMain(cur);
      key = 'text|' + m.main + '|' + (m.rest ? 'r' : '');
      pkt = { mode: 'text', text: m.main, dim: m.dim, rest: m.rest };
    }
    pkt.playing = !!(cur.video && !cur.video.paused && cur.video.currentTime > 0);
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
    let rest = false; // show the sleeping cat instead of text

    if (status === 'ok') {
      const t = songTime(cur) + offset;
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
      rest = true;
    } else if (status === 'instrumental') {
      main = '♪ Instrumental';
      dim = true;
    } else if (status === 'error') {
      main = 'Lyrics service unavailable';
      dim = true;
    } else {
      main = 'Play a song to begin';
      dim = true;
      rest = true;
    }
    return { main: main, dim: dim, rest: rest };
  }

  // Sleeping cat (solid colour = text colour), shown instead of "no lyrics" / when nothing is playing.
  const CAT_SVG =
    '<svg class="cat" viewBox="0 0 120 68" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><defs><mask id="catA" maskUnits="userSpaceOnUse" x="-10" y="-10" width="140" height="90"><rect x="-10" y="-10" width="140" height="90" fill="#fff"/><g fill="#000" stroke="#000" stroke-width="5" stroke-linejoin="round" transform="translate(34 44) scale(0.76) translate(-38 -36)"><g transform="rotate(-11 38 38)"><ellipse cx="38" cy="39" rx="23" ry="18"/><path d="M19 30 20.5 18.5 30 23ZM57 30 55.5 18.5 46 23Z"/></g><ellipse cx="29" cy="56" rx="7.6" ry="5"/><ellipse cx="47" cy="56" rx="7.6" ry="5"/></g><g fill="#000" stroke="#000" stroke-width="4.2" stroke-linejoin="round"><g transform="translate(90 63.3) scale(.75) translate(-101 -63.3)"><path d="M77 63.3Q70 63.3 70 59.6Q70 55.9 77 55.9L86 53Q101 53 101 56Q101 63.3 92 63.3Z"/><ellipse cx="90" cy="52" rx="11.3" ry="11.3"/></g></g></mask><mask id="catT" maskUnits="userSpaceOnUse" x="-10" y="-10" width="140" height="90"><rect x="-10" y="-10" width="140" height="90" fill="#fff"/><g fill="#000" stroke="#000" stroke-width="4" stroke-linejoin="round"><path transform="translate(45 58) scale(.8) translate(-45 -58)" d="M50 58Q45 58 45 51Q45 29 59 23Q73 17 88 22Q103 28 103 43Q103 58 93 58Z"/><g transform="translate(90 63.3) scale(.75) translate(-101 -63.3)"><path d="M77 63.3Q70 63.3 70 59.6Q70 55.9 77 55.9L86 53Q101 53 101 56Q101 63.3 92 63.3Z"/><ellipse cx="90" cy="52" rx="11.3" ry="11.3"/></g><g transform="translate(34 44) scale(0.76) translate(-38 -36)"><g transform="rotate(-11 38 38)"><ellipse cx="38" cy="39" rx="23" ry="18"/><path d="M19 30 20.5 18.5 30 23ZM57 30 55.5 18.5 46 23Z"/></g><ellipse cx="29" cy="56" rx="7.6" ry="5"/><ellipse cx="47" cy="56" rx="7.6" ry="5"/></g></g></mask><mask id="catF" maskUnits="userSpaceOnUse" x="-10" y="-10" width="140" height="90"><rect x="-10" y="-10" width="140" height="90" fill="#fff"/><g fill="#000" stroke="#000" stroke-width="3.5" stroke-linejoin="round"><path transform="translate(45 58) scale(.8) translate(-45 -58)" d="M50 58Q45 58 45 51Q45 29 59 23Q73 17 88 22Q103 28 103 43Q103 58 93 58Z"/></g></mask><mask id="catPG" maskUnits="userSpaceOnUse" x="-10" y="-10" width="140" height="90"><rect x="-10" y="-10" width="140" height="90" fill="#fff"/><g fill="#000" stroke="#000" stroke-width="3.2" stroke-linejoin="round" transform="translate(34 44) scale(0.76) translate(-38 -36)"><ellipse cx="29" cy="56" rx="7.6" ry="5"/><ellipse cx="47" cy="56" rx="7.6" ry="5"/></g></mask><mask id="catH" maskUnits="userSpaceOnUse" x="-10" y="-10" width="140" height="90"><rect x="-10" y="-10" width="140" height="90" fill="#fff"/><g fill="none" stroke="#000" stroke-width="1.9" stroke-linecap="round"><path d="M25.5 38Q28.5 41.6 31.5 38M44.5 38Q47.5 41.6 50.5 38"/></g><path d="M36.8 42.6H39.2L38 44Z" fill="#000" stroke="#000" stroke-width="1" stroke-linejoin="round"/><path d="M38 44v.8M38 44.8Q36.6 46.4 35.2 45.4M38 44.8Q39.4 46.4 40.8 45.4" fill="none" stroke="#000" stroke-width="1.25" stroke-linecap="round"/><ellipse cx="22.5" cy="43.5" rx="3" ry="1.8" fill="#8a8a8a"/><ellipse cx="53.5" cy="43.5" rx="3" ry="1.8" fill="#8a8a8a"/></mask></defs><g class="body" mask="url(#catA)"><path transform="translate(45 58) scale(.8) translate(-45 -58)" d="M50 58Q45 58 45 51Q45 29 59 23Q73 17 88 22Q103 28 103 43Q103 58 93 58Z"/></g><g><g transform="translate(90 63.3) scale(.75) translate(-101 -63.3)"><path d="M77 63.3Q70 63.3 70 59.6Q70 55.9 77 55.9L86 53Q101 53 101 56Q101 63.3 92 63.3Z"/><ellipse cx="90" cy="52" rx="11.3" ry="11.3"/></g></g><g mask="url(#catT)"><path d="M89 55C101 53 101 63 87 63.5" fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="round"/></g><g class="head"><g transform="translate(34 44) scale(0.76) translate(-38 -36)"><g mask="url(#catPG)"><g transform="rotate(-11 38 38)"><g mask="url(#catH)"><ellipse cx="38" cy="39" rx="23" ry="18"/><path d="M19 30 20.5 18.5 30 23ZM57 30 55.5 18.5 46 23Z" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></g></g></g><ellipse cx="29" cy="56" rx="7.6" ry="5"/><ellipse cx="47" cy="56" rx="7.6" ry="5"/></g></g></svg>';
  const CAT_ZZZ = '<span class="z" style="left:31%;animation-delay:0s">z</span><span class="z" style="left:37%;animation-delay:1.2s">Z</span><span class="z" style="left:43%;animation-delay:2.4s">Z</span>';

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
    if (m.rest) {
      ui.cur.classList.add('restmode');
      ui.cur.innerHTML = CAT_SVG + CAT_ZZZ;
    } else {
      ui.cur.classList.remove('restmode');
      ui.cur.textContent = main;
    }
    ui.cur.classList.toggle('dim', dim);
    ui.offsetLabel.textContent = (offset >= 0 ? '+' : '') + offset.toFixed(1) + 's';
    if (!m.rest) fit();
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
    '.cur.restmode{position:absolute;left:61.8%;top:61.8%;transform:translate(-50%,-50%);display:flex;justify-content:center;opacity:.88;overflow:visible}' +
    '.cur.restmode .cat{filter:drop-shadow(1px 0 0 rgba(20,22,48,.5)) drop-shadow(-1px 0 0 rgba(20,22,48,.5)) drop-shadow(0 1px 0 rgba(20,22,48,.5)) drop-shadow(0 -1px 0 rgba(20,22,48,.5));height:min(56vh,66px);width:auto;display:block;overflow:visible}' +
    '.cur.restmode .cat .body{transform-box:fill-box;transform-origin:50% 100%;animation:breathe 3.8s ease-in-out infinite}' +
    '.cur.restmode .cat .head{animation:purr .13s linear infinite alternate}' +
    '.cur.restmode .z{position:absolute;top:6%;font-weight:700;font-size:13px;opacity:0;animation:zzz 3.6s ease-in infinite}' +
    '@keyframes breathe{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.06)}}' +
    '@keyframes purr{from{transform:translateX(-.35px)}to{transform:translateX(.35px)}}' +
    '@keyframes zzz{0%{opacity:0;transform:translate(0,0) scale(.7)}15%{opacity:.9}100%{opacity:0;transform:translate(10px,-18px) scale(1.15)}}' +
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
