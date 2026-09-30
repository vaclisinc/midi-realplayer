import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { MIDIBuilder } from "spessasynth_core";

// Exercise the real player with browser/audio boundaries replaced by counted fakes.
const bundle = await build({
  entryPoints: ["src/player.ts"], bundle: true, write: false, format: "esm", platform: "node",
  plugins: [{ name: "fake-audio", setup(b) {
    b.onResolve({ filter: /^spessasynth_lib$/ }, () => ({ path: "audio", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: `
      export const WorkletSynthesizer = globalThis.testAudio.Synth;
      export const Sequencer = globalThis.testAudio.Sequence;
      export const audioBufferToWav = () => { throw Error("unexpected export"); };
    ` }));
  } }]
});

class Events {
  callbacks = new Map();
  addEvent(name, id, callback) { this.callbacks.set(name + id, callback); }
  removeEvent(name, id) { this.callbacks.delete(name + id); }
  emit(name) { for (const [id, callback] of [...this.callbacks]) if (id.startsWith(name)) callback(); }
}
class Element {
  elements = new Map(); dataset = {}; style = { setProperty() {} };
  classList = { toggle() {}, add() {}, remove() {} };
  clientWidth = 800; clientHeight = 400;
  querySelector(key) {
    if (!this.elements.has(key)) this.elements.set(key, new Element());
    return this.elements.get(key);
  }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { width: 0, height: 0 }; }
  setAttribute() {} removeAttribute() {} toggleAttribute() {}
  addEventListener() {} removeEventListener() {}
}

