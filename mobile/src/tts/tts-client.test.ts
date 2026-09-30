import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The address the phone dials and the cursor it watches from.
 *
 * Both come for free from the host the user already paired with, so a wrong guess here is a
 * speaker button that plays nothing at all and says nothing about why.
 */
const { playAudioUrl, stopAudio } = vi.hoisted(() => ({
  playAudioUrl: vi.fn(async () => true),
  stopAudio: vi.fn()
}))
vi.mock('../../modules/orca-tts-player/src', () => ({
  playAudioUrl,
  stopAudio,
  isTtsPlayerAvailable: () => true
}))

const { VOICE_BRIDGE_PORT, playLast, playWavById, startFeedWatcher, stopPlayback, voiceBaseUrl } =
  await import('./tts-client')

describe('the voice base address', () => {
  it('is the bridge port on the paired host, from a ws endpoint', () => {
    expect(voiceBaseUrl('ws://100.93.172.126:6768', null)).toBe(
      `http://100.93.172.126:${VOICE_BRIDGE_PORT}`
    )
  })

  it('keeps tls when the host was paired over wss', () => {
    expect(voiceBaseUrl('wss://desktop-0qlurla.ts.net:6768/pair', null)).toBe(
      `https://desktop-0qlurla.ts.net:${VOICE_BRIDGE_PORT}`
    )
  })

  it('adds the bridge port to an endpoint that names none', () => {
    expect(voiceBaseUrl('ws://192.168.68.10', null)).toBe(
      `http://192.168.68.10:${VOICE_BRIDGE_PORT}`
    )
  })

  it('drops credentials and the host port the desktop owns', () => {
    expect(voiceBaseUrl('ws://token@10.0.0.5:6768', null)).toBe(
      `http://10.0.0.5:${VOICE_BRIDGE_PORT}`
    )
  })

  it('prefers a stored absolute override and ignores a half-written one', () => {
    expect(voiceBaseUrl('ws://10.0.0.5:6768', 'http://127.0.0.1:3457/')).toBe(
      'http://127.0.0.1:3457'
    )
    expect(voiceBaseUrl('ws://10.0.0.5:6768', '10.0.0.9:3457')).toBe(
      `http://10.0.0.5:${VOICE_BRIDGE_PORT}`
    )
  })

  it('is absent when there is no host to derive it from', () => {
    expect(voiceBaseUrl(undefined, null)).toBeNull()
    expect(voiceBaseUrl('10.0.0.5:6768', null)).toBeNull()
  })
})

