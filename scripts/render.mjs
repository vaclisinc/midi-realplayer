// Render MIDI files to WAV offline with the same SpessaSynth engine the player uses,
// so listening-test audio matches what the web player plays.
//   node scripts/render.mjs <soundfont> <out-dir> <file.mid>... [--seconds N] [--rate 44100]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  BasicMIDI,
  SoundBankLoader,
  SpessaSynthProcessor,
  SpessaSynthSequencer,
  audioToWav
} from "spessasynth_core";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const [, value] = args.splice(index, 2);
  return Number(value);
};
const seconds = option("--seconds", undefined);
const sampleRate = option("--rate", 44_100);
const [soundFontPath, outDir, ...midiPaths] = args;
if (!soundFontPath || !outDir || midiPaths.length === 0) {
  console.error("usage: node scripts/render.mjs <soundfont> <out-dir> <file.mid>... [--seconds N] [--rate 44100]");
  process.exit(2);
}

const toArrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const soundBankBytes = toArrayBuffer(await readFile(soundFontPath));
await mkdir(outDir, { recursive: true });

for (const midiPath of midiPaths) {
  const midi = BasicMIDI.fromArrayBuffer(toArrayBuffer(await readFile(midiPath)), basename(midiPath));
  const synth = new SpessaSynthProcessor(sampleRate, { eventsEnabled: false });
  synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(soundBankBytes.slice(0)), "main");
  await synth.processorInitialized;
  synth.setSystemParameter("autoAllocateVoices", true);
  const sequencer = new SpessaSynthSequencer(synth);
  // Keep leading silence: rendered audio must line up with the MIDI's own clock.
  sequencer.skipToFirstNoteOn = false;
  sequencer.loadNewSongList([midi]);
  sequencer.play();

  const total = Math.ceil(sampleRate * (seconds ?? midi.duration + 2));
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (let filled = 0; filled < total; ) {
    sequencer.processTick();
    const block = Math.min(128, total - filled);
    synth.process(left, right, filled, block);
    filled += block;
  }
  const out = join(outDir, basename(midiPath).replace(/\.midi?$/i, ".wav"));
  await writeFile(out, new Uint8Array(audioToWav([left, right], sampleRate)));
  synth.destroySynthProcessor();
  console.log(out);
}
