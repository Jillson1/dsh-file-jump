/**
 * Pending watch (F6/F7): the browser half of "IDE as a surface".
 *
 * Two jobs, both driven by the current session snapshot:
 *   F6 — surface `pending` approvals so the VS Code modal can answer them
 *        (`PendingWait.respond`), and relay the answer back;
 *   F7 — publish a tiny session state (running / turn / pending) so the VS Code
 *        status bar and completion notification have a data source.
 *
 * Zero DSH source changes: pending interactions are a client-visible contract
 * (`PendingInteraction` with `payload` + `respond()`), and the answer envelope is
 * `{ ok: true, value: { sessionId, approvalId, outcome } }` — the same shape DSH's
 * own panel sends (verified against `@deepseek-ai/dsh-api-remotes/client` and the
 * fixture transport in the rc.8 checkout).
 *
 * Pure derivations live here (no React, no DOM) so the mapping rules are testable;
 * the dock component only wires them to the snapshot and the bridge.
 */

/** Downlink events the bridge delivers inside this iframe. */
export const APPROVAL_DECISION_EVENT = 'dsh-file-jump:approvalDecision'
export const QUESTION_ANSWER_EVENT = 'dsh-file-jump:questionAnswer'

/** Uplink kind names (the bridge whitelists exactly these). */
export const UPLINK_KINDS = {
  sessionState: 'sessionState',
  approvalRequest: 'approvalRequest',
  questionRequest: 'questionRequest',
} as const

/** Approval outcome accepted by the host payload (no "always allow" exists). */
export type ApprovalOutcome = 'allowed-once' | 'rejected'

/** Minimal shape of one pending wait (see `PendingWait` in the DSH runtime). */
export interface PendingWaitLike {
  readonly kind: string
  /** Stable render identity, `a:<rpcId>` / `q:<rpcId>` — usable as a dedupe key. */
  readonly key: string
  readonly sessionId: string
  readonly payload: unknown
}

/** Minimal session snapshot shape this module reads. */
export interface PendingSessionLike {
  readonly sessionId: string
  readonly running?: boolean
  readonly pending?: readonly PendingWaitLike[]
  /** turn number → timing; the highest key is the current (or last) turn. */
  readonly turnTimings?: ReadonlyMap<number, unknown>
}

/** Payload shape forwarded to the VS Code extension for one approval. */
export interface ApprovalRequestPayload {
  readonly sessionId: string
  readonly approvalId: string
  readonly toolName: string
  readonly callId?: string
  /** The wait object this request came from (kept so the answer can settle it). */
  readonly wait: PendingWaitLike
}

/** Payload published for F7 (status bar / completion notification). */
export interface SessionStatePayload {
  readonly sessionId: string
  readonly running: boolean
  readonly turn: number
  readonly pending: number
}

