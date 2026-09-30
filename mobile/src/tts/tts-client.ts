import { playAudioUrl, stopAudio } from '../../modules/orca-tts-player/src'

/** Порт нашего голосового моста на том же ПК, к которому телефон сопряжён по ws. */
export const VOICE_BRIDGE_PORT = 3457

const FEED_POLL_MS = 2500
const FETCH_TIMEOUT_MS = 5000
/**
 * Единственное ограничение по возрасту — насколько далеко заглядывать при
 * *включении* динамика. Дальше телефон играет то, что движок выдал после курсора.
 */
const CATCH_UP_SEC = 300
/** «Только финал»: молчим, пока ответы сыплются; заговариваем через тишину в столько секунд. */
export const FINAL_QUIET_SEC = 15

export type TtsFeedEvent = { ts: number; id?: string; client?: string; text?: string }

/**
 * Режим воспроизведения задаёт НЕ телефон, а общий переключатель (панель 47772 /
 * страница моста): мост отдаёт его в каждом ответе `/api/feed`, смена ловится на
 * следующем опросе, переподключать ничего не надо.
 *  interrupt — новое обрывает звучащее, играет только самое свежее (сток 0.0.55);
 *  queue     — досказывает текущее, потом всё накопившееся по порядку;
 *  hold      — текущее до конца, из пришедших за речь — только самое последнее;
 *  final     — пока сыплются промежуточные, молчит; играет последнее через тишину.
 */
export type TtsPlayMode = 'interrupt' | 'queue' | 'hold' | 'final'
const PLAY_MODES: readonly string[] = ['interrupt', 'queue', 'hold', 'final']

export function normalizePlayMode(raw: unknown): TtsPlayMode {
  return (PLAY_MODES as readonly string[]).includes(String(raw))
    ? (raw as TtsPlayMode)
    : 'interrupt'
}

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
): Promise<{ events: TtsFeedEvent[]; serverNow: number | null; mode: TtsPlayMode }> {
  const response = await fetchWithTimeout(`${base}/api/feed?since=${since}`)
  if (!response || !response.ok) {
    return { events: [], serverNow: null, mode: 'interrupt' }
  }
  let events: TtsFeedEvent[] = []
  let rawMode: unknown = null
  try {
    const body = (await response.json()) as { events?: TtsFeedEvent[]; mode?: unknown }
    events = Array.isArray(body?.events) ? body.events : []
    rawMode = body?.mode
  } catch {
    events = []
  }
  const dateHeader = response.headers?.get?.('date')
  const parsed = dateHeader ? Date.parse(dateHeader) : Number.NaN
  return {
    events,
    serverNow: Number.isFinite(parsed) ? parsed / 1000 : null,
    mode: normalizePlayMode(rawMode)
  }
}

// Планировщик воспроизведения живёт вот здесь, в JS-стороне вотчера: режим приходит с
// ленты и решает, что делать со звуком — оборвать, дождаться, сложить в очередь или
// молчать до тишины. Тап по перечёркнутому динамику глушит ВСЁ в любом режиме: watcher.stop
// гасит опрос, stopPlayback — звучащее, а очередь и «ждущий» кусок живут в памяти вотчера,
// который тоже останавливается.

/** Сыграть уже готовый синтез по его id — движок кэширует WAV, повторного синтеза нет. */
export function playWavById(base: string, id: string): Promise<boolean> {
  return playWav(base, id)
}

async function playWav(base: string, id: string): Promise<boolean> {
  return playAudioUrl(`${base}/wav?id=${encodeURIComponent(id)}`)
}

/** Озвучить последнее высказывание в ленте движка — «я пропустил, прочитай». */
export async function playLast(base: string): Promise<boolean> {
  const feed = await fetchJson<{ events?: TtsFeedEvent[] }>(`${base}/api/feed?since=0`)
  const last = newestWithId(feed?.events ?? [])
  return last?.id ? playWav(base, last.id) : false
}

/** Последняя озвучка ленты: у движка события идут в порядке появления. */
function newestWithId(events: TtsFeedEvent[]): TtsFeedEvent | null {
  let newest: TtsFeedEvent | null = null
  for (const event of events) {
    if (event.id) {
      newest = event
    }
  }
  return newest
}

export type TtsFeedWatcher = { stop: () => void }

/**
 * Автоплей: подписка на ленту движка опросом + планировщик по режиму из той же ленты.
 * SSE (`/api/live`) тут не берём — он держит сокет, а телефону в кармане он всё равно
 * рвётся; опрос раз в 2,5 с переживает засыпание экрана без «мёртвых» подписок.
 *
 * Про возраст решение одно: при *включении* динамика догоняем не всю ленту (иначе телефон
 * начал бы читать вчерашнее), а самый свежий хвост — не старше CATCH_UP_SEC.
 */
