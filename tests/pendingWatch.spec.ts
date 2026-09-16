/**
 * pendingWatch (F6/F7) unit tests — the pure mapping rules behind the IDE-side
 * approval modal and status bar.
 *
 * What actually matters here:
 *   - the *dedupe key* (a modal that re-opens after every reconnect is unusable);
 *   - the *uplink payload shape* (the bridge whitelists fields, junk is dropped);
 *   - the *answer envelope* (`{ ok: true, value: { sessionId, approvalId, outcome } }`),
 *     i.e. exactly what DSH's own panel sends;
 *   - a settled wait must never be answered twice.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  APPROVAL_DECISION_EVENT,
  QUESTION_ANSWER_EVENT,
  collectQuestionRequests,
  questionUplink,
  answerQuestion,
  currentTurn,
  sessionStatePayload,
  collectApprovalRequests,
  approvalUplink,
  sessionStateUplink,
  answerApproval,
  type PendingWaitLike,
} from '../src/client/pendingWatch.ts'

/** One pending approval wait (shape of `PendingWait<'approval'>`). */
function approvalWait(over: Partial<PendingWaitLike> & { payload?: unknown } = {}): PendingWaitLike {
  return {
    kind: 'approval',
    key: 'a:rpc-1',
    sessionId: 'sess-1',
    payload: { approvalId: 'apr-1', toolName: 'bash', callId: 'call-9', reason: '越界写入' },
    ...over,
  } as PendingWaitLike
}

/** One pending question wait (F8 territory — must be ignored here). */
function questionWait(): PendingWaitLike {
  return {
    kind: 'question',
    key: 'q:rpc-2',
    sessionId: 'sess-1',
    payload: { questions: [{ id: 'x' }] },
  }
}

describe('sessionStatePayload / currentTurn', () => {
  it('取最高轮次与 pending 数；turnTimings 缺失时轮次为 0', () => {
    const withTimings = sessionStatePayload({
      sessionId: 'sess-1',
      running: true,
      pending: [approvalWait()],
      turnTimings: new Map([
        [1, {}],
        [3, {}],
      ]),
    })
    expect(withTimings).toEqual({ sessionId: 'sess-1', running: true, turn: 3, pending: 1 })
    // 缺 turnTimings / 非 Map → 轮次未知记 0（不猜）
    expect(currentTurn({ sessionId: 's' })).toBe(0)
    expect(currentTurn({ sessionId: 's', turnTimings: new Map() })).toBe(0)
  })

  it('running 非 true 一律 false；pending 缺失记 0', () => {
    expect(sessionStatePayload({ sessionId: 's', running: 'yes' as unknown as boolean }).running).toBe(false)
    expect(sessionStatePayload({ sessionId: 's' }).pending).toBe(0)
  })
})

describe('collectApprovalRequests', () => {
  it('只收审批等待（question 由 F8 负责），并带上会话与帧字段', () => {
    const seen = new Set<string>()
    const out = collectApprovalRequests(
      { sessionId: 'sess-1', pending: [approvalWait(), questionWait()] },
      seen,
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.approvalId).toBe('apr-1')
    expect(out[0]?.toolName).toBe('bash')
    expect(out[0]?.callId).toBe('call-9')
    expect(out[0]?.sessionId).toBe('sess-1')
    // 等待对象被保留：只有它能 settle 这次交互
    expect(out[0]?.wait.key).toBe('a:rpc-1')
    expect(seen.has('a:rpc-1')).toBe(true)
  })

  it('按 wait.key 去重：重连/重放不会重复弹同一个模态框', () => {
    const seen = new Set<string>()
    const session = { sessionId: 'sess-1', pending: [approvalWait()] }
    expect(collectApprovalRequests(session, seen)).toHaveLength(1)
    expect(collectApprovalRequests(session, seen)).toHaveLength(0)
    // 新的 rpcId（新的等待）→ 重新上报
    const next = { sessionId: 'sess-1', pending: [approvalWait({ key: 'a:rpc-9', payload: { approvalId: 'apr-9', toolName: 'write' } })] }
    expect(collectApprovalRequests(next, seen)).toHaveLength(1)
  })

  it('payload 缺 approvalId / toolName 的等待被跳过（不发半成品给扩展）', () => {
    const out = collectApprovalRequests(
      {
        sessionId: 'sess-1',
        pending: [
          approvalWait({ payload: { toolName: 'bash' } }),
          approvalWait({ key: 'a:2', payload: { approvalId: 'apr-2' } }),
          approvalWait({ key: '', payload: { approvalId: 'apr-3', toolName: 'bash' } }),
          approvalWait({ key: 'a:4', payload: null }),
        ],
      },
      new Set(),
    )
    expect(out).toEqual([])
  })

  it('等待未带 sessionId 时回落到会话 id', () => {
    const out = collectApprovalRequests(
      { sessionId: 'sess-fallback', pending: [approvalWait({ sessionId: '' })] },
      new Set(),
    )
    expect(out[0]?.sessionId).toBe('sess-fallback')
  })
})

describe('uplink envelopes', () => {
  it('approvalUplink：只带数据字段（活的 wait 对象不进 payload）', () => {
    const [request] = collectApprovalRequests({ sessionId: 'sess-1', pending: [approvalWait()] }, new Set())
    const uplink = approvalUplink(request!, '越界写入')
    expect(uplink).toEqual({
      kind: 'approvalRequest',
      payload: { sessionId: 'sess-1', approvalId: 'apr-1', toolName: 'bash', callId: 'call-9', reason: '越界写入' },
    })
    expect(JSON.stringify(uplink)).not.toContain('respond')
  })

  it('sessionStateUplink：字段与桥接白名单一致', () => {
    expect(sessionStateUplink({ sessionId: 's', running: false, turn: 2, pending: 0 })).toEqual({
      kind: 'sessionState',
      payload: { sessionId: 's', running: false, turn: 2, pending: 0 },
    })
  })
})

