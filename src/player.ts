import { idleAudioEngines } from "./idle-audio-engines";
import {
  Sequencer,
  WorkletSynthesizer,
  audioBufferToWav
} from "spessasynth_lib";
import { BasicMIDI } from "spessasynth_core";
import {
  getArrangementCanvasHeight,
  getArrangementNoteRect,
  getArrangementTrackOrder,
  getPianoRollCanvasHeight
} from "./arrangement-view";
import {
  parseCanonicalMidi,
  type CanonicalMidiDocument,
  type CanonicalTrack
} from "./canonical-midi";
import {
  getInstrumentFamilyClass,
  getInstrumentFamilyColor,
  getInstrumentThumbnailIndex,
  resolveInstrumentFamily
} from "./instrument-thumbnails";
import { getActiveNotesAtTime } from "./note-chase";
import { getGMProgramFamily } from "./gm-programs";
import { ticksToMeasures, signatureAtTick } from "./musical-time";
import { resolvePianoRollSeek } from "./piano-roll-seek";
import { getMidiPitchRange } from "./pitch-range";
import { buildPlaybackMidi } from "./playback-midi";
import {
  CHOIR_AAHS_PROGRAM,
  findPresetByKey,
  getDefaultTrackPreset,
  presetKey,
  type SoundFontPreset,
  type TrackPresetSelection
} from "./track-preset";
import { resolvePreset } from "./preset-resolution";
import {
  centerViewWindow,
  followPlaybackView,
  panViewWindow,
  resetViewWindowToStart,
  zoomViewWindow
} from "./view-window";
import { MAX_TRACK_GAIN, updateTrackGain } from "./track-mixer";
import {
  getAudibleTrackIds,
  getEngineTrackIds,
  hasSoloedTracks,
  haveSameTrackIds,
  isTrackAudible,
  toggleTrackMute,
  toggleTrackSolo
} from "./track-audibility";
import {
  chooseRulerSubdivision,
  getRulerTickLength
} from "./timeline-ruler";
import {
  resumeTransport,
  seekTransport
} from "./transport-clock";
import { PlaybackCoordinator } from "./playback-coordinator";
import {
  computeWaveformPeaks,
  isMasterClockSettled,
  planAudioSync,
  type ClockSample
} from "./audio-sync";
import {
  DEFAULT_ARRANGEMENT_TRACK_HEIGHT,
  DEFAULT_PIANO_ROLL_ROW_HEIGHT,
  CURRENT_PRESET_DEFAULTS_VERSION,
  collectViewerTrackState,
  normalizeViewerState,
  type PersistedViewerState,
  type ViewerMode
} from "./viewer-state";

export type SoundFontSource = {
  url: string;
  label: string;
  custom: boolean;
};

export type AudioExportWriter = {
  write(chunk: Uint8Array): Promise<void>;
  /** Resolves with the saved file name once the export is durable. */
  finish(): Promise<string | undefined>;
  abort(message: string): void;
};

/** Everything the player needs from its surroundings (VS Code, a web page, ...). */
export type PlayerHost = {
  loadState?(): unknown;
  saveState?(state: PersistedViewerState): void;
  persistViewMode?(viewMode: ViewerMode): void;
  /** Ask the host for another bank; the host answers with player.setSoundFont(). */
  requestSoundFont?(kind: "default" | "custom"): void;
  /** Resolves undefined when the user cancels. Omit to hide WAV export. */
  beginAudioExport?(suggestedName: string): Promise<AudioExportWriter | undefined>;
  fetchSoundBank?(url: string): Promise<ArrayBuffer>;
  onPlaybackChange?(playing: boolean): void;
};

/** A recording that plays in step with the MIDI, e.g. the source mix or a stem. */
export type AudioTrackSource = {
  url: string;
  label: string;
  /** Seconds into the MIDI where the recording starts (negative trims its start). */
  offset?: number;
  /** Display before this MIDI track (1-based). Omit to display above all MIDI. */
  beforeMidiTrack?: number;
};

export type PlayerConfig = {
  /** Element the player renders into. */
  app: HTMLElement;
  /** Receives global shortcuts (Space, Escape, menu arrows). */
  keyboardTarget: EventTarget;
  /** Receives outside clicks that close the SoundFont menu. */
  pointerTarget: EventTarget;
  midi: string | ArrayBuffer;
  fileName: string;
  workletUrl: string;
  soundFont?: SoundFontSource;
  /** Load the bank immediately instead of on first play or export. */
  preloadSoundFont?: boolean;
  /** Explicit starting state; its view mode overrides a remembered one. */
  viewerState?: unknown;
  /** View used when neither viewerState nor saved state names one. */
  defaultViewMode?: ViewerMode;
  audioTracks?: readonly AudioTrackSource[];
  host: PlayerHost;
};

export type MidiRealPlayer = {
  readonly duration: number;
  /** MIDI tracks plus audio tracks, once ready has resolved. */
  readonly trackCount: number;
  readonly currentTime: number;
  readonly playing: boolean;
  readonly ready: Promise<void>;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  /** Repaint the canvas, e.g. after the theme changed; colors are read from CSS. */
  redraw(): void;
  setSoundFont(source: SoundFontSource): void;
  destroy(): void;
};

type TrackModel = CanonicalTrack & {
  resolvedPreset?: string;
  presetFallback: boolean;
  presetOverride: TrackPresetSelection | null;
  enabled: boolean;
  solo: boolean;
  gain: number;
  color: string;
};

type AudioTrackModel = {
  beforeMidiTrack?: number;
  id: string;
  label: string;
  url: string;
  offset: number;
  enabled: boolean;
  solo: boolean;
  gain: number;
  color: string;
  rgb: string;
  status: "loading" | "ready" | "error";
  buffer?: AudioBuffer;
  peaks?: Float32Array;
  output?: GainNode;
  source?: AudioBufferSourceNode;
  /** Context time at which the source plays sourceBufferOffset. */
  sourceStartTime: number;
  sourceBufferOffset: number;
};

const AUDIO_TRACK_RGB = ["143, 152, 166", "179, 154, 114", "127, 163, 155", "168, 143, 176"];
const WAVEFORM_BINS_PER_SECOND = 40;
const AUDIO_DECODE_SAMPLE_RATE = 44_100;

type SoundFontState = "missing" | "loading" | "ready" | "error";

