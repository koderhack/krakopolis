/** Persistencja ustawień dźwięku miasta (localStorage). */

const KEY_ON = 'krakopolis.cityAudio.enabled';
const KEY_VOL = 'krakopolis.cityAudio.volume';

export const DEFAULT_CITY_AUDIO_VOLUME = 0.42;

export function loadCityAudioEnabled(): boolean {
  try {
    const v = localStorage.getItem(KEY_ON);
    if (v === null) return false;
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

export function saveCityAudioEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY_ON, on ? '1' : '0');
  } catch { /* private mode */ }
}

export function loadCityAudioVolume(): number {
  try {
    const v = localStorage.getItem(KEY_VOL);
    if (v === null) return DEFAULT_CITY_AUDIO_VOLUME;
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULT_CITY_AUDIO_VOLUME;
    return Math.max(0, Math.min(1, n));
  } catch {
    return DEFAULT_CITY_AUDIO_VOLUME;
  }
}

export function saveCityAudioVolume(vol: number) {
  try {
    localStorage.setItem(KEY_VOL, String(Math.max(0, Math.min(1, vol))));
  } catch { /* private mode */ }
}