export function startFeedWatcher(
  base: string,
  onEvent: (event: TtsFeedEvent) => void
): TtsFeedWatcher {
  let cursor = 0
  let stopped = false
  let ticking = false
  let seeded = false
  let mode: TtsPlayMode = 'interrupt'
  let queue: TtsFeedEvent[] = []
  let pending: TtsFeedEvent | null = null
  let lastEventAt = 0
  let serverClock = 0
  let generation = 0
  let sounding = false

  /**
   * Сыграть кусок. `generation` — метка «кто сейчас хозяин плеера»: нативный `play`
   * сам обрывает предыдущий, и обещание оборванного закрывается; кто хозяин — решает
   * и решаем, можно ли продвигаться дальше или нас уже сменили.
   */
  const play = (event: TtsFeedEvent) => {
    const mine = ++generation
    sounding = true
    onEvent(event)
    void playWav(base, event.id as string).then(() => {
      if (stopped || mine !== generation) {
        return
      }
      sounding = false
      advance()
    })
  }

  /** Что играть, когда звучащее закончилось само (не обрывом). */
  const advance = () => {
    if (mode === 'queue' && queue.length > 0) {
      play(queue.shift() as TtsFeedEvent)
    } else if ((mode === 'hold' || mode === 'final') && pending) {
      const last = pending
      pending = null
      play(last)
    }
  }

  /** Курсор за все события; в `fresh` — только те, что строго старше прежнего курсора и с id. */
  const takeFresh = (events: TtsFeedEvent[]): TtsFeedEvent[] => {
    const was = cursor
    const fresh: TtsFeedEvent[] = []
    for (const event of events) {
      if (event.ts > cursor) {
        cursor = event.ts
      }
      if (event.ts > was && event.id) {
        fresh.push(event)
      }
    }
    return fresh
  }

  /** Пришедшие после курсора куски — по правилам режима. */
  const deliver = (fresh: TtsFeedEvent[]) => {
    if (fresh.length === 0) {
      return
    }
    const newest = fresh.at(-1) as TtsFeedEvent
    lastEventAt = newest.ts
    if (mode === 'interrupt') {
      queue = []
      pending = null
      play(newest)
    } else if (mode === 'queue') {
      queue.push(...fresh)
      if (!sounding) {
        play(queue.shift() as TtsFeedEvent)
      }
    } else if (mode === 'hold') {
      if (sounding) {
        pending = newest
      } else {
        play(newest)
      }
    } else {
      pending = newest
    }
  }

  /** «Только финал» стартует не по событию, а по тишине — проверять каждым опросом. */
  const checkQuiet = () => {
    if (mode !== 'final' || sounding || !pending) {
      return
    }
    if (serverClock - lastEventAt >= FINAL_QUIET_SEC) {
      const last = pending
      pending = null
      play(last)
    }
  }

  const seed = async (): Promise<void> => {
    const feed = await fetchFeed(base, 0)
    if (stopped) {
      return
    }
    mode = feed.mode
    serverClock = feed.serverNow ?? Date.now() / 1000
    cursor = serverClock
    const inWindow = feed.events.filter(
      (event) => event.id && event.ts > serverClock - CATCH_UP_SEC
    )
    // Курсор — за всем, что вообще есть в ленте (и за протухшим тоже), иначе
    // вчерашняя строка возвращалась бы в каждый опрос.
    for (const event of feed.events) {
      if (event.ts > cursor) {
        cursor = event.ts
      }
    }
    seeded = true
    // Догон при включении — одна самая свежая строка окна, не весь backlog:
    // в «очереди» телефон, только что включённый, не должен зачитывать полчаса.
    const newest = inWindow.at(-1)
    if (newest) {
      deliver([newest])
    }
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
      const feed = await fetchFeed(base, cursor)
      // Проверить пришлось ПОСЛЕ запроса: выключили, пока он летел, — и опоздавший
      // ответ всё равно заиграл бы.
      if (stopped) {
        return
      }
      serverClock = feed.serverNow ?? Date.now() / 1000
      if (feed.mode !== mode) {
        // Режим сменили (панель/страница моста): старое расписание сбрасываем,
        // звучащее не трогаем — оно своё доскажет по-новому.
        mode = feed.mode
        queue = []
        pending = null
      }
      // Строже курсора: мост и так отдаёт только свежее `since`, но полагаться на чужой
      // фильтр нельзя — иначе повтор того же события заставит телефон читать одно дважды.
      deliver(takeFresh(feed.events))
      checkQuiet()
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

/**
 * Тишина по первому тапу: гасит звучащее. Очереди, которую надо было бы чистить, больше нет.
 */
export function stopPlayback(): void {
  stopAudio()
}
