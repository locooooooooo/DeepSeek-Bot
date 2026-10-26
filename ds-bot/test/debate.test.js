import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_RULES, matchNumberOf, memoryLine, migrate, nameFromRules, resolveSlots, resultOf, templateProblem, topicOf,
} from '../src/host/debate.js'

const line = (text, time = 1) => ({ who: '主持人', text, time })

test('resultOf takes the last S9 result from the group log', () => {
  const room = { log: [line('S1 开场'), line('S9 评分结果：反方 3:0 胜'), line('弹幕'), { kind: 'done', text: '' }] }
  assert.equal(resultOf(room), 'S9 评分结果：反方 3:0 胜')
  assert.equal(resultOf({ log: [line('S1 开场')] }), '')
  assert.equal(resultOf(undefined), '')
})

test('matchNumberOf reads Arabic and Chinese match numbers', () => {
  assert.equal(matchNumberOf('辩论赛直播间（第3场·已结束）'), 3)
  assert.equal(matchNumberOf('辩论赛直播间（第一场·已结束）'), 1)
  assert.equal(matchNumberOf('辩论赛直播间', 7), 7)
})

test('the default rules keep the show and the v3 output rules', () => {
  assert.match(DEFAULT_RULES, /S1 开场/)
  assert.match(DEFAULT_RULES, /S9/)
  assert.match(DEFAULT_RULES, /post_to_group/)
  assert.match(DEFAULT_RULES, /评委只在 S9 评分一次/)
})

test('topicOf reads the debate line and nameFromRules caps it', () => {
  assert.equal(topicOf('开场白\n辩题：甲 vs 乙\n规则'), '甲 vs 乙')
  assert.equal(topicOf('辩题:半角冒号也认'), '半角冒号也认')
  assert.equal(topicOf('没有辩题行'), '')
  assert.equal(nameFromRules('随便写'), 'Template 1')
  const long = nameFromRules(`辩题：${'长'.repeat(60)}`)
  assert.equal(long.length, 40)
  assert.ok(long.endsWith('…'))
})

test('memoryLine carries the match topic', () => {
  const text = memoryLine({
    matchNumber: 2,
    result: 'S9 评分结果：反方 3:0 胜，总分 42.7:38.7。'.repeat(20),
    role: '正方辩手',
    roomName: '辩论赛直播间（第2场·已结束）',
    topic: '薄荷绿丝袜',
  })
  assert.ok(text.length <= 290)
  assert.match(text, /第2场/)
  assert.match(text, /《薄荷绿丝袜》/)
  assert.match(text, /正方辩手/)
  assert.match(text, /已归档/)
  const bare = memoryLine({ matchNumber: 2, result: 'S9 结果', role: '', roomName: '群' })
  assert.doesNotMatch(bare, /《/)
})

test('migrate turns v1 rules and a persona snapshot into one template', () => {
  const saved = migrate({
    version: 1,
    roomId: 'r',
    hostId: 'h',
    adminId: 'a',
    memberIds: ['h', 'p'],
    matchNumber: 4,
    startedAt: 1,
    rules: '辩题：旧辩题\n流程',
    personas: { h: { name: '主持人', role: '控场', instructions: 'x' } },
    matches: [{ number: 3, roomId: 'r2', name: 'n', endedAt: 5, result: 'res' }],
  })
  assert.equal(saved.version, 2)
  assert.equal(saved.templates.length, 1)
  assert.equal(saved.templates[0].name, '旧辩题')
  assert.equal(saved.templates[0].personas[0].id, 'h')
  assert.equal(saved.activeTemplateId, saved.templates[0].id)
  assert.equal(saved.matches[0].number, 3)
  assert.equal(saved.matchNumber, 4)
  assert.equal(migrate(null).templates.length, 1)
})

test('resolveSlots falls back from id to name to a unique role', () => {
  const members = [
    { id: 'a', name: '甲', role: '控场' },
    { id: 'b', name: '乙', role: '评委' },
    { id: 'c', name: '丙', role: '评委' },
  ]
  const byId = resolveSlots([{ id: 'a', name: '甲', role: '控场' }], members)
  assert.equal(byId.slots[0].member.id, 'a')
  assert.deepEqual(byId.warnings, [])
  const byName = resolveSlots([{ id: 'gone', name: '乙', role: '' }], members)
  assert.equal(byName.slots[0].member.id, 'b')
  const byRole = resolveSlots([{ id: 'gone', name: '新人', role: '控场' }], members)
  assert.equal(byRole.slots[0].member.id, 'a')
  const ambiguous = resolveSlots([{ id: 'gone', name: '新人', role: '评委' }], members)
  assert.equal(ambiguous.slots.length, 0)
  assert.equal(ambiguous.warnings.length, 1)
  const twice = resolveSlots([
    { id: 'a', name: '甲', role: '控场' },
    { id: 'gone', name: '新人', role: '控场' },
  ], members)
  assert.equal(twice.slots.length, 1)
})

test('templateProblem rejects missing, long and duplicate names', () => {
  assert.notEqual(templateProblem({ name: '', rules: '' }, []), '')
  assert.notEqual(templateProblem({ name: 'x'.repeat(41), rules: '' }, []), '')
  assert.equal(
    templateProblem({ name: '薄荷绿', rules: '' }, [{ id: '1', name: '薄荷绿' }]),
    'A template with this name already exists.',
  )
  assert.equal(templateProblem({ id: '1', name: '薄荷绿', rules: '' }, [{ id: '1', name: '薄荷绿' }]), '')
  assert.notEqual(templateProblem({ name: '可以', rules: 'x'.repeat(8001) }, []), '')
})
