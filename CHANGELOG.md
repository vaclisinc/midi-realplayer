# Changelog

## 0.1.3

- Retain the three most recently used idle audio engines without a timeout,
  releasing the oldest when another becomes idle. Active engines are kept.
  Recreate evicted engines on demand while preserving transport position and
  mixer settings.
- Stop animation loops while idle and release unused SoundFont cache entries on
  player destruction or custom bank replacement.
- Guard asynchronous engine initialization against destruction and superseded
  loads; pause and stop now cancel a pending play request.

- Add a 100-player demo stress test with live AudioContext counts and teardown controls.

## 0.1.2

- Refresh the MIDI instrument artwork with a modern studio illustration set.
- Place audio recordings next to their MIDI parts with `before-midi-track`
  (or `beforeMidiTrack` in `mount()`), using 1-based MIDI track numbers.
- The demo pairs each stem with its MIDI track and uses piano for the single-track example.

## 0.1.1

- Match Roll, Tracks and Fit typography, including weight and capitalization.
- Fit all arrangement tracks into the viewport by default, down to 52 px per
  track; scroll only when they cannot fit. Moving the height slider keeps the
  chosen height. Automatic player height can grow to 44 rem.

- Repaint the Tracks and Roll canvas when the theme changes, whether through the
  `theme` attribute or the visitor's system setting; it used to keep the old colors
  until the next redraw.
- Add `redraw()` to the player returned by `mount()`.
- Give audio tracks cover art: the recording's own waveform on a dark stage lit
  in the track's color, instead of a plain gradient.
- Narrow and phone-width players keep every control, including the per-track
  instrument menu, and shrink them instead of hiding them; the transport stays on
  one line, and every label, including the canvas's ruler and key labels, uses one
  type size. Instrument artwork fills each row instead of letterboxing.
- The SoundFont menu is off by default: the page's author picks the bank with
  `soundfont`. Add `soundfont-menu` (or `soundFontMenu: true` in `mount()`) to let
  visitors load their own. This replaces `no-custom-soundfont` / `customSoundFont`,
  which no longer have an effect.
- The track list and canvas stop at their ends instead of rubber-banding or
  scrolling the page.

## 0.1.0

First release as a standalone web package, split from the
[MIDI RealPlayer VS Code extension](https://github.com/vaclisinc/midi-realplayer-vscode).

- `<midi-realplayer>` custom element and `mount()` API with Tracks and Roll
  views, mute/solo/volume mixer, per-track SoundFont instruments, and WAV export.
- Audio tracks (`<midi-realplayer-audio>`) that play in step with the MIDI on
  the synthesizer's clock, with waveforms, and are mixed into WAV export.
- GeneralUser GS as a compressed SF3 default, loaded on first play and shared
  by every player on the page; SoundFonts may also be passed as bytes.
- Assets resolve next to a self-hosted `dist/` script, otherwise from the same
  version on jsDelivr; `asset-base` and `setDefaultAssetBase()` override this.
- Player height fits the track count; unnamed tracks take their instrument name.
- `scripts/render.mjs` renders MIDI files to WAV with the player's synthesizer.
