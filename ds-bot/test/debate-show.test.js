import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_RULES, install, nameFromRules } from '../src/host/debate.js'

// The debate endpoint over a minimal fake rt: enough of the roster, room and memory
// surface for view → save → start to run for real, with prompts recorded.
const makeRt = () => {
  const bots = {
    host: { id: 'host', name: '主持人', role: '控场', instructions: 'old host card' },
    pro: { id: 'pro', name: '正方辩手', role: '正方', instructions: 'old pro card' },
    con: { id: 'con', name: '反方辩手', role: '反方', instructions: 'old con card' },
  }
  const rooms = {
    'room-1': {
      id: 'room-1',
      name: '辩论赛直播间',
      members: ['host', 'pro', 'con'],
      admin: 'con',
      createdAt: 1,
      log: [
        { who: '主持人', text: 'S1 开场', time: 1 },
        { who: '主持人', text: 'S9 评分结果：反方 3:0 胜', time: 2 },
      ],
    },
  }
  const rt = {
    state: { bots, rooms, works: {}, debate: null },
    prompts: [],
    cancels: [],
    memory: [],
    ctx: { sessionController: {
      prompt: async (request) => { rt.prompts.push(request) },
      cancel: async (request) => { rt.cancels.push(request) },
    } },
    live: new Map(),
    botOf: id => rt.state.bots[id],
    roomOf: id => rt.state.rooms[id],
    chatOf: id => id,
    ensureCapabilities: async () => {},
    updateBot: async (id, patch) => {
      if (patch.name === '被占用') throw new Error('name is taken')
      Object.assign(rt.state.bots[id], patch)
    },
    updateRoom: async (id, patch) => { Object.assign(rt.state.rooms[id], patch) },
    createRoom: async ({ members, name, admin }) => {
      const id = `room-${Object.keys(rt.state.rooms).length + 1}`
      rt.state.rooms[id] = { id, name, members, admin, log: [], createdAt: 3 }
      return rt.state.rooms[id]
    },
    memoryAdd: async ({ botId, text }) => { rt.memory.push({ botId, text }) },
    save: async () => {},
    load: async () => {},
  }
  install(rt)
  return rt
}

test('view migrates a v1 state and seeds the library from its rules', async () => {
  const rt = makeRt()
  rt.state.debate = {
    version: 1,
    roomId: 'room-1',
    hostId: 'host',
    adminId: 'con',
    memberIds: ['host', 'pro', 'con'],
    matchNumber: 1,
    startedAt: 1,
    rules: '辩题：旧辩题：甲 vs 乙\n流程：略',
    personas: {
      host: { name: '主持人', role: '控场', instructions: 'old host card' },
      pro: { name: '正方辩手', role: '正方', instructions: 'old pro card' },
    },
    matches: [],
  }
  const view = await rt.debateEndpoint('view', {})
  assert.equal(view.configured, true)
  assert.equal(view.templates.length, 1)
  assert.equal(view.templates[0].name, '旧辩题：甲 vs 乙')
  assert.equal(view.activeTemplateId, view.templates[0].id)
  assert.equal(rt.state.debate.version, 2)
})

