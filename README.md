# midi-realplayer

[![npm](https://img.shields.io/npm/v/midi-realplayer)](https://www.npmjs.com/package/midi-realplayer)
[![jsDelivr](https://data.jsdelivr.com/v1/package/npm/midi-realplayer/badge)](https://www.jsdelivr.com/package/npm/midi-realplayer)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Designed for music researchers building demo pages and listening tests.
Present single-track or multi-track MIDI, or play audio and MIDI together in
sync. Let listeners explore individual parts and listen to MIDI alongside
recordings, right in the browser.

**[Try the live demo](https://vaclisinc.github.io/midi-realplayer-web/)**

![Track view showing audio waveforms alongside MIDI notes, with mute, solo and volume controls](docs/screenshot.png)

Add these two lines to your page:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/midi-realplayer@0.1.1"></script>

<midi-realplayer src="song.mid"></midi-realplayer>
```

No build step is needed. The player includes a default set of instrument sounds,
so you do not need to supply a SoundFont to get started.

## What you can do

- **Explore the notes.** Use Tracks for an overview of each part, or Roll to see
  notes on a piano keyboard. Track heights adjust to fit the available space.
- **Listen to individual parts.** Mute or solo tracks, adjust their volume, and
  choose a different instrument for each MIDI track.
- **Compare MIDI with a recording.** Add a full mix or separate instrument
  recordings (stems). Their waveforms appear above the MIDI, and playback stays
  synchronized when you pause or seek.
- **Save what you hear.** Export the current mix as a WAV file, including audio
  tracks and your mute, solo and volume settings.
- **Use several examples on one page.** Starting a player pauses the others.
  All players share the same instrument sound download.

Playback uses [SpessaSynth](https://github.com/spessasus/SpessaSynth) and preserves
MIDI tempo changes, note velocities, instrument changes, drums and sustain pedal.
The player supports light and dark themes and keeps its styles separate from
those of your page.

## Usage

### From a CDN

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/midi-realplayer@0.1.1"></script>
```

The examples use a fixed version so future updates do not change your page.
If you prefer a classic script tag, use this version; it exposes a
`MidiRealPlayer` global:

```html
<script src="https://cdn.jsdelivr.net/npm/midi-realplayer@0.1.1/dist/midi-realplayer.iife.js"></script>
```

### From npm

```sh
npm install midi-realplayer
```

```js
import "midi-realplayer"; // registers <midi-realplayer>
```

The package has no runtime dependencies. With a bundler (Vite, webpack,
esbuild), the player loads its worklet, SoundFont, artwork and font from the
same version on jsDelivr. To serve them yourself, see
[Self-hosting](#self-hosting).

### Audio tracks

```html
<midi-realplayer src="song.mid">
  <midi-realplayer-audio src="mix.mp3" label="Mixture"></midi-realplayer-audio>
  <midi-realplayer-audio src="vocals.mp3" label="Vocals stem"></midi-realplayer-audio>
  <midi-realplayer-audio src="bass.mp3" label="Bass stem" offset="0.25"></midi-realplayer-audio>
</midi-realplayer>
```

`offset="0.25"` starts the recording 0.25 seconds after the MIDI begins.
A negative offset skips that many seconds at the start of the recording.
A single recording can also go in the `audio` attribute of `<midi-realplayer>` (with `audio-label`
and `audio-offset`).

Audio tracks are loaded into memory before playback. A 30-second stereo clip
uses about 10 MB, so short excerpts work best when a page has many players.

## Attributes

| attribute | effect |
|---|---|
| `src` | MIDI file URL (required) |
| `view-mode` | `arrangement` (Tracks, default) or `piano-roll` |
| `theme` | `light` or `dark`; follows the system setting when omitted |
| `soundfont` | SF2, SF3 or DLS URL; defaults to GeneralUser GS |
| `file-name` | name shown in messages and used for the exported WAV |
| `persist-key` | remember mute, solo, volume and view per visitor in `localStorage` |
| `preload` | download the SoundFont at once instead of on first play |
| `asset-base` | folder holding the player's assets; see [Self-hosting](#self-hosting) |
| `audio`, `audio-label`, `audio-offset` | one recording without a child element |
| `no-export` | hide the Export WAV button |
| `soundfont-menu` | show a SoundFont menu so visitors can load their own bank |
| `no-exclusive` | keep playing when another player on the page starts |

The player adjusts its height to the number of tracks, between 14 and 44 rem.
In Tracks view, rows shrink to fit, down to 52 px; if they still cannot fit,
you can scroll. Moving the row-height slider keeps your chosen height.
To set the overall player height yourself, use CSS:

```css
midi-realplayer { height: 24rem; }
```

## JavaScript

```js
const player = document.querySelector("midi-realplayer");

player.addEventListener("play", () => console.log("playing"));
player.addEventListener("pause", () => console.log("paused at", player.currentTime));

await player.play();
player.seek(12.5); // seconds
player.pause();
player.stop();
player.duration; // seconds
```

To render into an element you already have, or to pass bytes instead of URLs,
use `mount()`:

```js
import { mount } from "midi-realplayer";

const player = mount(document.querySelector("#slot"), {
  src: midiArrayBuffer, // URL or ArrayBuffer
  soundFont: sf2ArrayBuffer, // URL or ArrayBuffer, optional
  fileName: "take-3.mid",
  audioTracks: [{ url: "vocals.mp3", label: "Vocals" }],
  viewMode: "piano-roll"
});

player.destroy();
```

TypeScript types are included, and `document.querySelector("midi-realplayer")`
is typed as the player element.

## SoundFonts and assets

A SoundFont supplies the instrument sounds used to play MIDI. The default is
[GeneralUser GS](https://schristiancollins.com/generaluser.php) by S. Christian Collins, compressed to SF3 (8.4 MB). It downloads on the
first play and is shared by every player on the page. Use `soundfont` to pick
another bank, and add `soundfont-menu` if visitors should be able to load their
own. Each track's instrument menu works with whichever bank is loaded.

### Self-hosting

To serve everything from your own site (for offline use or a strict content
security policy), copy `node_modules/midi-realplayer/dist/` to your server
and load the script from there:

```html
<script type="module" src="/static/midi-realplayer/midi-realplayer.js"></script>
```

A script loaded from its own `dist/` folder finds the assets next to itself.
When the script is bundled into your app instead, point the player at the
copied folder with the `asset-base` attribute, or once for the whole page:

```js
import { setDefaultAssetBase } from "midi-realplayer";
setDefaultAssetBase("/static/midi-realplayer/");
```

## Rendering audio files

Listening tests usually need audio that sounds the same for every listener.
The repository includes a renderer that uses the same synthesizer as the
player:

```sh
git clone https://github.com/vaclisinc/midi-realplayer-web.git
cd midi-realplayer-web && npm install
node scripts/render.mjs path/to/bank.sf2 out/ song1.mid song2.mid --seconds 20
```

## Browser support

Current Chrome, Edge, Firefox and Safari. Playback uses the Web Audio
AudioWorklet. Browsers start audio only after a click or key press, so
playback starts from the player's controls or from your own button.

## Development

```sh
npm install
npm test          # unit tests
npm run typecheck
npm run build     # writes dist/
npx http-server . # then open /demo/
```

`npm run make-sf3 -- in.sf2 out.sf3` recompresses a SoundFont; it needs
`ffmpeg` with libvorbis.

The player started as the webview of the
[MIDI RealPlayer VS Code extension](https://github.com/vaclisinc/midi-realplayer-vscode).

## License

MIT. SpessaSynth is Apache-2.0. GeneralUser GS and JetBrains Mono (OFL)
ship with their license files in `dist/`. The demo's music excerpt is
CC BY-NC-SA 2.5; see the demo page for credits.
