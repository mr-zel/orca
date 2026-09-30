import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The address the phone dials and the cursor it watches from.
 *
 * Both come for free from the host the user already paired with, so a wrong guess here is a
 * speaker button that plays nothing at all and says nothing about why.
 */
const { playAudioUrl } = vi.hoisted(() => ({ playAudioUrl: vi.fn(async () => true) }))
vi.mock('../../modules/orca-tts-player/src', () => ({
  playAudioUrl,
  stopAudio: vi.fn(),
  isTtsPlayerAvailable: () => true
}))

const { VOICE_BRIDGE_PORT, playLast, startFeedWatcher, voiceBaseUrl } = await import('./tts-client')

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

  it('drops the hours of backlog a closed pocket collected', async () => {
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

  it('reads the whole feed back for the last utterance', async () => {
    feedResponse([{ ts: Date.now() / 1000, id: 'just-now' }])
    await expect(playLast(base)).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(`${base}/api/feed?since=0`, expect.anything())
    expect(playAudioUrl).toHaveBeenLastCalledWith(`${base}/wav?id=just-now`)
  })
})