export function createMidiRealPlayer(config: PlayerConfig): MidiRealPlayer {
const { app, host } = config;
const initialViewerState = normalizeViewerState(config.viewerState);
const localViewerState = normalizeViewerState(host.loadState?.());
const savedViewerState = mergeViewerState(
  initialViewerState,
  localViewerState
);

const midiSource = config.midi;
const fileName = config.fileName;
const workletUri = config.workletUrl;
let soundFontUri = config.soundFont?.url ?? "";
let soundFontLabel = config.soundFont?.label ?? "Choose SoundFont";
let soundFontIsCustom = config.soundFont?.custom ?? false;

let midiDocument: CanonicalMidiDocument;
let tracks: TrackModel[] = [];
const playback = new PlaybackCoordinator();
let viewStart = 0;
let viewEnd = 1;
let minPitch = 21;
let maxPitch = 108;
let soundFontState: SoundFontState = "missing";
let soundFontLoadPromise: Promise<boolean> | undefined;
let loadedSoundBank: ArrayBuffer | undefined;
let audioContext: AudioContext | undefined;
let synthesizer: WorkletSynthesizer | undefined;
let sequencer: Sequencer | undefined;
let rebuildQueue = Promise.resolve();
let animationFrame = 0;
let followPlayhead = savedViewerState.followPlayhead ?? true;
let viewMode: ViewerMode =
  initialViewerState.viewMode ??
  savedViewerState.viewMode ??
  config.defaultViewMode ??
  "arrangement";
let arrangementTrackHeight =
  savedViewerState.arrangementTrackHeight ??
  DEFAULT_ARRANGEMENT_TRACK_HEIGHT;
let arrangementTrackHeightManual = savedViewerState.arrangementTrackHeightManual ??
  (savedViewerState.arrangementTrackHeight !== undefined &&
    savedViewerState.arrangementTrackHeight !== DEFAULT_ARRANGEMENT_TRACK_HEIGHT);
let pianoRollRowHeight =
  savedViewerState.pianoRollRowHeight ?? DEFAULT_PIANO_ROLL_ROW_HEIGHT;
let exportingAudio = false;
let destroyed = false;
let engineGeneration = 0;
let playRequest = 0;
let startingPlayback = 0;
let engineLoading = false;
let engineLoadQueue = Promise.resolve(false);
const pendingSequenceLoads = new Set<() => void>();
const idleEngineKey = {};

function releaseEngine(): void {
  idleAudioEngines.cancel(idleEngineKey);
  for (const resolve of pendingSequenceLoads) resolve();
  pendingSequenceLoads.clear();
  for (const track of audioTracks) {
    stopAudioSource(track);
    track.output?.disconnect();
    track.output = undefined;
  }
  sequencer?.pause();
  synthesizer?.destroy();
  const context = audioContext;
  sequencer = undefined;
  synthesizer = undefined;
  audioContext = undefined;
  loadedSoundBank = undefined;
  if (!engineLoading) soundFontLoadPromise = undefined;
  playback.engineSeekPending = true;
  if (context && context.state !== "closed") void context.close().catch(() => {});
  if (!destroyed && soundFontState === "ready") setSoundFontState("missing", "");
}

function retireIdleEngine(): void {
  if (!destroyed && audioContext && !playback.playing && !playback.rebuilding &&
      !exportingAudio && !engineLoading && startingPlayback === 0) {
    idleAudioEngines.retire(idleEngineKey, releaseEngine);
  }
}
let canvasLabelSize = "10px";
const disposers: Array<() => void> = [];
const audioTracks: AudioTrackModel[] = (config.audioTracks ?? []).map(
  (source, index): AudioTrackModel => {
    return {
      id: `audio:${index}`,
      label: source.label,
      beforeMidiTrack: source.beforeMidiTrack,
      url: source.url,
      offset: source.offset ?? 0,
      enabled: true,
      solo: false,
      gain: 1,
      rgb: AUDIO_TRACK_RGB[index % AUDIO_TRACK_RGB.length]!,
      color: `rgb(${AUDIO_TRACK_RGB[index % AUDIO_TRACK_RGB.length]!})`,
      status: "loading",
      sourceStartTime: 0,
      sourceBufferOffset: 0
    };
  }
);
let canvas: HTMLCanvasElement;
let canvasScroll: HTMLDivElement;
let scrubber: HTMLInputElement;
let timeReadout: HTMLElement;
let positionReadout: HTMLElement;
let playButton: HTMLButtonElement;
let playIcon: SVGElement;
let pauseIcon: SVGElement;
let followPlayheadButton: HTMLButtonElement;
let followPlayheadState: HTMLElement;
let soundFontButton: HTMLButtonElement;
let soundFontModeElement: HTMLElement;
let soundFontMenu: HTMLElement;
let defaultSoundFontOption: HTMLButtonElement;
let customSoundFontOption: HTMLButtonElement;
let statusToast: HTMLElement;
let pianoRollModeButton: HTMLButtonElement;
let arrangementModeButton: HTMLButtonElement;
let verticalScaleControl: HTMLLabelElement;
let viewHeightSlider: HTMLInputElement;
let exportButton: HTMLButtonElement;

// Start after the rest of this function has run: with in-memory MIDI there is no await
// before rendering, and the state declared below must exist by then.
const ready = Promise.resolve().then(initialize);

async function initialize(): Promise<void> {
  try {
    let binary: ArrayBuffer;
    if (typeof midiSource === "string") {
      const response = await fetch(midiSource);
      if (!response.ok) {
        throw new Error(`${fileName} could not be read (HTTP ${response.status}).`);
      }
      binary = await response.arrayBuffer();
    } else {
      binary = midiSource;
    }
    if (destroyed) return;
    midiDocument = parseCanonicalMidi(binary.slice(0), fileName);
    createTrackModels();
    if (tracks.length === 0) {
      renderEmptyState();
      return;
    }
    viewEnd = Math.max(midiDocument.duration, 0.001);
    updatePitchRange();
    renderApplication();
    bindApplication();
    renderAll();
    app.setAttribute("aria-busy", "false");
    for (const audioTrack of audioTracks) {
      void loadAudioTrack(audioTrack);
    }

    if (soundFontUri && config.preloadSoundFont !== false) {
      soundFontLoadPromise = loadSoundFont(soundFontUri, soundFontLabel);
      await soundFontLoadPromise;
    } else if (!soundFontUri) {
      setSoundFontState(
        "missing",
        "Choose a SoundFont to hear the instruments in this MIDI file."
      );
      window.setTimeout(hideStatus, 3600);
    }

  } catch (error) {
    if (!destroyed) renderError(error);
  }
}

function createTrackModels(): void {
  tracks = midiDocument.tracks.map((track, visualIndex): TrackModel => {
      const savedTrack = savedViewerState.tracks?.[track.id];
      const solo = savedTrack?.solo ?? false;
      return {
        ...track,
        presetFallback: false,
        presetOverride: getInitialTrackPreset(track, savedTrack?.presetOverride),
        enabled: solo || (savedTrack?.enabled ?? true),
        solo,
        gain: clamp(
          savedTrack?.gain ?? 1,
          0,
          MAX_TRACK_GAIN
        ),
        color: getInstrumentFamilyColor(
          track.instrumentFamily,
          track.isDrums,
          visualIndex
        )
      };
    });
}

function getInitialTrackPreset(
  track: CanonicalTrack,
  savedPreset: TrackPresetSelection | null | undefined
): TrackPresetSelection | null {
  const isOldTightDefault =
    (savedViewerState.presetDefaultsVersion ?? 0) <
      CURRENT_PRESET_DEFAULTS_VERSION &&
    track.program === CHOIR_AAHS_PROGRAM &&
    savedPreset?.program === 53 &&
    savedPreset.bankMSB === 0 &&
    savedPreset.bankLSB === 0 &&
    savedPreset.name === "Voice Oohs";
  if (savedPreset === undefined || isOldTightDefault) {
    return getDefaultTrackPreset(track);
  }
  return savedPreset;
}

function renderApplication(): void {
  app.innerHTML = `
    <main class="app-shell">
      <aside class="track-rail" aria-label="MIDI tracks">
        <header class="section-heading">
          <h1>Tracks</h1>
          <span class="track-count">${tracks.length + audioTracks.length}</span>
        </header>
        <div class="track-list" id="track-list"></div>
      </aside>
      <section class="piano-roll-region" aria-label="MIDI visualization">
        <div class="canvas-scroll" id="canvas-scroll">
          <canvas id="piano-roll" tabindex="0" aria-label="Multi-track MIDI piano roll. Click a note to restart it, or click empty space to seek."></canvas>
        </div>
        <div class="view-tools" aria-label="MIDI view controls">
          <div class="view-mode-switch" role="group" aria-label="MIDI view mode">
            <button id="view-piano-roll" class="view-mode-button" type="button" aria-pressed="${viewMode === "piano-roll"}" title="Piano roll view">Roll</button>
            <button id="view-arrangement" class="view-mode-button" type="button" aria-pressed="${viewMode === "arrangement"}" title="Track arrangement view">Tracks</button>
          </div>
          <label class="track-height-control" id="view-height-control" title="Vertical scale">
            <span aria-hidden="true">↕</span>
            <input id="view-height" type="range" min="6" max="24" step="1" value="${pianoRollRowHeight}" aria-label="Piano roll row height">
          </label>
          <span class="view-tools-divider" aria-hidden="true"></span>
          <button id="zoom-out" type="button" aria-label="Zoom out">−</button>
          <button id="fit-view" type="button" aria-label="Fit full MIDI">Fit</button>
          <button id="zoom-in" type="button" aria-label="Zoom in">+</button>
        </div>
      </section>
      <footer class="transport" aria-label="MIDI transport">
        <div class="transport-cluster">
          <div class="transport-buttons">
            <button class="transport-button" id="go-start" type="button" aria-label="Go to start" title="Go to start">
              <svg class="transport-icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.25 2.5v11M12.75 3.25 6.5 8l6.25 4.75"/>
              </svg>
            </button>
            <button class="transport-button primary" id="play" type="button" aria-label="Play" title="Play (Space)">
              <svg class="transport-icon transport-icon-fill" id="play-icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4.25 2.75 13 8l-8.75 5.25z"/>
              </svg>
              <svg class="transport-icon transport-icon-fill" id="pause-icon" viewBox="0 0 16 16" aria-hidden="true" hidden>
                <rect x="3.5" y="2.75" width="3.25" height="10.5"/>
                <rect x="9.25" y="2.75" width="3.25" height="10.5"/>
              </svg>
            </button>
            <button class="transport-button" id="stop" type="button" aria-label="Stop" title="Stop">
              <svg class="transport-icon transport-icon-fill" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="3.25" y="3.25" width="9.5" height="9.5"/>
              </svg>
            </button>
          </div>
          <span class="transport-divider" aria-hidden="true"></span>
          <button class="transport-follow-toggle" id="follow-playhead" type="button" aria-pressed="${followPlayhead}">
            <span>Follow</span>
            <span class="transport-follow-state" id="follow-playhead-state">${followPlayhead ? "On" : "Off"}</span>
          </button>
        </div>
        <div class="time-group" aria-live="off">
          <span class="time-readout" id="time-readout">00:00.000</span>
          <span class="position-readout" id="position-readout">1.1.000</span>
        </div>
        <input class="scrubber" id="scrubber" type="range" min="0" max="${midiDocument.duration}" value="0" step="0.001" aria-label="Playback position">
        <button class="export-button" id="export-audio" type="button" title="Export the audible tracks and current volumes as WAV">
          <svg class="transport-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2.5v7M5.25 7.25 8 10l2.75-2.75M3 12.5h10"/>
          </svg>
          <span>Export WAV</span>
        </button>
        <button class="soundfont-button" id="soundfont-button" type="button" data-state="missing" aria-haspopup="menu" aria-expanded="false">
          <span class="soundfont-dot" aria-hidden="true"></span>
          <span class="soundfont-title">
            <span class="soundfont-title-full">SoundFont</span>
            <span class="soundfont-title-short">SF</span>
          </span>
          <span class="soundfont-mode" id="soundfont-mode">${soundFontIsCustom ? "Custom" : "Default"}</span>
          <svg class="soundfont-chevron" viewBox="0 0 12 12" aria-hidden="true">
            <path d="m2.5 4.25 3.5 3.5 3.5-3.5"/>
          </svg>
        </button>
        <div class="soundfont-menu" id="soundfont-menu" role="menu" aria-label="Choose SoundFont" hidden>
          <button class="soundfont-option" id="soundfont-default" type="button" role="menuitemradio" aria-checked="${!soundFontIsCustom}">
            <span>Default</span>
          </button>
          <button class="soundfont-option" id="soundfont-custom" type="button" role="menuitemradio" aria-checked="${soundFontIsCustom}">
            <span>Custom…</span>
          </button>
        </div>
      </footer>
      <div class="status-toast" id="status-toast" role="status" hidden></div>
    </main>
  `;

  canvas = requireElement("#piano-roll");
  canvasScroll = requireElement("#canvas-scroll");
  scrubber = requireElement("#scrubber");
  timeReadout = requireElement("#time-readout");
  positionReadout = requireElement("#position-readout");
  playButton = requireElement("#play");
  playIcon = requireElement("#play-icon");
  pauseIcon = requireElement("#pause-icon");
  followPlayheadButton = requireElement("#follow-playhead");
  followPlayheadState = requireElement("#follow-playhead-state");
  soundFontButton = requireElement("#soundfont-button");
  soundFontModeElement = requireElement("#soundfont-mode");
  soundFontMenu = requireElement("#soundfont-menu");
  defaultSoundFontOption = requireElement("#soundfont-default");
  customSoundFontOption = requireElement("#soundfont-custom");
  statusToast = requireElement("#status-toast");
  pianoRollModeButton = requireElement("#view-piano-roll");
  arrangementModeButton = requireElement("#view-arrangement");
  verticalScaleControl = requireElement("#view-height-control");
  viewHeightSlider = requireElement("#view-height");
  exportButton = requireElement("#export-audio");
  exportButton.hidden = !host.beginAudioExport;
  // The SoundFont menu exists only when the host can switch banks; otherwise the
  // page's author has chosen the bank and the control would be noise.
  if (!host.requestSoundFont) {
    soundFontButton.hidden = true;
    soundFontMenu.hidden = true;
    requireElement<HTMLElement>(".transport").dataset.soundfontMenu = "off";
  }
  updateViewMode();
  renderTrackList();
}

function bindApplication(): void {
  const resizeObserver = new ResizeObserver(() => {
    updateCanvasSize();
    renderCanvas();
    paintAudioCovers();
  });
  resizeObserver.observe(canvasScroll);
  disposers.push(() => resizeObserver.disconnect());

  requireElement<HTMLButtonElement>("#go-start").addEventListener("click", () => {
    seekToStart();
  });
  requireElement<HTMLButtonElement>("#stop").addEventListener("click", stop);
  playButton.addEventListener("click", () => void togglePlayback());
  followPlayheadButton.addEventListener("click", toggleFollowPlayhead);
  scrubber.addEventListener("input", () => {
    const targetTime = Number(scrubber.value);
    const nextView = centerViewWindow(
      targetTime,
      viewStart,
      viewEnd,
      midiDocument.duration
    );
    viewStart = nextView.start;
    viewEnd = nextView.end;
    seekTo(targetTime);
  });
  soundFontButton.addEventListener("click", toggleSoundFontMenu);
  pianoRollModeButton.addEventListener("click", () => {
    setViewMode("piano-roll");
  });
  arrangementModeButton.addEventListener("click", () => {
    setViewMode("arrangement");
  });
  viewHeightSlider.addEventListener("input", () => {
    if (viewMode === "arrangement") {
      arrangementTrackHeightManual = true;
      arrangementTrackHeight = clamp(
        Number(viewHeightSlider.value),
        52,
        180
      );
    } else {
      pianoRollRowHeight = clamp(
        Number(viewHeightSlider.value),
        6,
        24
      );
    }
    app.style.setProperty(
      "--arrangement-track-height",
      `${arrangementTrackHeight}px`
    );
    updateCanvasSize();
    renderCanvas();
    persistWebviewState();
  });
  exportButton.addEventListener("click", requestAudioExport);
  defaultSoundFontOption.addEventListener("click", () => {
    closeSoundFontMenu();
    if (soundFontIsCustom) {
      host.requestSoundFont?.("default");
    }
  });
  customSoundFontOption.addEventListener("click", () => {
    closeSoundFontMenu();
    host.requestSoundFont?.("custom");
  });
  requireElement<HTMLButtonElement>("#zoom-in").addEventListener("click", () => {
    zoomView(0.5);
  });
  requireElement<HTMLButtonElement>("#zoom-out").addEventListener("click", () => {
    zoomView(2);
  });
  requireElement<HTMLButtonElement>("#fit-view").addEventListener("click", () => {
    viewStart = 0;
    viewEnd = midiDocument.duration;
    renderCanvas();
  });
  updateFollowPlayheadButton();

  canvas.addEventListener("pointerdown", (event) => {
    const bounds = canvas.getBoundingClientRect();
    const keyboardWidth = viewMode === "piano-roll" ? 48 : 0;
    const headerHeight = getCanvasHeaderHeight();
    const ratio = clamp(
      (event.clientX - bounds.left - keyboardWidth) /
        Math.max(1, bounds.width - keyboardWidth),
      0,
      1
    );
    const clickedTime = viewStart + ratio * (viewEnd - viewStart);
    const canvasY = event.clientY - bounds.top;
    const gridHeight = Math.max(1, bounds.height - headerHeight);
    const rowHeight = gridHeight / Math.max(1, maxPitch - minPitch + 1);
    const clickedMidi =
      viewMode === "piano-roll" &&
      event.clientX - bounds.left >= keyboardWidth && canvasY >= headerHeight
        ? clamp(
            maxPitch - Math.floor((canvasY - headerHeight) / rowHeight),
            minPitch,
            maxPitch
          )
        : undefined;
    const target = resolvePianoRollSeek(
      tracksWithAudibility(),
      clickedTime,
      clickedMidi
    );
    seekTo(target.displayTime, target.engineTime);
  });
  canvas.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const bounds = canvas.getBoundingClientRect();
        const keyboardWidth = viewMode === "piano-roll" ? 48 : 0;
        const anchorRatio = clamp(
          (event.clientX - bounds.left - keyboardWidth) /
            Math.max(1, bounds.width - keyboardWidth),
          0,
          1
        );
        const anchorTime =
          viewStart + anchorRatio * (viewEnd - viewStart);
        zoomView(
          Math.exp(event.deltaY * 0.006),
          anchorTime,
          anchorRatio
        );
        return;
      }

      const panDelta =
        Math.abs(event.deltaX) > 0.5
          ? event.deltaX
          : event.shiftKey
            ? event.deltaY
            : 0;
      if (panDelta === 0) {
        return;
      }
      event.preventDefault();
      const nextView = panViewWindow(
        (panDelta / 600) * (viewEnd - viewStart),
        viewStart,
        viewEnd,
        midiDocument.duration
      );
      viewStart = nextView.start;
      viewEnd = nextView.end;
      renderCanvas();
    },
    { passive: false }
  );
  let syncingScroll = false;
  const trackList = requireElement<HTMLDivElement>("#track-list");
  trackList.addEventListener("change", handleTrackPresetChange);
  trackList.addEventListener("scroll", () => {
    if (viewMode !== "arrangement" || syncingScroll) {
      return;
    }
    syncingScroll = true;
    canvasScroll.scrollTop = trackList.scrollTop;
    syncingScroll = false;
  });
  canvasScroll.addEventListener("scroll", () => {
    if (viewMode !== "arrangement" || syncingScroll) {
      return;
    }
    syncingScroll = true;
    trackList.scrollTop = canvasScroll.scrollTop;
    syncingScroll = false;
  });
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      seekTo(
        playback.currentTime +
          (event.key === "ArrowLeft" ? -1 : 1) *
            (event.shiftKey ? 5 : 0.1)
      );
    }
  });
  listen(config.keyboardTarget, "keydown", (rawEvent) => {
    const event = rawEvent as KeyboardEvent;
    const eventTarget = event.composedPath()[0];
    if (event.key === "Escape" && !soundFontMenu.hidden) {
      event.preventDefault();
      closeSoundFontMenu();
      soundFontButton.focus();
      return;
    }
    if (
      !soundFontMenu.hidden &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      const onDefault = eventTarget === defaultSoundFontOption;
      (onDefault ? customSoundFontOption : defaultSoundFontOption).focus();
      return;
    }
    if (
      event.code === "Space" &&
      !(eventTarget instanceof HTMLButtonElement) &&
      !(eventTarget instanceof HTMLInputElement) &&
      !(eventTarget instanceof HTMLSelectElement)
    ) {
      event.preventDefault();
      void togglePlayback();
    }
  });
  listen(config.pointerTarget, "pointerdown", (event) => {
    const target = event.composedPath()[0];
    if (
      target instanceof Node &&
      !soundFontMenu.hidden &&
      !soundFontMenu.contains(target) &&
      !soundFontButton.contains(target)
    ) {
      closeSoundFontMenu();
    }
  });
}