test('save, then start applies the template, archives and remembers', async () => {
  const rt = makeRt()
  await rt.debateEndpoint('view', {})
  const saved = await rt.debateEndpoint('save', { template: {
    name: '薄荷绿丝袜',
    rules: '辩题：短视频平台的薄荷绿丝袜：满足还是驯化？\n流程：S1–S9',
    personas: [
      { id: 'host', name: '主持人', role: '控场', instructions: 'new host card' },
      { id: 'pro', name: '正方辩手', role: '正方', instructions: 'new pro card' },
      { id: 'con', name: '反方辩手', role: '反方', instructions: '' },
      { id: 'ghost', name: '已删的成员', role: '评委', instructions: '不应出现' },
    ],
  } })
  assert.equal(saved.templates.length, 2)
  const templateId = saved.templates.find(template => template.name === '薄荷绿丝袜').id
  assert.ok(templateId !== saved.templates[0].id)

  const started = await rt.debateEndpoint('start', { templateId })
  assert.deepEqual(started.warnings, [])
  assert.equal(rt.memory.length, 3)
  assert.equal(rt.state.rooms['room-1'].name, '辩论赛直播间（第1场·已结束）')
  const next = Object.values(rt.state.rooms).find(room => room.name === '辩论赛直播间')
  assert.equal(next.members.length, 3)
  assert.equal(next.admin, 'con')
  assert.equal(rt.state.bots.host.instructions, 'new host card')
  assert.equal(rt.state.bots.pro.instructions, 'new pro card')
  assert.equal(rt.state.bots.con.instructions, 'old con card')
  assert.ok(rt.memory.length === 3)
  // The archived match is recorded under the template that ran it, not the next one.
  const finishedName = nameFromRules(DEFAULT_RULES)
  for (const entry of rt.memory) assert.match(entry.text, new RegExp(`《${finishedName.slice(0, 6)}`))
  assert.equal(rt.state.debate.version, 2)
  assert.equal(rt.state.debate.matchNumber, 2)
  assert.equal(rt.state.debate.activeTemplateId, templateId)
  assert.equal(rt.state.debate.matches.at(-1).topic, finishedName)
  assert.equal(started.topic, '薄荷绿丝袜')
  assert.equal(started.canStart, false)
  const kickoff = rt.prompts.at(-1).content[0].text
  assert.match(kickoff, /第2场/)
  assert.match(kickoff, /薄荷绿丝袜/)
  assert.equal(rt.prompts.filter(prompt => /【第2场】/.test(prompt.content[0].text)).length, 2)
})

test('a card the roster rejects becomes a warning, not a broken match', async () => {
  const rt = makeRt()
  const saved = await rt.debateEndpoint('save', { template: {
    name: '改名冲突',
    rules: '辩题：改名冲突\n流程：略',
    personas: [{ id: 'host', name: '被占用', role: '控场', instructions: 'x' }],
  } })
  const templateId = saved.templates.find(template => template.name === '改名冲突').id
  const started = await rt.debateEndpoint('start', { templateId })
  assert.equal(started.warnings.length, 1)
  assert.match(started.warnings[0], /主持人/)
  assert.equal(rt.state.bots.host.name, '主持人')
  assert.equal(rt.state.rooms['room-1'].name, '辩论赛直播间（第1场·已结束）')
})

test('the watchdog cuts a silent turn during an unfinished match', async () => {
  const rt = makeRt()
  rt.notes = []
  rt.noteFailure = note => { rt.notes.push(note) }
  const saved = await rt.debateEndpoint('save', { template: { name: '测试', rules: '辩题：测试\n流程', personas: [] } })
  const started = await rt.debateEndpoint('start', { templateId: saved.templates.find(template => template.name === '测试').id })
  assert.equal(started.canStart, false)

  // A live entry without a running turn is an idle session, not a busy show.
  rt.live.set('host', { turn: undefined, texts: [] })
  const withIdle = await rt.debateEndpoint('view', {})
  assert.equal(withIdle.busy, false)

  assert.equal(await rt.debateAutoNudge(), null)
  rt.live.set('con', { turn: 4, lastAt: Date.now() - 6 * 60_000, texts: [] })
  const nudged = await rt.debateAutoNudge()
  assert.equal(nudged.cut, true)
  assert.equal(nudged.stuck.id, 'con')
  assert.deepEqual(rt.cancels, [{ sessionId: 'con' }])
  assert.match(rt.prompts.at(-1).content[0].text, /反方辩手/)
  assert.equal(rt.notes.length, 1)
  // The cooldown holds a second cut back, whatever the map says.
  rt.live.set('host', { turn: 5, lastAt: Date.now() - 9 * 60_000, texts: [] })
  assert.equal(await rt.debateAutoNudge(), null)
})

