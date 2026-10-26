// The debate show: one template of rules and personas, and a fresh group chat per
// match. The host's chat drives the flow; the group is the live stream. Starting a
// match archives the old group, writes the result into every member's memory, and
// opens a clean group so the next match starts without the last one's context.
import { randomUUID } from 'node:crypto'

export const DEBATE_ROOM = '辩论赛直播间'
const ARCHIVED = /（第\s*[0-9一二三四五六七八九十]+\s*场·已结束）$/
const CHINESE = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

export const DEFAULT_RULES = `辩题：AI 进化速度已超过人的学习速度：开发者的出路，是做"AI 指挥官"，还是做"AI 替代不了的工匠"？
正方（指挥官）vs 反方（工匠）
流程：S1 开场 → S2 正方立论 → S3 反方立论 → S4 反方质询正方（3 轮）→ S5 正方质询反方（3 轮）→ S6 自由辩论（正反各 4 次）→ S7 事实核查（随时插入）→ S8 总结陈词（反方先）→ S9 评分与宣布。
规则：发言以【阶段-角色】开头；引用数据须带来源；禁止人身攻击；评委只在 S9 评分一次；辩手自己用 post_to_group 把正式发言发到群里。`

const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim()
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function resultOf(room) {
  const lines = (room?.log ?? []).filter(line => line.kind === undefined && typeof line.text === 'string')
  const hit = [...lines].reverse().find(line => /S9|评分结果|获胜/.test(line.text))
  return hit === undefined ? '' : clean(hit.text)
}

export function matchNumberOf(name, fallback = 1) {
  const arabic = /第\s*(\d+)\s*场/.exec(String(name ?? ''))
  if (arabic !== null) return Number(arabic[1])
  const chinese = /第([一二三四五六七八九十]+)场/.exec(String(name ?? ''))
  if (chinese !== null) return chinese[1].split('').reduce((value, digit) => value * 10 + (CHINESE[digit] ?? 0), 0) || fallback
  return fallback
}

export function memoryLine({ matchNumber, result, role, roomName }) {
  const summary = truncate(clean(result), 140)
  return truncate(`历届战绩：第${matchNumber}场辩论《出路·AI 时代的开发者》结束：${summary}。我担任${role || '成员'}。本场记录已归档在群「${roomName}」。`, 290)
}

const lastTime = room => (room?.log ?? []).filter(line => line.time).at(-1)?.time ?? room?.createdAt ?? Date.now()

