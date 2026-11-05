// localStorage bazı durumlarda (gizli sekme, engellenmiş site verisi) hata fırlatabilir.
// Uygulama ayarsız da çalışmalı, bu yüzden her erişim korumalı.

const PREFIX = 'cerezcord:'

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw == null ? fallback : { ...fallbackObj(fallback), ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

function fallbackObj<T>(v: T) {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}
}

export function loadValue<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw == null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    /* yok say */
  }
}

export type VoiceMode = 'vad' | 'ptt'

export type Settings = {
  name: string
  lastRoom: string
  /** Son girilen oda açık (şifresiz) oda mıydı */
  lastRoomPublic: boolean
  micDeviceId: string
  voiceMode: VoiceMode
  /** KeyboardEvent.code, ör. "KeyV" */
  pttKey: string
  turnUrl: string
  turnUsername: string
  turnCredential: string
}

export const defaultSettings: Settings = {
  name: '',
  lastRoom: '',
  lastRoomPublic: false,
  micDeviceId: '',
  voiceMode: 'vad',
  pttKey: 'KeyV',
  turnUrl: '',
  turnUsername: '',
  turnCredential: '',
}

export const loadSettings = () => load<Settings>('settings', defaultSettings)
export const saveSettings = (s: Settings) => save('settings', s)

/** Kişi başı ses seviyesi isimle hatırlanır (peer id her girişte değişir). */
export const loadVolumes = () => loadValue<Record<string, number>>('volumes', {})
export const saveVolumes = (v: Record<string, number>) => save('volumes', v)
