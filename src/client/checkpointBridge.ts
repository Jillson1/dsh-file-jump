/**
 * Checkpoint bridge (F9): the browser half of "restore a turn".
 *
 * Why the browser and not the extension: the recovery engine (`@anionex/dsh-turn-rewind`)
 * exposes a **same-origin HTTP endpoint** `/turn-rewind` on the DSH web server, and the
 * extension host is a different process with no session to that server. The iframe is
 * already same-origin with it, so it performs the two-step call and reports back:
 *
 *   preview → GET  /turn-rewind?sessionId&messageSeq  → { planId, confirmation, changes, ... }
 *   apply   → POST /turn-rewind  { mode, sessionId, messageSeq, checkpointId, planId, confirmation }
 *
 * Two steps are mandatory, not a design choice: the POST rejects a request without a
 * planId/confirmation pair (`NO_CHANGES`), i.e. the engine refuses to restore anything it
 * has not first shown a plan for. Verified against the installed 0.1.1 `rewind-host.js`.
 *
 * Pure mapping (URL/body/response → typed result) lives here so it is unit-testable;
 * the installer is a thin window listener.
 */

/** Downlink event the bridge delivers inside this iframe. */
export const CHECKPOINT_RESTORE_EVENT = 'dsh-file-jump:checkpointRestore'

/** Uplink kind name (the bridge whitelists it). */
export const CHECKPOINT_READY_KIND = 'checkpointsReady'

/** HTTP path registered by turn-rewind (`REWIND_HTTP_PATH`). */
export const REWIND_HTTP_PATH = '/turn-rewind'

/** One restore request as it arrives from the extension. */
export interface CheckpointRestoreRequest {
  readonly phase: 'preview' | 'apply'
  readonly sessionId: string
  readonly messageSeq: number
  readonly checkpointId: string
  readonly mode: 'code' | 'both'
  /** Echoed back in the uplink so the extension can match request ↔ response. */
  readonly requestId: string
  readonly planId?: string
  readonly confirmation?: string
}

/** Normalized outcome (both phases share one shape; the extension already saw the phase). */
export interface CheckpointResult {
  readonly phase: 'preview' | 'apply'
  readonly ok: boolean
  readonly sessionId?: string
  readonly error?: string
  /** Engine error code (WORKSPACE_IN_USE / PLAN_STALE / NO_CHANGES / REWIND_FAILED …) */
  readonly code?: string
  readonly turn?: number
  readonly totalChanges?: number
  readonly changes?: readonly { readonly path: string; readonly kind: string }[]
  readonly truncated?: boolean
  readonly restoreBlocked?: boolean
  readonly headChanged?: boolean
  readonly operationChanged?: boolean
  readonly planId?: string
  readonly confirmation?: string
}

/** Preview URL (query params are the engine's contract). */
export function buildPreviewUrl(req: CheckpointRestoreRequest): string {
  const params = new URLSearchParams({
    sessionId: req.sessionId,
    messageSeq: String(req.messageSeq),
  })
  return `${REWIND_HTTP_PATH}?${params.toString()}`
}

/** Apply body (POST). Carries the planId/confirmation obtained from the preview. */
export function buildApplyBody(req: CheckpointRestoreRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    mode: req.mode,
    sessionId: req.sessionId,
    messageSeq: req.messageSeq,
    checkpointId: req.checkpointId,
  }
  if (req.planId !== undefined) body.planId = req.planId
  if (req.confirmation !== undefined) body.confirmation = req.confirmation
  return body
}

/** 非空字符串字段的窄化（响应来自未公开契约，防御性拷贝一遍） */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** 布尔字段窄化 */
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

/** 数字字段窄化 */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * 解释一次响应。
 *
 * 两相共用：引擎的 GET 成功体带 `status:'ready'`，POST 成功体带 `status:'completed'`，
 * 失败体统一 `{ error, code }` 且 HTTP 409/404。这里按"HTTP 与 error 字段"判定成败，
 * 不依赖某个具体 status 字面量（未公开契约里多一个 status 值不该让我们误判）。
 */