test('the watchdog wakes the host when a delivery never reaches a turn', async (t) => {
  const rt = makeRt()
  rt.notes = []
  rt.noteFailure = note => { rt.notes.push(note) }
  const saved = await rt.debateEndpoint('save', { template: { name: '孤儿', rules: '辩题：孤儿\n流程', personas: [] } })
  await rt.debateEndpoint('start', { templateId: saved.templates.find(template => template.name === '孤儿').id })
  // A judge's reply sits unread on the idle host; no turn is running anywhere.
  rt.unreadOf = sessionId => (sessionId === 'host' ? [{ exchangeId: 'ex-1' }] : [])
  assert.equal(await rt.debateAutoNudge(), null)
  t.mock.timers.enable({ now: Date.now() })
  t.mock.timers.tick(4 * 60_000)
  const nudged = await rt.debateAutoNudge()
  assert.equal(nudged.cut, false)
  assert.deepEqual(rt.cancels, [])
  assert.equal(nudged.stuck.id, 'host')
  assert.match(rt.prompts.at(-1).content[0].text, /【催场】/)
  assert.match(rt.notes[0].text, /never reached a turn/)
})

test('the watchdog asks the host to check when the whole show goes quiet', async (t) => {
  const rt = makeRt()
  rt.notes = []
  rt.noteFailure = note => { rt.notes.push(note) }
  rt.unreadOf = () => []
  const saved = await rt.debateEndpoint('save', { template: { name: '安静', rules: '辩题：安静', personas: [] } })
  await rt.debateEndpoint('start', { templateId: saved.templates.find(template => template.name === '安静').id })
  assert.equal(await rt.debateAutoNudge(), null)
  t.mock.timers.enable({ now: Date.now() })
  t.mock.timers.tick(4 * 60_000)
  const nudged = await rt.debateAutoNudge()
  assert.equal(nudged.stuck.id, 'host')
  assert.equal(nudged.stuck.why, 'went quiet all over')
  assert.deepEqual(rt.cancels, [])
  assert.match(rt.prompts.at(-1).content[0].text, /【催场】/)
  assert.match(rt.notes[0].text, /went quiet all over/)
})

test('a nudge cuts a hung host turn and asks it to carry on', async () => {
  const rt = makeRt()
  await rt.debateEndpoint('view', {})
  const idle = await rt.debateEndpoint('nudge', {})
  assert.equal(idle.cut, false)
  assert.deepEqual(rt.cancels, [])
  assert.match(rt.prompts.at(-1).content[0].text, /【催场】/)

  rt.live.set('host', { turn: 7, texts: [] })
  const cut = await rt.debateEndpoint('nudge', {})
  assert.equal(cut.cut, true)
  assert.deepEqual(rt.cancels, [{ sessionId: 'host' }])
  assert.match(rt.prompts.at(-1).content[0].text, /从停住的位置继续/)
  rt.live.delete('host')
})

test('the endpoints refuse what they cannot do', async () => {
  const rt = makeRt()
  await assert.rejects(() => rt.debateEndpoint('start', { templateId: 'missing' }), /Pick a template/)
  const saved = await rt.debateEndpoint('save', { template: { name: '唯一', rules: '' } })
  assert.equal(saved.templates.length, 2)
  await assert.rejects(
    () => rt.debateEndpoint('save', { template: { name: '唯一', rules: '' } }),
    /already exists/,
  )
  const gone = saved.templates[0].id
  const view = await rt.debateEndpoint('delete', { id: gone })
  assert.equal(view.templates.length, 1)
  assert.equal(view.activeTemplateId, view.templates[0].id)
  await assert.rejects(() => rt.debateEndpoint('delete', { id: gone }), /No such template/)
  await assert.rejects(() => rt.debateEndpoint('apply', { id: 'missing' }), /No such template/)
})
