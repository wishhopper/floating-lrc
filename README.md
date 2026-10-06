# Floating lrc

Synced lyrics for **YouTube Music**, shown like subtitles floating on your desktop.
A transparent, always-on-top overlay that stays out of your way: clicks pass straight through to
the apps underneath, and the controls only appear when you hover.

Works with any language (English, Chinese, Korean, Japanese, ...). Lyrics come from the open
[LRCLIB](https://lrclib.net) database at play time and are never stored.

## Features
- Transparent, frameless, click-through overlay; drag it anywhere, resize it freely
- Remembers its position per display (multi-monitor friendly)
- Two modes: **Subtitle** (one line) and **Lines** (previous / current / next)
- Hover controls: move, mode, lyric timing offset (slower / faster, remembered per song), font size,
  text color, background color and opacity, frame style
- Two pixel-art frames with clouds in the background:
  - **Star Hop** – Hopstar, a little green winged star, hops along a dashed vine of charms under a pastel macaron rainbow
  - **Tokyo Neko** – a night skyline with Tokyo Tower, Skytree, a Ferris wheel and a passing tram,
    and a cat that walks, stands and sits (and sometimes licks a paw or washes its face)
- Menu bar icon, Dock icon, and a tiny launcher app
- Also includes a Picture-in-Picture lyrics window inside Chrome (no install needed besides the extension)

## Requirements
- macOS (Intel or Apple Silicon)
- Google Chrome 116 or newer
- Internet access during setup (to download Electron) and while playing (to fetch lyrics)

## Install (about 3 minutes)
1. Unzip the download anywhere you like (for example your Documents folder).
2. Double-click **Install.command**.
   - If macOS says it cannot verify the file: right-click it, choose **Open**, then **Open** again.
   - If it says you do not have permission to run it (this can happen with files downloaded from GitHub),
     open Terminal, type `chmod +x ` (with a trailing space), drag **Install.command** and
     **Start.command** into the window, press Return, then try again.
   - It installs what the overlay needs and creates **Floating lrc.app** next to it.
     If Node.js is missing it downloads a private copy; nothing is installed system-wide.
3. In Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**
   and select the **extension** folder.
4. Double-click **Floating lrc.app** (or **Start.command**). If macOS blocks it, right-click, **Open**.
5. Open https://music.youtube.com and play a song. Lyrics appear at the bottom of your screen.

Tip: drag *Floating lrc.app* to your Dock, or add it in *System Settings > General > Login Items*
to have it start with your Mac. If you move the folder later, run Install.command again.

## Using it
- Hover over the overlay to show the controls; hover the bottom-right corner to resize.
- Click the move button (or drag the grip) to reposition it.
- Menu bar icon: show/hide, change mode, change frame, quit.
- Shortcuts: **Cmd+Option+L** show/hide, **Cmd+Option+Q** quit.
- If lyrics feel early or late, use the slower / faster buttons (0.5 s per click).
- Settings are remembered between launches.

## Troubleshooting
- **"Permission denied" when opening a .command file**: run `chmod +x Install.command Start.command`
  in Terminal from inside the folder.
- **Nothing shows up**: make sure the overlay is running (menu bar icon), reload the extension on
  `chrome://extensions`, then reload the YouTube Music tab.
- **"No synced lyrics found"**: LRCLIB does not have that song yet. Try another version of the track.
- **Overlay does not appear over a full-screen app**: it should; if not, toggle it with Cmd+Option+L.
- **Port in use**: the overlay listens on 127.0.0.1:38917 (local only). Quit any other copy first.

## Supporting another website
The extension reads "what is playing" through a **site adapter**, so adding a player means adding one file.
1. Copy `extension/adapters/youtube-music.js` to `extension/adapters/<your-site>.js`.
2. Implement `matches(location)`, `getMedia()` (the page's `<audio>`/`<video>` element) and
   `readTrack()` (returns `{ title, artist, album, duration, video }`).
3. In `extension/manifest.json`, add the site to `content_scripts.matches` and your file to `js`
   (before `content.js`). Lyrics lookups need no other change.
4. Reload the extension and test. `node tests/test.js` shows how the YouTube Music adapter is tested.

Only websites are supported this way; desktop apps (Spotify app, Music.app) are not readable by a browser extension.

## Privacy
No accounts, no analytics. The extension only reads the current track's title, artist, duration and
playback position on music.youtube.com, asks lrclib.net for matching lyrics, and passes them to the
overlay over localhost.

## Project layout
```
extension/   Chrome extension (content script, background worker, LRC parser)
  adapters/  one small file per supported website (currently: YouTube Music)
app/         Electron overlay (main.js, overlay.html, assets/)
tests/       Logic tests: node tests/test.js
Install.command   one-time setup
Start.command     start the overlay
```

## License
MIT. See [LICENSE](LICENSE). Made by [wishhopper](https://github.com/wishhopper).

## Disclaimer
Floating lrc is an independent hobby project. It is not affiliated with, endorsed by, or sponsored by
YouTube, Google, or LRCLIB. "YouTube" and "YouTube Music" are trademarks of Google LLC.
Lyrics belong to their respective rights holders; this tool only fetches them for display at play time
and does not store or redistribute them.

## Credits
Lyrics: [LRCLIB](https://lrclib.net). Overlay built with [Electron](https://www.electronjs.org).
Hopstar, Tokyo Neko and the app icon are original artwork made for this project.