export function interpretResponse(phase: 'preview' | 'apply', httpStatus: number, json: unknown): CheckpointResult {
  const body = json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : {}
  const error = str(body.error)
  const code = str(body.code)
  const ok = httpStatus >= 200 && httpStatus < 300 && error === undefined
  if (!ok) {
    return {
      phase,
      ok: false,
      ...(str(body.sessionId) === undefined ? {} : { sessionId: str(body.sessionId) as string }),
      error: error ?? `HTTP ${httpStatus}`,
      ...(code === undefined ? {} : { code }),
    }
  }
  const changes = Array.isArray(body.changes)
    ? body.changes
        .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
        .map((c) => ({ path: String(c.path ?? ''), kind: String(c.kind ?? 'modified') }))
        .filter((c) => c.path !== '')
    : undefined
  return {
    phase,
    ok: true,
    ...(str(body.sessionId) === undefined ? {} : { sessionId: str(body.sessionId) as string }),
    ...(num(body.turn) === undefined ? {} : { turn: num(body.turn) as number }),
    ...(num(body.totalChanges) === undefined ? {} : { totalChanges: num(body.totalChanges) as number }),
    ...(changes === undefined ? {} : { changes }),
    ...(bool(body.truncated) === undefined ? {} : { truncated: bool(body.truncated) as boolean }),
    ...(bool(body.restoreBlocked) === undefined ? {} : { restoreBlocked: bool(body.restoreBlocked) as boolean }),
    ...(bool(body.headChanged) === undefined ? {} : { headChanged: bool(body.headChanged) as boolean }),
    ...(bool(body.operationChanged) === undefined ? {} : { operationChanged: bool(body.operationChanged) as boolean }),
    ...(str(body.planId) === undefined ? {} : { planId: str(body.planId) as string }),
    ...(str(body.confirmation) === undefined ? {} : { confirmation: str(body.confirmation) as string }),
  }
}

/** 注入的 fetch（测试可替换；生产用全局 fetch） */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>

/**
 * 执行一次预览或应用。
 *
 * 失败一律**折叠为 ok:false 的结果**而不是抛出：恢复是用户明确发起的动作，
 * "为什么没成功"必须回到 UI，而不是变成控制台里一个未捕获的 Promise。
 */
export async function runCheckpointRequest(
  req: CheckpointRestoreRequest,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<CheckpointResult> {
  if (req.sessionId === '' || req.checkpointId === '') {
    return { phase: req.phase, ok: false, error: '缺少会话或检查点标识', code: 'INVALID_ARGUMENTS' }
  }
  if (req.phase === 'apply' && (req.planId === undefined || req.confirmation === undefined)) {
    // 引擎会以 NO_CHANGES 拒绝——在客户端先拦住，给出能看懂的原因
    return { phase: req.phase, ok: false, error: '缺少恢复计划（需先预览）', code: 'NO_PLAN' }
  }
  try {
    const response =
      req.phase === 'preview'
        ? await fetchImpl(buildPreviewUrl(req), { method: 'GET', headers: { accept: 'application/json' } })
        : await fetchImpl(REWIND_HTTP_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildApplyBody(req)),
          })
    let json: unknown = null
    try {
      json = await response.json()
    } catch {
      json = null
    }
    return interpretResponse(req.phase, response.status, json)
  } catch (err) {
    return {
      phase: req.phase,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: 'NETWORK',
    }
  }
}

/** Narrow an unknown downlink message into a request (or null when invalid). */
export function parseRestoreRequest(data: unknown): CheckpointRestoreRequest | null {
  if (data === null || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.kind !== CHECKPOINT_RESTORE_EVENT) return null
  if (d.phase !== 'preview' && d.phase !== 'apply') return null
  if (typeof d.sessionId !== 'string' || d.sessionId === '') return null
  if (typeof d.messageSeq !== 'number' || !Number.isFinite(d.messageSeq)) return null
  if (typeof d.checkpointId !== 'string' || d.checkpointId === '') return null
  return {
    phase: d.phase,
    sessionId: d.sessionId,
    messageSeq: d.messageSeq,
    checkpointId: d.checkpointId,
    mode: d.mode === 'both' ? 'both' : 'code',
    requestId: typeof d.requestId === 'string' ? d.requestId : '',
    ...(typeof d.planId === 'string' && d.planId !== '' ? { planId: d.planId } : {}),
    ...(typeof d.confirmation === 'string' && d.confirmation !== '' ? { confirmation: d.confirmation } : {}),
  }
}

/** Uplink envelope for the result (bridge forwards it as `checkpointsReady`). */
export function resultUplink(req: CheckpointRestoreRequest, result: CheckpointResult): {
  kind: string
  payload: Record<string, unknown>
} {
  return {
    kind: CHECKPOINT_READY_KIND,
    payload: { requestId: req.requestId, ...result },
  }
}

/**
 * 安装下行走廊：监听到恢复请求 → 调用 `/turn-rewind` → 上行回执。
 *
 * 刻意不做重试：恢复是"改磁盘"的破坏性动作，网络抖动时自动重试可能造成第二次恢复；
 * 让扩展侧拿到失败并让用户再点一次，是更安全的默认。
 *
 * @returns 卸载函数
 */
export function installCheckpointBridge(fetchImpl: FetchLike = fetch as unknown as FetchLike): () => void {
  const onMessage = (e: MessageEvent): void => {
    const req = parseRestoreRequest(e.data)
    if (req === null) return
    void runCheckpointRequest(req, fetchImpl).then((result) => {
      const uplink = resultUplink(req, result)
      window.dispatchEvent(new CustomEvent('dsh-file-jump:bridgeUp', { detail: uplink }))
    })
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}
