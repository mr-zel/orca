import { playAudioUrl, stopAudio } from '../../modules/orca-tts-player/src'

/** Порт нашего голосового моста на том же ПК, к которому телефон сопряжён по ws. */
export const VOICE_BRIDGE_PORT = 3457

const FEED_POLL_MS = 2500
const FETCH_TIMEOUT_MS = 5000

export type TtsFeedEvent = { ts: number; id?: string; client?: string; text?: string }

/**
 * Адрес голосового сервера выводится из endpoint сопряжённого хоста (`ws://192.168.68.10:6768`
 * → `http://192.168.68.10:3457`): телефон уже знает машину, второго адреса заводить не нужно.
 * Разбираем регуляркой, а не `new URL()` — в Hermes глобальный URL не гарантирован.
 */
export function voiceBaseUrl(
  endpoint: string | null | undefined,
  override: string | null
): string | null {
  const trimmed = (override ?? '').replace(/\/+$/, '')
  if (/^https?:\/\//.test(trimmed)) {
    return trimmed
  }
  const match = /^(wss?):\/\/([^/?#]+)/.exec(endpoint ?? '')
  if (!match) {
    return null
  }
  const host = match[2].split('@').pop()?.split(':')[0]
  if (!host) {
    return null
  }
  const scheme = match[1] === 'wss' ? 'https' : 'http'
  return `${scheme}://${host}:${VOICE_BRIDGE_PORT}`
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' })
    if (!response.ok) {
      return null
    }
    return (await response.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Почему очередь: каждый новый вызов движка обрывает предыдущий (MediaPlayer один), а
// ответы приходят подряд кусками — без серии по очереди голос сам себя перебивает.
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Сыграть уже готовый синтез по его id — движок кэширует WAV, повторного синтеза нет. */
export function playWavById(base: string, id: string): Promise<boolean> {
  return enqueue(() => playWav(base, id))
}

async function playWav(base: string, id: string): Promise<boolean> {
  return playAudioUrl(`${base}/wav?id=${encodeURIComponent(id)}`)
}

/** Озвучить последнее высказывание в ленте движка — «я пропустил, прочитай». */
export function playLast(base: string): Promise<boolean> {
  return enqueue(async () => {
    const feed = await fetchJson<{ events?: TtsFeedEvent[] }>(`${base}/api/feed?since=0`)
    const last = feed?.events?.slice(-1)[0]
    return last?.id ? playWav(base, last.id) : false
  })
}

export type TtsFeedWatcher = { stop: () => void }

/**
 * Автоплей: подписка на ленту движка опросом. SSE (`/api/live`) тут не берём — он держит
 * сокет, а телефону в кармане он всё равно рвётся; опрос раз в 2.5 с переживает засыпание
 * экрана без «мёртвых» подписок. Курсор стартует с «сейчас», чтобы при включении не
 * проигрывать вчерашние фразы.
 */
export function startFeedWatcher(
  base: string,
  onEvent: (event: TtsFeedEvent) => void
): TtsFeedWatcher {
  let cursor = Date.now() / 1000
  let stopped = false
  let ticking = false

  const tick = async () => {
    if (stopped || ticking) {
      return
    }
    ticking = true
    try {
      const feed = await fetchJson<{ events?: TtsFeedEvent[] }>(`${base}/api/feed?since=${cursor}`)
      for (const event of feed?.events ?? []) {
        if (event.ts > cursor) {
          cursor = event.ts
        }
        if (event.id) {
          onEvent(event)
        }
      }
    } finally {
      ticking = false
    }
  }

  const interval = setInterval(() => void tick(), FEED_POLL_MS)
  void tick()

  return {
    stop: () => {
      stopped = true
      clearInterval(interval)
    }
  }
}

export function stopPlayback(): void {
  queue = Promise.resolve()
  stopAudio()
}
