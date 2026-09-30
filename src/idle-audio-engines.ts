/** Retain the three most recently used idle engines for instant resume. */
export class IdleAudioEngines {
  private idle = new Map<object, () => void>();

  retire(key: object, release: () => void): void {
    // Repeated pause calls do not make an unused engine more recent.
    // Starting playback removes its entry; the next pause adds it at the end.
    if (this.idle.has(key)) return;
    this.idle.set(key, release);
    if (this.idle.size > 3) {
      const [oldestKey, releaseOldest] = this.idle.entries().next().value!;
      this.idle.delete(oldestKey);
      releaseOldest();
    }
  }

  cancel(key: object): void {
    this.idle.delete(key);
  }
}

export const idleAudioEngines = new IdleAudioEngines();
