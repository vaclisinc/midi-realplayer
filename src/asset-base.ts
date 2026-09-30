export const PACKAGE_NAME = "midi-realplayer";

/**
 * Where the player finds its worklet, SoundFont, artwork and font.
 *
 * When the script is itself a file from `dist/` (a self-hosted copy, or a CDN
 * URL that names the file), the assets sit next to it. Anything else, such as
 * a bare CDN URL (`cdn.jsdelivr.net/npm/midi-realplayer`) or a bundler output
 * (`index-3f2a.js`, `node_modules/.vite/deps/...`), gets the same version's
 * `dist/` from jsDelivr.
 */
export function resolveAssetBase(scriptUrl: string | undefined, version: string): string {
  const cdn = `https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${version}/dist/`;
  if (!scriptUrl) {
    return cdn;
  }
  let url: URL;
  try {
    url = new URL(scriptUrl);
  } catch {
    return cdn;
  }
  const fileName = url.pathname.split("/").pop() ?? "";
  const isDistFile = /^midi-realplayer(\.iife)?\.js$/.test(fileName);
  const isBundlerCopy = /\/node_modules\/|\/\.vite\//.test(url.pathname);
  return isDistFile && !isBundlerCopy ? new URL("./", url).href : cdn;
}
