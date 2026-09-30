import { Platform } from 'react-native'
import { requireNativeModule } from 'expo-modules-core'

type ExpoTtsPlayerNative = {
  play(url: string): Promise<boolean>
  stop(): unknown
  isPlaying(): boolean
}

// Модуль андроид-only (expo-module.config.json). На iOS/web его нет, и звать
// requireNativeModule нельзя — он кидает. Молчаливый null = «озвучки нет», а не падение.
const native: ExpoTtsPlayerNative | null = (() => {
  if (Platform.OS !== 'android') {
    return null
  }
  try {
    return requireNativeModule('ExpoTtsPlayer') as ExpoTtsPlayerNative
  } catch {
    return null
  }
})()

export function isTtsPlayerAvailable(): boolean {
  return native !== null
}

export async function playAudioUrl(url: string): Promise<boolean> {
  if (!native) {
    return false
  }
  try {
    return (await native.play(url)) === true
  } catch {
    return false
  }
}

export function stopAudio(): void {
  try {
    native?.stop()
  } catch {
    // уже остановлено / модуля нет
  }
}