test("player lifecycle: 100 mounts, idle eviction, resume, stop, end, and destruction during load", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const contexts = [], synths = [], sequences = [], frames = new Set();
  let moduleGate;
  class Context {
    state = "suspended";
    audioWorklet = { addModule: async () => { if (moduleGate) await moduleGate; } };
    constructor() { contexts.push(this); }
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; }
  }
  class Synth {
    isReady = Promise.resolve(); eventHandler = new Events(); midiChannels = []; presetList = [];
    soundBankManager = { addSoundBank: async () => {} };
    constructor() { synths.push(this); }
    connect() {} stopAll() {} noteOn() {}
    destroy() { this.destroyed = true; }
  }
  class Sequence {
    paused = true; currentTime = 0; eventHandler = new Events();
    constructor() { sequences.push(this); }
    get currentHighResolutionTime() { return this.currentTime; }
    loadNewSongList() { queueMicrotask(() => this.eventHandler.emit("songChange")); }
    play() { this.paused = false; }
    pause() { this.paused = true; }
  }
  const globals = {
    testAudio: { Synth, Sequence }, AudioContext: Context,
    window: { setTimeout: (...args) => setTimeout(...args), devicePixelRatio: 1 },
    ResizeObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "", fontSize: "12px" }),
    requestAnimationFrame: (cb) => { frames.add(cb); return cb; },
    cancelAnimationFrame: (cb) => frames.delete(cb)
  };
  const previous = Object.fromEntries(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const players = [];
  try {
    const { createMidiRealPlayer } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
    const midi = new MIDIBuilder({ format: 0, initialTempo: 120, timeDivision: 480 });
    midi.noteOn(0, 0, 0, 60, 100); midi.noteOff(9600, 0, 0, 60); midi.flush(true);
    const create = (fetchSoundBank = async () => new ArrayBuffer(8)) => {
      const app = new Element();
      const player = createMidiRealPlayer({
        app, keyboardTarget: app, pointerTarget: app, midi: midi.writeMIDI(), fileName: "test.mid",
        workletUrl: "worklet.js", soundFont: { url: "bank.sf3", label: "Bank", custom: false },
        preloadSoundFont: false, host: { fetchSoundBank }
      });
      players.push(player); return player;
    };
    for (let i = 0; i < 100; i++) create();
    await Promise.all(players.map(p => p.ready));
    assert.equal(players[0].trackCount, 1);
    assert.equal(contexts.length, 0, "mounts stay lazy");
    assert.equal(frames.size, 0, "idle players do not animate");
    for (const player of players) {
      await player.play(); assert.equal(player.playing, true);
      player.pause();
      assert.ok(contexts.filter(c => c.state !== "closed").length <= 3, "at most three paused contexts remain");
    }
    t.mock.timers.tick(60_000);
    assert.equal(contexts.filter(c => c.state !== "closed").length, 3, "idle engines do not expire");
    assert.ok(contexts.slice(0, 97).every(c => c.state === "closed"));
    assert.ok(synths.slice(0, 97).every(s => s.destroyed));
    assert.equal(frames.size, 0);

    // Revisiting an older retained player refreshes its place in the idle pool.
    const retainedContext = contexts[97];
    const countBeforeResume = contexts.length;
    await players[97].play(); players[97].pause();
    assert.equal(contexts.length, countBeforeResume);
    const player = players[0];
    await player.play(); player.pause();
    assert.equal(retainedContext.state, "running");
    assert.equal(contexts[98].state, "closed", "least recently used idle engine is evicted");

    await player.play();
    const warmContext = contexts.at(-1);
    const warmSequence = sequences.at(-1);
    player.pause();
    t.mock.timers.tick(60_000);
    await player.play();
    assert.equal(contexts.at(-1), warmContext, "resume reuses a retained engine even after a minute");
    // Even repeated evictions must never remove an actively playing engine.
    const fillIdlePool = async () => {
      for (const other of players.slice(1, 4)) {
        await other.play(); other.pause();
      }
    };
    await fillIdlePool();
    assert.equal(warmContext.state, "running", "idle eviction leaves active playback intact");
    assert.equal(player.playing, true);
    assert.equal(contexts.filter(c => c.state !== "closed").length, 4, "one active plus three idle engines");

    warmSequence.currentTime = 4;
    player.pause();
    await fillIdlePool();
    assert.equal(warmContext.state, "closed");
    assert.equal(player.currentTime, 4);
    await player.play(); assert.equal(sequences.at(-1).currentTime, 4);
    player.pause();
    await fillIdlePool();
    player.seek(3); await player.play();
    assert.equal(sequences.at(-1).currentTime, 3, "seek while evicted survives rebuilding");
    const stoppedContext = contexts.at(-1);
    player.stop();
    assert.equal(player.currentTime, 0);
    assert.notEqual(stoppedContext.state, "closed", "stop keeps the engine warm");
    await fillIdlePool();
    assert.equal(stoppedContext.state, "closed");
    await player.play();
    const endedContext = contexts.at(-1);
    sequences.at(-1).eventHandler.emit("songEnded");
    assert.notEqual(endedContext.state, "closed", "finished engines stay warm");
    await fillIdlePool();
    assert.equal(endedContext.state, "closed");

    let finishFetch;
    const loading = create(() => new Promise(resolve => { finishFetch = resolve; }));
    await loading.ready;
    const playing = loading.play();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    loading.pause(); finishFetch(new ArrayBuffer(8)); await playing;
    assert.equal(loading.playing, false, "pause cancels pending play");
    t.mock.timers.tick(1000);

    let finishModule;
    moduleGate = new Promise(resolve => { finishModule = resolve; });
    const removed = create(); await removed.ready;
    const pendingPlay = removed.play();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const before = synths.length;
    removed.destroy(); finishModule(); await pendingPlay;
    assert.equal(synths.length, before, "destroyed player cannot construct a late synth");
    assert.equal(contexts.at(-1).state, "closed");
    for (const player of players) player.destroy();
    assert.ok(contexts.every(c => c.state === "closed"), "destroy also releases retained engines");
    assert.ok(synths.every(s => s.destroyed));
  } finally {
    for (const player of players) player.destroy();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