function listen(
  target: EventTarget,
  type: string,
  handler: (event: Event) => void
): void {
  target.addEventListener(type, handler);
  disposers.push(() => target.removeEventListener(type, handler));
}

function trackLaneOrder() {
  return getArrangementTrackOrder(tracks.length, audioTracks.map(track => track.beforeMidiTrack));
}

function trackLaneIndex(kind: "audio" | "midi", index: number): number {
  return trackLaneOrder().findIndex(lane => lane.kind === kind && lane.index === index);
}

function renderTrackList(): void {
  const list = requireElement<HTMLDivElement>("#track-list");
  const previousScrollTop = list.scrollTop;
  const anyTrackSoloed = anyTrackSoloedAnywhere();
  list.innerHTML = trackLaneOrder().map(({ kind, index }) => {
      if (kind === "audio") return renderAudioTrackRow(audioTracks[index]!, index, anyTrackSoloed);
      const track = tracks[index]!;
      const displayFamily = resolveInstrumentFamily(
        track.instrumentFamily,
        track.isDrums,
        track.name,
        track.notes.length > 0
      );
      return `
        <div
          class="track-row track-family-${getInstrumentFamilyClass(
            displayFamily,
            track.isDrums
          )}"
          data-track-id="${escapeHtml(track.id)}"
          data-enabled="${isTrackAudible(track, anyTrackSoloed)}"
          data-muted="${!track.enabled}"
          data-solo="${track.solo}"
        >
          <span
            class="track-cover${track.notes.length === 0 ? " track-cover-empty" : ""}"
          >
            <span
              class="track-cover-art"
              data-family-index="${getInstrumentThumbnailIndex(
                displayFamily,
                track.isDrums
              )}"
              aria-hidden="true"
            ></span>
            <span class="track-cover-number">[${String(index + 1).padStart(2, "0")}]</span>
            <span class="track-name" title="${escapeHtml(track.name)}">${escapeHtml(track.name)}</span>
            <span class="track-copy">
              ${renderTrackMeta(track, index)}
            </span>
          </span>
          <span class="track-state">
            <span class="track-mix-buttons" role="group" aria-label="${escapeHtml(track.name)} playback controls">
              <button
                class="track-mix-button track-mute"
                type="button"
                aria-pressed="${!track.enabled}"
                aria-label="${track.enabled ? "Mute" : "Unmute"} ${escapeHtml(track.name)}"
                title="${track.enabled ? "Mute" : "Unmute"} ${escapeHtml(track.name)}"
              >M</button>
              <button
                class="track-mix-button track-solo"
                type="button"
                aria-pressed="${track.solo}"
                aria-label="${track.solo ? "Unsolo" : "Solo"} ${escapeHtml(track.name)}"
                title="${track.solo ? "Unsolo" : "Solo"} ${escapeHtml(track.name)}"
              >S</button>
            </span>
            ${renderTrackVolume(track, index)}
          </span>
        </div>
      `;
    })
    .join("");
  list.scrollTop = previousScrollTop;
  paintAudioCovers();

  list.querySelectorAll<HTMLButtonElement>(".track-mute").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest<HTMLElement>(".track-row");
      const track = findAnyTrack(row?.dataset.trackId);
      if (!track) {
        return;
      }
      const previousAudibleTrackIds = getAudibleMidiTrackIds();
      toggleTrackMute(track);
      applyTrackAudibilityChange(previousAudibleTrackIds);
    });
  });

  list.querySelectorAll<HTMLButtonElement>(".track-solo").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest<HTMLElement>(".track-row");
      const track = findAnyTrack(row?.dataset.trackId);
      if (!track) {
        return;
      }
      const previousAudibleTrackIds = getAudibleMidiTrackIds();
      toggleTrackSolo(track);
      applyTrackAudibilityChange(previousAudibleTrackIds);
    });
  });

  list.querySelectorAll<HTMLInputElement>(".track-volume-slider").forEach((slider) => {
    slider.addEventListener("input", () => {
      const row = slider.closest<HTMLElement>(".track-row");
      const trackId = row?.dataset.trackId ?? "";
      const audioTrack = audioTracks.find((candidate) => candidate.id === trackId);
      if (audioTrack) {
        audioTrack.gain = clamp(Number(slider.value) / 100, 0, 1);
        const value = row?.querySelector<HTMLElement>(".track-volume-value");
        if (value) {
          value.textContent = String(Math.round(audioTrack.gain * 100));
        }
        slider.setAttribute("aria-valuetext", describeTrackVolume(audioTrack.gain));
        applyAudioTrackStates();
        return;
      }
      const changed = updateTrackGain(
        tracks,
        trackId,
        Number(slider.value) / 100
      );
      const track = tracks.find((candidate) => candidate.id === trackId);
      if (!track || !changed) {
        return;
      }
      const index = tracks.indexOf(track);
      updateTrackVolumeControl(index);
      applyTrackGainState(track);
      persistWebviewState();
    });
  });
}

function handleTrackPresetChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  const index = Number(target.dataset.trackPreset);
  const track = tracks[index];
  if (!track || !Number.isInteger(index)) {
    return;
  }

  if (target.value === "original") {
    track.presetOverride = null;
    track.presetFallback = false;
    track.resolvedPreset = track.instrument;
    showStatus(`${track.name} now follows the MIDI's original sound.`);
  } else {
    const preset = findPresetByKey(
      getAvailableSoundFontPresets(),
      target.value
    );
    if (!preset) {
      renderTrackList();
      showStatus("That preset is not available in the active SoundFont.");
      return;
    }
    track.presetOverride = copyPreset(preset);
    track.presetFallback = false;
    track.resolvedPreset = preset.name;
    showStatus(`${track.name} now plays ${preset.name}.`);
  }

  renderTrackList();
  persistWebviewState();
  if (sequencer) {
    queueSequenceRebuild();
  }
  window.setTimeout(hideStatus, 2200);
}

function applyTrackAudibilityChange(
  previousAudibleTrackIds: ReadonlySet<string>
): void {
  renderTrackList();
  renderCanvas();
  persistWebviewState();
  applyAudioTrackStates();
  const audibleTrackIds = getAudibleMidiTrackIds();
  if (audibleTrackIds.size === 0) {
    synthesizer?.stopAll(true);
    applyAllTrackGainStates();
    return;
  }
  if (sequencer && !haveSameTrackIds(previousAudibleTrackIds, audibleTrackIds)) {
    queueSequenceRebuild();
  } else {
    applyAllTrackGainStates();
  }
}

function loadSoundFont(uri: string, label: string): Promise<boolean> {
  const generation = ++engineGeneration;
  idleAudioEngines.cancel(idleEngineKey);
  engineLoading = true;
  setSoundFontState("loading", `Loading ${label}…`);
  const pending = engineLoadQueue.then(async () => {
    if (destroyed || generation !== engineGeneration) return false;
    return buildSoundFontEngine(uri, label, generation);
  });
  engineLoadQueue = pending;
  void pending.finally(() => {
    if (generation === engineGeneration) {
      engineLoading = false;
      retireIdleEngine();
    }
  });
  return pending;
}

