import { describe, it, expect } from 'vitest'
import {
  filePathFromArgs,
  resolveAbsPath,
  editOldTextFrom,
  readOffsetFrom,
  isErrorBlock,
  blockArgsRaw,
} from '../src/client/parse.ts'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'

function runningBlock(over: Partial<Record<string, unknown>> = {}): ToolCallBlock {
  return {
    callId: 'c1',
    name: 'edit',
    argsRaw: JSON.stringify({ file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }),
    turn: 1,
    step: 1,
    time: 0,
    callView: { card: 'diff', title: 'Edit src/a.ts', diffs: [{ path: 'src/a.ts', oldText: 'x', newText: 'y' }] },
    subCalls: [],
    ...over,
  } as unknown as ToolCallBlock
}

describe('filePathFromArgs', () => {
  it('读 file_path（edit/write）', () => {
    expect(filePathFromArgs('{"file_path":"a.ts","content":"hi"}')).toBe('a.ts')
  })
  it('读 path（read）', () => {
    expect(filePathFromArgs('{"path":"b.ts","offset":1}')).toBe('b.ts')
  })
  it('非法/空 args 返回 undefined', () => {
    expect(filePathFromArgs('')).toBeUndefined()
    expect(filePathFromArgs('not-json')).toBeUndefined()
    expect(filePathFromArgs(null)).toBeUndefined()
    expect(filePathFromArgs('{"other":1}')).toBeUndefined()
  })
})

describe('resolveAbsPath', () => {
  it('cwd 已知时解析相对路径为绝对路径', () => {
    expect(resolveAbsPath('/w', 'src/a.ts')).toBe('/w/src/a.ts')
  })
  it('绝对路径原样返回', () => {
    expect(resolveAbsPath('/w', '/abs/a.ts')).toBe('/abs/a.ts')
  })
  it('cwd 缺失时返回原路径', () => {
    expect(resolveAbsPath(undefined, 'src/a.ts')).toBe('src/a.ts')
  })
  it('空路径返回 undefined', () => {
    expect(resolveAbsPath('/w', undefined)).toBeUndefined()
  })
})

describe('editOldTextFrom', () => {
  it('从 callView.diffs 读 edit 改前片段', () => {
    const b = runningBlock()
    expect(editOldTextFrom(b)).toBe('x')
  })
  it('write/create 的 oldText null → undefined', () => {
    const b = runningBlock({
      name: 'write',
      argsRaw: JSON.stringify({ file_path: 'n.ts', content: 'hi' }),
      callView: { card: 'diff', title: 'Write n.ts', diffs: [{ path: 'n.ts', oldText: null, newText: 'hi' }] },
    })
    expect(editOldTextFrom(b)).toBeUndefined()
  })
  it('非 diff 卡片 → undefined', () => {
    const b = runningBlock({ callView: null })
    expect(editOldTextFrom(b)).toBeUndefined()
  })
})

describe('readOffsetFrom', () => {
  it('从 resultView 读 read 的 offset', () => {
    const b = runningBlock({
      name: 'read',
      argsRaw: JSON.stringify({ path: 'a.ts', offset: 10 }),
      callView: { card: 'generic', kind: 'read', title: 'Read a.ts' },
      resultView: { card: 'read', path: 'a.ts', offset: 10, lines: [], totalLines: 100 },
    })
    expect(readOffsetFrom(b)).toBe(10)
  })
  it('非 read result → undefined', () => {
    const b = runningBlock({ resultView: null })
    expect(readOffsetFrom(b)).toBeUndefined()
  })
})

describe('isErrorBlock / blockArgsRaw', () => {
  it('运行中 block 用 argsRaw，settled 用 call.argsRaw', () => {
    const running = runningBlock()
    expect(blockArgsRaw(running)).toContain('file_path')
    const settled = { ...running, kind: 'tool-result', isError: false, call: { name: 'edit', argsRaw: '{"file_path":"s.ts"}' } } as unknown as ToolCallBlock
    expect(blockArgsRaw(settled)).toContain('file_path')
    expect(isErrorBlock(running)).toBe(false)
  })
  it('错误 block isError=true', () => {
    const b = { ...runningBlock(), kind: 'tool-result', isError: true } as unknown as ToolCallBlock
    expect(isErrorBlock(b)).toBe(true)
  })
})
