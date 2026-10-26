import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_RULES, matchNumberOf, memoryLine, resultOf } from '../src/host/debate.js'

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

test('memoryLine keeps one short entry with the role and archive name', () => {
  const text = memoryLine({
    matchNumber: 2,
    result: 'S9 评分结果：反方 3:0 胜，总分 42.7:38.7。'.repeat(20),
    role: '正方辩手',
    roomName: '辩论赛直播间（第2场·已结束）',
  })
  assert.ok(text.length <= 290)
  assert.match(text, /第2场/)
  assert.match(text, /正方辩手/)
  assert.match(text, /已归档/)
})

test('the default rules keep the show and the v3 output rules', () => {
  assert.match(DEFAULT_RULES, /S1 开场/)
  assert.match(DEFAULT_RULES, /S9/)
  assert.match(DEFAULT_RULES, /post_to_group/)
  assert.match(DEFAULT_RULES, /评委只在 S9 评分一次/)
})
