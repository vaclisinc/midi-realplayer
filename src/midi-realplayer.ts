import playerStyles from "./player.css";
import {
  createMidiRealPlayer,
  type AudioExportWriter,
  type AudioTrackSource,
  type MidiRealPlayer,
  type SoundFontSource
} from "./player";

export type { AudioTrackSource, MidiRealPlayer, SoundFontSource } from "./player";

export type MountOptions = {
  /** MIDI file URL or bytes. */
  src: string | ArrayBuffer;
  /** Shown in messages and used for the WAV export name. */
  fileName?: string;
  /**
   * SF2/SF3/DLS as a URL or as bytes. Defaults to the bundled GeneralUser GS (SF3)
   * next to the script. Pass bytes where the host cannot serve SoundFont files.
   */
  soundFont?: string | ArrayBuffer;
  soundFontLabel?: string;
  /** Folder holding the worklet, SoundFont, sprite and font. Defaults to the script's folder. */
  assetBase?: string;
  /** "auto" follows prefers-color-scheme. */
  theme?: "auto" | "dark" | "light";
  /** Pause other players on the page when this one starts. Default true. */
  exclusive?: boolean;
  /** Fetch the SoundFont at mount instead of on first play. Default false. */
  preloadSoundFont?: boolean;
  /** localStorage key for remembering mute/solo/volume/view state. Off by default. */
  persistKey?: string;
  /** Show the Export WAV button (downloads a file). Default true. */
  wavExport?: boolean;
  /** Show the SoundFont menu so visitors can load their own bank. Default false. */
  soundFontMenu?: boolean;
  /** Initial view: "arrangement" (tracks, the default) or "piano-roll". */
  viewMode?: "piano-roll" | "arrangement";
  /** Recordings (mix, stems) that play in step with the MIDI as extra mixer rows. */
  audioTracks?: readonly AudioTrackSource[];
};

const webStyles = `
:host {
  display: block;
  width: auto;
  /* Fits the track list unless the page sets a height; see fitHeightToTracks. */
  height: var(--midi-realplayer-fit-height, 32rem);
  --light-surface-base: oklch(99% 0.002 255);
  --light-surface-raised: oklch(96.4% 0.004 255);
  --light-surface-control: oklch(100% 0 0);
  --light-border: oklch(85% 0.006 255);
  --light-text: oklch(24% 0.01 255);
  --light-text-muted: oklch(47% 0.01 255);
  --light-playhead: oklch(32% 0.03 255);
}
:host([hidden]) { display: none; }
:host([theme="light"]) {
  color-scheme: light;
  --brand-blue: oklch(43% 0.122 252);
  --brand-gold: oklch(76% 0.142 82);
  --surface-base: var(--light-surface-base);
  --surface-raised: var(--light-surface-raised);
  --surface-control: var(--light-surface-control);
  --border: var(--light-border);
  --text: var(--light-text);
  --text-muted: var(--light-text-muted);
  --playhead: var(--light-playhead);
}
:host([theme="dark"]) { color-scheme: dark; }
@media (prefers-color-scheme: light) {
  :host(:not([theme="dark"])) {
    color-scheme: light;
    --brand-blue: oklch(43% 0.122 252);
    --brand-gold: oklch(76% 0.142 82);
    --surface-base: var(--light-surface-base);
    --surface-raised: var(--light-surface-raised);
    --surface-control: var(--light-surface-control);
    --border: var(--light-border);
    --text: var(--light-text);
    --text-muted: var(--light-text-muted);
    --playhead: var(--light-playhead);
  }
}
`;

let defaultAssetBase = "";
const players = new Set<MidiRealPlayer>();
const soundBanks = new Map<string, Promise<ArrayBuffer>>();
const soundBankUsers = new Map<string, number>();

function retainSoundBank(url: string): void {
  soundBankUsers.set(url, (soundBankUsers.get(url) ?? 0) + 1);
}

function releaseSoundBank(url: string): void {
  const users = (soundBankUsers.get(url) ?? 1) - 1;
  if (users > 0) {
    soundBankUsers.set(url, users);
  } else {
    soundBankUsers.delete(url);
    soundBanks.delete(url);
  }
}

