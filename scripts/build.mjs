import { build, context } from "esbuild";
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const dist = resolve(root, "dist");
const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  loader: { ".css": "text" },
  define: { __MRP_VERSION__: JSON.stringify(version) }
};
const builds = [
  { ...shared, entryPoints: [resolve(root, "src/esm.ts")], outfile: resolve(dist, "midi-realplayer.js"), format: "esm" },
  {
    ...shared,
    entryPoints: [resolve(root, "src/iife.ts")],
    outfile: resolve(dist, "midi-realplayer.iife.js"),
    format: "iife",
    globalName: "MidiRealPlayer"
  }
];

// Everything the player loads at runtime sits next to the script.
const assets = [
  ["node_modules/spessasynth_lib/dist/spessasynth_processor.min.js", "spessasynth_processor.min.js"],
  ["assets/soundfonts/GeneralUser-GS.sf3", "GeneralUser-GS.sf3"],
  ["assets/soundfonts/GeneralUser-GS-LICENSE.txt", "GeneralUser-GS-LICENSE.txt"],
  ["assets/instruments/gm-families-modern.png", "gm-instrument-families.png"],
  ["assets/fonts/JetBrainsMono-Variable.ttf", "JetBrainsMono-Variable.ttf"],
  ["assets/fonts/JetBrainsMono-OFL.txt", "JetBrainsMono-OFL.txt"],
  ["LICENSE", "LICENSE"]
];
const copyAssets = () =>
  Promise.all(assets.map(([source, name]) => cp(resolve(root, source), resolve(dist, name))));

await mkdir(dist, { recursive: true });
if (watch) {
  const contexts = await Promise.all(builds.map((options) => context(options)));
  await Promise.all(contexts.map((item) => item.watch()));
  await copyAssets();
  console.log("Watching sources.");
} else {
  await Promise.all(builds.map((options) => build(options)));
  await copyAssets();
  console.log("Built dist/.");
}
