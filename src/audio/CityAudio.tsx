/**
 * React: CityAudio – napędza silnik dźwięku z sim + kamery.
 * Start dopiero po geście użytkownika (klik ON / pierwsze interakcja gdy ON).
 */
import { useCallback, useEffect, useRef } from 'react';
import type { Sim } from '../simulation/sim';
import type { MiniCam } from '../ui/Minimap';
import { CityAudioEngine } from './engine';
import { sampleCityAudio } from './sample';
import {
  loadCityAudioEnabled,
  loadCityAudioVolume,
  saveCityAudioEnabled,
  saveCityAudioVolume,
} from './settings';

export interface CityAudioControls {
  enabled: boolean;
  volume: number;
  setEnabled: (on: boolean) => void;
  setVolume: (v: number) => void;
  /** Wywołaj przy kliknięciu ON – odblokowuje AudioContext. */
  unlock: () => Promise<void>;
}

export function useCityAudio(
  sim: Sim,
  camSample: MiniCam | null,
  enabled: boolean,
  volume: number,
): { unlock: () => Promise<void> } {
  const engineRef = useRef<CityAudioEngine | null>(null);
  const enabledRef = useRef(enabled);
  const volumeRef = useRef(volume);
  const camRef = useRef(camSample);
  enabledRef.current = enabled;
  volumeRef.current = volume;
  camRef.current = camSample;

  useEffect(() => {
    const eng = new CityAudioEngine();
    engineRef.current = eng;
    return () => {
      eng.dispose();
      engineRef.current = null;
    };
  }, []);

  const unlock = useCallback(async () => {
    const eng = engineRef.current;
    if (!eng) return;
    await eng.ensureStarted();
  }, []);

  // Gdy włączone – próbuj wznowić (jeśli już był gest); gdy wyłączone – wycisz.
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    if (!enabled) {
      eng.setMuted(true);
      return;
    }
    eng.setMuted(false);
    void eng.ensureStarted().then((ok) => {
      if (!ok) eng.setMuted(true);
    });
  }, [enabled]);

  // Pętla próbkowania (~5 Hz) – tanie, bez RAF.
  useEffect(() => {
    const id = window.setInterval(() => {
      const eng = engineRef.current;
      if (!eng || !enabledRef.current) return;
      if (!eng.isRunning) return;
      const frame = sampleCityAudio(sim, camRef.current, volumeRef.current);
      eng.apply(frame);
    }, 200);
    return () => window.clearInterval(id);
  }, [sim]);

  // Odblokowanie po pierwszej interakcji użytkownika, jeśli dźwięk był już ON (persist).
  useEffect(() => {
    if (!enabled) return;
    const onGesture = () => {
      void unlock();
    };
    window.addEventListener('pointerdown', onGesture, { once: true, passive: true });
    window.addEventListener('keydown', onGesture, { once: true });
    return () => {
      window.removeEventListener('pointerdown', onGesture);
      window.removeEventListener('keydown', onGesture);
    };
  }, [enabled, unlock]);

  return { unlock };
}

/** Stan UI z localStorage – używany w Hud. */
export function useCityAudioSettings() {
  // lazy init – unikamy SSR / hydration mismatch (tu SPA bez SSR)
  const enabledRef = useRef<boolean | null>(null);
  const volumeRef = useRef<number | null>(null);
  if (enabledRef.current === null) enabledRef.current = loadCityAudioEnabled();
  if (volumeRef.current === null) volumeRef.current = loadCityAudioVolume();

  return {
    initialEnabled: enabledRef.current,
    initialVolume: volumeRef.current,
    persistEnabled: saveCityAudioEnabled,
    persistVolume: saveCityAudioVolume,
  };
}

export { loadCityAudioEnabled, loadCityAudioVolume, saveCityAudioEnabled, saveCityAudioVolume };