async function buildSoundFontEngine(uri: string, label: string, generation: number): Promise<boolean> {
  const stale = () => destroyed || generation !== engineGeneration;
  setSoundFontState("loading", `Loading ${label}…`);

  try {
    const soundBank = host.fetchSoundBank
      ? await host.fetchSoundBank(uri)
      : await fetchArrayBuffer(uri, label);
    if (stale()) return false;

    const previousEngineTime =
      playback.playing && sequencer && !sequencer.paused
        ? sequencer.currentHighResolutionTime
        : undefined;
    playback.requestPause(previousEngineTime, midiDocument.duration);
    releaseEngine();
    loadedSoundBank = soundBank.slice(0);

    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule(workletUri);
    if (stale()) { releaseEngine(); return false; }
    synthesizer = new WorkletSynthesizer(audioContext);
    synthesizer.connect(audioContext.destination);
    await synthesizer.isReady;
    if (stale()) { releaseEngine(); return false; }
    await synthesizer.soundBankManager.addSoundBank(soundBank, "main");
    if (stale()) { releaseEngine(); return false; }
    sequencer = new Sequencer(synthesizer, {
      skipToFirstNoteOn: false,
      initialPlaybackRate: 1
    });
    sequencer.eventHandler.addEvent("songEnded", "viewer-ended", () => {
      if (playback.rebuilding) {
        return;
      }
      playback.seek(
        midiDocument.duration,
        midiDocument.duration,
        midiDocument.duration
      );
      playback.finish();
      syncAudioTracks();
      retireIdleEngine();
      updateTransportButtons();
      updateReadouts();
    });
    sequencer.eventHandler.addEvent("midiError", "viewer-error", (error) => {
      showStatus(
        `This MIDI could not be played: ${error.message || "the sequence is not supported."}`
      );
    });
    synthesizer.eventHandler.addEvent(
      "programChange",
      "viewer-program-change",
      ({ channel }) => {
        refreshResolvedPreset(channel);
      }
    );
    await rebuildSequence(false);
    if (stale()) { releaseEngine(); return false; }
    refreshResolvedPresets();
    applyAllTrackGainStates();
    setSoundFontState("ready", `${label} is ready.`);
    renderTrackList();
    window.setTimeout(hideStatus, 1800);
    return true;
  } catch (error) {
    releaseEngine();
    if (stale()) return false;
    const message =
      error instanceof Error ? error.message : "The SoundFont could not be loaded.";
    setSoundFontState(
      "error",
      host.requestSoundFont ? `${message} Choose another SF2, SF3, or DLS file.` : message
    );
    return false;
  }
}

function refreshResolvedPresets(): void {
  const channels = new Set(
    tracks
      .map((track) => track.playbackChannelIndex)
      .filter((channel): channel is number => channel !== undefined)
  );
  for (const channel of channels) {
    refreshResolvedPreset(channel, false);
  }
  updateTrackMetaElements();
}

function refreshResolvedPreset(
  channel: number,
  render = true
): void {
  if (!synthesizer) {
    return;
  }
  const requested = synthesizer.midiChannels[channel]?.patch;
  if (!requested) {
    return;
  }
  const resolution = resolvePreset(
    synthesizer.presetList,
    requested,
    synthesizer.midiParameters.system
  );
  for (const track of tracks) {
    if (track.playbackChannelIndex !== channel) {
      continue;
    }
    track.resolvedPreset = resolution?.name;
    track.presetFallback = resolution?.fallback ?? false;
  }
  if (render) {
    updateTrackMetaElements(channel);
  }
}

function updateTrackMetaElements(channel?: number): void {
  tracks.forEach((track, index) => {
    if (
      channel !== undefined &&
      track.playbackChannelIndex !== channel
    ) {
      return;
    }
    const current = app.querySelector<HTMLElement>(
      `[data-track-meta="${index}"]`
    );
    if (current) {
      current.outerHTML = renderTrackMeta(track, index);
    }
  });
}

function renderTrackMeta(track: TrackModel, index: number): string {
  if (track.sourceChannel === undefined || track.notes.length === 0) {
    return `<span class="track-meta" data-track-meta="${index}">No notes</span>`;
  }
  const presets = getAvailableSoundFontPresets().filter(
    (preset) =>
      (preset.isDrum ?? preset.isGMGSDrum) === track.isDrums &&
      (track.isDrums ||
        getGMProgramFamily(preset.program, false) === track.instrumentFamily)
  );
  const selection = track.presetOverride;
  const selectedKey = selection ? presetKey(selection) : "original";
  // Until the SoundFont loads (on first play by default) its presets are unknown,
  // so a chosen preset is shown as chosen rather than flagged unavailable.
  const presetsKnown = Boolean(synthesizer);
  const selectionAvailable =
    !selection || !presetsKnown || Boolean(findPresetByKey(presets, selectedKey));
  const fallbackWarning =
    track.presetFallback && track.resolvedPreset
      ? `Requested ${selection?.name ?? track.instrument}, but this SoundFont is playing ${track.resolvedPreset}.`
      : "";
  const unavailableWarning =
    selection && !selectionAvailable
      ? `${selection.name} is unavailable in this SoundFont.`
      : "";
  const warning = fallbackWarning || unavailableWarning;
  const title =
    warning ||
    `Sound: ${selection?.name ?? track.instrument}. MIDI original: ${track.instrument}.`;

  return `
    <label
      class="track-preset-control${warning ? " track-meta-warning" : ""}"
      data-track-meta="${index}"
      title="${escapeHtml(title)}"
    >
      <span class="visually-hidden">Playback sound for ${escapeHtml(track.name)}</span>
      <select
        class="track-preset-select"
        data-track-preset="${index}"
        aria-label="Playback sound for ${escapeHtml(track.name)}"
        ${presets.length === 0 ? "disabled" : ""}
      >
        <option value="original"${selectedKey === "original" ? " selected" : ""}>MIDI · ${escapeHtml(track.instrument)}</option>
        ${selection && !presetsKnown ? `<option value="${escapeHtml(selectedKey)}" selected>SoundFont · ${escapeHtml(selection.name)}</option>` : ""}
        ${selection && !selectionAvailable ? `<option value="${escapeHtml(selectedKey)}" selected>Unavailable · ${escapeHtml(selection.name)}</option>` : ""}
        ${renderPresetGroup("SoundFont presets", presets, selectedKey)}
      </select>
    </label>
  `;
}

function renderPresetGroup(
  label: string,
  presets: readonly SoundFontPreset[],
  selectedKey: string
): string {
  if (presets.length === 0) {
    return "";
  }
  return `
    <optgroup label="${escapeHtml(label)}">
      ${presets
        .map((preset) => {
          const key = presetKey(preset);
          const isSelected = key === selectedKey;
          return `<option value="${escapeHtml(key)}"${isSelected ? " selected" : ""}>${escapeHtml(preset.name)}</option>`;
        })
        .join("")}
    </optgroup>
  `;
}

function getAvailableSoundFontPresets(): SoundFontPreset[] {
  if (!synthesizer) {
    return [];
  }
  const unique = new Map<string, SoundFontPreset>();
  for (const preset of synthesizer.presetList) {
    const copy = copyPreset(preset);
    unique.set(presetKey(copy), copy);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.program - right.program ||
      left.bankMSB - right.bankMSB ||
      left.bankLSB - right.bankLSB ||
      left.name.localeCompare(right.name)
  );
}

function copyPreset(preset: SoundFontPreset): SoundFontPreset {
  return {
    bankMSB: preset.bankMSB,
    bankLSB: preset.bankLSB,
    program: preset.program,
    isGMGSDrum: preset.isGMGSDrum,
    isDrum: preset.isDrum,
    name: preset.name
  };
}

function getTrackPatchOverrides(): ReadonlyMap<string, TrackPresetSelection> {
  return new Map(
    tracks.flatMap((track) =>
      track.presetOverride ? [[track.id, track.presetOverride]] : []
    )
  );
}

function renderTrackVolume(track: TrackModel, index: number): string {
  if (track.playbackChannelIndex === undefined) {
    return "";
  }
  const percent = Math.round(track.gain * 100);
  const volumeDescription = describeTrackVolume(track.gain);
  return `
    <label
      class="track-volume"
      data-boosted="${track.gain > 1}"
      title="Track volume: ${volumeDescription}"
    >
      <span class="track-volume-header" aria-hidden="true">
        <span>Vol</span>
        <span class="track-volume-value" data-track-volume-value="${index}">${percent}</span>
      </span>
      <input
        class="track-volume-slider"
        data-track-volume="${index}"
        type="range"
        min="0"
        max="${MAX_TRACK_GAIN * 100}"
        step="1"
        value="${percent}"
        aria-label="${escapeHtml(track.name)} volume"
        aria-valuetext="${volumeDescription}"
      >
    </label>
  `;
}

function updateTrackVolumeControl(index: number): void {
  const track = tracks[index];
  if (!track) {
    return;
  }
  const percent = Math.round(track.gain * 100);
  const volumeDescription = describeTrackVolume(track.gain);
  const slider = app.querySelector<HTMLInputElement>(
    `[data-track-volume="${index}"]`
  );
  const value = app.querySelector<HTMLElement>(
    `[data-track-volume-value="${index}"]`
  );
  if (slider) {
    slider.value = String(percent);
    slider.setAttribute("aria-valuetext", volumeDescription);
    slider.parentElement?.setAttribute(
      "title",
      `Track volume: ${volumeDescription}`
    );
    slider.parentElement?.setAttribute(
      "data-boosted",
      String(track.gain > 1)
    );
  }
  if (value) {
    value.textContent = String(percent);
  }
}

function describeTrackVolume(gain: number): string {
  const percent = Math.round(gain * 100);
  if (gain <= 1) {
    return `${percent} percent`;
  }
  const decibels = 20 * Math.log10(gain);
  return `${percent} percent, plus ${decibels.toFixed(1)} decibels`;
}

async function rebuildSequence(resumePreviousState = true): Promise<void> {
  if (!sequencer || !synthesizer) {
    return;
  }
  beginSequenceRebuild(resumePreviousState);
  if (!resumePreviousState) {
    playback.requestPause(undefined, midiDocument.duration);
  }
  try {
    await replacePlaybackSequence();
  } finally {
    await finishSequenceRebuild();
  }
}

async function replacePlaybackSequence(): Promise<void> {
  if (!sequencer) {
    return;
  }
  const activeSequencer = sequencer;
  const enabledTrackIds = getEngineMidiTrackIds();
  const binary = buildPlaybackMidi(
    midiDocument.original,
    midiDocument.tracks,
    enabledTrackIds,
    {
      patchOverrides: getTrackPatchOverrides()
    }
  );

  await new Promise<void>((resolve) => {
    const eventId = `viewer-rebuild-${Date.now()}-${Math.random()}`;
    const complete = () => {
      activeSequencer.eventHandler.removeEvent("songChange", eventId);
      pendingSequenceLoads.delete(complete);
      resolve();
    };
    pendingSequenceLoads.add(complete);
    activeSequencer.eventHandler.addEvent(
      "songChange",
      eventId,
      complete
    );
    activeSequencer.loadNewSongList([{ binary, fileName }]);
  });

  applyAllTrackGainStates();
}

function beginSequenceRebuild(resumePreviousState = true): void {
  idleAudioEngines.cancel(idleEngineKey);
  const observedEngineTime =
    resumePreviousState && playback.playing && sequencer && !sequencer.paused
      ? sequencer.currentHighResolutionTime
      : undefined;
  const firstRebuild = playback.beginRebuild(
    observedEngineTime,
    midiDocument.duration
  );
  if (firstRebuild) {
    sequencer?.pause();
    synthesizer?.stopAll(true);
  }
  updateTransportButtons();
}

async function finishSequenceRebuild(): Promise<void> {
  if (!playback.completeRebuild()) {
    updateTransportButtons();
    retireIdleEngine();
    return;
  }
  const activeSequencer = sequencer;
  const activeAudioContext = audioContext;
  if (!activeSequencer || !activeAudioContext) {
    return;
  }
  await activeAudioContext.resume();
  if (playback.rebuilding || !playback.playing || sequencer !== activeSequencer) {
    updateTransportButtons();
    return;
  }
  resumeTransport(activeSequencer, playback.pendingEngineTime, true);
  playback.markEngineResumed();
  chaseActiveNotes(playback.currentTime);
  updateTransportButtons();
}

function applyTrackGainState(track: TrackModel): void {
  if (!synthesizer || track.playbackChannelIndex === undefined) {
    return;
  }
  synthesizer.midiChannels[track.playbackChannelIndex]?.setSystemParameter(
    "gain",
    getAudibleMidiTrackIds().size === 0 ? 0 : track.gain
  );
}

function applyAllTrackGainStates(): void {
  for (const track of tracks) {
    applyTrackGainState(track);
  }
}

