# Changelog

## Unreleased

### Fixed: lyrics missing or stuck after a track auto-advances
YouTube Music plays consecutive tracks gaplessly inside one media stream. After an auto-advance,
`video.currentTime` keeps counting from the previous track and the reported duration keeps changing.
Lyrics were looked up and timed against the wrong values, so they only appeared when a song was
clicked manually.
- A track is identified by title + artist (not duration), so a changing length no longer reloads the lyrics
- The start of each song on the player clock is remembered and subtracted from the playback position
- The true song length is read from the player bar ("0:12 / 3:25")
- The media element that is actually playing is followed
- When the browser tab and the installed app window are both open, only the one that is playing drives the desktop overlay
- A lookup that finds nothing is retried (2 s / 5 s / 12 s); "not found" is cached only briefly

### Lyric matching
- Scored LRCLIB result picker: the title must match; artist and duration add points
- Mixed-script titles (Korean + English) are split and searched per part
- Title alias map (e.g. 프린스핑송 → Princeping Song) and an artist + duration fallback for Korean-only titles
- Retry on 429 / 5xx from LRCLIB
- New `tools/check-matching.html` to check a list of YouTube Music titles against LRCLIB

### Resting screen
- "No synced lyrics found" is replaced by a sleeping cat (purring, floating "zzz"), in the overlay and in the in-page subtitles

### Overlay
- Drag the window from anywhere (the move button is gone); a small black-and-white cat paw follows the pointer
- Control bar hides faster and is more transparent; speed readout is a small 12 px label; small/large "A" buttons differ in size
- Text is centred correctly with the Star Hop frame; each frame remembers its own background colour
- Colour popup: Hue / Light / Opacity no longer reset each other
- Star Hop: mascot sits on the golden-ratio line, wings 20 % smaller
- Resize handle is a small three-dot grip