describe('watching the engine feed', () => {
  const base = 'http://10.0.0.5:3457'
  let fetchMock: ReturnType<typeof vi.fn>

  /** The bridge answers with a `Date` header — the phone reads server time from it, not its own clock. */
  function feedResponse(events: { ts: number; id: string }[], serverNowSec?: number): void {
    const date = new Date((serverNowSec ?? Date.now() / 1000) * 1000).toUTCString()
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/api/feed')
        ? {
            ok: true,
            headers: { get: (name: string) => (name === 'date' ? date : null) },
            json: async () => ({ events })
          }
        : { ok: false }
    )
  }

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    playAudioUrl.mockReset()
  })

  it('leaves what was said long ago alone', async () => {
    const stale = Date.now() / 1000 - 3600
    feedResponse([{ ts: stale, id: 'yesterday' }])
    const onEvent = vi.fn()
    const watcher = startFeedWatcher(base, onEvent)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    watcher.stop()
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('catches up on the answer already on screen when the speaker is switched on', async () => {
    const now = Date.now() / 1000
    const current = { ts: now - 10, id: 'on-screen' }
    feedResponse([current], now)
    const onEvent = vi.fn()
    const watcher = startFeedWatcher(base, onEvent)
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(current))
    watcher.stop()
  })

  it('plays what lands after the cursor', async () => {
    const fresh = { ts: Date.now() / 1000 + 1, id: 'just-now' }
    feedResponse([fresh])
    const onEvent = vi.fn()
    const watcher = startFeedWatcher(base, onEvent)
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(fresh))
    watcher.stop()
  })

  it('catches up only the fresh tail when the speaker is switched on', async () => {
    const now = Date.now() / 1000
    feedResponse(
      [
        { ts: now - 7200, id: 'old-a' },
        { ts: now - 3600, id: 'old-b' },
        { ts: now - 5, id: 'now-c' }
      ],
      now
    )
    const onEvent = vi.fn()
    const watcher = startFeedWatcher(base, onEvent)
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled())
    watcher.stop()
    expect(onEvent.mock.calls.map((call) => call[0].id)).toEqual(['now-c'])
  })

  it('reads only the freshest of what piled up while the pocket was shut', async () => {
    // Nothing queues behind it: one answer the user might still want, not a backlog to
    // sit through. The cursor still moves past everything, or the phone would loop.
    const t0 = Date.now() / 1000
    const backlog = [
      { ts: t0 + 60, id: 'while-asleep-a' },
      { ts: t0 + 1800, id: 'while-asleep-b' }
    ]
    let calls = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (!String(url).includes('/api/feed')) {
        return { ok: false }
      }
      calls += 1
      // Первый ответ — разметка ленты при включении (часы движка = t0), второй — опрос
      // после получаса в кармане: обе строки вышли позже курсора, но играем только
      // самую свежую, за остальной backlog телефон не держат.
      const nowSec = calls === 1 ? t0 : t0 + 3600
      const events = calls === 1 ? [] : backlog
      const date = new Date(nowSec * 1000).toUTCString()
      return {
        ok: true,
        headers: { get: (name: string) => (name === 'date' ? date : null) },
        json: async () => ({ events })
      }
    })
    const onEvent = vi.fn()
    const watcher = startFeedWatcher(base, onEvent)
    await vi.waitFor(() => expect(calls).toBe(1))
    await vi.advanceTimersByTimeAsync(3000)
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2))
    await vi.advanceTimersByTimeAsync(3000)
    watcher.stop()
    expect(onEvent.mock.calls.map((call) => call[0].id)).toEqual(['while-asleep-b'])
    // Курсор ушёл за обе строки: иначе следующий опрос принёс бы тот же хвост, и телефон
    // зациклился бы на одном и том же ответе.
    const thirdCallUrl = String(fetchMock.mock.calls[2]?.[0] ?? '')
    expect(thirdCallUrl).toContain(`since=${t0 + 1800}`)
  })

  it('says nothing when the speaker was switched off while the poll was in flight', async () => {
    let resolveFeed: (value: unknown) => void = () => {}
    const feedPending = new Promise((resolve) => {
      resolveFeed = resolve
    })
    const date = new Date(Date.now()).toUTCString()
    fetchMock.mockImplementation(async () => {
      await feedPending
      return {
        ok: true,
        headers: { get: (name: string) => (name === 'date' ? date : null) },
        json: async () => ({ events: [{ ts: Date.now() / 1000 + 5, id: 'opozdalo' }] })
      }
    })
    const onEvent = vi.fn()
    const watcher = startFeedWatcher(base, onEvent)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    watcher.stop()
    resolveFeed(null)
    await Promise.resolve()
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('reads the whole feed back for the last utterance', async () => {
    feedResponse([{ ts: Date.now() / 1000, id: 'just-now' }])
    await expect(playLast(base)).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(`${base}/api/feed?since=0`, expect.anything())
    expect(playAudioUrl).toHaveBeenLastCalledWith(`${base}/wav?id=just-now`)
  })
})

describe('one message at a time', () => {
  const base = 'http://10.0.0.5:3457'

  afterEach(() => {
    playAudioUrl.mockReset()
    stopAudio.mockReset()
  })

  it('sends the new utterance straight to the player instead of lining it up', async () => {
    // The old queue was the bug: everything waiting behind the sounding piece kept playing
    // after the speaker was crossed off. There is no queue to clear now, so a fresh answer
    // reaches the player the moment it arrives and simply cuts what sounded before it.
    let releaseFirst: () => void = () => {}
    const firstSounding = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    playAudioUrl.mockImplementation(async (url: string) => {
      if (String(url).includes('chunk-1')) {
        await firstSounding
      }
      return true
    })

    void playWavById(base, 'chunk-1')
    const second = playWavById(base, 'chunk-2')
    await expect(second).resolves.toBe(true)
    expect(playAudioUrl.mock.calls.map((call) => call[0])).toEqual([
      `${base}/wav?id=chunk-1`,
      `${base}/wav?id=chunk-2`
    ])
    releaseFirst()
  })

  it('puts the player down on the tap', () => {
    playAudioUrl.mockImplementation(() => new Promise(() => {}))
    void playWavById(base, 'chunk-1')
    stopPlayback()
    expect(stopAudio).toHaveBeenCalled()
  })
})