export function install(rt) {
  const { state, ctx } = rt

  const snapshot = (members) => Object.fromEntries(members.flatMap((id) => {
    const bot = rt.botOf(id)
    return bot === undefined ? [] : [[id, { name: bot.name, role: bot.role, instructions: bot.instructions }]]
  }))

  const debateRoom = () => {
    const rooms = Object.values(state.rooms)
    return rooms.find(room => room.name === DEBATE_ROOM)
      ?? rooms.find(room => room.name.startsWith(DEBATE_ROOM) && !ARCHIVED.test(room.name))
  }

  const archivedRooms = () => Object.values(state.rooms).filter(room => room.name.startsWith(DEBATE_ROOM) && ARCHIVED.test(room.name))

  function history() {
    return archivedRooms().map((room, index) => ({
      number: matchNumberOf(room.name, index + 1),
      roomId: room.id,
      name: room.name,
      endedAt: lastTime(room),
      result: truncate(resultOf(room), 400),
    })).sort((a, b) => a.number - b.number)
  }

  async function ensureDebate() {
    const saved = state.debate
    if (saved !== null && typeof saved === 'object' && saved.roomId !== undefined && rt.roomOf(saved.roomId) !== undefined) return saved
    const room = debateRoom()
    if (room === undefined) return null
    const members = room.members.filter(id => rt.botOf(id) !== undefined)
    if (members.length < 2) return null
    const host = members.map(id => rt.botOf(id)).find(bot => bot.role === '控场')
      ?? rt.botOf(room.admin)
      ?? rt.botOf(members[0])
    const admin = rt.botOf(room.admin)
      ?? members.map(id => rt.botOf(id)).find(bot => bot.role === '核查')
      ?? host
    const archived = history()
    state.debate = {
      version: 1,
      roomId: room.id,
      hostId: host.id,
      adminId: admin.id,
      memberIds: members,
      matchNumber: archived.length + 1,
      startedAt: room.createdAt ?? Date.now(),
      rules: DEFAULT_RULES,
      personas: snapshot(members),
      matches: archived,
    }
    await rt.save()
    return state.debate
  }

  async function view() {
    const debate = await ensureDebate()
    if (debate === null) return { configured: false }
    const room = rt.roomOf(debate.roomId)
    const members = debate.memberIds.filter(id => rt.botOf(id) !== undefined).map((id) => {
      const bot = rt.botOf(id)
      return { id, name: bot.name, role: bot.role }
    })
    const personas = members.map((member) => {
      const bot = rt.botOf(member.id)
      return { ...member, instructions: bot.instructions }
    })
    const result = room === undefined ? '' : resultOf(room)
    const busy = Object.keys(state.works ?? {}).length > 0 || (rt.live?.size ?? 0) > 0
    return {
      configured: true,
      matchNumber: debate.matchNumber,
      startedAt: debate.startedAt,
      room: room === undefined ? null : { id: room.id, name: room.name },
      hostId: debate.hostId,
      adminId: debate.adminId,
      members,
      personas,
      rules: debate.rules ?? DEFAULT_RULES,
      history: (debate.matches ?? []).slice().sort((a, b) => a.number - b.number),
      result: truncate(result, 600),
      canStart: result !== '' && !busy,
      busy,
    }
  }

  async function save(body) {
    const debate = await ensureDebate()
    if (debate === null) throw new Error('No debate group found')
    if (typeof body.rules === 'string') debate.rules = body.rules.trim().slice(0, 8000)
    if (Array.isArray(body.personas)) {
      for (const entry of body.personas) {
        if (typeof entry?.id !== 'string' || typeof entry.instructions !== 'string') continue
        if (!debate.memberIds.includes(entry.id) || rt.botOf(entry.id) === undefined) continue
        await rt.updateBot(entry.id, { instructions: entry.instructions })
      }
    }
    debate.personas = snapshot(debate.memberIds.filter(id => rt.botOf(id) !== undefined))
    await rt.save()
    return view()
  }

  async function sendToBot(botId, text) {
    const sessionId = rt.chatOf(botId)
    await rt.ensureCapabilities?.(sessionId)
    await ctx.sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, AbortSignal.timeout(30_000))
  }

  const resetText = (bot, number) => {
    const base = `【第${number}场】上一场已归档；本场从零开始，历届战绩保留在记忆里，但不要把它当作本场论据。等待主持人的调度，不要提问。`
    if (bot.role === '评委') return `${base} 不要往群里发消息；只在 S9 私聊回主持人评分。`
    if (bot.role === '核查') return `${base} 你是新群的管理员，但保持静默；核查结果私聊回主持人。`
    if (bot.role === '气氛') return `${base} 只在新群用自己的身份发弹幕。`
    return base
  }

  let starting = false
  async function start() {
    if (starting) throw new Error('A new match is already starting')
    starting = true
    try {
      return await startMatch()
    } finally {
      starting = false
    }
  }

  async function startMatch() {
    const debate = await ensureDebate()
    if (debate === null) throw new Error('No debate group found')
    const room = rt.roomOf(debate.roomId)
    if (room === undefined) throw new Error('The debate group is gone')
    if (Object.keys(state.works ?? {}).length > 0 || (rt.live?.size ?? 0) > 0) throw new Error('The current match is still running')
    const result = resultOf(room)
    if (result === '') throw new Error('The current match has no S9 result yet')

    const number = debate.matchNumber
    const oldName = room.name
    const archivedName = `${DEBATE_ROOM}（第${number}场·已结束）`
    const members = debate.memberIds.filter(id => rt.botOf(id) !== undefined)
    const hostId = members.includes(debate.hostId) ? debate.hostId : members[0]
    const adminId = members.includes(debate.adminId) ? debate.adminId : hostId
    const warnings = []

    try {
      await rt.updateRoom(room.id, { name: archivedName })
    } catch (error) {
      throw new Error(`The current group could not be archived: ${error?.message ?? error}`)
    }

    let nextRoom
    try {
      nextRoom = await rt.createRoom({ members, name: DEBATE_ROOM, admin: adminId })
    } catch (error) {
      await rt.updateRoom(room.id, { name: oldName }).catch(() => {})
      throw new Error(`The next group could not be created: ${error?.message ?? error}`)
    }

    if (typeof rt.memoryAdd === 'function') {
      for (const id of members) {
        const bot = rt.botOf(id)
        if (bot === undefined) continue
        const text = memoryLine({ matchNumber: number, result, role: bot.role, roomName: archivedName })
        try {
          await rt.memoryAdd({ botId: id, text, topic: 'debate' })
        } catch (error) {
          warnings.push(`${bot.name}: ${error?.message ?? error}`)
        }
      }
    }

    debate.matchNumber = number + 1
    debate.roomId = nextRoom.id
    debate.startedAt = Date.now()
    debate.hostId = hostId
    debate.adminId = adminId
    debate.memberIds = members
    debate.personas = snapshot(members)
    debate.matches = [...(debate.matches ?? []), {
      number,
      roomId: room.id,
      name: archivedName,
      endedAt: Date.now(),
      result: truncate(result, 600),
    }]
    await rt.save()

    for (const id of members) {
      if (id === hostId) continue
      const bot = rt.botOf(id)
      try {
        await sendToBot(id, resetText(bot, number + 1))
      } catch (error) {
        warnings.push(`${bot.name}: ${error?.message ?? error}`)
      }
    }
    try {
      await sendToBot(hostId, `【第${number + 1}场开始】上一场已归档为「${archivedName}」；本场从零开始，历届战绩保留在记忆里，但不要把它当作本场论据。新群是「${DEBATE_ROOM}」。请按 v3 规则开始第${number + 1}场：先发 S1，然后用 message_bot 私聊派活；所有正式发言由本人 post_to_group 发到群里；评委只在 S9 评分一次。`)
    } catch (error) {
      warnings.push(`主持人: ${error?.message ?? error}`)
    }

    return { ...(await view()), warnings }
  }

  // Backfill a match's result into every member's debate topic, for a match that
  // finished before the topic was in use. Re-running it adds nothing twice.
  async function remember(body) {
    const debate = await ensureDebate()
    if (debate === null) throw new Error('No debate group found')
    const number = Number.isInteger(Number(body.number)) ? Number(body.number) : debate.matchNumber
    const saved = number === debate.matchNumber
      ? { roomId: debate.roomId, name: `${DEBATE_ROOM}（第${number}场·已结束）` }
      : (debate.matches ?? []).find(match => match.number === number)
    if (saved === undefined) throw new Error(`No match ${number}`)
    const room = rt.roomOf(saved.roomId)
    if (room === undefined) throw new Error('That match group is gone')
    const result = resultOf(room)
    if (result === '') throw new Error('That match has no S9 result')
    const warnings = []
    let written = 0
    for (const id of debate.memberIds) {
      const bot = rt.botOf(id)
      if (bot === undefined) continue
      try {
        await rt.memoryAdd({
          botId: id,
          topic: 'debate',
          text: memoryLine({ matchNumber: number, result, role: bot.role, roomName: saved.name }),
        })
        written += 1
      } catch (error) {
        warnings.push(`${bot.name}: ${error?.message ?? error}`)
      }
    }
    return { written, warnings }
  }

  async function endpoint(action, body = {}) {
    await rt.load()
    if (action === 'view') return view()
    if (action === 'save') return save(body)
    if (action === 'start') return start()
    if (action === 'remember') return remember(body)
    throw new Error(`Unknown debate action ${action}`)
  }

  Object.assign(rt, { debateEndpoint: endpoint })
}