export function setDefaultAssetBase(base: string): void {
  defaultAssetBase = base;
}

/** Render a player into target's shadow root. Call destroy() on the result to remove it. */
export function mount(target: HTMLElement, options: MountOptions): MidiRealPlayer {
  const assetBase = ensureTrailingSlash(options.assetBase ?? defaultAssetBase);
  const asset = (name: string) => new URL(name, assetBase || document.baseURI).href;
  const defaultSoundFont: SoundFontSource = {
    url:
      options.soundFont instanceof ArrayBuffer
        ? registerSoundBank(options.soundFont)
        : (options.soundFont ?? asset("GeneralUser-GS.sf3")),
    label:
      options.soundFontLabel ??
      (typeof options.soundFont === "string"
        ? fileNameOf(options.soundFont)
        : options.soundFont
          ? "SoundFont"
          : "GeneralUser GS"),
    custom: false
  };
  retainSoundBank(defaultSoundFont.url);
  const fileName =
    options.fileName ??
    (typeof options.src === "string" ? fileNameOf(options.src) : "sequence.mid");

  ensureFontFace(asset("JetBrainsMono-Variable.ttf"));
  if (options.theme && options.theme !== "auto") {
    target.setAttribute("theme", options.theme);
  }
  target.style.setProperty(
    "--instrument-sprite",
    `url("${asset("gm-instrument-families.png")}")`
  );

  const shadow = target.shadowRoot ?? target.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${playerStyles}${webStyles}</style>
    <div id="app" aria-busy="true">
      <section class="loading-screen" role="status">
        <div class="loading-mark" aria-hidden="true"></div>
        <div>
          <strong>Reading MIDI structure</strong>
          <span>This should only take a moment.</span>
        </div>
      </section>
    </div>
    <input id="soundfont-file" type="file" accept=".sf2,.sf3,.dls" hidden>
  `;
  const app = shadow.querySelector<HTMLDivElement>("#app")!;
  const fileInput = shadow.querySelector<HTMLInputElement>("#soundfont-file")!;
  let customSoundFontUrl: string | undefined;

  const player: MidiRealPlayer = createMidiRealPlayer({
    app,
    keyboardTarget: target,
    pointerTarget: document,
    midi: options.src,
    fileName,
    workletUrl: asset("spessasynth_processor.min.js"),
    soundFont: defaultSoundFont,
    preloadSoundFont: options.preloadSoundFont ?? false,
    viewerState: options.viewMode ? { viewMode: options.viewMode } : undefined,
    defaultViewMode: "arrangement",
    audioTracks: options.audioTracks?.map((track) => ({
      ...track,
      url: new URL(track.url, document.baseURI).href
    })),
    host: {
      loadState: () => readStorage(options.persistKey),
      saveState: (state) => writeStorage(options.persistKey, state),
      requestSoundFont:
        options.soundFontMenu !== true
          ? undefined
          : (kind) => {
              if (kind === "default") {
                player.setSoundFont(defaultSoundFont);
              } else {
                fileInput.click();
              }
            },
      beginAudioExport:
        options.wavExport === false ? undefined : beginDownload,
      fetchSoundBank,
      onPlaybackChange: (playing) => {
        if (playing && options.exclusive !== false) {
          for (const other of players) {
            if (other !== player && other.playing) {
              other.pause();
            }
          }
        }
        target.dispatchEvent(
          new CustomEvent(playing ? "play" : "pause", { bubbles: true, composed: true })
        );
      }
    }
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) {
      return;
    }
    if (customSoundFontUrl) {
      releaseSoundBank(customSoundFontUrl);
      URL.revokeObjectURL(customSoundFontUrl);
    }
    customSoundFontUrl = URL.createObjectURL(file);
    retainSoundBank(customSoundFontUrl);
    player.setSoundFont({ url: customSoundFontUrl, label: file.name, custom: true });
  });

  void player.ready.then(() => fitHeightToTracks(target, player.trackCount));
  players.add(player);
  // The canvas is painted from CSS colors, so repaint it whenever the theme can change:
  // the host's `theme` attribute or the visitor's system setting.
  const themeObserver = new MutationObserver(() => player.redraw());
  themeObserver.observe(target, { attributes: true, attributeFilter: ["theme"] });
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");
  const onSystemThemeChange = () => player.redraw();
  systemTheme.addEventListener("change", onSystemThemeChange);

  let disposed = false;
  const destroy = player.destroy;
  player.destroy = () => {
    if (disposed) return;
    disposed = true;
    releaseSoundBank(defaultSoundFont.url);
    themeObserver.disconnect();
    systemTheme.removeEventListener("change", onSystemThemeChange);
    players.delete(player);
    destroy();
    if (customSoundFontUrl) {
      releaseSoundBank(customSoundFontUrl);
      URL.revokeObjectURL(customSoundFontUrl);
    }
    shadow.innerHTML = "";
  };
  return player;
}

/** Header, one 88 px lane per track and the transport, within 14 to 44 rem. */
function fitHeightToTracks(target: HTMLElement, trackCount: number): void {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const content = 48 + Math.max(1, trackCount) * 88 + 56;
  const height = Math.min(44 * rem, Math.max(14 * rem, content));
  target.style.setProperty("--midi-realplayer-fit-height", `${height}px`);
}

async function beginDownload(suggestedName: string): Promise<AudioExportWriter> {
  const chunks: Uint8Array[] = [];
  const name = `${suggestedName}.wav`;
  return {
    write: async (chunk) => {
      chunks.push(chunk.slice());
    },
    finish: async () => {
      const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: "audio/wav" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return name;
    },
    abort: () => {
      chunks.length = 0;
    }
  };
}

let registeredBanks = 0;

/** Make in-memory SoundFont bytes addressable like a URL for the shared bank cache. */
function registerSoundBank(bytes: ArrayBuffer): string {
  const key = `memory:soundfont-${++registeredBanks}`;
  soundBanks.set(key, Promise.resolve(bytes.slice(0)));
  return key;
}

async function fetchSoundBank(url: string): Promise<ArrayBuffer> {
  let pending = soundBanks.get(url);
  if (!pending) {
    pending = fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(`The SoundFont could not be downloaded (HTTP ${response.status}).`);
      }
      return response.arrayBuffer();
    });
    soundBanks.set(url, pending);
    pending.catch(() => {
      if (soundBanks.get(url) === pending) soundBanks.delete(url);
    });
  }
  // The synthesizer takes ownership of the buffer it receives, so hand out copies.
  return (await pending).slice(0);
}

let fontInjected = false;
function ensureFontFace(url: string): void {
  if (fontInjected) {
    return;
  }
  fontInjected = true;
  const style = document.createElement("style");
  style.textContent = `@font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 400 800; font-display: swap; src: url("${url}") format("truetype"); }`;
  document.head.append(style);
}

function readStorage(key: string | undefined): unknown {
  if (!key) {
    return undefined;
  }
  try {
    const value = localStorage.getItem(`midi-realplayer:${key}`);
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}

function writeStorage(key: string | undefined, state: unknown): void {
  if (!key) {
    return;
  }
  try {
    localStorage.setItem(`midi-realplayer:${key}`, JSON.stringify(state));
  } catch {
    // Storage can be unavailable (private mode, sandboxed frames); state then lasts one visit.
  }
}

function ensureTrailingSlash(base: string): string {
  return !base || base.endsWith("/") ? base : `${base}/`;
}

function fileNameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url, document.baseURI).pathname.split("/").pop() || url);
  } catch {
    return url;
  }
}

const OBSERVED = [
  "src",
  "soundfont",
  "theme",
  "file-name",
  "persist-key",
  "view-mode",
  "preload",
  "no-export",
  "soundfont-menu",
  "no-exclusive",
  "asset-base"
] as const;

/**
 * <midi-realplayer src="song.mid" audio="song.mp3"></midi-realplayer>
 *
 * Stems go in child elements, each becoming a mixer row that plays in step with the MIDI:
 * <midi-realplayer src="song.mid">
 *   <midi-realplayer-audio src="vocals.mp3" label="Vocals"></midi-realplayer-audio>
 * </midi-realplayer>
 *
 * Emits bubbling "play" and "pause" events; exposes play(), pause(), stop(), seek(), currentTime.
 */
export class MidiRealPlayerElement extends HTMLElement {
  static observedAttributes = [...OBSERVED, "audio", "audio-label", "audio-offset"];
  #player: MidiRealPlayer | undefined;
  #scheduled = false;
  #childObserver: MutationObserver | undefined;
  /** False until the first mount, so upgrade-time attribute callbacks do not mount twice. */
  #initialized = false;

  get player(): MidiRealPlayer | undefined {
    return this.#player;
  }
  get currentTime(): number {
    return this.#player?.currentTime ?? 0;
  }
  set currentTime(seconds: number) {
    this.#player?.seek(seconds);
  }
  get duration(): number {
    return this.#player?.duration ?? 0;
  }
  get playing(): boolean {
    return this.#player?.playing ?? false;
  }
  play(): Promise<void> {
    return this.#player?.play() ?? Promise.resolve();
  }
  pause(): void {
    this.#player?.pause();
  }
  stop(): void {
    this.#player?.stop();
  }
  seek(seconds: number): void {
    this.#player?.seek(seconds);
  }

  connectedCallback(): void {
    this.#childObserver ??= new MutationObserver(() => {
      if (this.#initialized) {
        this.#scheduleRemount();
      }
    });
    this.#childObserver.observe(this, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "label", "offset", "before-midi-track"]
    });
    if (document.readyState === "loading") {
      // Children are not parsed yet when a classic script upgrades the element early.
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          this.#initialized = true;
          this.#scheduleRemount();
        },
        { once: true }
      );
      return;
    }
    this.#initialized = true;
    this.#remount();
  }
  disconnectedCallback(): void {
    this.#initialized = false;
    this.#childObserver?.disconnect();
    this.#player?.destroy();
    this.#player = undefined;
  }
  attributeChangedCallback(name: string, oldValue: string | null, value: string | null): void {
    if (oldValue === value || !this.isConnected) {
      return;
    }
    if (name === "theme" || !this.#initialized) {
      return;
    }
    this.#scheduleRemount();
  }

  #scheduleRemount(): void {
    if (!this.isConnected) {
      return;
    }
    // Batch several changes made in one task into a single remount.
    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        this.#remount();
      });
    }
  }

  #remount(): void {
    if (!this.isConnected) return;
    this.#player?.destroy();
    this.#player = undefined;
    const src = this.getAttribute("src");
    if (!src) {
      return;
    }
    const viewMode = this.getAttribute("view-mode");
    this.#player = mount(this, {
      src,
      fileName: this.getAttribute("file-name") ?? undefined,
      soundFont: this.getAttribute("soundfont") ?? undefined,
      persistKey: this.getAttribute("persist-key") ?? undefined,
      viewMode:
        viewMode === "arrangement" || viewMode === "piano-roll" ? viewMode : undefined,
      preloadSoundFont: this.hasAttribute("preload"),
      wavExport: !this.hasAttribute("no-export"),
      soundFontMenu: this.hasAttribute("soundfont-menu"),
      exclusive: !this.hasAttribute("no-exclusive"),
      assetBase: this.getAttribute("asset-base") ?? undefined,
      audioTracks: this.#audioTracks()
    });
  }

  #audioTracks(): AudioTrackSource[] {
    const tracks: AudioTrackSource[] = [];
    const mix = this.getAttribute("audio");
    if (mix) {
      tracks.push({
        url: mix,
        label: this.getAttribute("audio-label") ?? "Audio",
        offset: parseOffset(this.getAttribute("audio-offset"))
      });
    }
    for (const child of this.querySelectorAll("midi-realplayer-audio")) {
      const src = child.getAttribute("src");
      if (src) {
        tracks.push({
          url: src,
          label: child.getAttribute("label") ?? fileNameOf(src),
          offset: parseOffset(child.getAttribute("offset")),
          beforeMidiTrack: child.hasAttribute("before-midi-track")
            ? Number(child.getAttribute("before-midi-track")) : undefined
        });
      }
    }
    return tracks;
  }
}

function parseOffset(value: string | null): number {
  const seconds = Number(value);
  return value !== null && Number.isFinite(seconds) ? seconds : 0;
}

export function defineElement(tagName = "midi-realplayer"): void {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, class extends MidiRealPlayerElement {});
  }
}
