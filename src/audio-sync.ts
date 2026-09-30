/**
 * Audio tracks play as AudioBufferSourceNodes in the synthesizer's own
 * AudioContext, so the recording and the MIDI share one sample clock. The only
 * way they can part is a transport change (play, pause, seek, tempo-free
 * rebuild), which shows up as a position error and is fixed by restarting the
 * source at the right offset.
 */

/** A playing source further than this from the MIDI position is restarted. */
export const AUDIO_RESTART_SECONDS = 0.03;
/** A recording that starts this soon after the playhead is scheduled sample-accurately. */
export const AUDIO_SCHEDULE_AHEAD_SECONDS = 0.5;

/** The MIDI clock counts as settled once it tracks the context clock this closely. */
export const MASTER_SETTLED_SECONDS = 0.01;

export type ClockSample = { contextTime: number; masterTime: number };

/**
 * The sequencer reports a lagging position for a few frames after it resumes.
 * Audio is started only once the MIDI clock advances in step with the context clock.
 */
export function isMasterClockSettled(
  previous: ClockSample | undefined,
  current: ClockSample
): boolean {
  if (!previous) {
    return false;
  }
  const contextDelta = current.contextTime - previous.contextTime;
  const masterDelta = current.masterTime - previous.masterTime;
  return contextDelta > 0 && Math.abs(masterDelta - contextDelta) <= MASTER_SETTLED_SECONDS;
}

export type AudioSyncInput = {
  /** MIDI transport time in seconds. */
  masterTime: number;
  /** True while the MIDI engine is actually advancing. */
  masterRunning: boolean;
  /** See isMasterClockSettled; starting waits for it, keeping and stopping do not. */
  masterSettled: boolean;
  /** Seconds into the MIDI where the recording starts (negative trims its start). */
  offset: number;
  /** Recording duration in seconds. */
  duration: number;
  /**
   * Where the current source is (or will be) in the recording now, or undefined
   * when no source is scheduled. May be negative for a source scheduled to start later.
   */
  sourcePosition: number | undefined;
};

export type AudioSyncPlan =
  | { action: "stop" }
  | { action: "keep" }
  /** Start a new source after `delay` seconds, `bufferOffset` seconds into the recording. */
  | { action: "start"; delay: number; bufferOffset: number };

export function planAudioSync(input: AudioSyncInput): AudioSyncPlan {
  const localTime = input.masterTime - input.offset;
  const scheduled = input.sourcePosition !== undefined;
  if (
    !input.masterRunning ||
    localTime >= input.duration ||
    localTime < -AUDIO_SCHEDULE_AHEAD_SECONDS
  ) {
    return scheduled ? { action: "stop" } : { action: "keep" };
  }
  if (
    scheduled &&
    Math.abs((input.sourcePosition as number) - localTime) <= AUDIO_RESTART_SECONDS
  ) {
    return { action: "keep" };
  }
  if (!input.masterSettled) {
    return scheduled ? { action: "stop" } : { action: "keep" };
  }
  return localTime < 0
    ? { action: "start", delay: -localTime, bufferOffset: 0 }
    : { action: "start", delay: 0, bufferOffset: localTime };
}

/** Peak amplitude per bin across all channels, for drawing a waveform. */
export function computeWaveformPeaks(
  channels: readonly Float32Array[],
  binCount: number
): Float32Array {
  const peaks = new Float32Array(Math.max(0, binCount));
  const length = channels[0]?.length ?? 0;
  if (length === 0 || binCount <= 0) {
    return peaks;
  }
  const binSize = length / binCount;
  for (let bin = 0; bin < binCount; bin++) {
    const start = Math.floor(bin * binSize);
    const end = Math.max(start + 1, Math.floor((bin + 1) * binSize));
    let peak = 0;
    for (const channel of channels) {
      for (let index = start; index < end && index < length; index++) {
        const value = Math.abs(channel[index] ?? 0);
        if (value > peak) {
          peak = value;
        }
      }
    }
    peaks[bin] = peak;
  }
  return peaks;
}
