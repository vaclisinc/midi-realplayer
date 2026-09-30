import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { MIDIBuilder } from "spessasynth_core";

const run = promisify(execFile);

test("offline render keeps leading silence so audio lines up with the MIDI clock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-test-"));
  try {
    // One piano note starting 1.5 s in (120 bpm, 480 ticks per beat -> 1440 ticks).
    const midi = new MIDIBuilder({ format: 0, initialTempo: 120, timeDivision: 480 });
    midi.programChange(0, 0, 0, 0);
    midi.noteOn(1440, 0, 0, 60, 100);
    midi.noteOff(1920, 0, 0, 60);
    midi.flush(true);
    const midiPath = join(dir, "late.mid");
    await writeFile(midiPath, new Uint8Array(midi.writeMIDI()));

    await run(process.execPath, [
      "scripts/render.mjs", "assets/soundfonts/GeneralUser-GS.sf3", dir, midiPath, "--seconds", "3"
    ]);

    const wav = await readFile(join(dir, "late.wav"));
    // 16-bit stereo PCM after a 44-byte header: find the first clearly audible sample.
    const samples = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.byteLength - 44) >> 1);
    let peak = 0;
    for (const value of samples) peak = Math.max(peak, Math.abs(value));
    const first = samples.findIndex((value) => Math.abs(value) > peak * 0.05);
    const seconds = first / 2 / 44_100;
    assert.ok(Math.abs(seconds - 1.5) < 0.05, `first sound at ${seconds.toFixed(3)} s, expected 1.5 s`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