/** Narrow an unknown payload into the approval frame fields. */
function approvalFields(payload: unknown): { approvalId: string; toolName: string; callId?: string; reason?: string } | null {
  if (payload === null || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (typeof p.approvalId !== 'string' || p.approvalId === '') return null
  if (typeof p.toolName !== 'string' || p.toolName === '') return null
  const out: { approvalId: string; toolName: string; callId?: string; reason?: string } = {
    approvalId: p.approvalId,
    toolName: p.toolName,
  }
  if (typeof p.callId === 'string' && p.callId !== '') out.callId = p.callId
  if (typeof p.reason === 'string' && p.reason !== '') out.reason = p.reason
  return out
}

/** Current turn number: the highest key of `turnTimings` (0 = unknown). */
export function currentTurn(session: PendingSessionLike): number {
  const timings = session.turnTimings
  if (timings === undefined || typeof timings.keys !== 'function') return 0
  let max = 0
  for (const turn of timings.keys()) {
    if (typeof turn === 'number' && turn > max) max = turn
  }
  return max
}

/** F7 payload derivation (pure). */
export function sessionStatePayload(session: PendingSessionLike): SessionStatePayload {
  return {
    sessionId: session.sessionId,
    running: session.running === true,
    turn: currentTurn(session),
    pending: session.pending?.length ?? 0,
  }
}

/**
 * F6 payload derivation (pure): collect the *unseen* approval waits.
 *
 * Dedupe is by `wait.key` (stable across baseline replay, so a reconnect does not
 * re-open a modal the user already saw). Questions are deliberately NOT collected
 * here — F8 owns them (different answer shape; shipping a half-answer would be worse
 * than waiting one phase).
 *
 * @param session snapshot subset
 * @param seen    per-instance dedupe set (`wait.key`), mutated in place
 */
export function collectApprovalRequests(
  session: PendingSessionLike,
  seen: Set<string>,
): ApprovalRequestPayload[] {
  const out: ApprovalRequestPayload[] = []
  for (const wait of session.pending ?? []) {
    if (wait.kind !== 'approval') continue
    if (typeof wait.key !== 'string' || wait.key === '') continue
    if (seen.has(wait.key)) continue
    const fields = approvalFields(wait.payload)
    if (fields === null) continue
    seen.add(wait.key)
    out.push({
      sessionId: typeof wait.sessionId === 'string' && wait.sessionId !== '' ? wait.sessionId : session.sessionId,
      approvalId: fields.approvalId,
      toolName: fields.toolName,
      ...(fields.callId === undefined ? {} : { callId: fields.callId }),
      wait,
    })
  }
  return out
}

/** Uplink envelope for the bridge relay (`dsh-file-jump:bridgeUp`). */
export interface BridgeUplink {
  readonly kind: string
  readonly payload: Record<string, unknown>
}

/** Build the approval uplink payload (drops the live wait object — payloads must stay data). */
export function approvalUplink(request: ApprovalRequestPayload, reason?: string): BridgeUplink {
  const payload: Record<string, unknown> = {
    sessionId: request.sessionId,
    approvalId: request.approvalId,
    toolName: request.toolName,
  }
  if (request.callId !== undefined) payload.callId = request.callId
  if (reason !== undefined && reason !== '') payload.reason = reason
  return { kind: UPLINK_KINDS.approvalRequest, payload }
}

/** Build the session-state uplink envelope. */
export function sessionStateUplink(state: SessionStatePayload): BridgeUplink {
  return { kind: UPLINK_KINDS.sessionState, payload: { ...state } }
}

/**
 * Answer one approval wait through the host's response carrier.
 *
 * Envelope shape verified in the rc.8 checkout: the domain payload is
 * `{ sessionId, approvalId, outcome }` wrapped in `{ ok: true, value }`.
 * A settled wait throws (`already settled`) — the browser panel may have answered
 * while the VS Code modal was open, which is a normal race, so it is swallowed.
 *
 * @returns true when the answer was accepted by the host
 */
export async function answerApproval(
  wait: PendingWaitLike & { respond?(result: unknown): Promise<unknown> },
  outcome: ApprovalOutcome,
): Promise<boolean> {
  if (typeof wait.respond !== 'function') return false
  const payload = approvalFields(wait.payload)
  if (payload === null) return false
  try {
    await wait.respond({
      ok: true,
      value: { sessionId: wait.sessionId, approvalId: payload.approvalId, outcome },
    })
    return true
  } catch {
    // already settled（浏览器端先答 / 超时）——静默忽略，不改判也不重试
    return false
  }
}

// ============================================================================
// F8：提问 / plan-review 半边
//
// 与审批同源（都是 `pending` 上的可应答等待），但**回答形状完全不同**：
// 审批是 `{ sessionId, approvalId, outcome }`，提问是整批一次作答
// `{ sessionId, answer: { answers: [{ id, selected[], custom? }] } }`——一次 ask 多问一答，不能拆。
// 这就是 pendingWatch 里 question 与 approval 分开收集、分开回答的原因。
//
// 注意：host 的 `question/requested` 帧**没有 questionId**（rpcId 就是逻辑 id）。
// 因此这里用 `wait.key`（`q:<rpcId>`）作为扩展侧的问句标识：它对回放稳定，且能唯一映射回等待对象。
// ============================================================================

/** Payload forwarded to the extension for one question batch. */
export interface QuestionRequestPayload {
  readonly sessionId: string
  /** `wait.key` (`q:<rpcId>`) — the only stable identifier the frame carries. */
  readonly questionId: string
  /** Raw `AskUserQuestionItem[]` (the extension owns presentation). */
  readonly questions: readonly unknown[]
  /** The wait object this request came from. */
  readonly wait: PendingWaitLike
}

/** Narrow an unknown payload into the question frame fields (must have a non-empty `questions` array). */
function questionFields(payload: unknown): { questions: readonly unknown[] } | null {
  if (payload === null || typeof payload !== 'object') return null
  const questions = (payload as { questions?: unknown }).questions
  if (!Array.isArray(questions) || questions.length === 0) return null
  const items = questions.filter((q) => q !== null && typeof q === 'object')
  if (items.length === 0) return null
  return { questions: items }
}

/**
 * F8 payload derivation (pure): collect the *unseen* question waits.
 * Empty/invalid batches are dropped — the wire contract already forbids them,
 * and a modal with no question is worse than no modal.
 */
export function collectQuestionRequests(
  session: PendingSessionLike,
  seen: Set<string>,
): QuestionRequestPayload[] {
  const out: QuestionRequestPayload[] = []
  for (const wait of session.pending ?? []) {
    if (wait.kind !== 'question') continue
    if (typeof wait.key !== 'string' || wait.key === '') continue
    if (seen.has(wait.key)) continue
    const fields = questionFields(wait.payload)
    if (fields === null) continue
    seen.add(wait.key)
    out.push({
      sessionId: typeof wait.sessionId === 'string' && wait.sessionId !== '' ? wait.sessionId : session.sessionId,
      questionId: wait.key,
      questions: fields.questions,
      wait,
    })
  }
  return out
}

/** Build the question uplink envelope (data only — the live wait stays local). */
export function questionUplink(request: QuestionRequestPayload): BridgeUplink {
  return {
    kind: UPLINK_KINDS.questionRequest,
    payload: { sessionId: request.sessionId, questionId: request.questionId, questions: request.questions },
  }
}

/**
 * Answer one question batch through the host's response carrier.
 *
 * Payload shape verified in the rc.8 checkout: `{ sessionId, answer }` where
 * `answer` is `{ answers: [{ id, selected: string[], custom? }] }` — one ask(),
 * many questions, **one** answer (never split per question).
 *
 * @returns true when the host accepted the answer
 */
export async function answerQuestion(
  wait: PendingWaitLike & { respond?(result: unknown): Promise<unknown> },
  answer: unknown,
): Promise<boolean> {
  if (typeof wait.respond !== 'function') return false
  if (answer === null || typeof answer !== 'object') return false
  try {
    await wait.respond({ ok: true, value: { sessionId: wait.sessionId, answer } })
    return true
  } catch {
    // already settled（浏览器端先答 / 会话已推进）——静默忽略
    return false
  }
}
