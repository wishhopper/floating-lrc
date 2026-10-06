// Pure logic: LRC parsing, time lookup, title cleaning, picking a version by duration, and the lyrics lookup flow.
// Supports both the browser (extension) global LrcUtil and node (tests) require.
(function (root) {
  'use strict';

  // Parse LRC text into [{t: seconds, text}], sorted by time ascending. Supports multiple timestamps on one line.
  function parseLrc(text) {
    if (typeof text !== 'string') return [];
    const out = [];
    const tagRe = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
    for (const raw of text.split(/\r?\n/)) {
      const stamps = [];
      let m;
      let lastEnd = 0;
      tagRe.lastIndex = 0;
      while ((m = tagRe.exec(raw)) !== null) {
        const sec = parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.'));
        stamps.push(sec);
        lastEnd = tagRe.lastIndex;
      }
      if (!stamps.length) continue; // metadata lines such as [ar:..] are simply ignored
      const body = raw.slice(lastEnd).trim();
      for (const t of stamps) out.push({ t, text: body });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  // Return the index of the last line with t <= time; -1 if the first line has not been reached yet.
  function findIndex(lines, time) {
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t <= time) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  const NOISE_WORDS =
    /(official|audio|video|mv|m\/v|lyric|lyrics|visualizer|live|ver\.?|version|remaster|feat\.?|ft\.?|with|inst\.?|instrumental|performance)/i;

  // Strip noise in brackets (Official Audio / feat. xxx, etc.) and the "- Topic" suffix.
  function cleanTitle(s) {
    if (!s) return '';
    let r = String(s);
    r = r.replace(/[\(\[（【][^\)\]）】]*[\)\]）】]/g, function (seg) {
      return NOISE_WORDS.test(seg) ? '' : seg;
    });
    r = r.replace(/\s+(feat\.?|ft\.?)\s+.*$/i, '');
    r = r.replace(/\s*-\s*Topic\s*$/i, '');
    return r.replace(/\s{2,}/g, ' ').trim();
  }

  // Take the first artist name.
  function firstArtist(s) {
    if (!s) return '';
    let r = String(s).replace(/\s*-\s*Topic\s*$/i, '');
    r = r.split(/\s*(?:,|，|、|&|\/|\s+x\s+|\s+feat\.?\s+|\s+ft\.?\s+)\s*/i)[0];
    return r.trim();
  }

  // Pick, from the LRCLIB search results, the entry that has synced lyrics and the closest duration.
  function pickBest(list, duration) {
    if (!Array.isArray(list)) return null;
    const cands = list.filter(function (x) {
      return x && typeof x.syncedLyrics === 'string' && x.syncedLyrics.trim().length > 0;
    });
    if (!cands.length) return null;
    if (!Number.isFinite(duration) || duration <= 0) return cands[0];
    let best = null;
    let bestDiff = Infinity;
    for (const c of cands) {
      const d = Number(c.duration);
      const diff = Number.isFinite(d) ? Math.abs(d - duration) : Infinity;
      if (diff < bestDiff) {
        best = c;
        bestDiff = diff;
      }
    }
    // A large duration difference is basically a different version; better to show nothing than misaligned lyrics
    return bestDiff <= 8 ? best : null;
  }

  // Lyrics lookup flow. fetchJson(path, params) returns JSON on success, null on 404, and throws on other errors.
  async function lookup(fetchJson, q) {
    const title = cleanTitle(q.title);
    const artist = firstArtist(q.artist);
    const duration = Number(q.duration);

    // 1. Exact match (requires album and duration)
    if (q.title && q.artist && q.album && Number.isFinite(duration) && duration > 0) {
      try {
        const r = await fetchJson('/api/get', {
          track_name: q.title,
          artist_name: q.artist,
          album_name: q.album,
          duration: Math.round(duration),
        });
        if (r && typeof r.syncedLyrics === 'string' && r.syncedLyrics.trim()) {
          return { item: r, how: 'get' };
        }
        if (r && r.instrumental) return { instrumental: true, how: 'get' };
      } catch (e) {
        /* continue with search */
      }
    }

    // 2. Search, trying several spellings in turn
    const attempts = [];
    if (title && artist) attempts.push({ track_name: title, artist_name: artist });
    if (title && artist) attempts.push({ q: title + ' ' + artist });
    if (title) attempts.push({ track_name: title });
    for (const params of attempts) {
      const list = await fetchJson('/api/search', params);
      const best = pickBest(list, duration);
      if (best) return { item: best, how: 'search' };
    }
    return null;
  }

  const api = { parseLrc, findIndex, cleanTitle, firstArtist, pickBest, lookup };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LrcUtil = api;
})(typeof self !== 'undefined' ? self : this);
