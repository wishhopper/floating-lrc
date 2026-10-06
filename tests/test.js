// Local logic tests (node test.js). All data is synthetic; no real lyrics.
const assert = require('assert');
const U = require('../extension/lrc.js');

let passed = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(() => { passed++; console.log('ok  ', name); });
    passed++;
    console.log('ok  ', name);
  } catch (e) {
    console.error('FAIL', name, '\n    ', e.message);
    process.exitCode = 1;
  }
}

(async function () {
  // ---- parseLrc ----
  t('parseLrc: basic parsing and sorting', () => {
    const lines = U.parseLrc('[ar:Someone]\n[00:12.50]second\n[00:01.00]first\n[01:02.345]third');
    assert.deepStrictEqual(lines.map((l) => l.text), ['first', 'second', 'third']);
    assert.strictEqual(lines[0].t, 1);
    assert.strictEqual(lines[1].t, 12.5);
    assert.ok(Math.abs(lines[2].t - 62.345) < 1e-9);
  });
  t('parseLrc: multiple timestamps on one line', () => {
    const lines = U.parseLrc('[00:05.00][00:30.00]repeat');
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[1].t, 30);
    assert.strictEqual(lines[1].text, 'repeat');
  });
  t('parseLrc: blank lines kept as interludes, metadata ignored, CRLF handled', () => {
    const lines = U.parseLrc('[ti:x]\r\n[00:01.00]a\r\n[00:03.00]\r\n[00:05.00]b');
    assert.deepStrictEqual(lines.map((l) => l.text), ['a', '', 'b']);
  });
  t('parseLrc: non-string / empty input', () => {
    assert.deepStrictEqual(U.parseLrc(null), []);
    assert.deepStrictEqual(U.parseLrc(''), []);
  });

  // ---- findIndex ----
  const L = U.parseLrc('[00:10.00]a\n[00:20.00]b\n[00:30.00]c');
  t('findIndex: returns -1 before the first line', () => assert.strictEqual(U.findIndex(L, 5), -1));
  t('findIndex: exactly on a timestamp', () => assert.strictEqual(U.findIndex(L, 20), 1));
  t('findIndex: between two lines', () => assert.strictEqual(U.findIndex(L, 29.99), 1));
  t('findIndex: after the last line', () => assert.strictEqual(U.findIndex(L, 999), 2));
  t('findIndex: empty array', () => assert.strictEqual(U.findIndex([], 3), -1));

  // ---- cleanTitle / firstArtist ----
  t('cleanTitle: strips noise brackets', () => {
    assert.strictEqual(U.cleanTitle('Song Name (Official Audio)'), 'Song Name');
    assert.strictEqual(U.cleanTitle('Song Name [Lyric Video]'), 'Song Name');
    assert.strictEqual(U.cleanTitle('Song Name (feat. Someone)'), 'Song Name');
    assert.strictEqual(U.cleanTitle('Song Name (Live)'), 'Song Name');
  });
  t('cleanTitle: keeps meaningful brackets', () => {
    assert.strictEqual(U.cleanTitle('Song Name (Part 2)'), 'Song Name (Part 2)');
    assert.strictEqual(U.cleanTitle('\u6b4c\u540d\uff08\u5e8f\u7ae0\uff09'), '\u6b4c\u540d\uff08\u5e8f\u7ae0\uff09');
  });
  t('cleanTitle: strips - Topic, empty input', () => {
    assert.strictEqual(U.cleanTitle('Song - Topic'), 'Song');
    assert.strictEqual(U.cleanTitle(''), '');
    assert.strictEqual(U.cleanTitle(null), '');
  });
  t('firstArtist: takes the first of multiple artists', () => {
    assert.strictEqual(U.firstArtist('Artist A & Artist B'), 'Artist A');
    assert.strictEqual(U.firstArtist('Artist A, Artist B'), 'Artist A');
    assert.strictEqual(U.firstArtist('Artist A feat. Artist B'), 'Artist A');
    assert.strictEqual(U.firstArtist('Artist A - Topic'), 'Artist A');
    assert.strictEqual(U.firstArtist('\u5468\u6770\u4f26'), '\u5468\u6770\u4f26');
  });

  // ---- pickBest ----
  const mk = (d, synced) => ({ duration: d, syncedLyrics: synced === undefined ? '[00:01.00]x' : synced });
  t('pickBest: picks the closest duration with synced lyrics', () => {
    const best = U.pickBest([mk(190), mk(186), mk(221), mk(185, null)], 187);
    assert.strictEqual(best.duration, 186);
  });
  t('pickBest: returns null when the duration gap is too large', () => {
    assert.strictEqual(U.pickBest([mk(221)], 186), null);
  });
  t('pickBest: with no duration info, takes the first one with synced lyrics', () => {
    assert.strictEqual(U.pickBest([mk(1, null), mk(2), mk(3)], NaN).duration, 2);
  });
  t('pickBest: non-array / no synced lyrics at all', () => {
    assert.strictEqual(U.pickBest(null, 100), null);
    assert.strictEqual(U.pickBest([mk(100, null), mk(100, '  ')], 100), null);
  });

  // ---- lookup (using a mocked fetchJson)----
  await t('lookup: exact match hit', async () => {
    const calls = [];
    const f = async (path, p) => {
      calls.push(path);
      return path === '/api/get' ? { syncedLyrics: '[00:01.00]x', duration: 180 } : null;
    };
    const r = await U.lookup(f, { title: 'T', artist: 'A', album: 'B', duration: 180 });
    assert.strictEqual(r.how, 'get');
    assert.deepStrictEqual(calls, ['/api/get']);
  });
  await t('lookup: exact miss -> hit via search after cleaning', async () => {
    const seen = [];
    const f = async (path, p) => {
      seen.push([path, p.track_name || p.q]);
      if (path === '/api/get') return null;
      if (p.track_name === 'Song' && p.artist_name === 'Artist A') return [{ duration: 200, syncedLyrics: '[00:01.00]x' }];
      return [];
    };
    const r = await U.lookup(f, { title: 'Song (Official Audio)', artist: 'Artist A & B', album: 'Alb', duration: 201 });
    assert.strictEqual(r.how, 'search');
    assert.strictEqual(seen[1][1], 'Song');
  });
  await t('lookup: search continues even if exact match throws', async () => {
    const f = async (path) => {
      if (path === '/api/get') throw new Error('boom');
      return [{ duration: 100, syncedLyrics: '[00:01.00]x' }];
    };
    const r = await U.lookup(f, { title: 'T', artist: 'A', album: 'B', duration: 100 });
    assert.ok(r && r.item);
  });
  await t('lookup: instrumental marker', async () => {
    const f = async (path) => (path === '/api/get' ? { instrumental: true } : null);
    const r = await U.lookup(f, { title: 'T', artist: 'A', album: 'B', duration: 100 });
    assert.strictEqual(r.instrumental, true);
  });
  await t('lookup: returns null when everything misses', async () => {
    const f = async () => null;
    const r = await U.lookup(f, { title: 'T', artist: 'A', album: 'B', duration: 100 });
    assert.strictEqual(r, null);
  });
  await t('lookup: rethrows when the search API errors (left to the caller to display the error)', async () => {
    const f = async (path) => {
      if (path === '/api/get') return null;
      throw new Error('HTTP 500');
    };
    await assert.rejects(() => U.lookup(f, { title: 'T', artist: 'A', album: '', duration: 100 }), /HTTP 500/);
  });

  // ---- site adapter (youtube-music) ----
  const video = { duration: 215.4, currentTime: 12, playbackRate: 1, paused: false };
  const fakeDom = (opts) => {
    global.window = {};
    global.document = {
      querySelector: (sel) => {
        if (sel === 'video') return video;
        if (sel === 'ytmusic-player-bar .title') return opts.barTitle ? { textContent: ' ' + opts.barTitle + ' ' } : null;
        if (sel === 'ytmusic-player-bar .byline') return opts.byline ? { textContent: opts.byline } : null;
        return null;
      },
    };
    Object.defineProperty(global, 'navigator', { value: { mediaSession: opts.md ? { metadata: opts.md } : undefined }, configurable: true, writable: true });
    delete require.cache[require.resolve('../extension/adapters/youtube-music.js')];
    return require('../extension/adapters/youtube-music.js');
  };
  t('adapter: matches only music.youtube.com', () => {
    const a = fakeDom({});
    assert.strictEqual(a.matches({ hostname: 'music.youtube.com' }), true);
    assert.strictEqual(a.matches({ hostname: 'www.youtube.com' }), false);
    assert.ok(Array.isArray(global.window.LrcAdapters) && global.window.LrcAdapters.length === 1);
  });
  t('adapter: reads track from mediaSession metadata', () => {
    const a = fakeDom({ md: { title: 'Song', artist: 'Artist', album: 'Album' } });
    const r = a.readTrack();
    assert.deepStrictEqual([r.title, r.artist, r.album, r.duration], ['Song', 'Artist', 'Album', 215.4]);
    assert.strictEqual(r.video, video);
  });
  t('adapter: falls back to the player bar when mediaSession is empty', () => {
    const a = fakeDom({ barTitle: 'Bar Song', byline: 'Bar Artist \u2022 Bar Album \u2022 2020' });
    const r = a.readTrack();
    assert.deepStrictEqual([r.title, r.artist, r.album], ['Bar Song', 'Bar Artist', 'Bar Album']);
  });
  t('adapter: getMedia returns the page video element', () => {
    assert.strictEqual(fakeDom({}).getMedia(), video);
  });

  console.log('\n' + passed + ' passed' + (process.exitCode ? ', some failed' : ''));
})();