describe('answerApproval', () => {
  it('按 DSH 自己的载荷形状回答：{ ok:true, value:{ sessionId, approvalId, outcome } }', async () => {
    const respond = vi.fn().mockResolvedValue({ accepted: true })
    const ok = await answerApproval({ ...approvalWait(), respond }, 'allowed-once')
    expect(ok).toBe(true)
    expect(respond).toHaveBeenCalledWith({
      ok: true,
      value: { sessionId: 'sess-1', approvalId: 'apr-1', outcome: 'allowed-once' },
    })
  })

  it('rejected 也能回答（载荷只支持这两种结果，没有"总是允许"）', async () => {
    const respond = vi.fn().mockResolvedValue({ accepted: true })
    await answerApproval({ ...approvalWait(), respond }, 'rejected')
    expect(respond.mock.calls[0]?.[0]).toMatchObject({ value: { outcome: 'rejected' } })
  })

  it('已 settle（浏览器端先答）→ 抛错被吞掉，返回 false 而不是把异常冒到 UI', async () => {
    const respond = vi.fn().mockImplementation(() => {
      throw new Error('pending wait a:rpc-1 is already settled')
    })
    await expect(answerApproval({ ...approvalWait(), respond }, 'rejected')).resolves.toBe(false)
  })

  it('没有 respond 载体 / payload 非法 → false（不抛）', async () => {
    await expect(answerApproval(approvalWait(), 'rejected')).resolves.toBe(false)
    await expect(
      answerApproval({ ...approvalWait({ payload: {} }), respond: vi.fn() }, 'rejected'),
    ).resolves.toBe(false)
  })
})

describe('事件名契约', () => {
  it('下行事件名与桥接加前缀后的形状一致', () => {
    expect(APPROVAL_DECISION_EVENT).toBe('dsh-file-jump:approvalDecision')
  })
})

describe('F8 提问半边', () => {
  /** 一个提问等待（host 的 question/requested 帧没有 questionId，靠 wait.key 定位） */
  function questionWaitShared(key = 'q:rpc-7', questions: unknown[] = [{ id: 'x', question: '选哪个？' }]) {
    return { kind: 'question', key, sessionId: 'sess-1', payload: { questions } }
  }

  it('只收 question 等待，questionId 用 wait.key（帧里没有 questionId）', () => {
    const seen = new Set<string>()
    const out = collectQuestionRequests(
      { sessionId: 'sess-1', pending: [approvalWait(), questionWaitShared()] },
      seen,
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.questionId).toBe('q:rpc-7')
    expect(out[0]?.questions).toHaveLength(1)
    expect(out[0]?.wait.key).toBe('q:rpc-7')
    expect(seen.has('q:rpc-7')).toBe(true)
  })

  it('审批与提问共用一个 seen 集合也不会互相顶掉（前缀 a:/q: 不同）', () => {
    const seen = new Set<string>()
    const session = { sessionId: 'sess-1', pending: [approvalWait(), questionWaitShared()] }
    expect(collectApprovalRequests(session, seen)).toHaveLength(1)
    expect(collectQuestionRequests(session, seen)).toHaveLength(1)
    // 再扫一遍：两边都不应重复上报
    expect(collectApprovalRequests(session, seen)).toHaveLength(0)
    expect(collectQuestionRequests(session, seen)).toHaveLength(0)
  })

  it('问题批次为空或非法 → 跳过（空问题的弹窗比不弹更糟）', () => {
    expect(collectQuestionRequests({ sessionId: 's', pending: [questionWaitShared('q:1', [])] }, new Set())).toEqual([])
    expect(
      collectQuestionRequests({ sessionId: 's', pending: [questionWaitShared('q:2', ['junk', null])] }, new Set()),
    ).toEqual([]);
    expect(
      collectQuestionRequests({ sessionId: 's', pending: [questionWaitShared('q:3', [{ id: 'x' }])] }, new Set()),
    ).toHaveLength(1)
  })

  it('questionUplink：载荷只带数据字段', () => {
    const [request] = collectQuestionRequests({ sessionId: 'sess-1', pending: [questionWaitShared()] }, new Set())
    const uplink = questionUplink(request!)
    expect(uplink.kind).toBe('questionRequest')
    expect(JSON.stringify(uplink)).not.toContain('respond')
    expect((uplink.payload as { questionId: string }).questionId).toBe('q:rpc-7')
  })

  it('answerQuestion：整批一次作答，载荷为 { sessionId, answer }', async () => {
    const respond = vi.fn().mockResolvedValue({ accepted: true })
    const answer = { answers: [{ id: 'x', selected: ['A'] }] }
    await expect(answerQuestion({ ...questionWaitShared(), respond }, answer)).resolves.toBe(true)
    expect(respond).toHaveBeenCalledWith({ ok: true, value: { sessionId: 'sess-1', answer } })
  })

  it('answerQuestion：已 settle / 无载体 / 非法答案 → false（不抛）', async () => {
    const settled = vi.fn().mockImplementation(() => {
      throw new Error('pending wait q:1 is already settled')
    })
    await expect(answerQuestion({ ...questionWaitShared(), respond: settled }, { answers: [] })).resolves.toBe(false)
    await expect(answerQuestion(questionWaitShared(), { answers: [] })).resolves.toBe(false)
    await expect(answerQuestion({ ...questionWaitShared(), respond: vi.fn() }, null)).resolves.toBe(false)
  })

  it('下行事件名与桥接前缀一致', () => {
    expect(QUESTION_ANSWER_EVENT).toBe('dsh-file-jump:questionAnswer')
  })
})
