import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from './mirrored-storage-keys'

/** Куда идёт озвучка ответов: выключено (иконка перечёркнута) или автоплей новой речи. */
export type MobileTtsMode = 'off' | 'on'

const TTS_MODE_KEY = 'orca:ttsMode'
const TTS_BASE_URL_KEY = 'orca:ttsBaseUrl'

// Почему default 'off': озвучка сама тянет сеть и говорит вслух — включать её должен
// только тап пользователя, а не первый запуск собранного приложения.
export const DEFAULT_TTS_MODE: MobileTtsMode = 'off'

let ttsWriteBarrier: Promise<void> | null = null

function isMode(raw: string | null): raw is MobileTtsMode {
  return raw === 'off' || raw === 'on'
}

export async function loadTtsMode(): Promise<MobileTtsMode> {
  await ttsWriteBarrier
  try {
    const raw = await AsyncStorage.getItem(TTS_MODE_KEY)
    return isMode(raw) ? raw : DEFAULT_TTS_MODE
  } catch {
    return DEFAULT_TTS_MODE
  }
}

export function saveTtsMode(mode: MobileTtsMode): Promise<void> {
  // Why: тапать переключатель можно быстрее, чем отвечает хранилище; барьер не даёт
  // более позднему выбору перезаписаться более ранним.
  const write = (ttsWriteBarrier ?? Promise.resolve()).then(() =>
    persistMirrored(TTS_MODE_KEY, mode)
  )
  const barrier = write.catch(() => undefined)
  ttsWriteBarrier = barrier
  void barrier.then(() => {
    if (ttsWriteBarrier === barrier) {
      ttsWriteBarrier = null
    }
  })
  return write
}

/** Ручная замена адреса голосового сервера; null — выводить из адреса сопряжённого ПК. */
export async function loadTtsBaseUrlOverride(): Promise<string | null> {
  await ttsWriteBarrier
  try {
    const raw = await AsyncStorage.getItem(TTS_BASE_URL_KEY)
    return raw && /^https?:\/\//.test(raw) ? raw.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

export function saveTtsBaseUrlOverride(url: string | null): Promise<void> {
  const write = (ttsWriteBarrier ?? Promise.resolve()).then(() =>
    url ? persistMirrored(TTS_BASE_URL_KEY, url.replace(/\/+$/, '')) : AsyncStorage.removeItem(TTS_BASE_URL_KEY)
  )
  const barrier = write.then(() => undefined).catch(() => undefined)
  ttsWriteBarrier = barrier
  return write
}
