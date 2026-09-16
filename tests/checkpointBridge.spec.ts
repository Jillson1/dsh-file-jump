/**
 * checkpointBridge (F9) unit tests — the browser half of "restore a turn".
 *
 * What matters here:
 *   - the two-step contract (preview must yield planId/confirmation before apply);
 *   - failures never throw out of the request path (they must reach the UI as data);
 *   - the request/response pairing survives (requestId echoed in the uplink);
 *   - an apply without a plan is refused client-side instead of bouncing off the engine.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHECKPOINT_RESTORE_EVENT,
  CHECKPOINT_READY_KIND,
  REWIND_HTTP_PATH,
  buildApplyBody,
  buildPreviewUrl,
  installCheckpointBridge,
  interpretResponse,
  parseRestoreRequest,
  resultUplink,
  runCheckpointRequest,
  type CheckpointRestoreRequest,
  type FetchLike,
} from '../src/client/checkpointBridge.ts'

/** A well-formed preview request as the extension sends it. */
function request(over: Partial<CheckpointRestoreRequest> = {}): CheckpointRestoreRequest {
  return {
    phase: 'preview',
    sessionId: 'sess-1',
    messageSeq: 4,
    checkpointId: 'rp_1',
    mode: 'code',
    requestId: 'cp-1',
    ...over,
  }
}

/** A fake fetch returning one canned JSON body. */
function fakeFetch(status: number, body: unknown): FetchLike & { calls: { url: string; init?: unknown }[] } {
  const calls: { url: string; init?: unknown }[] = []
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return { status, json: async () => body }
  }
  return Object.assign(impl, { calls })
}

describe('请求构造', () => {
  it('preview 用 GET + 查询参数（引擎的契约参数只有 sessionId/messageSeq）', () => {
    const url = buildPreviewUrl(request())
    expect(url.startsWith(`${REWIND_HTTP_PATH}?`)).toBe(true)
    expect(url).toContain('sessionId=sess-1')
    expect(url).toContain('messageSeq=4')
  })

  it('apply 用 POST 体，带 planId/confirmation 与 mode', () => {
    const body = buildApplyBody(request({ phase: 'apply', planId: 'plan-9', confirmation: 'ab12' }))
    expect(body).toEqual({
      mode: 'code',
      sessionId: 'sess-1',
      messageSeq: 4,
      checkpointId: 'rp_1',
      planId: 'plan-9',
      confirmation: 'ab12',
    })
  })

  it('mode 默认 code，显式 both 时透传（both = 代码 + 会话一起回退）', () => {
    expect(buildApplyBody(request()).mode).toBe('code')
    expect(buildApplyBody(request({ mode: 'both' })).mode).toBe('both')
  })
})

