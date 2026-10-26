// The queue behind group listening, independent of React and the browser's audio
// stack so it can be tested with a fake provider and player. `listen.js` wires it
// to the host's `tts` endpoint and to React.
import { speakableSpeech } from './text.js'
import { t } from './i18n.js'

const MAX_QUEUE = 30
const MAX_CHARS = 10_000
const MAX_FAILURES = 3
const REMEMBER = 20
const MAX_CLIPS = 40
const NOTE_MS = 4_000
// A back press this soon after a speech starts replays it instead of stepping
// back, like a player's back button.
const REPLAY_AT_S = 3

const audioOf = url => new Audio(url)

export function createListening({ synthesize, play = audioOf, now = () => Date.now() } = {}) {
  let state = {
    roomId: null,
    cursor: 0,
    current: null,
    queue: [],
    played: [],
    manual: null,
    note: '',
    noteSeq: 0,
  }
  const listeners = new Set()
  const seen = new Set()
  const clips = new Map()
  const pending = new Map()
  let audio = null
  let token = 0
  let failures = 0
  let noteTimer = 0
  let manualClip = null
  let manualToken = 0
  let manualTimer = 0

  const publish = (patch) => {
    state = { ...state, ...patch }
    for (const listener of Array.from(listeners)) listener()
  }
  const subscribe = (listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  function say(message) {
    const seq = state.noteSeq + 1
    publish({ note: message, noteSeq: seq })
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => {
      if (state.noteSeq === seq) publish({ note: '' })
    }, NOTE_MS)
    noteTimer?.unref?.()
  }

  function stopClip() {
    if (audio === null) return
    const clip = audio
    audio = null
    clip.onended = null
    clip.onerror = null
    clip.pause()
  }

  function forgetClips() {
    clips.clear()
    pending.clear()
    seen.clear()
  }

  async function clipOf(item) {
    const cached = clips.get(item.key)
    if (cached !== undefined) return cached
    let job = pending.get(item.key)
    if (job === undefined) {
      job = Promise.resolve()
        .then(() => synthesize(item))
        .then((value) => {
          if (typeof value?.audio !== 'string' || value.audio === '') throw new Error(t('The speech service returned no audio.'))
          const url = `data:${value.mime ?? 'audio/mpeg'};base64,${value.audio}`
          clips.set(item.key, url)
          while (clips.size > MAX_CLIPS) clips.delete(clips.keys().next().value)
          return url
        })
        .finally(() => pending.delete(item.key))
      pending.set(item.key, job)
    }
    return job
  }

  function prefetch(item) {
    if (item === undefined || clips.has(item.key) || pending.has(item.key)) return
    void clipOf(item).catch(() => {})
  }

  function consume(item) {
    publish({ current: null, played: [...state.played, item].slice(-REMEMBER) })
  }

  async function playNext() {
    if (state.roomId === null || state.current !== null) return
    const nextItem = state.queue[0]
    if (nextItem === undefined) return
    publish({ queue: state.queue.slice(1) })
    await start(nextItem)
  }

  async function start(item) {
    const mine = ++token
    publish({ current: { ...item, status: 'loading' } })
    prefetch(state.queue[0])
    try {
      const url = await clipOf(item)
      if (mine !== token) return
      const clip = play(url)
      audio = clip
      clip.onended = () => {
        if (mine !== token) return
        audio = null
        failures = 0
        consume(item)
        void playNext()
      }
      clip.onerror = () => {
        if (mine !== token) return
        stopClip()
        fail(new Error(t('Could not play this audio.')), true)
      }
      await clip.play()
      if (mine !== token || audio !== clip) return
      failures = 0
      publish({ current: { ...item, status: 'playing' } })
    } catch (error) {
      if (mine !== token) return
      stopClip()
      fail(error, false)
    }
  }

  function fail(error, fatal) {
    failures += 1
    const message = error?.message ?? String(error)
    if (fatal || failures >= MAX_FAILURES) {
      disable()
      say(message)
      return
    }
    publish({ current: null })
    say(message)
    void playNext()
  }

  function enable(roomId) {
    if (typeof roomId !== 'string' || roomId === '' || state.roomId === roomId) return
    stopManual()
    token += 1
    stopClip()
    forgetClips()
    failures = 0
    publish({ roomId, cursor: now(), current: null, queue: [], played: [], note: '' })
  }

  function disable() {
    token += 1
    stopClip()
    forgetClips()
    failures = 0
    if (state.roomId !== null || state.current !== null || state.queue.length > 0 || state.note !== '') {
      publish({ roomId: null, cursor: 0, current: null, queue: [], played: [], note: '' })
    }
  }

  function stopRoom(roomId) {
    if (state.roomId === roomId) disable()
  }

  function enqueue({ roomId, key, text, botId, time } = {}) {
    if (state.roomId === null || roomId !== state.roomId) return false
    if (typeof key !== 'string' || key === '' || seen.has(key)) return false
    if (!Number.isFinite(time) || time < state.cursor) return false
    const clean = speakableSpeech(text)
    seen.add(key)
    if (clean === '') return false
    if (clean.length > MAX_CHARS) {
      say(t('This message is too long to read aloud (over 10,000 characters).'))
      return false
    }
    if (state.queue.length >= MAX_QUEUE) {
      say(t('The listening queue is full; new messages are skipped.'))
      return false
    }
    publish({ queue: [...state.queue, { key, text: clean, botId, time }] })
    if (state.current === null) void playNext()
    else prefetch(state.queue[0])
    return true
  }

  function next() {
    if (state.roomId === null) return
    const item = state.current
    token += 1
    stopClip()
    failures = 0
    if (item !== null) consume(item)
    void playNext()
  }

  function previous() {
    if (state.roomId === null) return
    const item = state.current
    const at = audio?.currentTime ?? 0
    token += 1
    stopClip()
    failures = 0
    if (item !== null && (state.played.length === 0 || (item.status === 'playing' && at <= REPLAY_AT_S))) {
      void start(item)
      return
    }
    const prev = state.played.at(-1)
    if (prev === undefined) {
      if (item !== null) void start(item)
      return
    }
    publish({
      current: null,
      queue: item === null ? state.queue : [item, ...state.queue],
      played: state.played.slice(0, -1),
    })
    void start(prev)
  }

  function clearManual() {
    manualToken += 1
    const clip = manualClip
    manualClip = null
    if (clip !== null) {
      clip.onended = null
      clip.onerror = null
      clip.onpause = null
      clip.pause()
    }
    clearTimeout(manualTimer)
    manualTimer = 0
    if (state.manual !== null) publish({ manual: null })
  }

  function stopManual() {
    if (state.manual !== null || manualClip !== null) clearManual()
  }

  function finishManual() {
    manualToken += 1
    const clip = manualClip
    manualClip = null
    if (clip !== null) {
      clip.onended = null
      clip.onerror = null
      clip.onpause = null
      clip.pause()
    }
    clearTimeout(manualTimer)
    manualTimer = 0
    if (state.manual !== null) publish({ manual: null })
  }

  function manualError(key, message) {
    clearTimeout(manualTimer)
    publish({ manual: { key, status: 'error', note: message } })
    manualTimer = setTimeout(() => {
      if (state.manual?.key === key && state.manual.status === 'error') publish({ manual: null })
    }, NOTE_MS)
    manualTimer?.unref?.()
  }

  function speakManual({ key, text, botId } = {}) {
    if (typeof key !== 'string' || key === '') return
    const current = state.manual
    if (current?.key === key) {
      if (current.status === 'playing') { clearManual(); return }
      if (current.status === 'loading') return
    }
    const clean = speakableSpeech(text)
    if (clean === '') {
      clearManual()
      manualError(key, t('Nothing to read aloud.'))
      return
    }
    disable()
    clearManual()
    const mine = ++manualToken
    publish({ manual: { key, status: 'loading' } })
    synthesize({ key, text: clean, botId })
      .then((value) => {
        if (mine !== manualToken) return
        if (typeof value?.audio !== 'string' || value.audio === '') throw new Error(t('The speech service returned no audio.'))
        const clip = play(`data:${value.mime ?? 'audio/mpeg'};base64,${value.audio}`)
        manualClip = clip
        clip.onended = () => { if (mine === manualToken) finishManual() }
        clip.onerror = () => {
          if (mine !== manualToken) return
          finishManual()
          manualError(key, t('Could not play this audio.'))
        }
        clip.onpause = () => { if (mine === manualToken && !clip.ended) finishManual() }
        return clip.play().then(() => {
          if (mine !== manualToken) return
          publish({ manual: { key, status: 'playing' } })
        })
      })
      .catch((error) => {
        if (mine !== manualToken) return
        finishManual()
        manualError(key, error?.message ?? String(error))
      })
  }

  return { snapshot: () => state, subscribe, enable, disable, stopRoom, enqueue, next, previous, notify: say, speakManual }
}
