// The debate show: a library of topic templates (rules plus a full card for every
// member) and a fresh group chat per match. Starting a match writes the chosen
// template's cards onto the Bots, archives the finished group, writes the result
// into every member's memory, and opens a clean group so the next match starts
// without the last one's context.
import { randomUUID } from 'node:crypto'

export const DEBATE_ROOM = '辩论赛直播间'
const ARCHIVED = /（第\s*[0-9一二三四五六七八九十]+\s*场·已结束）$/
const CHINESE = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const NAME_MAX = 40
const ROLE_MAX = 24
const RULES_MAX = 8000

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

// The debate line of a rules text: its first 辩题 line, without the marker.
export function topicOf(rules) {
  const line = String(rules ?? '').split(/\r?\n/).map(part => part.trim()).find(part => part.startsWith('辩题'))
  return clean(line?.replace(/^辩题[：:]\s*/, ''))
}

export function nameFromRules(rules) {
  return truncate(topicOf(rules), NAME_MAX) || 'Template 1'
}

export function memoryLine({ matchNumber, result, role, roomName, topic }) {
  const summary = truncate(clean(result), 140)
  const show = clean(topic) === '' ? '' : `《${truncate(clean(topic), NAME_MAX)}》`
  return truncate(`历届战绩：第${matchNumber}场辩论${show}结束：${summary}。我担任${role || '成员'}。本场记录已归档在群「${roomName}」。`, 290)
}

// A template persona anchors on the member id it was written for. When a Bot was
// recreated (new id), fall back to its name, then to a role only one member holds.
export function resolveSlots(personas, members) {
  const warnings = []
  const slots = []
  for (const persona of Array.isArray(personas) ? personas : []) {
    if (persona === null || typeof persona !== 'object') continue
    let member = members.find(candidate => candidate.id === persona.id)
    if (member === undefined && clean(persona.name) !== '') member = members.find(candidate => candidate.name === persona.name)
    if (member === undefined && clean(persona.role) !== '') {
      const byRole = members.filter(candidate => candidate.role === persona.role)
      if (byRole.length === 1) member = byRole[0]
    }
    if (member === undefined) {
      warnings.push(`「${clean(persona.name) || persona.id}」没有匹配到现在的成员，已跳过`)
      continue
    }
    if (slots.some(slot => slot.member.id === member.id)) continue
    slots.push({ persona, member })
  }
  return { slots, warnings }
}

export function templateProblem(input, templates = []) {
  const name = clean(input?.name)
  const id = typeof input?.id === 'string' ? input.id : ''
  if (name === '') return 'The template needs a name.'
  if (name.length > NAME_MAX) return 'The name is longer than 40 characters.'
  if (templates.some(template => template.id !== id && template.name === name)) return 'A template with this name already exists.'
  if (clean(input?.rules ?? '').length > RULES_MAX) return 'The rules are longer than 8000 characters.'
  return ''
}

// One shared rules text and one persona snapshot (version 1) become the library's
// first template. Matches keep their shape; old entries simply have no topic.
export function migrate(saved) {
  const rules = typeof saved?.rules === 'string' && saved.rules.trim() !== '' ? saved.rules : DEFAULT_RULES
  const personas = Object.entries(saved?.personas ?? {}).map(([id, card]) => ({
    id,
    name: typeof card?.name === 'string' ? card.name : '',
    role: typeof card?.role === 'string' ? card.role : '',
    instructions: typeof card?.instructions === 'string' ? card.instructions : '',
  }))
  const now = Date.now()
  const template = { id: randomUUID(), name: nameFromRules(rules), rules, personas, createdAt: now, updatedAt: now }
  return {
    version: 2,
    roomId: saved?.roomId,
    hostId: saved?.hostId,
    adminId: saved?.adminId,
    memberIds: Array.isArray(saved?.memberIds) ? saved.memberIds : [],
    matchNumber: saved?.matchNumber ?? 1,
    startedAt: saved?.startedAt ?? now,
    templates: [template],
    activeTemplateId: template.id,
    matches: Array.isArray(saved?.matches) ? saved.matches : [],
  }
}

const lastTime = room => (room?.log ?? []).filter(line => line.time).at(-1)?.time ?? room?.createdAt ?? Date.now()

