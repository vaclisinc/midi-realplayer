import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_RESTART_SECONDS,
  computeWaveformPeaks,
  isMasterClockSettled,
  planAudioSync
} from "../src/audio-sync.ts";

const running = {
  masterTime: 10,
  masterRunning: true,
  masterSettled: true,
  offset: 0,
  duration: 60,
  sourcePosition: 10
};

test("a source in step keeps playing", () => {
  assert.deepEqual(planAudioSync(running), { action: "keep" });
  assert.deepEqual(
    planAudioSync({ ...running, sourcePosition: 10 + AUDIO_RESTART_SECONDS / 2 }),
    { action: "keep" }
  );
});

test("play starts the recording at the MIDI position", () => {
  assert.deepEqual(planAudioSync({ ...running, sourcePosition: undefined }), {
    action: "start",
    delay: 0,
    bufferOffset: 10
  });
});

test("a seek restarts the source at the new position", () => {
  assert.deepEqual(planAudioSync({ ...running, masterTime: 42 }), {
    action: "start",
    delay: 0,
    bufferOffset: 42
  });
});

test("pause stops a playing source and leaves a stopped one alone", () => {
  assert.deepEqual(planAudioSync({ ...running, masterRunning: false }), {
    action: "stop"
  });
  assert.deepEqual(
    planAudioSync({ ...running, masterRunning: false, sourcePosition: undefined }),
    { action: "keep" }
  );
});

test("a positive offset schedules the recording to start on time", () => {
  assert.deepEqual(
    planAudioSync({ ...running, offset: 10.25, sourcePosition: undefined }),
    { action: "start", delay: 0.25, bufferOffset: 0 }
  );
  assert.deepEqual(
    planAudioSync({ ...running, offset: 30, sourcePosition: undefined }),
    { action: "keep" }
  );
});

test("a scheduled future start is kept while its countdown is right", () => {
  assert.deepEqual(
    planAudioSync({ ...running, offset: 10.25, sourcePosition: -0.25 }),
    { action: "keep" }
  );
});

test("a negative offset trims the start of the recording", () => {
  assert.deepEqual(
    planAudioSync({ ...running, offset: -2, sourcePosition: undefined }),
    { action: "start", delay: 0, bufferOffset: 12 }
  );
});

test("the recording stops after its own end", () => {
  assert.deepEqual(planAudioSync({ ...running, duration: 5, sourcePosition: 5 }), {
    action: "stop"
  });
});

test("audio waits for the MIDI clock to settle before starting", () => {
  assert.deepEqual(
    planAudioSync({ ...running, masterSettled: false, sourcePosition: undefined }),
    { action: "keep" }
  );
  assert.deepEqual(planAudioSync({ ...running, masterSettled: false }), {
    action: "keep"
  });
  assert.deepEqual(
    planAudioSync({ ...running, masterSettled: false, masterTime: 42 }),
    { action: "stop" }
  );
});

test("the MIDI clock is settled when it advances with the context clock", () => {
  const first = { contextTime: 1, masterTime: 5 };
  assert.equal(isMasterClockSettled(undefined, first), false);
  assert.equal(
    isMasterClockSettled(first, { contextTime: 1.016, masterTime: 5.017 }),
    true
  );
  assert.equal(
    isMasterClockSettled(first, { contextTime: 1.05, masterTime: 5.011 }),
    false
  );
});

test("waveform peaks take the loudest sample of every channel per bin", () => {
  const left = new Float32Array([0.1, -0.8, 0.2, 0.3]);
  const right = new Float32Array([0.5, 0, -0.1, -0.9]);
  assert.deepEqual(
    [...computeWaveformPeaks([left, right], 2)].map((value) => value.toFixed(2)),
    ["0.80", "0.90"]
  );
  assert.equal(computeWaveformPeaks([], 4).length, 4);
});