function queueSequenceRebuild(): void {
  beginSequenceRebuild();
  rebuildQueue = rebuildQueue
    .then(async () => {
      try {
        await replacePlaybackSequence();
      } finally {
        await finishSequenceRebuild();
      }
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : "The track Mute and Solo states could not be applied.";
      showStatus(`Track playback could not be updated: ${message}`);
    });
}

async function togglePlayback(): Promise<void> {
  if (playback.playing) {
    pausePlayback();
    return;
  }
  await startPlayback();
}

async function startPlayback(): Promise<void> {
  const request = ++playRequest;
  startingPlayback++;
  idleAudioEngines.cancel(idleEngineKey);
  try {
    await startPlaybackRequest(request);
  } finally {
    startingPlayback--;
    retireIdleEngine();
  }
}

async function startPlaybackRequest(request: number): Promise<void> {
  if (!(await ensureSoundFontReady())) {
    return;
  }
  const activeSequencer = sequencer;
  const activeAudioContext = audioContext;
  if (!activeSequencer || !activeAudioContext) {
    return;
  }
  if (destroyed || request !== playRequest) return;
  if (playback.currentTime >= midiDocument.duration - 0.001) {
    seekToStart();
  }
  playback.requestPlay();
  updateTransportButtons();
  if (followPlayhead) {
    revealPlayhead();
  }
  if (playback.rebuilding) {
    return;
  }
  await activeAudioContext.resume();
  if (playback.rebuilding || !playback.playing || sequencer !== activeSequencer) {
    return;
  }
  const targetTime = clamp(playback.pendingEngineTime, 0, midiDocument.duration);
  const shouldChaseAfterResume = playback.engineSeekPending;
  resumeTransport(activeSequencer, targetTime, shouldChaseAfterResume);
  playback.markEngineResumed();
  if (shouldChaseAfterResume) {
    chaseActiveNotes(playback.currentTime);
  }
  updateTransportButtons();
}

async function ensureSoundFontReady(): Promise<boolean> {
  if (destroyed) return false;
  if ((soundFontState === "missing" || soundFontState === "error") && soundFontUri && !engineLoading) {
    soundFontLoadPromise = loadSoundFont(soundFontUri, soundFontLabel);
  }
  if (soundFontState === "loading" && soundFontLoadPromise) {
    showStatus(`Finishing ${soundFontLabel} setup…`);
    await soundFontLoadPromise;
  }
  if (
    soundFontState === "ready" &&
    sequencer &&
    audioContext &&
    synthesizer
  ) {
    return true;
  }
  if (soundFontState === "error") {
    showStatus(
      host.requestSoundFont
        ? "The default SoundFont could not be loaded. Choose Custom in the SoundFont menu to use another bank."
        : "The SoundFont could not be loaded. Check the network connection and try again."
    );
  } else {
    showStatus("The bundled SoundFont is still being prepared.");
  }
  return false;
}

async function requestAudioExport(): Promise<void> {
  if (!host.beginAudioExport) {
    return;
  }
  if (exportingAudio || destroyed) return;
  idleAudioEngines.cancel(idleEngineKey);
  setExportingAudio(true);
  if (!(await ensureSoundFontReady()) || destroyed) {
    setExportingAudio(false);
    return;
  }
  const audibleTrackIds = getAudibleMidiTrackIds();
  if (
    !tracks.some((track) => audibleTrackIds.has(track.id) && track.notes.length > 0) &&
    getAudibleAudioTracks().length === 0
  ) {
    setExportingAudio(false);
    showStatus("Unmute or solo at least one track before exporting audio.");
    return;
  }
  setExportingAudio(true);
  showStatus("Choose where to save the rendered WAV file.");
  let writer: AudioExportWriter | undefined;
  try {
    writer = await host.beginAudioExport(
      `${fileName.replace(/\.(mid|midi)$/i, "")}-mix`
    );
  } catch (error) {
    setExportingAudio(false);
    showStatus(error instanceof Error ? error.message : "Audio export failed.");
    return;
  }
  if (!writer) {
    setExportingAudio(false);
    return;
  }
  await renderAndWriteAudioExport(writer);
}

async function renderAndWriteAudioExport(writer: AudioExportWriter): Promise<void> {
  if (!loadedSoundBank || !synthesizer) {
    setExportingAudio(false);
    showStatus("The active SoundFont is not ready for export.");
    writer.abort("The active SoundFont is not ready for export.");
    return;
  }

  try {
    showStatus("Rendering the audible tracks to WAV…");
    const enabledTrackIds = getAudibleMidiTrackIds();
    const sampleRate = 44_100;
    const tailSeconds = 3;
    const audioLayers = getExportAudioLayers();
    const endSeconds = Math.max(
      midiDocument.duration + tailSeconds,
      ...audioLayers.map((layer) => layer.offset + layer.buffer.duration)
    );
    const offlineContext = new OfflineAudioContext(
      2,
      Math.ceil(endSeconds * sampleRate),
      sampleRate
    );
    for (const layer of audioLayers) {
      const source = offlineContext.createBufferSource();
      const gain = offlineContext.createGain();
      source.buffer = layer.buffer;
      gain.gain.value = layer.gain;
      source.connect(gain).connect(offlineContext.destination);
      source.start(Math.max(0, layer.offset), Math.max(0, -layer.offset));
    }
    let offlineSynthesizer: WorkletSynthesizer | undefined;
    if (enabledTrackIds.size > 0) {
      const playbackBinary = buildPlaybackMidi(
        midiDocument.original,
        midiDocument.tracks,
        enabledTrackIds,
        {
          patchOverrides: getTrackPatchOverrides()
        }
      );
      const exportMidi = BasicMIDI.fromArrayBuffer(
        playbackBinary.slice(0),
        fileName
      );
      await offlineContext.audioWorklet.addModule(workletUri);
      const snapshot = await synthesizer.getSnapshot();
      offlineSynthesizer = new WorkletSynthesizer(offlineContext);
      offlineSynthesizer.connect(offlineContext.destination);
      await offlineSynthesizer.startOfflineRender({
        midiSequence: exportMidi,
        snapshot,
        loopCount: 0,
        soundBankList: [
          {
            bankOffset: 0,
            soundBankBuffer: loadedSoundBank.slice(0)
          }
        ],
        sequencerOptions: {
          skipToFirstNoteOn: false,
          initialPlaybackRate: 1
        }
      });
    }
    const rendered = await offlineContext.startRendering();
    offlineSynthesizer?.destroy();
    const wave = audioBufferToWav(rendered, { normalizeAudio: false });
    const waveBytes = new Uint8Array(await wave.arrayBuffer());
    const chunkSize = 256 * 1024;
    const totalChunks = Math.ceil(waveBytes.byteLength / chunkSize);

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * chunkSize;
      const chunk = waveBytes.subarray(
        start,
        Math.min(waveBytes.byteLength, start + chunkSize)
      );
      showStatus(
        `Writing WAV… ${Math.round(((chunkIndex + 1) / totalChunks) * 100)}%`
      );
      await writer.write(chunk);
    }
    const savedName = await writer.finish();
    setExportingAudio(false);
    showStatus(`${savedName ?? "WAV export"} is ready.`);
    window.setTimeout(hideStatus, 2600);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Audio export failed.";
    setExportingAudio(false);
    showStatus(`Audio export failed: ${message}`);
    writer.abort(`Audio export failed: ${message}`);
  }
}

function setExportingAudio(exporting: boolean): void {
  exportingAudio = exporting;
  if (!exporting) retireIdleEngine();
  exportButton.disabled = exporting;
  exportButton.setAttribute("aria-busy", String(exporting));
  exportButton.querySelector("span")!.textContent = exporting
    ? "Exporting…"
    : "Export WAV";
}

function pausePlayback(): void {
  playRequest++;
  if (!playback.playing) {
    retireIdleEngine();
    return;
  }
  const engineTime =
    !playback.rebuilding && sequencer && !sequencer.paused
      ? sequencer.currentHighResolutionTime
      : undefined;
  playback.requestPause(engineTime, midiDocument.duration);
  sequencer?.pause();
  synthesizer?.stopAll(false);
  syncAudioTracks();
  updateTransportButtons();
  retireIdleEngine();
}

function stop(): void {
  playRequest++;
  playback.requestPause(undefined, midiDocument.duration);
  sequencer?.pause();
  synthesizer?.stopAll(true);
  seekToStart();
  syncAudioTracks();
  updateTransportButtons();
  retireIdleEngine();
}

function seekToStart(): void {
  const nextView = resetViewWindowToStart(
    viewStart,
    viewEnd,
    midiDocument.duration
  );
  viewStart = nextView.start;
  viewEnd = nextView.end;
  seekTo(0);
}

function seekTo(time: number, engineTime = time): void {
  playback.seek(time, engineTime, midiDocument.duration);
  if (sequencer && !playback.rebuilding) {
    playback.engineSeekPending = seekTransport(
      sequencer,
      playback.pendingEngineTime
    );
    if (playback.playing && !sequencer.paused) {
      chaseActiveNotes(playback.currentTime);
    }
  } else {
    playback.engineSeekPending = true;
  }
  updateReadouts();
  renderCanvas();
}

function chaseActiveNotes(
  time: number,
  candidateTracks: TrackModel[] = tracks
): void {
  if (!synthesizer) {
    return;
  }
  const audibleCandidates = tracksWithAudibility(candidateTracks);
  for (const note of getActiveNotesAtTime(audibleCandidates, time)) {
    synthesizer.noteOn(note.channel, note.midi, note.velocity);
  }
}

function updateFrame(): void {
  animationFrame = 0;
  if (destroyed) return;
  if (playback.playing && sequencer && !sequencer.paused) {
    playback.updateFromEngine(
      sequencer.currentHighResolutionTime,
      midiDocument.duration
    );
    if (followPlayhead) {
      const nextView = followPlaybackView(
        playback.currentTime,
        viewStart,
        viewEnd,
        midiDocument.duration
      );
      viewStart = nextView.start;
      viewEnd = nextView.end;
    }
    updateReadouts();
    renderCanvas();
  }
  syncAudioTracks();
  if (playback.playing) animationFrame = requestAnimationFrame(updateFrame);
}

let reportedPlaying = false;

function updateTransportButtons(): void {
  if (destroyed) return;
  if (playback.playing && !animationFrame) {
    animationFrame = requestAnimationFrame(updateFrame);
  } else if (!playback.playing && animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  }
  const playing = playback.playing;
  if (playing !== reportedPlaying) {
    reportedPlaying = playing;
    host.onPlaybackChange?.(playing);
  }
  playIcon.toggleAttribute("hidden", playing);
  pauseIcon.toggleAttribute("hidden", !playing);
  playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
  playButton.title = playing ? "Pause (Space)" : "Play (Space)";
}

function toggleFollowPlayhead(): void {
  followPlayhead = !followPlayhead;
  persistWebviewState();
  updateFollowPlayheadButton();
  if (followPlayhead && playback.playing) {
    revealPlayhead();
  }
}

function updateFollowPlayheadButton(): void {
  followPlayheadButton.setAttribute(
    "aria-pressed",
    String(followPlayhead)
  );
  followPlayheadButton.setAttribute(
    "aria-label",
    `Follow playhead, ${followPlayhead ? "on" : "off"}`
  );
  followPlayheadButton.title =
    "Keep playhead visible during playback";
  followPlayheadState.textContent = followPlayhead ? "On" : "Off";
}

function persistWebviewState(): void {
  const state = {
    presetDefaultsVersion: CURRENT_PRESET_DEFAULTS_VERSION,
    followPlayhead,
    viewMode,
    arrangementTrackHeight,
    arrangementTrackHeightManual,
    pianoRollRowHeight,
    tracks: collectViewerTrackState(tracks)
  } satisfies PersistedViewerState;
  host.saveState?.(state);
}