export function install(rt) {
  const { state, ctx } = rt

  const snapshot = (members) => members.flatMap((id) => {
    const bot = rt.botOf(id)
    return bot === undefined ? [] : [{ id, name: bot.name, role: bot.role, instructions: bot.instructions }]
  })

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
    let saved = state.debate
    if (saved !== null && typeof saved === 'object' && saved.version !== 2) {
      saved = migrate(saved)
      state.debate = saved
      await rt.save()
    }
    if (saved?.version === 2 && rt.roomOf(saved.roomId) !== undefined) return saved
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
    const seed = {
      id: randomUUID(),
      name: nameFromRules(DEFAULT_RULES),
      rules: DEFAULT_RULES,
      personas: snapshot(members),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const base = saved ?? {
      version: 2,
      templates: [seed],
      activeTemplateId: seed.id,
      matches: archived,
      matchNumber: archived.length + 1,
      startedAt: room.createdAt ?? Date.now(),
    }
    Object.assign(base, { roomId: room.id, hostId: host.id, adminId: admin.id, memberIds: members })
    state.debate = base
    await rt.save()
    return base
  }

  async function view() {
    const debate = await ensureDebate()
    if (debate === null) return { configured: false }
    const room = rt.roomOf(debate.roomId)
    const memberIds = debate.memberIds.filter(id => rt.botOf(id) !== undefined)
    const members = memberIds.map((id) => {
      const bot = rt.botOf(id)
      return { id, name: bot.name, role: bot.role }
    })
    const personas = memberIds.flatMap((id) => {
      const bot = rt.botOf(id)
      return bot === undefined ? [] : [{ id, name: bot.name, role: bot.role, instructions: bot.instructions }]
    })
    const templates = (debate.templates ?? []).map(template => ({
      id: template.id,
      name: template.name,
      rules: template.rules ?? '',
      updatedAt: template.updatedAt,
      personas: (template.personas ?? []).map(persona => ({
        id: persona.id,
        name: persona.name ?? '',
        role: persona.role ?? '',
        instructions: persona.instructions ?? '',
      })),
    }))
    const active = templates.find(template => template.id === debate.activeTemplateId) ?? null
    const result = room === undefined ? '' : resultOf(room)
    const busy = Object.keys(state.works ?? {}).length > 0 || running()
    return {
      configured: true,
      matchNumber: debate.matchNumber,
      startedAt: debate.startedAt,
      room: room === undefined ? null : { id: room.id, name: room.name },
      topic: active?.name ?? (debate.matches ?? []).at(-1)?.topic ?? '',
      activeTemplateId: debate.activeTemplateId ?? null,
      hostId: debate.hostId,
      adminId: debate.adminId,
      members,
      personas,
      templates,
      history: (debate.matches ?? []).slice().sort((a, b) => a.number - b.number),
      result: truncate(result, 600),
      canStart: result !== '' && !busy && templates.length > 0,
      busy,
    }
  }

  async function save(body) {
    const debate = await ensureDebate()
    if (debate === null) throw new Error('No debate group found')
    const input = body.template ?? {}
    const problem = templateProblem(input, debate.templates ?? [])
    if (problem !== '') throw new Error(problem)
    const memberIds = debate.memberIds.filter(id => rt.botOf(id) !== undefined)
    const personas = (Array.isArray(input.personas) ? input.personas : [])
      .filter(persona => typeof persona?.id === 'string' && memberIds.includes(persona.id))
      .filter((persona, index, list) => list.findIndex(other => other.id === persona.id) === index)
      .map(persona => ({
        id: persona.id,
        name: String(persona.name ?? '').trim().slice(0, NAME_MAX),
        role: String(persona.role ?? '').trim().slice(0, ROLE_MAX),
        instructions: String(persona.instructions ?? ''),
      }))
    let template = debate.templates.find(candidate => candidate.id === input.id)
    if (template === undefined) {
      template = { id: randomUUID(), createdAt: Date.now() }
      debate.templates.push(template)
    }
    Object.assign(template, {
      name: clean(input.name),
      rules: String(input.rules ?? '').trim().slice(0, RULES_MAX),
      personas,
      updatedAt: Date.now(),
    })
    await rt.save()
    return view()
  }

  async function remove(body) {
    const debate = await ensureDebate()
    if (debate === null) throw new Error('No debate group found')
    const index = (debate.templates ?? []).findIndex(template => template.id === body.id)
    if (index === -1) throw new Error('No such template')
    const [gone] = debate.templates.splice(index, 1)
    if (debate.activeTemplateId === gone.id) debate.activeTemplateId = debate.templates[0]?.id ?? null
    await rt.save()
    return view()
  }

  // Writes a template's cards onto the members without starting a match; empty
  // fields leave that Bot's card as it is. Failures (a taken name, say) become
  // warnings so one member never blocks the rest.
  async function applyTemplate(debate, template) {
    const memberIds = debate.memberIds.filter(id => rt.botOf(id) !== undefined)
    const members = memberIds.flatMap((id) => {
      const bot = rt.botOf(id)
      return bot === undefined ? [] : [{ id, name: bot.name, role: bot.role }]
    })
    const { slots, warnings } = resolveSlots(template.personas ?? [], members)
    for (const { persona, member } of slots) {
      const patch = {}
      if (clean(persona.name) !== '') patch.name = clean(persona.name).slice(0, NAME_MAX)
      if (clean(persona.role) !== '') patch.role = clean(persona.role).slice(0, ROLE_MAX)
      if (String(persona.instructions ?? '').trim() !== '') patch.instructions = String(persona.instructions)
      if (Object.keys(patch).length === 0) continue
      try {
        await rt.updateBot(member.id, patch)
      } catch (error) {
        warnings.push(`${member.name}: ${error?.message ?? error}`)
      }
    }
    return warnings
  }

  async function applyToMembers(body) {
    const debate = await ensureDebate()
    if (debate === null) throw new Error('No debate group found')
    const template = (debate.templates ?? []).find(candidate => candidate.id === body.id)
    if (template === undefined) throw new Error('No such template')
    const warnings = await applyTemplate(debate, template)
    return { ...(await view()), warnings }
  }

  const running = () => [...(rt.live?.values() ?? [])].some(entry => entry?.turn !== undefined)

  // The show runs as a chain of turns, and a dropped model connection can leave one
  // hanging without ever ending - the chain then waits forever. A nudge cuts the
  // stuck turn, if any, and asks the host to carry on from where the record stops.
  async function carryOn(targetSessionId, stuckName) {
    const debate = await ensureDebate()
    if (debate === null) throw new Error('No debate group found')
    const memberIds = debate.memberIds.filter(id => rt.botOf(id) !== undefined)
    const hostId = memberIds.includes(debate.hostId)
      ? debate.hostId
      : memberIds.find(id => rt.botOf(id)?.role === '控场') ?? memberIds[0]
    if (hostId === undefined) throw new Error('No debate group found')
    let cut = false
    if (targetSessionId !== undefined && rt.live?.get(targetSessionId)?.turn !== undefined) {
      try {
        await ctx.sessionController.cancel({ sessionId: targetSessionId })
        cut = true
      } catch {
        // The turn may have ended by itself; the queued message still goes out.
      }
    }
    const who = stuckName === undefined ? '' : `（${stuckName} 的回复若没有交回，先把给它的调度指令重发一次）`
    await sendToBot(hostId, `【催场】请检查本场进度并继续主持：若上一次派活的回复没有交回（可能因为模型故障），就按群里的公共记录把那条调度指令重发一次，从停住的位置继续；不要重开流程，不要跳过阶段。${who}`)
    return { ...(await view()), cut }
  }

  async function nudge() {
    const debate = await ensureDebate()
    if (debate === null) throw new Error('No debate group found')
    const memberIds = debate.memberIds.filter(id => rt.botOf(id) !== undefined)
    const hostId = memberIds.includes(debate.hostId)
      ? debate.hostId
      : memberIds.find(id => rt.botOf(id)?.role === '控场') ?? memberIds[0]
    if (hostId === undefined) throw new Error('No debate group found')
    return carryOn(rt.chatOf(hostId))
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
  async function start(templateId) {
    if (starting) throw new Error('A new match is already starting')
    starting = true
    try {
      return await startMatch(templateId)
    } finally {
      starting = false
    }
  }

  async function startMatch(templateId) {
    const debate = await ensureDebate()
    if (debate === null) throw new Error('No debate group found')
    const room = rt.roomOf(debate.roomId)
    if (room === undefined) throw new Error('The debate group is gone')
    if (Object.keys(state.works ?? {}).length > 0 || running()) throw new Error('The current match is still running')
    const result = resultOf(room)
    if (result === '') throw new Error('The current match has no S9 result yet')
    const template = (debate.templates ?? []).find(candidate => candidate.id === templateId)
    if (template === undefined) throw new Error('Pick a template for the next match')

    const warnings = await applyTemplate(debate, template)
    // The finished match ran on the template that was active until now; the picked
    // template only names the match that is about to start.
    const finishedTopic = (debate.templates ?? []).find(candidate => candidate.id === debate.activeTemplateId)?.name ?? ''
    const number = debate.matchNumber
    const oldName = room.name
    const archivedName = `${DEBATE_ROOM}（第${number}场·已结束）`
    const memberIds = debate.memberIds.filter(id => rt.botOf(id) !== undefined)
    const hostId = memberIds.includes(debate.hostId)
      ? debate.hostId
      : memberIds.find(id => rt.botOf(id)?.role === '控场') ?? memberIds[0]
    const adminId = memberIds.includes(debate.adminId)
      ? debate.adminId
      : memberIds.find(id => rt.botOf(id)?.role === '核查') ?? hostId

    try {
      await rt.updateRoom(room.id, { name: archivedName })
    } catch (error) {
      throw new Error(`The current group could not be archived: ${error?.message ?? error}`)
    }

    let nextRoom
    try {
      nextRoom = await rt.createRoom({ members: memberIds, name: DEBATE_ROOM, admin: adminId })
    } catch (error) {
      await rt.updateRoom(room.id, { name: oldName }).catch(() => {})
      throw new Error(`The next group could not be created: ${error?.message ?? error}`)
    }

    if (typeof rt.memoryAdd === 'function') {
      for (const id of memberIds) {
        const bot = rt.botOf(id)
        if (bot === undefined) continue
        const text = memoryLine({ matchNumber: number, result, role: bot.role, roomName: archivedName, topic: finishedTopic })
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
    debate.memberIds = memberIds
    debate.activeTemplateId = template.id
    debate.matches = [...(debate.matches ?? []), {
      number,
      roomId: room.id,
      name: archivedName,
      endedAt: Date.now(),
      result: truncate(result, 600),
      topic: finishedTopic,
    }]
    await rt.save()

    for (const id of memberIds) {
      if (id === hostId) continue
      const bot = rt.botOf(id)
      try {
        await sendToBot(id, resetText(bot, number + 1))
      } catch (error) {
        warnings.push(`${bot.name}: ${error?.message ?? error}`)
      }
    }
    const topicLine = topicOf(template.rules) || template.name
    try {
      await sendToBot(hostId, `【第${number + 1}场开始】上一场已归档为「${archivedName}」；本场从零开始，历届战绩保留在记忆里，但不要把它当作本场论据。本场辩题：${topicLine}。新群是「${DEBATE_ROOM}」。请按 v3 规则开始第${number + 1}场：先发 S1，然后用 message_bot 私聊派活；所有正式发言由本人 post_to_group 发到群里；评委只在 S9 评分一次。`)
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
      ? { roomId: debate.roomId, name: `${DEBATE_ROOM}（第${number}场·已结束）`, topic: '' }
      : (debate.matches ?? []).find(match => match.number === number)
    if (saved === undefined) throw new Error(`No match ${number}`)
    const room = rt.roomOf(saved.roomId)
    if (room === undefined) throw new Error('That match group is gone')
    const result = resultOf(room)
    if (result === '') throw new Error('That match has no S9 result')
    const topic = saved.topic
      ?? (debate.templates ?? []).find(template => template.id === debate.activeTemplateId)?.name
      ?? ''
    const warnings = []
    let written = 0
    for (const id of debate.memberIds) {
      const bot = rt.botOf(id)
      if (bot === undefined) continue
      try {
        await rt.memoryAdd({
          botId: id,
          topic: 'debate',
          text: memoryLine({ matchNumber: number, result, role: bot.role, roomName: saved.name, topic }),
        })
        written += 1
      } catch (error) {
        warnings.push(`${bot.name}: ${error?.message ?? error}`)
      }
    }
    return { written, warnings }
  }

  // Turns that stop emitting events are how a dropped model connection shows up
  // here; every event of a running turn refreshes `lastAt` (turns.js). Once a
  // member's turn has been silent past STALE_MS during an unfinished match, the
  // watchdog cuts it and tells the host to carry on, so a reconnect no longer ends
  // the show. The cooldown keeps a genuinely long turn from being cut twice.
  // A delivery can also land on an idle Session and never be taken up by any turn
  // (unreadOf); past IDLE_MS that is an orphaned message, and a fresh prompt wakes
  // the Session with the inbox still aboard.
  const STALE_MS = 5 * 60_000
  const IDLE_MS = 3 * 60_000
  const NUDGE_COOLDOWN_MS = 3 * 60_000
  let nudgedAt = 0
  const seenUnread = new Map()
  async function autoNudge() {
    const debate = state.debate
    if (debate?.version !== 2 || starting) return null
    if (Date.now() - nudgedAt < NUDGE_COOLDOWN_MS) return null
    const room = rt.roomOf(debate.roomId)
    if (room === undefined || resultOf(room) !== '') return null
    let stuck = null
    for (const id of debate.memberIds) {
      const sessionId = rt.chatOf(id)
      if (rt.live?.get(sessionId)?.turn === undefined) continue
      const entry = rt.live.get(sessionId)
      const last = entry.lastAt ?? entry.since ?? Date.now()
      if (Date.now() - last >= STALE_MS) { stuck = { id, cancelSessionId: sessionId, forMinutes: Math.round((Date.now() - last) / 60_000), why: 'went silent' }; break }
    }
    if (stuck === null) {
      // Across all members at once: an exchange one member's empty inbox would
      // otherwise strike from the map while another still holds it.
      const unreadOfMember = new Map(debate.memberIds.map(id => [id, (rt.unreadOf?.(rt.chatOf(id)) ?? []).map(item => item?.exchangeId).filter(Boolean)]))
      const anyUnread = new Set([...unreadOfMember.values()].flat())
      for (const exchangeId of anyUnread) if (!seenUnread.has(exchangeId)) seenUnread.set(exchangeId, Date.now())
      for (const [exchangeId, at] of seenUnread) {
        if (!anyUnread.has(exchangeId)) { seenUnread.delete(exchangeId); continue }
        const holder = debate.memberIds.find(id => (unreadOfMember.get(id) ?? []).includes(exchangeId) && rt.live?.get(rt.chatOf(id))?.turn === undefined)
        if (holder !== undefined && Date.now() - at >= IDLE_MS) {
          stuck = { id: holder, cancelSessionId: undefined, forMinutes: Math.round((Date.now() - at) / 60_000), why: 'never reached a turn' }
          break
        }
      }
    }
    if (stuck === null) return null
    nudgedAt = Date.now()
    const name = rt.botOf(stuck.id)?.name ?? 'A member'
    rt.noteFailure?.({ source: 'debate', text: `${name}'s turn ${stuck.why} for ${stuck.forMinutes} min; ${stuck.cancelSessionId === undefined ? 'woke the host to carry on' : 'cut it and asked the host to carry on'}` })
    return { ...(await carryOn(stuck.cancelSessionId, name).catch(error => ({ error: error?.message ?? String(error) }))), stuck }
  }
  const watch = setInterval(() => { void autoNudge().catch(() => {}) }, 60_000)
  watch.unref?.()

  async function endpoint(action, body = {}) {
    await rt.load()
    if (action === 'view') return view()
    if (action === 'save') return save(body)
    if (action === 'delete') return remove(body)
    if (action === 'apply') return applyToMembers(body)
    if (action === 'nudge') return nudge()
    if (action === 'start') return start(body.templateId)
    if (action === 'remember') return remember(body)
    throw new Error(`Unknown debate action ${action}`)
  }

  Object.assign(rt, { debateEndpoint: endpoint, debateAutoNudge: autoNudge })
}
