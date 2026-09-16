/**
 * SessionPulse (F6/F7): a headless dock entry that turns the session snapshot into
 * IDE-visible state.
 *
 * Why its own dock entry (rather than folding into ReplayDock):
 *   ReplayDock owns "what did this session change" (diff replay). This entry owns
 *   "what is the session doing right now" (running / turn / pending + approval
 *   forwarding). Both are headless and snapshot-driven, but they fail differently:
 *   a replay bug loses highlights, a pulse bug leaves the user staring at a modal
 *   that never answers. Two entries keep each failure diagnosable on its own.
 *
 * Everything decision-shaped lives in `pendingWatch.ts` (pure, unit-tested); this
 * file only wires: snapshot → uplink events, downlink decision → `respond()`.
 */

import { useEffect, useRef } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge so 'conversation.input.dock' resolves.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import {
  APPROVAL_DECISION_EVENT,
  QUESTION_ANSWER_EVENT,
  answerApproval,
  answerQuestion,
  approvalUplink,
  collectApprovalRequests,
  collectQuestionRequests,
  questionUplink,
  sessionStatePayload,
  sessionStateUplink,
  type ApprovalOutcome,
  type PendingSessionLike,
  type PendingWaitLike,
} from './pendingWatch.ts'

/** Full props of this dock entry (owner share + session standard kit). */
type SessionPulseProps = PropsRuntime<'conversation.input.dock'>

/** List-slot entry id (unique per plugin; list entries are keyed by `id`). */
export const SESSION_PULSE_ID = 'dsh-file-jump-pulse'

/** Downlink envelope shape delivered by the bridge. */
interface ApprovalDecisionMessage {
  kind: typeof APPROVAL_DECISION_EVENT
  sessionId?: string
  approvalId?: string
  outcome?: string
}

/** Uplink through the bridge relay: a window CustomEvent the bridge forwards. */
function publish(kind: string, payload: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent('dsh-file-jump:bridgeUp', { detail: { kind, payload } }))
}

/** Narrow the snapshot to the fields this module reads (keeps the component thin). */
function toSessionLike(session: unknown): PendingSessionLike | null {
  if (session === null || typeof session !== 'object') return null
  const s = session as { sessionId?: unknown; running?: unknown; pending?: unknown; turnTimings?: unknown }
  if (typeof s.sessionId !== 'string' || s.sessionId === '') return null
  const like: PendingSessionLike = {
    sessionId: s.sessionId,
    running: s.running === true,
    pending: Array.isArray(s.pending) ? (s.pending as readonly PendingWaitLike[]) : [],
  }
  if (s.turnTimings instanceof Map) {
    return { ...like, turnTimings: s.turnTimings as ReadonlyMap<number, unknown> }
  }
  return like
}

/**
 * Headless pulse: publishes session state on every change and forwards new
 * approval waits; answers the ones the extension decides on.
 */
export function SessionPulse({ session }: SessionPulseProps): null {
  const seenRef = useRef<Set<string>>(new Set())
  /** approvalId → live wait object (only the object can settle the interaction) */
  const waitsRef = useRef<Map<string, PendingWaitLike>>(new Map())
  /** questionId (= wait.key) → live wait object（提问按 key 映射：帧里没有 questionId） */
  const questionWaitsRef = useRef<Map<string, PendingWaitLike>>(new Map())
  const lastStateRef = useRef<string>('')

  useEffect(() => {
    const like = toSessionLike(session)
    if (like === null) return

    // F7：状态上行（去重：只有真正变化才发，避免每次渲染都刷桥接）
    const state = sessionStatePayload(like)
    const fingerprint = `${state.sessionId}|${state.running}|${state.turn}|${state.pending}`
    if (fingerprint !== lastStateRef.current) {
      lastStateRef.current = fingerprint
      const uplink = sessionStateUplink(state)
      publish(uplink.kind, uplink.payload)
    }

    // F6：把"新出现的审批等待"转给扩展（modal 由扩展弹）
    const requests = collectApprovalRequests(like, seenRef.current)
    for (const request of requests) {
      waitsRef.current.set(request.approvalId, request.wait)
      const uplink = approvalUplink(request, reasonOf(request.wait))
      publish(uplink.kind, uplink.payload)
    }

    // F8：把"新出现的提问等待"转给扩展（QuickPick / 计划文档由扩展呈现）
    // seen 与审批共用：key 前缀不同（a:/q:），不会互相顶掉
    const questions = collectQuestionRequests(like, seenRef.current)
    for (const request of questions) {
      questionWaitsRef.current.set(request.questionId, request.wait)
      const uplink = questionUplink(request)
      publish(uplink.kind, uplink.payload)
    }
  }, [session])

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const d = e.data as ApprovalDecisionMessage | undefined
      if (d === undefined || d === null || d.kind !== APPROVAL_DECISION_EVENT) return
      if (typeof d.approvalId !== 'string' || d.approvalId === '') return
      const outcome: ApprovalOutcome | null =
        d.outcome === 'allowed-once' || d.outcome === 'rejected' ? d.outcome : null
      if (outcome === null) {
        console.warn('[dsh-file-jump] approvalDecision: 非法 outcome，已忽略')
        return
      }
      const wait = waitsRef.current.get(d.approvalId)
      if (wait === undefined) {
        // 等待已消失（浏览器端先答 / 会话切换）→ 静默忽略：不改判、不重试
        return
      }
      void answerApproval(wait as PendingWaitLike & { respond?(r: unknown): Promise<unknown> }, outcome).then((ok) => {
        if (ok) waitsRef.current.delete(d.approvalId as string)
      })
    }
    const onQuestionAnswer = (e: MessageEvent): void => {
      const d = e.data as { kind?: unknown; questionId?: unknown; answer?: unknown } | undefined
      if (d === undefined || d === null || d.kind !== QUESTION_ANSWER_EVENT) return
      if (typeof d.questionId !== 'string' || d.questionId === '') return
      const wait = questionWaitsRef.current.get(d.questionId)
      if (wait === undefined) return // 等待已消失（浏览器端先答 / 会话推进）→ 静默忽略
      void answerQuestion(
        wait as PendingWaitLike & { respond?(r: unknown): Promise<unknown> },
        d.answer,
      ).then((ok) => {
        if (ok) questionWaitsRef.current.delete(d.questionId as string)
      })
    }
    window.addEventListener('message', onMessage)
    window.addEventListener('message', onQuestionAnswer)
    return () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('message', onQuestionAnswer)
    }
  }, [])

  return null
}

/** Pull the human-readable reason out of a wait payload (optional field). */
function reasonOf(wait: PendingWaitLike): string | undefined {
  if (wait.payload === null || typeof wait.payload !== 'object') return undefined
  const reason = (wait.payload as { reason?: unknown }).reason
  return typeof reason === 'string' && reason !== '' ? reason : undefined
}

/**
 * Register the pulse entry on the input dock.
 *
 * @param scope plugin client context (already injected with `slots`)
 */
export function registerSessionPulse(scope: ClientContext): void {
  scope.slots.inject('conversation.input.dock', () =>
    scope.slots.register({ name: 'conversation.input.dock', id: SESSION_PULSE_ID, order: 31 }, SessionPulse),
  )
}
