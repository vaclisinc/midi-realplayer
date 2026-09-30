// Convert an SF2 bank to SF3 (Ogg Vorbis samples) so the default SoundFont stays
// small enough for npm CDNs. Requires ffmpeg with libvorbis on PATH.
//   node scripts/make-sf3.mjs <in.sf2> <out.sf3> [vorbis quality 0-10, default 5]
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SoundBankLoader } from "spessasynth_core";

const run = promisify(execFile);
const [input, output, quality = "5"] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node scripts/make-sf3.mjs <in.sf2> <out.sf3> [quality]");
  process.exit(2);
}

const work = await mkdtemp(join(tmpdir(), "make-sf3-"));
let count = 0;
async function encodeVorbis(audioData, sampleRate) {
  const id = count++;
  const raw = join(work, `${id}.f32`);
  const ogg = join(work, `${id}.ogg`);
  await writeFile(raw, Buffer.from(audioData.buffer, audioData.byteOffset, audioData.byteLength));
  await run("ffmpeg", [
    "-v", "error", "-f", "f32le", "-ar", String(sampleRate), "-ac", "1", "-i", raw,
    "-c:a", "libvorbis", "-q:a", quality, "-y", ogg
  ]);
  const bytes = new Uint8Array(await readFile(ogg));
  await Promise.all([rm(raw), rm(ogg)]);
  return bytes;
}

try {
  const source = await readFile(input);
  const bank = SoundBankLoader.fromArrayBuffer(
    source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
  );
  await bank.setSampleFormat({ format: "compressed", compressionFunction: encodeVorbis });
  const sf3 = bank.writeSF2({ software: "midi-realplayer make-sf3" });
  await writeFile(output, new Uint8Array(sf3));
  console.log(`${count} samples, ${(source.byteLength / 1e6).toFixed(1)} MB -> ${(sf3.byteLength / 1e6).toFixed(1)} MB`);
} finally {
  await rm(work, { recursive: true, force: true });
}
