// Site adapter: YouTube Music (music.youtube.com).
//
// An adapter tells Floating lrc how to read "what is playing" on one website.
// To support another site, copy this file and implement the same three members:
//   id        - short unique id
//   matches   - (location) => true when this adapter should run on the current page
//   getMedia  - () => the page's playing <audio>/<video> element (needs currentTime, playbackRate, paused, duration)
//   readTrack - () => { title, artist, album, duration, video } for the current track
// Then register it in manifest.json (content_scripts matches + js) before content.js.
(function () {
  'use strict';

  // YouTube Music can keep more than one media element in the page (e.g. the next track is prepared in a second one).
  // Follow the one that is actually playing, not simply the first in the document.
  function getMedia() {
    const els = Array.prototype.slice.call(document.querySelectorAll('video, audio'));
    if (els.length <= 1) return els[0] || null;
    const playing = els.filter(function (e) {
      return !e.paused && !e.ended && e.readyState >= 2;
    });
    if (playing.length) return playing[0];
    const loaded = els.filter(function (e) {
      return e.readyState >= 1 && Number.isFinite(e.duration) && e.duration > 0;
    });
    return loaded[0] || els[0];
  }

  function readTrack() {
    const video = getMedia();
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    let title = (md && md.title) || '';
    let artist = (md && md.artist) || '';
    let album = (md && md.album) || '';
    if (!title) {
      const el = document.querySelector('ytmusic-player-bar .title');
      title = el ? el.textContent.trim() : '';
    }
    if (!artist) {
      const el = document.querySelector('ytmusic-player-bar .byline');
      if (el) {
        const parts = el.textContent.split('•').map(function (s) {
          return s.trim();
        });
        artist = parts[0] || '';
        album = album || parts[1] || '';
      }
    }
    // The player bar's "0:12 / 3:25" is the song's true length; video.duration can be the whole gapless stream so far.
    let duration = video && Number.isFinite(video.duration) ? video.duration : NaN;
    const ti = document.querySelector('ytmusic-player-bar .time-info');
    const m = ti && /\/\s*([\d:]+)\s*$/.exec(ti.textContent.trim());
    if (m) {
      const total = m[1].split(':').reduce(function (acc, p) { return acc * 60 + Number(p); }, 0);
      if (total > 0) duration = total;
    }

    return { title: title, artist: artist, album: album, duration: duration, video: video };
  }

  const adapter = {
    id: 'youtube-music',
    matches: function (loc) {
      return loc.hostname === 'music.youtube.com';
    },
    getMedia: getMedia,
    readTrack: readTrack,
  };

  (window.LrcAdapters = window.LrcAdapters || []).push(adapter);
  if (typeof module !== 'undefined' && module.exports) module.exports = adapter;
})();
