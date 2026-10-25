// Text-to-speech for listening to a Bot's message: MiniMax's T2A v2 over the
// plugin's own api/bot channel. The key lives in the secrets store under
// TTS_SECRET (the same store the Secrets page edits), the rest of the setup in
// state.tts. Synthesized clips are cached on disk by text and voice, so replaying
// a message never bills twice. Independent of the Bot team code.
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const TTS_SECRET = 'MINIMAX_TTS_KEY'
export const DEFAULT_BASE_URL = 'https://api.minimaxi.com/v1/t2a_v2'
export const DEFAULT_MODEL = 'speech-02-turbo'
export const DEFAULT_VOICE = 'male-qn-qingse'
export const TTS_MODELS = ['speech-02-turbo', 'speech-02-hd', 'speech-2.6-turbo', 'speech-2.6-hd', 'speech-2.8-turbo', 'speech-2.8-hd']

// The API takes whole texts of up to 10,000 characters in one request.
const MAX_CHARS = 10_000
const MAX_CACHE_FILES = 300
const TIMEOUT_MS = 120_000

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })

const textOf = raw => String(raw ?? '').replace(/\s+/g, ' ').trim()
const shortText = (raw, max) => (typeof raw === 'string' && raw.trim() !== '' ? raw.trim().slice(0, max) : undefined)

// The settings the Voice page can write. Everything but the key: the key goes
// through the secrets endpoints and never sits in state.json.
export function readPatch(current = {}, patch = {}) {
  const next = { ...current }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw invalid('Voice is on or off')
    next.enabled = patch.enabled
  }
  if (patch.baseUrl !== undefined) {
    const value = shortText(patch.baseUrl, 300)
    if (value === undefined) delete next.baseUrl
    else {
      if (!/^https?:\/\//i.test(value)) throw invalid('The speech service address starts with http:// or https://')
      next.baseUrl = value
    }
  }
  if (patch.groupId !== undefined) {
    const value = shortText(patch.groupId, 64)
    if (value === undefined) delete next.groupId
    else next.groupId = value
  }
  if (patch.model !== undefined) {
    const value = shortText(patch.model, 64)
    if (value === undefined) delete next.model
    else {
      if (!TTS_MODELS.includes(value)) throw invalid('Pick one of the speech models')
      next.model = value
    }
  }
  if (patch.defaultVoice !== undefined) {
    const value = shortText(patch.defaultVoice, 128)
    if (value === undefined) delete next.defaultVoice
    else next.defaultVoice = value
  }
  if (patch.speed !== undefined) {
    if (patch.speed === null) delete next.speed
    else {
      if (typeof patch.speed !== 'number' || patch.speed < 0.5 || patch.speed > 2) throw invalid('Speaking speed is between 0.5 and 2')
      next.speed = Math.round(patch.speed * 100) / 100
    }
  }
  if (patch.voices !== undefined) {
    const voices = {}
    for (const [botId, voice] of Object.entries(patch.voices ?? {})) {
      const value = shortText(voice, 128)
      if (value !== undefined) voices[String(botId).slice(0, 64)] = value
    }
    if (Object.keys(voices).length > 0) next.voices = voices
    else delete next.voices
  }
  return next
}