function setViewMode(nextMode: ViewerMode): void {
  if (viewMode === nextMode) {
    return;
  }
  viewMode = nextMode;
  updateViewMode();
  renderTrackList();
  updateCanvasSize();
  renderCanvas();
  persistWebviewState();
  host.persistViewMode?.(viewMode);
}

function updateViewMode(): void {
  const shell = app.querySelector<HTMLElement>(".app-shell");
  shell?.setAttribute("data-view-mode", viewMode);
  app.style.setProperty(
    "--arrangement-track-height",
    `${arrangementTrackHeight}px`
  );
  pianoRollModeButton.setAttribute(
    "aria-pressed",
    String(viewMode === "piano-roll")
  );
  arrangementModeButton.setAttribute(
    "aria-pressed",
    String(viewMode === "arrangement")
  );
  verticalScaleControl.title =
    viewMode === "arrangement" ? "Track height" : "Piano roll row height";
  viewHeightSlider.min = viewMode === "arrangement" ? "52" : "6";
  viewHeightSlider.max = viewMode === "arrangement" ? "180" : "24";
  viewHeightSlider.step = viewMode === "arrangement" ? "4" : "1";
  viewHeightSlider.value = String(
    viewMode === "arrangement"
      ? arrangementTrackHeight
      : pianoRollRowHeight
  );
  viewHeightSlider.setAttribute(
    "aria-label",
    viewMode === "arrangement"
      ? "Arrangement track height"
      : "Piano roll row height"
  );
  canvas.setAttribute(
    "aria-label",
    viewMode === "arrangement"
      ? "MIDI track arrangement. Click to seek."
      : "Multi-track MIDI piano roll. Click a note to restart it, or click empty space to seek."
  );
  if (viewMode === "piano-roll") {
    canvasScroll.scrollTop = 0;
  }
}

function updateCanvasSize(): void {
  if (!canvas || !canvasScroll) {
    return;
  }
  if (viewMode === "arrangement") {
    if (!arrangementTrackHeightManual && canvasScroll.clientHeight > 0) {
      const count = Math.max(1, tracks.length + audioTracks.length);
      arrangementTrackHeight = clamp(
        Math.floor((canvasScroll.clientHeight - getCanvasHeaderHeight()) / count),
        52,
        DEFAULT_ARRANGEMENT_TRACK_HEIGHT
      );
      app.style.setProperty("--arrangement-track-height", `${arrangementTrackHeight}px`);
      viewHeightSlider.value = String(arrangementTrackHeight);
    }
    canvas.style.height = `${getArrangementCanvasHeight(
      tracks.length + audioTracks.length,
      arrangementTrackHeight,
      getCanvasHeaderHeight(),
      canvasScroll.clientHeight
    )}px`;
  } else {
    canvas.style.height = `${getPianoRollCanvasHeight(
      Math.max(1, maxPitch - minPitch + 1),
      pianoRollRowHeight,
      getCanvasHeaderHeight(),
      canvasScroll.clientHeight
    )}px`;
  }
}

function getCanvasHeaderHeight(): number {
  if (viewMode !== "arrangement") {
    return 28;
  }
  return (
    app
      .querySelector<HTMLElement>(".section-heading")
      ?.getBoundingClientRect().height ?? 39
  );
}

function revealPlayhead(): void {
  const nextView = followPlaybackView(
    playback.currentTime,
    viewStart,
    viewEnd,
    midiDocument.duration
  );
  viewStart = nextView.start;
  viewEnd = nextView.end;
  renderCanvas();
}

function updateReadouts(): void {
  scrubber.value = String(playback.currentTime);
  timeReadout.textContent = formatTime(playback.currentTime);
  positionReadout.textContent = formatMusicalPosition(playback.currentTime);
}

function zoomView(
  factor: number,
  anchorTime = playback.currentTime,
  anchorRatio?: number
): void {
  const duration = midiDocument.duration;
  const currentWindow = viewEnd - viewStart;
  const resolvedRatio =
    anchorRatio ??
    (anchorTime >= viewStart && anchorTime <= viewEnd && currentWindow > 0
      ? (anchorTime - viewStart) / currentWindow
      : 0.5);
  const nextView = zoomViewWindow(
    anchorTime,
    resolvedRatio,
    factor,
    viewStart,
    viewEnd,
    duration
  );
  viewStart = nextView.start;
  viewEnd = nextView.end;
  renderCanvas();
}

function updatePitchRange(): void {
  const range = getMidiPitchRange(tracks);
  minPitch = range.min;
  maxPitch = range.max;
}

function renderAll(): void {
  updateReadouts();
  updateCanvasSize();
  renderCanvas();
}

function renderCanvas(): void {
  if (!canvas || !midiDocument) {
    return;
  }
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(bounds.width * dpr);
  canvas.height = Math.round(bounds.height * dpr);
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.scale(dpr, dpr);

  const styles = getComputedStyle(app);
  const background = styles.getPropertyValue("--surface-base").trim();
  const raised = styles.getPropertyValue("--surface-raised").trim();
  const border = styles.getPropertyValue("--border").trim();
  const muted = styles.getPropertyValue("--text-muted").trim();
  const text = styles.getPropertyValue("--text").trim();
  const focus = styles.getPropertyValue("--focus").trim();
  const playhead = styles.getPropertyValue("--playhead").trim() || focus;
  const pianoKeyLight = styles.getPropertyValue("--piano-key-light").trim();
  const pianoKeyDark = styles.getPropertyValue("--piano-key-dark").trim();
  const pianoKeyBorder = styles.getPropertyValue("--piano-key-border").trim();
  const pianoKeyLabel = styles.getPropertyValue("--piano-key-label").trim();
  const interfaceFont =
    styles.getPropertyValue("--interface-font").trim() || "monospace";
  // Canvas labels follow the player's type size, which shrinks on narrow players.
  // Container queries style .app-shell, not #app, so read it there.
  const shell = app.querySelector<HTMLElement>(".app-shell");
  canvasLabelSize =
    (shell && getComputedStyle(shell).getPropertyValue("--canvas-label-size").trim()) ||
    "10px";
  const width = bounds.width;
  const height = bounds.height;
  if (viewMode === "arrangement") {
    renderArrangementCanvas(context, {
      width,
      height,
      background,
      raised,
      border,
      muted,
      playhead,
      interfaceFont
    });
    return;
  }
  const headerHeight = 28;
  const keyboardWidth = 48;
  const gridWidth = Math.max(1, width - keyboardWidth);
  const gridHeight = Math.max(1, height - headerHeight);
  const pitchCount = Math.max(1, maxPitch - minPitch + 1);
  const rowHeight = gridHeight / pitchCount;
  const windowDuration = Math.max(0.001, viewEnd - viewStart);

  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = raised;
  context.fillRect(0, 0, width, headerHeight);
  context.fillRect(0, headerHeight, keyboardWidth, gridHeight);

  for (let pitch = minPitch; pitch <= maxPitch; pitch++) {
    const y = headerHeight + (maxPitch - pitch) * rowHeight;
    const pitchClass = pitch % 12;
    const black = [1, 3, 6, 8, 10].includes(pitchClass);
    context.fillStyle = pianoKeyLight;
    context.fillRect(0, y, keyboardWidth, Math.max(1, rowHeight - 0.5));
    if (black) {
      context.fillStyle =
        "color-mix(in oklch, " + raised + ", " + background + " 45%)";
      context.fillRect(keyboardWidth, y, gridWidth, rowHeight);
      context.fillStyle = pianoKeyDark;
      context.fillRect(0, y, keyboardWidth * 0.62, Math.max(1, rowHeight - 0.5));
    }
    context.strokeStyle = border;
    context.globalAlpha = 0.24;
    context.beginPath();
    context.moveTo(keyboardWidth, y);
    context.lineTo(width, y);
    context.stroke();
    context.globalAlpha = 1;
    if (pitchClass === 0 && rowHeight >= 5) {
      context.fillStyle = pianoKeyLabel;
      context.font = `${canvasLabelSize} ${interfaceFont}`;
      context.textBaseline = "middle";
      context.fillText(`C${Math.floor(pitch / 12) - 1}`, 4, y + rowHeight / 2);
    }
  }
  context.strokeStyle = pianoKeyBorder;
  context.globalAlpha = 1;
  context.beginPath();
  context.moveTo(keyboardWidth - 0.5, headerHeight);
  context.lineTo(keyboardWidth - 0.5, height);
  context.stroke();

  drawMusicalRuler(context, {
    xOrigin: keyboardWidth,
    contentWidth: gridWidth,
    height,
    headerHeight,
    border,
    muted,
    interfaceFont
  });

  context.save();
  context.beginPath();
  context.rect(keyboardWidth, headerHeight, gridWidth, gridHeight);
  context.clip();

  const audibleTrackIds = getAudibleMidiTrackIds();
  for (const track of tracks) {
    if (!audibleTrackIds.has(track.id)) {
      continue;
    }
    for (const note of track.notes) {
      const noteEnd = note.time + Math.max(note.duration, 0.004);
      if (noteEnd < viewStart || note.time > viewEnd) {
        continue;
      }
      const x =
        keyboardWidth +
        ((note.time - viewStart) / windowDuration) * gridWidth;
      const noteWidth = Math.max(
        1.5,
        (Math.max(note.duration, 0.004) / windowDuration) * gridWidth
      );
      const y =
        headerHeight +
        (maxPitch - note.midi) * rowHeight +
        rowHeight * 0.14;
      const noteHeight = Math.max(1.5, rowHeight * 0.72);
      const noteInset = Math.min(0.35, noteWidth * 0.12);
      const drawWidth = Math.max(1, noteWidth - noteInset * 2);
      const radius = Math.min(2.5, drawWidth / 2, noteHeight / 2);
      context.fillStyle = track.color;
      context.globalAlpha = 0.42 + note.velocity * 0.58;
      context.beginPath();
      context.roundRect(x + noteInset, y, drawWidth, noteHeight, radius);
      context.fill();
      context.globalAlpha = 1;
    }
  }
  context.restore();

  const playheadX =
    keyboardWidth +
    ((playback.currentTime - viewStart) / windowDuration) * gridWidth;
  if (playheadX >= keyboardWidth && playheadX <= width) {
    context.strokeStyle = playhead;
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(playheadX, 0);
    context.lineTo(playheadX, height);
    context.stroke();
    context.fillStyle = playhead;
    context.beginPath();
    context.moveTo(playheadX - 5, 0);
    context.lineTo(playheadX + 5, 0);
    context.lineTo(playheadX, 7);
    context.closePath();
    context.fill();
  }

  context.strokeStyle = border;
  context.globalAlpha = 0.9;
  context.beginPath();
  context.moveTo(keyboardWidth, 0);
  context.lineTo(keyboardWidth, height);
  context.moveTo(0, headerHeight);
  context.lineTo(width, headerHeight);
  context.stroke();
  context.globalAlpha = 1;
}

