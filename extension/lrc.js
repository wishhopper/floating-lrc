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
    // A large duration difference is probably a different version (misaligned lyrics), but streaming
    // versions often differ from the database entry by a few seconds (intro / outro), so be lenient.
    return bestDiff <= 15 ? best : null;
  }


  // Normalise a title for comparison: lowercase, drop version/brackets noise and punctuation.
  function normTitle(s) {
    return cleanTitle(s || '')
      .toLowerCase()
      .replace(/[\(\[（【][^\)\]）】]*[\)\]）】]/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, '');
  }
  function normName(s) {
    return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  }

  // Score the candidates and pick the most plausible one. Uses title / artist / album equality and how close the
  // duration is. Entries with a clearly wrong duration (preview clips, other versions) are rejected.
  function pickBestScored(list, q) {
    if (!Array.isArray(list)) return null;
    q = q || {};
    const duration = Number(q.duration);
    const qTitle = normTitle(q.title);
    const qArtist = normName(firstArtist(q.artist));
    const qAlbum = normName(q.album);
    let best = null;
    let bestScore = -Infinity;
    for (const c of list) {
      if (!c || typeof c.syncedLyrics !== 'string' || !c.syncedLyrics.trim()) continue;
      let sc = 0;
      const t = normTitle(c.trackName);
      if (qTitle) {
        if (t === qTitle) sc += 4;
        else if (t && (t.indexOf(qTitle) >= 0 || qTitle.indexOf(t) >= 0)) sc += 1;
        else continue; // a different song: never accept
      }
      const a = normName(c.artistName);
      if (qArtist) {
        if (a === qArtist) sc += 3;
        else if (a && (a.indexOf(qArtist) >= 0 || qArtist.indexOf(a) >= 0)) sc += 2;
        else sc -= 3;
      }
      if (qAlbum && normName(c.albumName) === qAlbum) sc += 1;
      const d = Number(c.duration);
      if (Number.isFinite(duration) && duration > 0 && Number.isFinite(d) && d > 0) {
        const diff = Math.abs(d - duration);
        if (diff <= 2) sc += 5;
        else if (diff <= 5) sc += 3;
        else if (diff <= 10) sc += 1;
        else if (diff <= 20) sc -= 1;
        else if (d < 90 && diff > 20) sc -= 8; // a preview clip / junk duration
        else sc -= 3; // possibly another cut (e.g. music-video length): still OK if title and artist match exactly
      }
      if (sc > bestScore) {
        best = c;
        bestScore = sc;
      }
    }
    return bestScore >= 3 ? best : null;
  }

  // Titles that YouTube Music shows only in Korean, mapped to the title LRCLIB uses.
  // Key: normalised Korean title. Add more lines here as they turn up.
  const TITLE_ALIASES = {
    '프린스핑송': 'Princeping Song',
  };

  // Lyrics lookup flow. fetchJson(path, params) returns JSON on success, null on 404, and throws on other errors.
  async function lookup(fetchJson, q) {
    const alias = TITLE_ALIASES[normName(q.title)];
    if (alias) {
      const r = await lookup(fetchJson, Object.assign({}, q, { title: alias }));
      if (r) return r;
    }
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
    // Artist spelled without spaces / punctuation (e.g. "NCT WISH" vs "NCTWISH")
    const compact = artist.replace(/[\s.\-_]+/g, '');
    if (title && compact && compact !== artist) attempts.push({ q: title + ' ' + compact });
    // Whole artist string as given by the player (it may be a combined name)
    if (title && q.artist && q.artist !== artist) attempts.push({ q: title + ' ' + q.artist });
    // Titles that mix scripts (e.g. "고양이 릴스 Reel-ationship"): also search each script part on its own.
    const latin = title.replace(/[^\x00-\u024F]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    const other = title.replace(/[\x00-\u024F]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    for (const part of [latin, other]) {
      if (part && part !== title && part.length >= 2) {
        if (artist) attempts.push({ track_name: part, artist_name: artist });
        attempts.push({ q: part + (artist ? ' ' + artist : '') });
        attempts.push({ q: part });
      }
    }
    for (const params of attempts) {
      const list = await fetchJson('/api/search', params);
      const best = pickBestScored(list, q);
      if (best) return { item: best, how: 'search' };
    }
    // 3. Last resort (e.g. a title written only in Korean while LRCLIB has the English title):
    // search by artist and accept a single candidate whose artist matches and whose duration is almost identical.
    if (artist && Number.isFinite(duration) && duration > 0) {
      const qa = normName(artist);
      const found = new Map();
      const fallbacks = [{ q: artist }];
      if (q.album) fallbacks.push({ q: artist + ' ' + q.album });
      for (const params of fallbacks) {
        let list;
        try { list = await fetchJson('/api/search', params); } catch (e) { continue; }
        if (!Array.isArray(list)) continue;
        for (const c of list) {
          if (!c || typeof c.syncedLyrics !== 'string' || !c.syncedLyrics.trim()) continue;
          const a = normName(c.artistName);
          const d = Number(c.duration);
          if (a && (a === qa || a.indexOf(qa) >= 0 || qa.indexOf(a) >= 0) && Number.isFinite(d) && Math.abs(d - duration) <= 3) {
            found.set(c.id != null ? c.id : c.trackName + '|' + d, c);
          }
        }
      }
      if (found.size === 1) return { item: Array.from(found.values())[0], how: 'artist+duration' };
    }
    return null;
  }

  const api = { parseLrc, findIndex, cleanTitle, firstArtist, pickBest, pickBestScored, lookup };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LrcUtil = api;
})(typeof self !== 'undefined' ? self : this);