// One speech request against MiniMax, over an injected `fetch` for the tests.
export function createSpeech({ fetch = globalThis.fetch, dir } = {}) {
  const memory = new Map()
  const pending = new Map()

  const fileOf = key => join(dir, `${key}.mp3`)
  const keyOf = ask => createHash('sha256').update(JSON.stringify({
    v: 1, text: ask.text, voice: ask.voice, speed: ask.speed, model: ask.model, baseUrl: ask.baseUrl,
  })).digest('hex')

  async function cached(key) {
    if (memory.has(key)) return memory.get(key)
    try { return await readFile(fileOf(key)) } catch { return undefined }
  }

  // A cache this size never needs a real index: after writing, drop the oldest
  // files whenever the folder has grown past its cap.
  async function sweep() {
    let names
    try { names = (await readdir(dir)).filter(name => name.endsWith('.mp3')) } catch { return }
    if (names.length <= MAX_CACHE_FILES) return
    const stamps = await Promise.all(names.map(async (name) => {
      try { return { name, mtime: (await stat(join(dir, name))).mtimeMs } } catch { return { name, mtime: Infinity } }
    }))
    for (const { name } of stamps.sort((a, b) => a.mtime - b.mtime).slice(0, names.length - MAX_CACHE_FILES)) {
      memory.delete(name.replace(/\.mp3$/, ''))
      await rm(join(dir, name), { force: true }).catch(() => {})
    }
  }

  async function call(ask) {
    const url = ask.groupId === undefined ? ask.baseUrl : `${ask.baseUrl}?GroupId=${encodeURIComponent(ask.groupId)}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ask.key}` },
      body: JSON.stringify({
        model: ask.model,
        text: ask.text,
        stream: false,
        voice_setting: { voice_id: ask.voice, speed: ask.speed },
        audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const answer = await response.json().catch(() => null)
    const status = answer?.base_resp?.status_code ?? (response.ok ? -1 : -2)
    if (status !== 0) {
      const detail = answer?.base_resp?.status_msg ?? (response.ok ? 'The answer was not speech' : `HTTP ${response.status}`)
      throw refused(`MiniMax speech failed (${status}): ${detail}`)
    }
    const hex = answer?.data?.audio
    if (typeof hex !== 'string' || hex.length === 0) throw refused('MiniMax returned no audio')
    return Buffer.from(hex, 'hex')
  }

  return {
    async speak(ask) {
      const key = keyOf(ask)
      const hit = await cached(key)
      if (hit !== undefined) return { audio: hit, cached: true }
      const running = pending.get(key)
      if (running !== undefined) return { audio: await running, cached: true }
      const started = (async () => {
        try {
          const audio = await call(ask)
          await mkdir(dir, { recursive: true }).catch(() => {})
          await writeFile(fileOf(key), audio).catch(() => {})
          memory.set(key, audio)
          void sweep().catch(() => {})
          return audio
        } finally {
          pending.delete(key)
        }
      })()
      pending.set(key, started)
      return { audio: await started, cached: false }
    },
  }
}

export function install(rt) {
  const { state, home } = rt
  const speech = createSpeech({ dir: join(home, 'tts-audio') })
  // Loaded lazily: the secrets store reads secrets.json, which exists only once
  // the user has saved any key.
  const key = () => rt.secretValue?.(TTS_SECRET)

  const view = () => {
    const saved = state.tts ?? {}
    return {
      enabled: saved.enabled === true,
      baseUrl: saved.baseUrl ?? DEFAULT_BASE_URL,
      groupId: saved.groupId ?? '',
      model: saved.model ?? DEFAULT_MODEL,
      defaultVoice: saved.defaultVoice ?? DEFAULT_VOICE,
      speed: saved.speed ?? 1,
      voices: saved.voices ?? {},
      keySet: key() !== undefined,
    }
  }

  async function synthesize({ text, botId } = {}) {
    const saved = state.tts ?? {}
    const clean = textOf(text)
    if (clean === '') throw invalid('Nothing to speak')
    if (clean.length > MAX_CHARS) throw refused(`This message is too long to speak (over ${MAX_CHARS.toLocaleString('en-US')} characters).`)
    if (saved.enabled !== true) throw refused('Speech is off. Turn it on in Settings → Voice.')
    const secret = key()
    if (secret === undefined) throw refused('Add the MiniMax API key in Settings → Voice.')
    const { audio } = await speech.speak({
      text: clean,
      key: secret,
      baseUrl: saved.baseUrl ?? DEFAULT_BASE_URL,
      groupId: saved.groupId,
      model: saved.model ?? DEFAULT_MODEL,
      voice: saved.voices?.[botId] ?? saved.defaultVoice ?? DEFAULT_VOICE,
      speed: saved.speed ?? 1,
    })
    return { audio: audio.toString('base64'), mime: 'audio/mpeg' }
  }

  async function save(patch = {}) {
    state.tts = readPatch(state.tts ?? {}, patch)
    await rt.save()
    return view()
  }

  Object.assign(rt, { ttsView: view, ttsSynthesize: synthesize, ttsSave: save })
}