describe('playback modes from the feed', () => {
  const base = 'http://10.0.0.5:3457'
  let fetchMock: ReturnType<typeof vi.fn>
  let releases: (() => void)[]

  /**
   * One scripted answer per poll: events, the playback mode and the engine clock the
   * `Date` header carries. Every playAudioUrl call parks until the test releases it,
   * so «sounding» is exactly what the test says is sounding.
   */
  function script(steps: { events?: { ts: number; id: string }[]; mode?: string; now: number }[]) {
    let call = 0
    fetchMock.mockImplementation(async () => {
      const step = steps[Math.min(call, steps.length - 1)]
      call += 1
      const date = new Date(step.now * 1000).toUTCString()
      return {
        ok: true,
        headers: { get: (name: string) => (name === 'date' ? date : null) },
        json: async () => ({ events: step.events ?? [], mode: step.mode })
      }
    })
  }

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    releases = []
    playAudioUrl.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releases.push(() => resolve(true))
        })
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    playAudioUrl.mockReset()
  })

  const played = () => playAudioUrl.mock.calls.map((call) => String(call[0]).split('id=')[1])

  async function run(timesSec: number) {
    await vi.advanceTimersByTimeAsync(timesSec * 1000)
  }

  it('queue: sounds everything that piled up, one after another', async () => {
    const t0 = Date.now() / 1000
    script([
      { now: t0 },
      {
        now: t0 + 10,
        mode: 'queue',
        events: [
          { ts: t0 + 5, id: 'a' },
          { ts: t0 + 8, id: 'b' }
        ]
      },
      { now: t0 + 12, mode: 'queue' }
    ])
    const watcher = startFeedWatcher(base, () => {})
    await run(3)
    // «a» звучит, «b» ждёт за ним — очередь в этом режиме и есть смысл.
    expect(played()).toEqual(['a'])
    releases[0]?.()
    await run(1)
    expect(played()).toEqual(['a', 'b'])
    releases[1]?.()
    watcher.stop()
  })

  it('hold: finishes what sounded, then reads only the newest of the waiters', async () => {
    const t0 = Date.now() / 1000
    script([
      { now: t0 },
      { now: t0 + 10, mode: 'hold', events: [{ ts: t0 + 5, id: 'a' }] },
      {
        now: t0 + 12,
        mode: 'hold',
        events: [
          { ts: t0 + 11, id: 'middle' },
          { ts: t0 + 11.5, id: 'last' }
        ]
      },
      { now: t0 + 20, mode: 'hold' }
    ])
    const watcher = startFeedWatcher(base, () => {})
    await run(6)
    expect(played()).toEqual(['a'])
    releases[0]?.()
    await run(1)
    // «middle» прилетел, пока звучал «a», и был выброшен: досказываем последнее.
    expect(played()).toEqual(['a', 'last'])
    releases[1]?.()
    watcher.stop()
  })

  it('final: keeps quiet while answers pour in, reads the last one after the silence', async () => {
    const t0 = Date.now() / 1000
    script([
      { now: t0 },
      { now: t0 + 10, mode: 'final', events: [{ ts: t0 + 9, id: 'draft' }] },
      { now: t0 + 12, mode: 'final', events: [{ ts: t0 + 11, id: 'revised' }] },
      { now: t0 + 16, mode: 'final' },
      { now: t0 + 22, mode: 'final' },
      { now: t0 + 30, mode: 'final' }
    ])
    const watcher = startFeedWatcher(base, () => {})
    await run(8)
    // Всё это время агент ещё строчит (тишина от последней строки < 15 с) — телефон молчит.
    expect(played()).toEqual([])
    await run(10)
    // Тишина дольше порога — играем ровно последнюю строку, «draft» не вспоминаем.
    expect(played()).toEqual(['revised'])
    releases[0]?.()
    watcher.stop()
  })

  it('a mode switch drops the old schedule, the sounding piece finishes as it is', async () => {
    const t0 = Date.now() / 1000
    script([
      { now: t0 },
      {
        now: t0 + 10,
        mode: 'queue',
        events: [
          { ts: t0 + 5, id: 'a' },
          { ts: t0 + 8, id: 'b' }
        ]
      },
      { now: t0 + 12, mode: 'interrupt' }
    ])
    const watcher = startFeedWatcher(base, () => {})
    await run(6)
    expect(played()).toEqual(['a'])
    releases[0]?.()
    await run(1)
    // Режим сменили: «b» ждал в очереди очереди, а ей больше не жить.
    expect(played()).toEqual(['a'])
    watcher.stop()
  })

  it('interrupt mode cuts the sounding piece for the newest one', async () => {
    const t0 = Date.now() / 1000
    script([
      { now: t0 },
      { now: t0 + 10, mode: 'interrupt', events: [{ ts: t0 + 5, id: 'a' }] },
      { now: t0 + 12, mode: 'interrupt', events: [{ ts: t0 + 11, id: 'b' }] }
    ])
    const watcher = startFeedWatcher(base, () => {})
    await run(1)
    await run(4)
    // Не дожидаясь конца «a»: новое событие сразу идёт в плеер.
    expect(played()).toEqual(['a', 'b'])
    releases.forEach((release) => release())
    watcher.stop()
  })
})
