import { describe, it, expect } from 'vitest'
import {
  DIFF_EVENT,
  extractAppliedDiffs,
  diffTargetPath,
  takePendingDiff,
  type AppliedDiff,
} from '../src/client/diffNotify.ts'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'

/** Settled edit block with an applied diff on the result side. */
function settledEdit(over: Partial<Record<string, unknown>> = {}): ToolCallBlock {
  return {
    kind: 'tool-result',
    seq: 1,
    time: 0,
    callId: 'c-edit-1',
    call: { name: 'edit', argsRaw: JSON.stringify({ file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }) },
    callTime: 0,
    content: [],
    isError: false,
    callView: null,
    resultView: {
      card: 'diff',
      title: 'Edit src/a.ts',
      diffs: [{ path: 'src/a.ts', oldText: 'x', newText: 'y' }],
    },
    subCalls: [],
    ...over,
  } as unknown as ToolCallBlock
}

/** Settled write block whose result diff has oldText null (create). */
function settledWrite(over: Partial<Record<string, unknown>> = {}): ToolCallBlock {
  return {
    kind: 'tool-result',
    seq: 2,
    time: 0,
    callId: 'c-write-1',
    call: { name: 'write', argsRaw: JSON.stringify({ file_path: 'n.ts', content: 'hi' }) },
    callTime: 0,
    content: [],
    isError: false,
    callView: null,
    resultView: {
      card: 'diff',
      title: 'Write n.ts',
      diffs: [{ path: 'n.ts', oldText: null, newText: 'hi' }],
    },
    subCalls: [],
    ...over,
  } as unknown as ToolCallBlock
}

/** Running (not settled) edit block. */
function runningEdit(): ToolCallBlock {
  return {
    callId: 'c-run-1',
    name: 'edit',
    argsRaw: JSON.stringify({ file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }),
    turn: 1,
    step: 1,
    time: 0,
    callView: { card: 'diff', title: 'Edit src/a.ts', diffs: [{ path: 'src/a.ts', oldText: 'x', newText: 'y' }] },
    subCalls: [],
  } as unknown as ToolCallBlock
}

describe('extractAppliedDiffs', () => {
  it('settled edit 从 resultView 提取 applied hunk', () => {
    const diffs = extractAppliedDiffs(settledEdit())
    expect(diffs).toEqual([{ oldText: 'x', newText: 'y' }])
  })
  it('settled write（oldText null）→ null（不可撤销，不通知）', () => {
    expect(extractAppliedDiffs(settledWrite())).toBeNull()
  })
  it('running block 从 callView 提取（宽松：running 时也通知，扩展按 newText 重定位）', () => {
    const diffs = extractAppliedDiffs(runningEdit())
    expect(diffs).toEqual([{ oldText: 'x', newText: 'y' }])
  })
  it('非 edit/write 工具 → null', () => {
    const b = settledEdit({ call: { name: 'read', argsRaw: '{"path":"a.ts"}' } })
    expect(extractAppliedDiffs(b)).toBeNull()
  })
  it('resultView 非 diff 卡片 → null', () => {
    const b = settledEdit({ resultView: { card: 'generic' } })
    expect(extractAppliedDiffs(b)).toBeNull()
  })
  it('isError block → null（错误结果无 applied diff）', () => {
    const b = settledEdit({ isError: true, resultView: null })
    expect(extractAppliedDiffs(b)).toBeNull()
  })
})

describe('diffTargetPath', () => {
  it('cwd 已知时解析相对路径为绝对路径', () => {
    expect(diffTargetPath('/w', settledEdit())).toBe('/w/src/a.ts')
  })
  it('绝对路径原样返回', () => {
    const b = settledEdit({ call: { name: 'edit', argsRaw: '{"file_path":"D:/abs/a.ts"}' } })
    expect(diffTargetPath('/w', b)).toBe('D:/abs/a.ts')
  })
  it('cwd 缺失时返回原路径', () => {
    expect(diffTargetPath(undefined, settledEdit())).toBe('src/a.ts')
  })
})

describe('takePendingDiff', () => {
  it('首次见到 settled edit → 返回 payload 并记录 callId', () => {
    const notified = new Set<string>()
    const p = takePendingDiff('/w', settledEdit(), notified)
    expect(p).toEqual({
      kind: DIFF_EVENT,
      path: '/w/src/a.ts',
      diffs: [{ oldText: 'x', newText: 'y' }],
      cwd: '/w',
      callId: 'c-edit-1',
    })
    expect(notified.has('c-edit-1')).toBe(true)
  })
  it('同一 callId 再次渲染 → null（去重）', () => {
    const notified = new Set<string>()
    takePendingDiff('/w', settledEdit(), notified)
    expect(takePendingDiff('/w', settledEdit(), notified)).toBeNull()
  })
  it('无 callId → null', () => {
    const b = settledEdit({ callId: undefined })
    expect(takePendingDiff('/w', b, new Set())).toBeNull()
  })
  it('write（oldText null）→ null 且不记录', () => {
    const notified = new Set<string>()
    expect(takePendingDiff('/w', settledWrite(), notified)).toBeNull()
    expect(notified.size).toBe(0)
  })
  it('running edit 也通知（宽松语义：callView 有 diffs 即广播）', () => {
    const p = takePendingDiff('/w', runningEdit(), new Set())
    expect(p).not.toBeNull()
    expect(p?.callId).toBe('c-run-1')
  })
  it('多个不同 callId 分别通知', () => {
    const notified = new Set<string>()
    const a = takePendingDiff('/w', settledEdit(), notified)
    const b = settledEdit({ callId: 'c-edit-2' })
    const second = takePendingDiff('/w', b, notified)
    expect(a?.callId).toBe('c-edit-1')
    expect(second?.callId).toBe('c-edit-2')
    expect(notified.size).toBe(2)
  })
})

describe('payload shape', () => {
  it('diffs 是 AppliedDiff[] 形状', () => {
    const p = takePendingDiff('/w', settledEdit(), new Set())
    const diffs: AppliedDiff[] | undefined = p?.diffs
    expect(diffs).toBeDefined()
    expect(typeof diffs?.[0].oldText).toBe('string')
    expect(typeof diffs?.[0].newText).toBe('string')
  })
})
