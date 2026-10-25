import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpeech, readPatch } from '../src/host/tts.js'

const ASK = {
  text: '你好，世界',
  key: 'secret-key',
  baseUrl: 'https://api.example.test/v1/t2a_v2',
  model: 'speech-02-turbo',
  voice: 'male-qn-qingse',
  speed: 1,
}
const audioJson = (bytes, code = 0) => new Response(JSON.stringify({
  data: { audio: Buffer.from(bytes).toString('hex'), status: 2 },
  base_resp: { status_code: code, status_msg: code === 0 ? 'success' : 'bad key' },
}), { status: 200, headers: { 'content-type': 'application/json' } })

test('readPatch keeps the setup small and checked', () => {
  const next = readPatch({}, { enabled: true, groupId: '181', model: 'speech-02-hd', defaultVoice: 'female-shaonv', speed: 1.2, voices: { bot1: 'male-qn-badao', bot2: '' } })
  assert.deepEqual(next, { enabled: true, groupId: '181', model: 'speech-02-hd', defaultVoice: 'female-shaonv', speed: 1.2, voices: { bot1: 'male-qn-badao' } })
  assert.throws(() => readPatch({}, { model: 'gpt' }), /speech models/)
  assert.throws(() => readPatch({}, { speed: 0.1 }), /0\.5 and 2/)
  assert.throws(() => readPatch({}, { baseUrl: 'ftp://x' }), /http/)
  assert.throws(() => readPatch({}, { enabled: 'yes' }), /on or off/)
  assert.equal(readPatch({ model: 'speech-02-hd' }, { model: null }).model, undefined)
})

test('speak calls MiniMax with the shape the T2A v2 API takes', async () => {
  const calls = []
  const speech = createSpeech({
    dir: await mkdtemp(join(tmpdir(), 'ds-bot-tts-')),
    fetch: async (url, init) => { calls.push({ url, init }); return audioJson('mp3-bytes') },
  })
  const { audio, cached } = await speech.speak({ ...ASK, groupId: '181' })
  assert.equal(cached, false)
  assert.equal(audio.toString(), 'mp3-bytes')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${ASK.baseUrl}?GroupId=181`)
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-key')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, ASK.model)
  assert.equal(body.text, ASK.text)
  assert.equal(body.stream, false)
  assert.deepEqual(body.voice_setting, { voice_id: ASK.voice, speed: ASK.speed })
  assert.deepEqual(body.audio_setting, { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 })
})

test('a cached clip is served without another request', async () => {
  let asked = 0
  const speech = createSpeech({
    dir: await mkdtemp(join(tmpdir(), 'ds-bot-tts-')),
    fetch: async () => { asked += 1; return audioJson('first') },
  })
  const again = await speech.speak(ASK)
  assert.deepEqual((await speech.speak(ASK)).audio, again.audio)
  assert.equal((await speech.speak(ASK)).cached, true)
  assert.equal(asked, 1)
  // A different voice is a different clip.
  await speech.speak({ ...ASK, voice: 'female-shaonv' })
  assert.equal(asked, 2)
})

test('a fresh cache answers again after a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ds-bot-tts-'))
  const first = createSpeech({ dir, fetch: async () => audioJson('kept') })
  await first.speak(ASK)
  let asked = 0
  const second = createSpeech({ dir, fetch: async () => { asked += 1; return audioJson('new') } })
  assert.equal((await second.speak(ASK)).audio.toString(), 'kept')
  assert.equal(asked, 0)
})

test('MiniMax refusals surface as refusals, not crashes', async () => {
  const speech = createSpeech({ dir: await mkdtemp(join(tmpdir(), 'ds-bot-tts-')), fetch: async () => audioJson('x', 1004) })
  await assert.rejects(speech.speak(ASK), error => error.code === 'bot/refused' && /1004/.test(error.message))
  const broken = createSpeech({
    dir: await mkdtemp(join(tmpdir(), 'ds-bot-tts-')),
    fetch: async () => new Response('gateway', { status: 502 }),
  })
  await assert.rejects(broken.speak(ASK), error => error.code === 'bot/refused' && /502/.test(error.message))
})
