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

  function getMedia() {
    return document.querySelector('video');
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
    const duration = video && Number.isFinite(video.duration) ? video.duration : NaN;
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
