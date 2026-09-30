import { playAudioUrl, stopAudio } from '../../modules/orca-tts-player/src'

/** Порт нашего голосового моста на том же ПК, к которому телефон сопряжён по ws. */
export const VOICE_BRIDGE_PORT = 3457

const FEED_POLL_MS = 2500
const FETCH_TIMEOUT_MS = 5000
/**
 * How old a line may be and still be worth speaking. The engine keeps a rolling feed of
 * everything every agent said, so a poll after a pocket-full of dead time returns dozens of
 * lines from yesterday — read all of them and the phone talks for hours about nothing.
 */
const FRESH_EVENT_SEC = 120

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
  const response = await fetchWithTimeout(url, init)
  if (!response || !response.ok) {
    return null
  }
  try {
    return (await response.json()) as T
  } catch {
    return null
  }
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Лента движка вместе с событиями отдаёт и дату ответа (`Date` заголовком) — по ней и
 * сверяемся: часы телефона и ПК гуляют на минуты, и «свежесть» по локальному времени
 * либо съедает текущий ответ, либо выдаёт вчерашний.
 */
async function fetchFeed(
  base: string,
  since: number
): Promise<{ events: TtsFeedEvent[]; serverNow: number | null }> {
  const response = await fetchWithTimeout(`${base}/api/feed?since=${since}`)
  if (!response || !response.ok) {
    return { events: [], serverNow: null }
  }
  let events: TtsFeedEvent[] = []
  try {
    const body = (await response.json()) as { events?: TtsFeedEvent[] }
    events = Array.isArray(body?.events) ? body.events : []
  } catch {
    events = []
  }
  const dateHeader = response.headers?.get?.('date')
  const parsed = dateHeader ? Date.parse(dateHeader) : Number.NaN
  return { events, serverNow: Number.isFinite(parsed) ? parsed / 1000 : null }
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
    const last = feed?.events?.at(-1)
    return last?.id ? playWav(base, last.id) : false
  })
}

export type TtsFeedWatcher = { stop: () => void }

/**
 * Автоплей: подписка на ленту движка опросом. SSE (`/api/live`) тут не берём — он держит
 * сокет, а телефону в кармане он всё равно рвётся; опрос раз в 2.5 с переживает засыпание
 * экрана без «мёртвых» подписок.
 *
 * При включении догоняем ровно хвост: последние строки не старше FRESH_EVENT_SEC. Иначе
 * получалось либо «молчу, хотя ответ уже на экране» (курсор ставился в «сейчас» по часам
 * телефона), либо «часы назад включил — читает вчерашнее» (курсор по `since=0`).
 */
export function startFeedWatcher(
  base: string,
  onEvent: (event: TtsFeedEvent) => void
): TtsFeedWatcher {
  let cursor = 0
  let stopped = false
  let ticking = false
  let seeded = false

  const fresh = (event: TtsFeedEvent, serverNow: number | null): boolean => {
    if (!event.id) {
      return false
    }
    return serverNow === null || event.ts > serverNow - FRESH_EVENT_SEC
  }

  const seed = async (): Promise<void> => {
    const { events, serverNow } = await fetchFeed(base, 0)
    if (stopped) {
      return
    }
    cursor = serverNow ?? Date.now() / 1000
    for (const event of events) {
      if (event.ts > cursor) {
        cursor = event.ts
      }
      if (fresh(event, serverNow)) {
        onEvent(event)
      }
    }
    seeded = true
  }

  const tick = async () => {
    if (stopped || ticking) {
      return
    }
    ticking = true
    try {
      if (!seeded) {
        await seed()
        return
      }
      const { events, serverNow } = await fetchFeed(base, cursor)
      for (const event of events) {
        if (event.ts > cursor) {
          cursor = event.ts
        }
        if (fresh(event, serverNow)) {
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
