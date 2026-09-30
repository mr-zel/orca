import { useCallback, useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react-native'
import { MobileSessionHeaderIconButton } from './MobileSessionHeaderIconButton'
import { loadTtsBaseUrlOverride, loadTtsMode, saveTtsMode } from '../storage/tts-preferences'
import { loadHosts } from '../transport/host-store'
import {
  playLast,
  playWavById,
  startFeedWatcher,
  stopPlayback,
  voiceBaseUrl
} from '../tts/tts-client'
import type { TtsFeedWatcher } from '../tts/tts-client'
import { triggerMediumImpact } from '../platform/haptics'
import type { MobileTtsMode } from '../storage/tts-preferences'

/**
 * Динамик в шапке сессии, рядом с «файлами».
 * тап = выкл/вкл автоплея (перечёркнутый динамик = выкл);
 * долгое нажатие = «я пропустил, прочитай последнее».
 */
export function MobileSessionTtsButton({ hostId }: { hostId: string | null | undefined }) {
  const [mode, setMode] = useState<MobileTtsMode>('off')
  const [base, setBase] = useState<string | null>(null)
  const watcherRef = useRef<TtsFeedWatcher | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [storedMode, override, hosts] = await Promise.all([
        loadTtsMode(),
        loadTtsBaseUrlOverride(),
        hostId ? loadHosts() : Promise.resolve([])
      ])
      if (!alive) {
        return
      }
      setMode(storedMode)
      const endpoint = hosts.find((host) => host.id === hostId)?.endpoint
      setBase(voiceBaseUrl(endpoint, override))
    })()
    return () => {
      alive = false
    }
  }, [hostId])

  // Подписка живёт ровно столько, сколько включён автоплей: с выключенным тумблером
  // опрос ленты не идёт и телефон не держит сеть.
  useEffect(() => {
    watcherRef.current?.stop()
    watcherRef.current = null
    if (mode !== 'on' || !base) {
      return
    }
    watcherRef.current = startFeedWatcher(base, (event) => {
      void playWavById(base, event.id as string)
    })
    return () => {
      watcherRef.current?.stop()
      watcherRef.current = null
    }
  }, [mode, base])

  const toggle = useCallback(() => {
    triggerMediumImpact()
    const next: MobileTtsMode = mode === 'on' ? 'off' : 'on'
    setMode(next)
    if (next === 'off') {
      stopPlayback()
    }
    void saveTtsMode(next)
  }, [mode])

  const speakLast = useCallback(() => {
    triggerMediumImpact()
    if (base) {
      void playLast(base)
    }
  }, [base])

  return (
    <MobileSessionHeaderIconButton
      active={mode === 'on'}
      accessibilityLabel={mode === 'on' ? 'Voice answers off' : 'Voice answers on'}
      icon={mode === 'on' ? Volume2 : VolumeX}
      onPress={toggle}
      onLongPress={speakLast}
    />
  )
}
