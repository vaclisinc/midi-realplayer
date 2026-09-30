# Changelog

## 0.1.1

- Repaint the Tracks and Roll canvas when the theme changes, whether through the
  `theme` attribute or the visitor's system setting; it used to keep the old colors
  until the next redraw.
- Add `redraw()` to the player returned by `mount()`.

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
