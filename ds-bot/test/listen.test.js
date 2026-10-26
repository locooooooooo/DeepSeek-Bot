import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createListening } from '../src/client/listen-core.js'
import { speakableSpeech } from '../src/client/text.js'

const flush = () => new Promise(resolve => setImmediate(resolve))
const audio = text => ({ audio: Buffer.from(text).toString('base64'), mime: 'audio/mpeg' })

function fakePlayer() {
  const clips = []
  const play = (url) => {
    const clip = {
      url,
      currentTime: 0,
      ended: false,
      play: async () => {},
      pause: () => { clip.onpause?.() },
      finish: () => { clip.ended = true; clip.onended?.() },
    }
    clips.push(clip)
    return clip
  }
  return { clips, play }
}

const ask = (listen, key, text, time, roomId = 'room', botId = 'bot') => listen.enqueue({ roomId, key, text, botId, time })

test('a new group speech is cleaned and spoken in its Bot voice', async () => {
  const calls = []
  const player = fakePlayer()
  const listen = createListening({
    synthesize: async (item) => { calls.push(item); return audio(item.text) },
    play: player.play,
    now: () => 1000,
  })
  listen.enable('room')
  assert.equal(ask(listen, 'm1', '【正方立论-正方】**Hello** world', 1001, 'room', 'debater'), true)
  await flush()
  assert.deepEqual(calls.map(item => [item.text, item.botId]), [['Hello world', 'debater']])
  assert.equal(listen.snapshot().current.status, 'playing')
  assert.equal(player.clips.length, 1)
})

test('only later messages of the listened room enter the queue', async () => {
  const listen = createListening({ synthesize: async item => audio(item.text), play: fakePlayer().play, now: () => 1000 })
  listen.enable('room')
  assert.equal(ask(listen, 'old', 'old', 999), false)
  assert.equal(ask(listen, 'other', 'other', 1001, 'another'), false)
  assert.equal(ask(listen, 'm1', 'one', 1001), true)
  assert.equal(ask(listen, 'm1', 'one again', 1002), false)
  await flush()
  assert.equal(listen.snapshot().queue.length, 0)
})

test('the next speech is already synthesized while the first one plays', async () => {
  const calls = []
  const player = fakePlayer()
  const listen = createListening({
    synthesize: async (item) => { calls.push(item.key); return audio(item.text) },
    play: player.play,
    now: () => 0,
  })
  listen.enable('room')
  ask(listen, 'a', 'A', 1)
  await flush()
  ask(listen, 'b', 'B', 2)
  await flush()
  assert.deepEqual(calls, ['a', 'b'])
  player.clips[0].finish()
  await flush()
  assert.equal(listen.snapshot().current.key, 'b')
  assert.equal(player.clips[1].url.startsWith('data:audio/mpeg;base64,'), true)
})

test('next skips and previous returns to what was playing', async () => {
  const player = fakePlayer()
  const listen = createListening({ synthesize: async item => audio(item.text), play: player.play, now: () => 0 })
  listen.enable('room')
  ask(listen, 'a', 'A', 1)
  ask(listen, 'b', 'B', 2)
  await flush()
  assert.equal(listen.snapshot().current.key, 'a')
  listen.next()
  await flush()
  assert.equal(listen.snapshot().current.key, 'b')
  player.clips[1].currentTime = 10
  listen.previous()
  await flush()
  assert.equal(listen.snapshot().current.key, 'a')
  assert.equal(listen.snapshot().played.map(item => item.key).join(','), '')
  player.clips[2].finish()
  await flush()
  assert.equal(listen.snapshot().current.key, 'b')
})

test('a clip that ends before play() resolves does not linger as playing', async () => {
  const play = () => {
    const clip = {
      currentTime: 0,
      ended: false,
      pause() {},
      play: async () => { clip.ended = true; clip.onended?.() },
    }
    return clip
  }
  const listen = createListening({ synthesize: async item => audio(item.text), play, now: () => 0 })
  listen.enable('room')
  ask(listen, 'a', 'A', 1)
  await flush()
  assert.equal(listen.snapshot().current, null)
  assert.equal(listen.snapshot().played.length, 1)
})

test('a failed speech is skipped and the next one still plays', async () => {
  const player = fakePlayer()
  const listen = createListening({
    synthesize: async (item) => {
      if (item.key === 'bad') throw Object.assign(new Error('provider refused'), { code: 'bot/refused' })
      return audio(item.text)
    },
    play: player.play,
    now: () => 0,
  })
  listen.enable('room')
  ask(listen, 'bad', 'bad', 1)
  ask(listen, 'good', 'good', 2)
  await flush()
  await flush()
  assert.equal(listen.snapshot().current.key, 'good')
  assert.equal(listen.snapshot().note, 'provider refused')
})

test('three failures in a row stop listening', async () => {
  const listen = createListening({
    synthesize: async () => { throw Object.assign(new Error('no key'), { code: 'bot/refused' }) },
    play: fakePlayer().play,
    now: () => 0,
  })
  listen.enable('room')
  ask(listen, 'a', 'A', 1)
  ask(listen, 'b', 'B', 2)
  ask(listen, 'c', 'C', 3)
  await flush()
  await flush()
  assert.equal(listen.snapshot().roomId, null)
  assert.equal(listen.snapshot().note, 'no key')
})

test('manual listening lives on the same player and stops on enable', async () => {
  const player = fakePlayer()
  const listen = createListening({ synthesize: async item => audio(item.text), play: player.play })
  listen.speakManual({ key: 'm1', text: 'Hello', botId: 'bot' })
  await flush()
  assert.equal(listen.snapshot().manual.status, 'playing')
  listen.speakManual({ key: 'm1', text: 'Hello', botId: 'bot' })
  assert.equal(listen.snapshot().manual, null)
  listen.speakManual({ key: 'm2', text: 'Again', botId: 'bot' })
  await flush()
  assert.equal(listen.snapshot().manual.status, 'playing')
  listen.enable('room')
  assert.equal(listen.snapshot().manual, null)
})

test('debate stage tags and review requests are not read aloud', () => {
  assert.equal(speakableSpeech('【正方立论-正方】定义一下“出路”。'), '定义一下“出路”。')
  assert.equal(speakableSpeech('【重点】这条要读出来。'), '【重点】这条要读出来。')
  assert.equal(speakableSpeech('结论明确。【申请核查：增长 12%】'), '结论明确。')
  assert.equal(speakableSpeech('```js\nconst x = 1\n```\n正文'), '正文')
})
