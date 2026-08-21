import { describe, it, expect } from 'vitest'
import {
  spliceIntoDraft,
  injectIntoActive,
  INJECT_EVENT,
  type SessionsLike,
} from '../src/client/composerInject.ts'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

describe('spliceIntoDraft', () => {
  it('空草稿直接返回注入文本', () => {
    expect(spliceIntoDraft('', '@a.ts')).toBe('@a.ts')
  })
  it('草稿以空白结尾 → 直接追加（不再加空格）', () => {
    expect(spliceIntoDraft('看一下 ', '@a.ts')).toBe('看一下 @a.ts')
  })
  it('草稿非空白结尾 → 加一个空格再追加', () => {
    expect(spliceIntoDraft('请阅读', '@a.ts')).toBe('请阅读 @a.ts')
  })
})

describe('injectIntoActive', () => {
  /** 构造会话桩：current 会话、scope 返回伪 actx、setDraft 记录调用 */
  function makeCtx(over: Partial<{
    current: string | undefined
    actx: unknown
    input: unknown
    hasInput: boolean
    draft: string
  }> = {}) {
    const calls: string[] = []
    const sessions: SessionsLike = {
      list: { getSnapshot: () => ({ current: over.current }) },
      scope: (id: string) => (id === over.current && over.actx !== undefined ? (over.actx as ClientContext) : undefined),
    }
    // hasInput 显式控制 conversation.input 是否存在；默认存在（能写）
    const hasInput = over.hasInput ?? true
    const input = hasInput
      ? over.input ?? {
          for: (actx: unknown) => ({
            state: { getSnapshot: () => ({ draft: over.draft ?? '' }) },
            setDraft: (t: string) => { calls.push(t) },
          }),
        }
      : undefined
    const conversation = { input } as ClientContext['conversation']
    return { sessions, conversation, calls }
  }

  it('定位当前会话并写入草稿（带拼接）', () => {
    const { sessions, conversation, calls } = makeCtx({
      current: 's1', actx: {}, draft: '请阅读',
    })
    const ok = injectIntoActive(sessions, conversation, '@a.ts')
    expect(ok).toBe(true)
    expect(calls).toEqual(['请阅读 @a.ts'])
  })

  it('无当前会话 → 返回 false 不写入', () => {
    const { sessions, conversation, calls } = makeCtx({ current: undefined, actx: {} })
    const ok = injectIntoActive(sessions, conversation, '@a.ts')
    expect(ok).toBe(false)
    expect(calls).toEqual([])
  })

  it('会话未物化（scope 返回 undefined）→ 返回 false', () => {
    const { sessions, conversation, calls } = makeCtx({ current: 's1', actx: undefined })
    const ok = injectIntoActive(sessions, conversation, '@a.ts')
    expect(ok).toBe(false)
    expect(calls).toEqual([])
  })

  it('conversation.input 缺失 → 返回 false', () => {
    const { sessions, conversation, calls } = makeCtx({ current: 's1', actx: {}, hasInput: false })
    const ok = injectIntoActive(sessions, conversation, '@a.ts')
    expect(ok).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('INJECT_EVENT', () => {
  it('事件名与桥接转发的命名空间一致', () => {
    expect(INJECT_EVENT).toBe('dsh-file-jump:injectComposer')
  })
})