function renderArrangementCanvas(
  context: CanvasRenderingContext2D,
  palette: {
    width: number;
    height: number;
    background: string;
    raised: string;
    border: string;
    muted: string;
    playhead: string;
    interfaceFont: string;
  }
): void {
  const {
    width,
    height,
    background,
    raised,
    border,
    muted,
    playhead,
    interfaceFont
  } = palette;
  const headerHeight = getCanvasHeaderHeight();
  const windowDuration = Math.max(0.001, viewEnd - viewStart);

  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = raised;
  context.fillRect(0, 0, width, headerHeight);

  const audibleTrackIds = getAudibleMidiTrackIds();
  drawAudioLanes(context, width, headerHeight, border);
  tracks.forEach((track, trackIndex) => {
    const laneY =
      headerHeight + trackLaneIndex("midi", trackIndex) * arrangementTrackHeight;
    context.fillStyle = track.color;
    context.globalAlpha = audibleTrackIds.has(track.id) ? 0.08 : 0.025;
    context.fillRect(0, laneY, width, arrangementTrackHeight);
    context.globalAlpha = 1;
    context.strokeStyle = border;
    context.globalAlpha = 0.75;
    context.beginPath();
    context.moveTo(0, laneY + arrangementTrackHeight - 0.5);
    context.lineTo(width, laneY + arrangementTrackHeight - 0.5);
    context.stroke();
    context.globalAlpha = 1;

    if (!audibleTrackIds.has(track.id)) {
      return;
    }
    let trackMinPitch = 127;
    let trackMaxPitch = 0;
    for (const note of track.notes) {
      trackMinPitch = Math.min(trackMinPitch, note.midi);
      trackMaxPitch = Math.max(trackMaxPitch, note.midi);
    }
    if (track.notes.length === 0) {
      trackMinPitch = 0;
      trackMaxPitch = 127;
    }
    for (const note of track.notes) {
      const noteEnd = note.time + Math.max(note.duration, 0.004);
      if (noteEnd < viewStart || note.time > viewEnd) {
        continue;
      }
      const rect = getArrangementNoteRect(
        note,
        trackMinPitch,
        trackMaxPitch,
        trackLaneIndex("midi", trackIndex),
        arrangementTrackHeight,
        headerHeight,
        width,
        viewStart,
        viewEnd
      );
      context.fillStyle = track.color;
      context.globalAlpha = 0.5 + note.velocity * 0.5;
      context.beginPath();
      context.roundRect(
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        Math.min(2, rect.height / 2, rect.width / 2)
      );
      context.fill();
      context.globalAlpha = 1;
    }
  });

  drawMusicalRuler(context, {
    xOrigin: 0,
    contentWidth: width,
    height,
    headerHeight,
    border,
    muted,
    interfaceFont
  });

  const playheadX =
    ((playback.currentTime - viewStart) / windowDuration) * width;
  if (playheadX >= 0 && playheadX <= width) {
    context.strokeStyle = playhead;
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(playheadX, 0);
    context.lineTo(playheadX, height);
    context.stroke();
    context.fillStyle = playhead;
    context.beginPath();
    context.moveTo(playheadX - 5, 0);
    context.lineTo(playheadX + 5, 0);
    context.lineTo(playheadX, 7);
    context.closePath();
    context.fill();
  }

  context.strokeStyle = border;
  context.globalAlpha = 0.9;
  context.beginPath();
  context.moveTo(0, headerHeight - 0.5);
  context.lineTo(width, headerHeight - 0.5);
  context.stroke();
  context.globalAlpha = 1;
}

/** Solo is page-wide: soloing a recording silences unsoloed MIDI tracks and vice versa. */
function anyTrackSoloedAnywhere(): boolean {
  return hasSoloedTracks(tracks) || hasSoloedTracks(audioTracks);
}

function getAudibleMidiTrackIds(): Set<string> {
  const anyTrackSoloed = anyTrackSoloedAnywhere();
  return new Set(
    tracks
      .filter((track) => isTrackAudible(track, anyTrackSoloed))
      .map((track) => track.id)
  );
}

/** See getEngineTrackIds: keep a timed sequence loaded even when nothing MIDI is audible. */
function getEngineMidiTrackIds(): Set<string> {
  const audible = getAudibleMidiTrackIds();
  return audible.size > 0 ? audible : getEngineTrackIds(tracks);
}

function getAudibleAudioTracks(): AudioTrackModel[] {
  const anyTrackSoloed = anyTrackSoloedAnywhere();
  return audioTracks.filter((track) => isTrackAudible(track, anyTrackSoloed));
}

function findAnyTrack(id: string | undefined): TrackModel | AudioTrackModel | undefined {
  return (
    tracks.find((candidate) => candidate.id === id) ??
    audioTracks.find((candidate) => candidate.id === id)
  );
}

function applyAudioTrackStates(): void {
  const audible = new Set(getAudibleAudioTracks());
  for (const track of audioTracks) {
    track.output?.gain.setTargetAtTime(
      audible.has(track) ? clamp(track.gain, 0, 1) : 0,
      track.output.context.currentTime,
      0.01
    );
  }
}

let previousClockSample: ClockSample | undefined;

function syncAudioTracks(): void {
  if (audioTracks.length === 0) {
    return;
  }
  const context = audioContext;
  const masterRunning = Boolean(
    context &&
      playback.playing &&
      !playback.rebuilding &&
      sequencer &&
      !sequencer.paused
  );
  const masterTime =
    masterRunning && sequencer
      ? sequencer.currentHighResolutionTime
      : playback.currentTime;
  const clockSample =
    masterRunning && context
      ? { contextTime: context.currentTime, masterTime }
      : undefined;
  const masterSettled = Boolean(
    clockSample && isMasterClockSettled(previousClockSample, clockSample)
  );
  previousClockSample = clockSample;
  for (const track of audioTracks) {
    if (!track.buffer) {
      continue;
    }
    if (track.source && track.source.context !== context) {
      stopAudioSource(track);
    }
    const plan = planAudioSync({
      masterTime,
      masterRunning,
      masterSettled,
      offset: track.offset,
      duration: track.buffer.duration,
      sourcePosition:
        track.source && context
          ? track.sourceBufferOffset + (context.currentTime - track.sourceStartTime)
          : undefined
    });
    if (plan.action === "stop") {
      stopAudioSource(track);
    } else if (plan.action === "start" && context) {
      stopAudioSource(track);
      startAudioSource(track, context, plan.delay, plan.bufferOffset);
    }
  }
}

function startAudioSource(
  track: AudioTrackModel,
  context: AudioContext,
  delay: number,
  bufferOffset: number
): void {
  if (!track.buffer) {
    return;
  }
  if (!track.output || track.output.context !== context) {
    track.output?.disconnect();
    track.output = context.createGain();
    track.output.connect(context.destination);
    applyAudioTrackStates();
  }
  const source = context.createBufferSource();
  source.buffer = track.buffer;
  source.connect(track.output);
  const startTime = context.currentTime + delay;
  source.start(startTime, bufferOffset);
  source.addEventListener("ended", () => {
    if (track.source === source) {
      track.source = undefined;
    }
  });
  track.source = source;
  track.sourceStartTime = startTime;
  track.sourceBufferOffset = bufferOffset;
}

function stopAudioSource(track: AudioTrackModel): void {
  const source = track.source;
  track.source = undefined;
  if (!source) {
    return;
  }
  try {
    source.stop();
  } catch {
    // Already stopped.
  }
  source.disconnect();
}

async function loadAudioTrack(track: AudioTrackModel): Promise<void> {
  try {
    const bytes = await fetchArrayBuffer(track.url, track.label);
    if (destroyed) return;
    const decoder = new OfflineAudioContext(2, 1, AUDIO_DECODE_SAMPLE_RATE);
    const buffer = await decoder.decodeAudioData(bytes);
    if (destroyed) {
      return;
    }
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
      buffer.getChannelData(index)
    );
    track.buffer = buffer;
    track.peaks = computeWaveformPeaks(
      channels,
      Math.max(1, Math.round(buffer.duration * WAVEFORM_BINS_PER_SECOND))
    );
    track.status = "ready";
  } catch {
    track.status = "error";
  }
  if (!destroyed) {
    renderTrackList();
    renderCanvas();
  }
}

function getExportAudioLayers(): Array<{ buffer: AudioBuffer; offset: number; gain: number }> {
  return getAudibleAudioTracks().flatMap((track) =>
    track.buffer
      ? [{ buffer: track.buffer, offset: track.offset, gain: clamp(track.gain, 0, 1) }]
      : []
  );
}

function drawAudioLanes(
  context: CanvasRenderingContext2D,
  width: number,
  headerHeight: number,
  border: string
): void {
  const audible = new Set(getAudibleAudioTracks());
  const windowDuration = Math.max(0.001, viewEnd - viewStart);
  audioTracks.forEach((track, index) => {
    const laneY = headerHeight + trackLaneIndex("audio", index) * arrangementTrackHeight;
    const isAudible = audible.has(track);
    context.fillStyle = track.color;
    context.globalAlpha = isAudible ? 0.08 : 0.025;
    context.fillRect(0, laneY, width, arrangementTrackHeight);
    context.globalAlpha = 0.75;
    context.strokeStyle = border;
    context.beginPath();
    context.moveTo(0, laneY + arrangementTrackHeight - 0.5);
    context.lineTo(width, laneY + arrangementTrackHeight - 0.5);
    context.stroke();
    context.globalAlpha = 1;
    const peaks = track.peaks;
    if (!peaks || !track.buffer) {
      return;
    }
    const centerY = laneY + arrangementTrackHeight / 2;
    const halfHeight = Math.max(4, arrangementTrackHeight / 2 - 8);
    context.fillStyle = track.color;
    context.globalAlpha = isAudible ? 0.85 : 0.3;
    const secondsPerBin = track.buffer.duration / peaks.length;
    for (let x = 0; x < width; x++) {
      const start = viewStart + (x / width) * windowDuration - track.offset;
      const end = viewStart + ((x + 1) / width) * windowDuration - track.offset;
      const firstBin = Math.max(0, Math.floor(start / secondsPerBin));
      const lastBin = Math.min(peaks.length, Math.ceil(end / secondsPerBin));
      let peak = 0;
      for (let bin = firstBin; bin < lastBin; bin++) {
        peak = Math.max(peak, peaks[bin] ?? 0);
      }
      if (peak > 0) {
        const barHeight = Math.max(1, peak * halfHeight);
        context.fillRect(x, centerY - barHeight, 1, barHeight * 2);
      }
    }
    context.globalAlpha = 1;
  });
}

/**
 * Cover art for a recording, in the spirit of the instrument photos on MIDI rows:
 * a dark stage lit in the track's color with the recording's own waveform glowing
 * across it, so vocals, drums and bass look different at a glance.
 */
function paintAudioCovers(): void {
  for (const track of audioTracks) {
    const canvas = app.querySelector<HTMLCanvasElement>(
      `canvas[data-audio-art="${CSS.escape(track.id)}"]`
    );
    if (canvas) {
      paintAudioCover(canvas, track);
    }
  }
}

function paintAudioCover(canvas: HTMLCanvasElement, track: AudioTrackModel): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const color = (alpha: number) => `rgba(${track.rgb}, ${alpha})`;

  context.fillStyle = "rgb(11, 14, 19)";
  context.fillRect(0, 0, width, height);
  const glow = context.createRadialGradient(
    width * 0.68, height * 0.38, 0,
    width * 0.68, height * 0.38, width * 0.62
  );
  glow.addColorStop(0, color(0.34));
  glow.addColorStop(0.55, color(0.1));
  glow.addColorStop(1, color(0));
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  const centerY = height * 0.4;
  const reach = height * 0.3;
  const peaks = track.peaks;
  if (!peaks || peaks.length === 0) {
    context.strokeStyle = color(0.45);
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, centerY);
    context.lineTo(width, centerY);
    context.stroke();
    return;
  }

  const barWidth = 2;
  const gap = 1.5;
  const bars = Math.max(1, Math.floor(width / (barWidth + gap)));
  let loudest = 0;
  for (const value of peaks) {
    loudest = Math.max(loudest, value);
  }
  const bar = context.createLinearGradient(0, centerY - reach, 0, centerY + reach);
  bar.addColorStop(0, color(0.25));
  bar.addColorStop(0.5, color(0.95));
  bar.addColorStop(1, color(0.25));
  context.fillStyle = bar;
  context.shadowColor = color(0.7);
  context.shadowBlur = 6;
  for (let index = 0; index < bars; index++) {
    const from = Math.floor((index / bars) * peaks.length);
    const to = Math.max(from + 1, Math.floor(((index + 1) / bars) * peaks.length));
    let peak = 0;
    for (let bin = from; bin < to; bin++) {
      peak = Math.max(peak, peaks[bin] ?? 0);
    }
    // Normalized with a gentle curve so quiet stems still read as shapes.
    const level = loudest > 0 ? Math.pow(peak / loudest, 0.7) : 0;
    const half = Math.max(0.75, level * reach);
    context.fillRect(index * (barWidth + gap), centerY - half, barWidth, half * 2);
  }
  context.shadowBlur = 0;
}

