import { useEffect, useRef, useState } from 'preact/hooks';

export interface MicLevel {
  level: number | null; // normalized 0.0–1.0 (RMS), or null when unavailable
  error: string | null;
}

/**
 * Live microphone input level via the Web Audio API. This is browser
 * presentation infrastructure (no domain logic), so it lives in packages/ui
 * per the documented Principle II decision. Returns a normalized RMS level and
 * an error string if the mic is denied or unavailable.
 */
export function useMicLevel(active = true): MicLevel {
  const [level, setLevel] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) return;
        ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);

        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          // RMS of the centered waveform → 0.0–1.0.
          let sumSq = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sumSq += v * v;
          }
          setLevel(Math.min(1, Math.sqrt(sumSq / buf.length)));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Microphone unavailable');
      }
    }

    start();

    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
  }, [active]);

  return { level, error };
}
