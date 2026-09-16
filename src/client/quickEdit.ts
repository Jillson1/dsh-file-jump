/**
 * Quick Edit (F11): the browser half of "send an instruction for this selection".
 *
 * Flow: VS Code sends a downlink `quickEditSubmit { path, startLine, endLine, instruction }`
 * → this module writes `@path:start-end instruction` into the active session's composer
 * → submits it (only when the input machine is in its `plain` phase) → the agent runs.
 *
 * Why the "only when plain" rule: `SessionInput.submit()` enters adjudication, and while the
 * machine is `adjudicating | claimed | submitting` a submit is refused or queued. Degrading to
 * "draft only + a notice" keeps the user's text instead of throwing it away — and it matches
 * the project's standing rule that nothing steals focus or silently drops input.
 *
 * `submit` mode is `'queue'` (the only other value is `'steer'`): verified against
 * `BUSY_ENTER_BEHAVIORS` in ui-conversation 0.1.0-rc.8 — the "default" spelling that appears
 * in the design doc is not a valid InputSubmitMode.
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge so `conversation.input` resolves on the client Context.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { spliceIntoDraft, type SessionsLike } from './composerInject.ts'

/** Downlink event name the bridge broadcasts inside this iframe. */
export const QUICK_EDIT_EVENT = 'dsh-file-jump:quickEditSubmit'

/** One quick-edit request (1-based line range, matching the `@path:start-end` convention). */
export interface QuickEditRequest {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly instruction: string
}

/** What happened to the request. */
export type QuickEditOutcome = 'sent' | 'drafted' | 'no-session'

/** Narrow an unknown downlink message into a request (or null when invalid). */
export function parseQuickEdit(data: unknown): QuickEditRequest | null {
  if (data === null || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.kind !== QUICK_EDIT_EVENT) return null
  if (typeof d.path !== 'string' || d.path === '') return null
  if (typeof d.startLine !== 'number' || !Number.isFinite(d.startLine)) return null
  if (typeof d.endLine !== 'number' || !Number.isFinite(d.endLine)) return null
  if (typeof d.instruction !== 'string') return null
  return {
    path: d.path,
    startLine: d.startLine,
    endLine: d.endLine,
    instruction: d.instruction,
  }
}

/**
 * Composer text for one request: `@path:12-30 改成防抖`.
 * 单行选区的范围不重复写（`@path:12` 比 `@path:12-12` 干净），与 addToDsh 的既有写法一致。
 */
export function quickEditDraftText(req: QuickEditRequest): string {
  const from = Math.max(1, Math.floor(req.startLine))
  const to = Math.max(from, Math.floor(req.endLine))
  const ref = from === to ? `@${req.path}:${from}` : `@${req.path}:${from}-${to}`
  const instruction = req.instruction.trim()
  return instruction === '' ? ref : `${ref} ${instruction}`
}

/**
 * Write the request into the active session's composer and send it when the machine is idle.
 *
 * 依赖最小化（sessions / conversation 的结构子集）：这条路径要能在单测里跑，
 * 而真实的 cordis 服务对象无法在测试里构造。
 */
export function quickEditIntoActive(
  sessions: SessionsLike,
  conversation: ClientContext['conversation'],
  req: QuickEditRequest,
): QuickEditOutcome {
  const sessionId = sessions.list.getSnapshot().current as SessionId | undefined
  if (sessionId === undefined) return 'no-session'
  const actx = sessions.scope(sessionId)
  if (actx === undefined) return 'no-session' // 会话尚未物化
  const input = conversation.input
  if (input === undefined) return 'no-session'
  const shell = input.for(actx)
  shell.setDraft(spliceIntoDraft(shell.state.getSnapshot().draft, quickEditDraftText(req)))
  const phase = shell.state.getSnapshot().phase
  if (phase !== 'plain') {
    // 忙时降级：草稿已写入，等空闲后由用户自己回车（不排队、不抢占）
    shell.notify('info', 'DSH 正在运行，指令已写入输入框，空闲后发送即可')
    return 'drafted'
  }
  shell.submit('queue')
  return 'sent'
}

/**
 * 安装下行监听。
 *
 * @param ctx 插件 client 上下文（apply 内调用）
 */
export function installQuickEdit(ctx: ClientContext): void {
  ctx.inject(['sessions', 'conversation'], (scope) => {
    const onMessage = (e: MessageEvent): void => {
      const req = parseQuickEdit(e.data)
      if (req === null) return
      const outcome = quickEditIntoActive(scope.sessions, scope.conversation, req)
      if (outcome === 'no-session') {
        console.warn('[dsh-file-jump] quickEdit: 没有可写入的会话')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  })
}