function describeAudioTrack(track: AudioTrackModel): string {
  if (track.status === "loading") {
    return "Audio · loading…";
  }
  if (track.status === "error") {
    return "Audio · could not be loaded";
  }
  const offset = track.offset
    ? ` · starts ${track.offset > 0 ? "+" : ""}${track.offset.toFixed(2)} s`
    : "";
  return `Audio${offset}`;
}

function renderAudioTrackRow(
  track: AudioTrackModel,
  index: number,
  anyTrackSoloed: boolean
): string {
  const percent = Math.round(track.gain * 100);
  return `
    <div
      class="track-row track-row-audio"
      style="--track-rgb: ${track.rgb}"
      data-track-id="${escapeHtml(track.id)}"
      data-enabled="${isTrackAudible(track, anyTrackSoloed)}"
      data-muted="${!track.enabled}"
      data-solo="${track.solo}"
    >
      <span class="track-cover track-cover-audio">
        <canvas class="track-audio-art" data-audio-art="${escapeHtml(track.id)}" aria-hidden="true"></canvas>
        <span class="track-cover-number">[A${index + 1}]</span>
        <span class="track-name" title="${escapeHtml(track.label)}">${escapeHtml(track.label)}</span>
        <span class="track-copy">
          <span class="track-meta">${describeAudioTrack(track)}</span>
        </span>
      </span>
      <span class="track-state">
        <span class="track-mix-buttons" role="group" aria-label="${escapeHtml(track.label)} playback controls">
          <button
            class="track-mix-button track-mute"
            type="button"
            aria-pressed="${!track.enabled}"
            aria-label="${track.enabled ? "Mute" : "Unmute"} ${escapeHtml(track.label)}"
            title="${track.enabled ? "Mute" : "Unmute"} ${escapeHtml(track.label)}"
          >M</button>
          <button
            class="track-mix-button track-solo"
            type="button"
            aria-pressed="${track.solo}"
            aria-label="${track.solo ? "Unsolo" : "Solo"} ${escapeHtml(track.label)}"
            title="${track.solo ? "Unsolo" : "Solo"} ${escapeHtml(track.label)}"
          >S</button>
        </span>
        <label class="track-volume" data-boosted="false" title="Track volume: ${describeTrackVolume(track.gain)}">
          <span class="track-volume-header" aria-hidden="true">
            <span>Vol</span>
            <span class="track-volume-value">${percent}</span>
          </span>
          <input
            class="track-volume-slider"
            type="range"
            min="0"
            max="100"
            step="1"
            value="${percent}"
            aria-label="${escapeHtml(track.label)} volume"
            aria-valuetext="${describeTrackVolume(track.gain)}"
          >
        </label>
      </span>
    </div>
  `;
}

function tracksWithAudibility(
  sourceTracks: TrackModel[] = tracks
): TrackModel[] {
  const anyTrackSoloed = anyTrackSoloedAnywhere();
  return sourceTracks.map((track) => ({
    ...track,
    enabled: isTrackAudible(track, anyTrackSoloed)
  }));
}

function drawMusicalRuler(
  context: CanvasRenderingContext2D,
  options: {
    xOrigin: number;
    contentWidth: number;
    height: number;
    headerHeight: number;
    border: string;
    muted: string;
    interfaceFont: string;
  }
): void {
  const {
    xOrigin,
    contentWidth,
    height,
    headerHeight,
    border,
    muted,
    interfaceFont
  } = options;
  const windowDuration = Math.max(0.001, viewEnd - viewStart);
  const quarter = midiDocument.ppq;
  const centerTick = midiDocument.original.secondsToMIDITicks(
    (viewStart + viewEnd) / 2
  );
  const quarterStart = midiDocument.original.midiTicksToSeconds(centerTick);
  const quarterEnd = midiDocument.original.midiTicksToSeconds(
    centerTick + quarter
  );
  const quarterWidth =
    (Math.abs(quarterEnd - quarterStart) / windowDuration) * contentWidth;
  const subdivision = chooseRulerSubdivision(quarterWidth);
  const tickStep = quarter / subdivision;
  const startTick = Math.max(
    0,
    Math.floor(
      midiDocument.original.secondsToMIDITicks(viewStart) / tickStep
    ) * tickStep
  );
  const endTick =
    midiDocument.original.secondsToMIDITicks(viewEnd) + tickStep;
  context.font = `${canvasLabelSize} ${interfaceFont}`;
  context.textBaseline = "middle";
  let lastGridX = -Infinity;
  let lastLabelX = -Infinity;

  for (let tick = startTick; tick <= endTick; tick += tickStep) {
    const seconds = midiDocument.original.midiTicksToSeconds(tick);
    const x =
      xOrigin + ((seconds - viewStart) / windowDuration) * contentWidth;
    if (x < xOrigin - 1 || x > xOrigin + contentWidth + 1) {
      continue;
    }
    const measures = ticksToMeasures(
      tick,
      midiDocument.ppq,
      midiDocument.timeSignatures
    );
    const isMeasure = Math.abs(measures - Math.round(measures)) < 0.001;
    const quarterPosition = tick / quarter;
    const isBeat =
      Math.abs(quarterPosition - Math.round(quarterPosition)) < 0.001;
    const kind = isMeasure
      ? "measure"
      : isBeat
        ? "beat"
        : "subdivision";

    if ((isMeasure || isBeat) && (isMeasure || x - lastGridX >= 4)) {
      context.strokeStyle = border;
      context.globalAlpha = isMeasure ? 0.52 : 0.14;
      context.lineWidth = isMeasure ? 1 : 0.5;
      context.beginPath();
      context.moveTo(x, isMeasure ? 0 : headerHeight);
      context.lineTo(x, height);
      context.stroke();
      lastGridX = x;
    }

    context.strokeStyle = border;
    context.globalAlpha = isMeasure ? 0.8 : isBeat ? 0.58 : 0.34;
    context.lineWidth = isMeasure ? 1 : 0.75;
    context.beginPath();
    context.moveTo(x, headerHeight - getRulerTickLength(kind));
    context.lineTo(x, headerHeight);
    context.stroke();
    context.globalAlpha = 1;

    if (isMeasure && x - lastLabelX >= 44) {
      context.fillStyle = muted;
      context.fillText(String(Math.round(measures) + 1), x + 5, headerHeight / 2);
      lastLabelX = x;
    }
  }
  context.globalAlpha = 1;
}

function setSoundFontState(state: SoundFontState, message: string): void {
  soundFontState = state;
  soundFontButton.dataset.state = state;
  updateSoundFontControl();
  showStatus(message);
  updateTransportButtons();
}

function updateSoundFontControl(): void {
  soundFontModeElement.textContent = soundFontIsCustom
    ? "Custom"
    : "Default";
  soundFontButton.setAttribute(
    "aria-label",
    `SoundFont: ${soundFontLabel}. Open SoundFont menu`
  );
  defaultSoundFontOption.setAttribute(
    "aria-checked",
    String(!soundFontIsCustom)
  );
  customSoundFontOption.setAttribute(
    "aria-checked",
    String(soundFontIsCustom)
  );
}

function toggleSoundFontMenu(): void {
  const nextOpen = soundFontMenu.hidden;
  soundFontMenu.hidden = !nextOpen;
  soundFontButton.setAttribute("aria-expanded", String(nextOpen));
  if (nextOpen) {
    hideStatus();
    (soundFontIsCustom
      ? customSoundFontOption
      : defaultSoundFontOption
    ).focus();
  }
}

function closeSoundFontMenu(): void {
  soundFontMenu.hidden = true;
  soundFontButton.setAttribute("aria-expanded", "false");
}

function showStatus(message: string): void {
  statusToast.textContent = message;
  statusToast.hidden = false;
}

function hideStatus(): void {
  statusToast.hidden = true;
}

function renderEmptyState(): void {
  app.innerHTML = `
    <section class="empty-screen" role="status">
      <div aria-hidden="true">♪</div>
      <div>
        <strong>No playable notes found</strong>
        <span>${escapeHtml(fileName)} contains no paired note-on and note-off events to display.</span>
      </div>
    </section>
  `;
  app.setAttribute("aria-busy", "false");
}

function renderError(error: unknown): void {
  const reason =
    error instanceof Error ? error.message : "The file is not a supported MIDI sequence.";
  app.innerHTML = `
    <section class="error-screen" role="alert">
      <div aria-hidden="true">!</div>
      <div>
        <strong>MIDI could not be opened</strong>
        <span>${escapeHtml(reason)} Check that the file is a valid .mid or .midi file.</span>
      </div>
    </section>
  `;
  app.setAttribute("aria-busy", "false");
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const milliseconds = Math.floor((safe % 1) * 1000);
  return `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function formatMusicalPosition(seconds: number): string {
  const ticks = midiDocument.original.secondsToMIDITicks(seconds);
  const measures = ticksToMeasures(
    ticks,
    midiDocument.ppq,
    midiDocument.timeSignatures
  );
  const bar = Math.floor(measures) + 1;
  const signature = signatureAtTick(
    ticks,
    midiDocument.timeSignatures
  );
  const beatsPerBar = signature.numerator;
  const fraction = measures - Math.floor(measures);
  const exactBeat = fraction * beatsPerBar;
  const beat = Math.floor(exactBeat) + 1;
  const subdivision = Math.floor(
    (exactBeat - Math.floor(exactBeat)) * midiDocument.ppq
  );
  return `${bar}.${beat}.${String(subdivision).padStart(3, "0")}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mergeViewerState(
  persisted: Partial<PersistedViewerState>,
  local: Partial<PersistedViewerState>
): Partial<PersistedViewerState> {
  return {
    ...persisted,
    ...local,
    tracks: {
      ...(persisted.tracks ?? {}),
      ...(local.tracks ?? {})
    }
  };
}

function requireElement<T extends Element>(selector: string): T {
  const element = app.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Required interface element is missing: ${selector}`);
  }
  return element;
}

async function fetchArrayBuffer(url: string, label: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} could not be read (HTTP ${response.status}).`);
  }
  return response.arrayBuffer();
}

return {
  get duration() {
    return midiDocument?.duration ?? 0;
  },
  get trackCount() {
    return tracks.length + audioTracks.length;
  },
  get currentTime() {
    return playback.currentTime;
  },
  get playing() {
    return playback.playing;
  },
  ready,
  play: async () => {
    await ready;
    if (!destroyed && !playback.playing && midiDocument) {
      await startPlayback();
    }
  },
  pause: () => {
    if (midiDocument) {
      pausePlayback();
    }
  },
  stop: () => {
    if (midiDocument) {
      stop();
    }
  },
  redraw: () => {
    if (midiDocument && tracks.length > 0 && !destroyed) {
      renderCanvas();
    }
  },
  seek: (seconds: number) => {
    if (midiDocument) {
      seekTo(clamp(seconds, 0, midiDocument.duration));
    }
  },
  setSoundFont: (source: SoundFontSource) => {
    if (destroyed) return;
    playRequest++;
    soundFontUri = source.url;
    soundFontLabel = source.label;
    soundFontIsCustom = source.custom;
    if (!midiDocument || tracks.length === 0) {
      return;
    }
    updateSoundFontControl();
    soundFontLoadPromise = loadSoundFont(soundFontUri, soundFontLabel);
    void soundFontLoadPromise;
  },
  destroy: () => {
    if (destroyed) return;
    destroyed = true;
    engineGeneration++;
    playRequest++;
    playback.finish();
    releaseEngine();
    cancelAnimationFrame(animationFrame);
    for (const track of audioTracks) {
      stopAudioSource(track);
      track.output?.disconnect();
      track.buffer = undefined;
      track.peaks = undefined;
    }
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
  }
};
}