describe('interpretResponse', () => {
  it('2xx 且无 error → ok，并白名单拷贝预览字段', () => {
    const result = interpretResponse('preview', 200, {
      status: 'ready',
      turn: 3,
      totalChanges: 7,
      changes: [{ path: 'src/a.ts', kind: 'modified' }, { path: '', kind: 'x' }, null],
      truncated: true,
      restoreBlocked: false,
      planId: 'plan-1',
      confirmation: 'conf-1',
      junk: 'ignored',
    })
    expect(result.ok).toBe(true)
    expect(result.turn).toBe(3)
    expect(result.totalChanges).toBe(7)
    expect(result.changes).toEqual([{ path: 'src/a.ts', kind: 'modified' }])
    expect(result.planId).toBe('plan-1')
    expect(result.confirmation).toBe('conf-1')
    expect(JSON.stringify(result)).not.toContain('junk')
  })

  it('409 + error/code → ok:false，错误码原样带回（WORKSPACE_IN_USE / PLAN_STALE …）', () => {
    const result = interpretResponse('apply', 409, { error: 'busy', code: 'WORKSPACE_IN_USE' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('WORKSPACE_IN_USE')
    expect(result.error).toBe('busy')
  })

  it('404（检查点不存在）与非 JSON 体都不抛', () => {
    expect(interpretResponse('preview', 404, { error: 'not found', code: 'RESTORE_POINT_NOT_FOUND' }).ok).toBe(false)
    expect(interpretResponse('preview', 500, null).ok).toBe(false)
    expect(interpretResponse('preview', 200, null).ok).toBe(true)
  })
})

describe('runCheckpointRequest', () => {
  it('preview：GET 到端点，成功结果原样返回', async () => {
    const f = fakeFetch(200, { status: 'ready', totalChanges: 2, planId: 'p', confirmation: 'c' })
    const result = await runCheckpointRequest(request(), f)
    expect(f.calls[0]?.url).toContain(REWIND_HTTP_PATH)
    expect(result.ok).toBe(true)
    expect(result.planId).toBe('p')
  })

  it('apply 缺 planId/confirmation → 客户端先拒绝（不白跑一次请求）', async () => {
    const f = fakeFetch(200, {})
    const result = await runCheckpointRequest(request({ phase: 'apply' }), f)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('NO_PLAN')
    expect(f.calls).toHaveLength(0)
  })

  it('apply 带计划 → POST 体里带上 planId/confirmation', async () => {
    const f = fakeFetch(200, { status: 'completed' })
    await runCheckpointRequest(request({ phase: 'apply', planId: 'p', confirmation: 'c' }), f)
    expect(f.calls[0]?.init).toMatchObject({ method: 'POST' })
    expect(String((f.calls[0]?.init as { body: string }).body)).toContain('"planId":"p"')
  })

  it('网络异常折叠为 ok:false（不把异常抛给 UI）', async () => {
    const boom: FetchLike = async () => {
      throw new Error('network down')
    }
    const result = await runCheckpointRequest(request(), boom)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('NETWORK')
    expect(result.error).toBe('network down')
  })

  it('缺会话或检查点标识 → 直接拒绝', async () => {
    const f = fakeFetch(200, {})
    expect((await runCheckpointRequest(request({ sessionId: '' }), f)).code).toBe('INVALID_ARGUMENTS')
    expect((await runCheckpointRequest(request({ checkpointId: '' }), f)).code).toBe('INVALID_ARGUMENTS')
    expect(f.calls).toHaveLength(0)
  })
})

describe('parseRestoreRequest', () => {
  it('合法下行 → 归一为请求（mode 非法回落 code）', () => {
    const parsed = parseRestoreRequest({
      kind: CHECKPOINT_RESTORE_EVENT,
      phase: 'apply',
      sessionId: 's',
      messageSeq: 4,
      checkpointId: 'rp',
      mode: 'weird',
      requestId: 'cp-2',
      planId: 'p',
      confirmation: 'c',
    })
    expect(parsed).toEqual({
      phase: 'apply',
      sessionId: 's',
      messageSeq: 4,
      checkpointId: 'rp',
      mode: 'code',
      requestId: 'cp-2',
      planId: 'p',
      confirmation: 'c',
    })
  })

  it('非法 kind / 缺字段 → null', () => {
    expect(parseRestoreRequest({ kind: 'other' })).toBeNull()
    expect(parseRestoreRequest({ kind: CHECKPOINT_RESTORE_EVENT, phase: 'x' })).toBeNull()
    expect(parseRestoreRequest({ kind: CHECKPOINT_RESTORE_EVENT, phase: 'preview', sessionId: 's' })).toBeNull()
    expect(parseRestoreRequest(null)).toBeNull()
  })
})

describe('resultUplink / installCheckpointBridge', () => {
  it('回执带 requestId 与 phase（配对必需）', () => {
    const uplink = resultUplink(request(), { phase: 'preview', ok: true, totalChanges: 1 })
    expect(uplink.kind).toBe(CHECKPOINT_READY_KIND)
    expect(uplink.payload).toMatchObject({ requestId: 'cp-1', phase: 'preview', ok: true, totalChanges: 1 })
  })

  it('安装后可端到端跑通：下行请求 → fetch → 上行回执', async () => {
    const f = fakeFetch(200, { status: 'ready', totalChanges: 3, planId: 'p', confirmation: 'c' })
    const seen: unknown[] = []
    const onUp = (e: Event): void => {
      seen.push((e as CustomEvent).detail)
    }
    window.addEventListener('dsh-file-jump:bridgeUp', onUp)
    const uninstall = installCheckpointBridge(f)
    try {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { kind: CHECKPOINT_RESTORE_EVENT, phase: 'preview', sessionId: 's', messageSeq: 4, checkpointId: 'rp', requestId: 'cp-9' },
        }),
      )
      await vi.waitFor(() => expect(seen).toHaveLength(1))
      expect(seen[0]).toMatchObject({ kind: CHECKPOINT_READY_KIND, payload: { requestId: 'cp-9', ok: true } })
      expect(f.calls).toHaveLength(1)
    } finally {
      window.removeEventListener('dsh-file-jump:bridgeUp', onUp)
      uninstall()
    }
  })

  it('无关消息不触发任何请求（桥接会把所有下行都投到这个 window）', async () => {
    const f = fakeFetch(200, {})
    const uninstall = installCheckpointBridge(f)
    try {
      window.dispatchEvent(new MessageEvent('message', { data: { kind: 'somethingElse' } }))
      await Promise.resolve()
      expect(f.calls).toHaveLength(0)
    } finally {
      uninstall()
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
