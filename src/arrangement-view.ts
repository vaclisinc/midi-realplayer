export type ArrangementNote = {
  midi: number;
  time: number;
  duration: number;
};

export type ArrangementNoteRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function getArrangementCanvasHeight(
  trackCount: number,
  trackHeight: number,
  headerHeight: number,
  viewportHeight: number
): number {
  return Math.max(
    viewportHeight,
    headerHeight + Math.max(0, trackCount) * trackHeight
  );
}

export function getPianoRollCanvasHeight(
  pitchCount: number,
  rowHeight: number,
  headerHeight: number,
  viewportHeight: number
): number {
  return Math.max(
    viewportHeight,
    headerHeight + Math.max(1, pitchCount) * rowHeight
  );
}

export function getArrangementNoteRect(
  note: ArrangementNote,
  minPitch: number,
  maxPitch: number,
  trackIndex: number,
  trackHeight: number,
  headerHeight: number,
  width: number,
  viewStart: number,
  viewEnd: number
): ArrangementNoteRect {
  const pitchSpan = Math.max(1, maxPitch - minPitch + 1);
  const innerTop = headerHeight + trackIndex * trackHeight + 8;
  const innerHeight = Math.max(8, trackHeight - 16);
  const noteHeight = Math.max(2, Math.min(5, innerHeight / pitchSpan));
  const yRatio = (maxPitch - note.midi + 0.5) / pitchSpan;
  const duration = Math.max(0.001, viewEnd - viewStart);
  return {
    x: ((note.time - viewStart) / duration) * width,
    y: innerTop + yRatio * Math.max(1, innerHeight - noteHeight),
    width: Math.max(1.5, (Math.max(0.004, note.duration) / duration) * width),
    height: noteHeight
  };
}

/** Place audio rows before the specified MIDI track (1-based); default above MIDI. */
export function getArrangementTrackOrder(midiCount: number, audioBefore: readonly (number | undefined)[]): { kind: "audio" | "midi"; index: number }[] {
  const order: { kind: "audio" | "midi"; index: number }[] = [];
  const positions = audioBefore.map(value => value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.min(midiCount, Math.floor(value) - 1)) : 0);
  for (let index = 0; index <= midiCount; index++) {
    positions.forEach((position, audioIndex) => {
      if (position === index) order.push({ kind: "audio", index: audioIndex });
    });
    if (index < midiCount) order.push({ kind: "midi", index });
  }
  return order;
}
