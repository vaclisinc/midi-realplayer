# midi-realplayer

[![npm](https://img.shields.io/npm/v/midi-realplayer)](https://www.npmjs.com/package/midi-realplayer)
[![jsDelivr](https://data.jsdelivr.com/v1/package/npm/midi-realplayer/badge)](https://www.jsdelivr.com/package/npm/midi-realplayer)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Designed for music researchers building demo pages and listening tests.
Play MIDI and audio in your browser, just like in your DAW.

<p align="center">
  <a href="https://vaclisinc.github.io/midi-realplayer/">
    <img src="docs/player-modern-five-tracks.png" alt="Five-track MIDI player with modern instrument artwork, notes, and mute, solo and volume controls">
  </a><br>
  <sub>(Click the image to try the live demo.)</sub>
</p>

Add these two lines to your page:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/midi-realplayer@0.1.3"></script>

<midi-realplayer src="song.mid"></midi-realplayer>
```

No build step is needed. The player includes a default set of instrument sounds,
so you do not need to supply a SoundFont to get started.

## Features

- Track and piano-roll views.
- Mute, solo, volume and instrument controls for each MIDI track.
- Audio recordings and stems that stay in sync with MIDI.
- WAV export of the current mix.
- Light and dark themes.

## Usage

### From a CDN

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/midi-realplayer@0.1.3"></script>
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

`offset="0.25"` delays a recording by 0.25 seconds; a negative value skips its
beginning. Add `before-midi-track="1"` to place a recording above the first MIDI
track. Without it, recordings appear above all MIDI tracks.

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

Set the player height with CSS: `midi-realplayer { height: 24rem; }`.

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

The included [GeneralUser GS](https://schristiancollins.com/generaluser.php)
SoundFont downloads on first play (8.4 MB). Use `soundfont` to choose another bank.
Players share the download; starting one pauses the others by default.
For large collections, mount players as needed and remove them when finished.
Audio recordings are decoded into memory, so short excerpts work best.

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

The demo loads the published `midi-realplayer@0.1.3` package from jsDelivr,
including its SoundFont and worklet. It does not load the local `dist/` build.
To try local changes, change the demo's script URL to `../dist/midi-realplayer.js`.

## Publishing

GitHub releases tagged `v<version>` publish to npm. Update the package version,
lockfile and changelog first. The npm Trusted Publisher must point to
`vaclisinc/midi-realplayer`, workflow `publish.yml`, with no environment name.

## License

MIT. SpessaSynth is Apache-2.0. GeneralUser GS and JetBrains Mono (OFL)
ship with their license files in `dist/`. The demo's music excerpt is
CC BY-NC-SA 2.5; see the demo page for credits.
