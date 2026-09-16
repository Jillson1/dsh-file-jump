/**
 * ReplayDock (F1) unit tests — the pure half: snapshot narrowing + replay scan.
 *
 * These cover the rules that make replay safe to run on every conversation
 * change: only settled non-error mutation results, only once per callId, and
 * bounded work per scan. The dock component itself is a thin wrapper that only
 * dispatches the returned payloads.
 */
import { describe, expect, it } from 'vitest'
import { collectReplayPayloads, toReplaySession, TAIL_SCAN_LIMIT } from '../src/client/replayScan.ts'
import { DIFF_EVENT } from '../src/client/diffNotify.ts'

/** A settled edit node with an applied diff (the shape ConversationSnapshot.nodes carries). */
function settledEdit(over: Record<string, unknown> = {}) {
  return {
    kind: 'tool-result',
    callId: 'c-edit-1',
    isError: false,
    call: { name: 'edit', argsRaw: JSON.stringify({ file_path: 'src/a.ts' }) },
    callView: null,
    resultView: { card: 'diff', diffs: [{ path: 'src/a.ts', oldText: 'x', newText: 'y' }] },
    ...over,
  }
}

/** A settled write node (create: result diff carries oldText null). */
function settledWrite(over: Record<string, unknown> = {}) {
  return {
    kind: 'tool-result',
    callId: 'c-write-1',
    isError: false,
    call: { name: 'write', argsRaw: JSON.stringify({ file_path: 'src/new.ts' }) },
    callView: null,
    resultView: { card: 'diff', diffs: [{ path: 'src/new.ts', oldText: null, newText: 'hi' }] },
    ...over,
  }
}

describe('toReplaySession', () => {
  it('窄化会话 id 与节点数组', () => {
    const view = toReplaySession({ sessionId: 's1', nodes: [settledEdit()] })
    expect(view?.sessionId).toBe('s1')
    expect(view?.nodes).toHaveLength(1)
    expect(view && 'cwd' in view).toBe(false)
  })
  it('会话 id 缺失/非字符串 → null（没有归档目标，回放无意义）', () => {
    expect(toReplaySession(null)).toBeNull()
    expect(toReplaySession(undefined)).toBeNull()
    expect(toReplaySession({ nodes: [] })).toBeNull()
    expect(toReplaySession({ sessionId: 42, nodes: [] })).toBeNull()
  })
  it('nodes 非法 → 退化为空扫描而不是抛错（渲染期不能炸）', () => {
    expect(toReplaySession({ sessionId: 's1', nodes: 'oops' })?.nodes).toEqual([])
    expect(toReplaySession({ sessionId: 's1' })?.nodes).toEqual([])
  })
  it('cwd 非空时透传（扩展相对路径解析的兜底基准）', () => {
    expect(toReplaySession({ sessionId: 's1', nodes: [], cwd: '/w' })?.cwd).toBe('/w')
    expect(toReplaySession({ sessionId: 's1', nodes: [], cwd: '' })?.cwd).toBeUndefined()
  })
})

describe('collectReplayPayloads', () => {
  it('settled edit → 回放 payload（source=replay + 会话 id）', () => {
    const payloads = collectReplayPayloads({ sessionId: 's1', cwd: '/w', nodes: [settledEdit()] }, new Set())
    expect(payloads).toEqual([
      {
        kind: DIFF_EVENT,
        path: '/w/src/a.ts',
        diffs: [{ oldText: 'x', newText: 'y' }],
        callId: 'c-edit-1',
        sessionId: 's1',
        source: 'replay',
        cwd: '/w',
        tool: 'edit',
      },
    ])
  })

  it('write 新建（oldText null）→ oldText 归一为空串（宿主据此判定"丢弃=删文件"）', () => {
    const payloads = collectReplayPayloads({ sessionId: 's1', nodes: [settledWrite()] }, new Set())
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.diffs).toEqual([{ oldText: '', newText: 'hi' }])
    expect(payloads[0]?.tool).toBe('write')
    // cwd 未知时不写该字段（扩展回落到工作区根）
    expect(payloads[0] && 'cwd' in payloads[0]).toBe(false)
  })

  it('同一 callId 只回放一次（重复渲染不重复通知）', () => {
    const seen = new Set<string>()
    const session = { sessionId: 's1', cwd: '/w', nodes: [settledEdit()] }
    expect(collectReplayPayloads(session, seen)).toHaveLength(1)
    expect(collectReplayPayloads(session, seen)).toHaveLength(0)
  })

  it('running 节点（非 tool-result）不回放——那是 relay 的职责', () => {
    const running = { kind: 'tool-call', callId: 'c-run', name: 'edit', argsRaw: '{}', callView: null }
    expect(collectReplayPayloads({ sessionId: 's1', nodes: [running] }, new Set())).toEqual([])
  })

  it('失败节点不回放（错误结果没有可信的 applied diff）', () => {
    expect(collectReplayPayloads({ sessionId: 's1', nodes: [settledEdit({ isError: true })] }, new Set())).toEqual([])
  })

  it('非 mutation 工具不回放（read / bash 等没有 diff 卡片）', () => {
    const read = settledEdit({ call: { name: 'read', argsRaw: '{"path":"src/a.ts"}' } })
    expect(collectReplayPayloads({ sessionId: 's1', nodes: [read] }, new Set())).toEqual([])
  })

  it('call 头缺失（窗口截断）→ 工具名未知，不回放', () => {
    expect(collectReplayPayloads({ sessionId: 's1', nodes: [settledEdit({ call: null })] }, new Set())).toEqual([])
  })

  it('无 diff 卡片 / 无 callId / 无路径 → 一律跳过', () => {
    const noCard = settledEdit({ resultView: { card: 'text' }, callView: null })
    const noCallId = settledEdit({ callId: undefined })
    const noPath = settledEdit({ call: { name: 'edit', argsRaw: 'not-json' } })
    expect(collectReplayPayloads({ sessionId: 's1', cwd: '/w', nodes: [noCard, noCallId, noPath] }, new Set())).toEqual([])
  })

  it('扫描窗口有上限：超出 limit 的尾部窗口之外的节点不扫（大会话不卡渲染）', () => {
    // 首个是"老"改动，其后来 TAIL_SCAN_LIMIT 个空节点把它挤出窗口
    const filler = Array.from({ length: TAIL_SCAN_LIMIT }, (_, i) => ({ kind: 'assistant-message', callId: `f-${i}` }))
    const nodes = [settledEdit(), ...filler]
    expect(collectReplayPayloads({ sessionId: 's1', cwd: '/w', nodes }, new Set(), TAIL_SCAN_LIMIT)).toEqual([])
    // 放宽到 1000（首次扫描预算）就能找到它
    expect(collectReplayPayloads({ sessionId: 's1', cwd: '/w', nodes }, new Set(), 1000)).toHaveLength(1)
  })

  it('多个改动按出现顺序返回（旧 → 新）', () => {
    const a = settledEdit({ callId: 'c1' })
    const b = settledWrite({ callId: 'c2' })
    const payloads = collectReplayPayloads({ sessionId: 's1', cwd: '/w', nodes: [a, b] }, new Set())
    expect(payloads.map((p) => p.callId)).toEqual(['c1', 'c2'])
  })

  it('不抛异：nodes 为空 / 会话只有非工具节点', () => {
    expect(collectReplayPayloads({ sessionId: 's1', nodes: [] }, new Set())).toEqual([])
    expect(
      collectReplayPayloads({ sessionId: 's1', nodes: [{ kind: 'user-message' }, { kind: 'assistant-message' }] }, new Set()),
    ).toEqual([])
  })
})
