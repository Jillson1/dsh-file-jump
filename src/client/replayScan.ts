/**
 * Replay (F1 · 变更账本的回放半边): scan the session snapshot for settled
 * edit/write tool results that carry an applied diff, and re-broadcast them to
 * the host as `diffApplied` events — so the VS Code change book survives
 * "Reload / reopen the session" instead of losing every mark.
 *
 * Why replay is needed at all (and why the relay path is not enough):
 *   - The relay path fires from `JumpRow` when a card renders *and* the bridge
 *     handshake already happened. After a reload the handshake can land late
 *     (historical cards render first) and those notifications are lost.
 *   - The book is persisted per VS Code window; a fresh window starts empty and
 *     has no idea what the session changed before.
 * Replay makes that path deterministic: the snapshot is the source of truth for
 * "what did this session change", independent of render timing.
 *
 * Pure derivation here (no React, no DOM) so the scan/dedupe rules are
 * unit-testable; the dock component (ReplayDock.tsx) only wires it to the snapshot.
 *
 * Naming note: this module is deliberately NOT called `replayDock.ts` — on a
 * case-insensitive filesystem (Windows/macOS) it would emit a declaration file
 * that collides with `ReplayDock.tsx` (TS5056: overwritten by multiple inputs).
 */

import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { DIFF_EVENT, diffTargetPath, extractAppliedDiffs, type DiffAppliedPayload } from './diffNotify.ts'

/** Source channel of a diff notification (F1): live render vs historical replay. */
export type ChangeSource = 'relay' | 'replay'

/** Minimal session-snapshot shape the replay needs (keeps the scan testable with plain data). */
export interface ReplaySessionLike {
  readonly sessionId: string
  /** Session cwd when known; the host falls back to its workspace root otherwise. */
  readonly cwd?: string
  /** Conversation nodes, oldest first (the snapshot's `nodes` field). */
  readonly nodes: readonly ReplayNodeLike[]
}

/** Minimal node shape: only the fields the replay reads (a settled tool result). */
export interface ReplayNodeLike {
  readonly kind?: string
  readonly callId?: string
  readonly isError?: boolean
  readonly call?: { readonly name?: string; readonly argsRaw?: string } | null
  readonly callView?: unknown
  readonly resultView?: unknown
}

/**
 * How many trailing nodes a steady-state render scans. The dock re-renders on
 * every conversation change, so the scan must stay bounded even for a 25k-event
 * session; dedupe by callId keeps the work incremental.
 */
export const TAIL_SCAN_LIMIT = 200

/**
 * Node budget for the FIRST scan after mount (the reload case): changes made
 * before the reload live anywhere in the window, so a tail-only scan would miss
 * them. Still capped — a hard floor against pathological sessions.
 */
export const FIRST_SCAN_LIMIT = 1000

/** Tool names whose results carry an applied diff. */
const MUTATION_TOOLS = new Set(['edit', 'write'])

/** Tool name of a settled node (`call` is null when the call head fell outside the window). */
function nodeTool(node: ReplayNodeLike): string | undefined {
  const name = node.call?.name
  return typeof name === 'string' && name !== '' ? name : undefined
}

/**
 * Collect replay payloads from a session snapshot.
 *
 * Rules (each one earns its place):
 *   - only settled, non-error `tool-result` nodes (running cards are the relay's job);
 *   - only edit/write (mutation) tools;
 *   - only nodes with a usable diff card;
 *   - only nodes whose callId was not already dispatched (per-instance `seen` set) —
 *     this is what makes repeat renders cheap and idempotent.
 *
 * @param session snapshot subset (sessionId / nodes / optional cwd)
 * @param seen    per-instance dedupe set, mutated in place
 * @param limit   how many trailing nodes to consider (see the two limits above)
 * @returns payloads to dispatch, oldest first
 */
export function collectReplayPayloads(
  session: ReplaySessionLike,
  seen: Set<string>,
  limit: number = TAIL_SCAN_LIMIT,
): DiffAppliedPayload[] {
  const nodes = limit > 0 && session.nodes.length > limit ? session.nodes.slice(-limit) : session.nodes
  const out: DiffAppliedPayload[] = []
  for (const node of nodes) {
    if (node.kind !== 'tool-result') continue
    if (node.isError === true) continue
    const callId = node.callId
    if (typeof callId !== 'string' || callId === '') continue
    if (seen.has(callId)) continue
    const tool = nodeTool(node)
    if (tool === undefined || !MUTATION_TOOLS.has(tool)) continue
    // extractAppliedDiffs / diffTargetPath are written against ToolCallBlock; a
    // settled node is structurally one (kind/callId/call/argsRaw/callView/resultView).
    const block = node as unknown as ToolCallBlock
    const diffs = extractAppliedDiffs(block)
    if (diffs === null) continue
    const path = diffTargetPath(session.cwd, block)
    if (path === undefined) continue
    seen.add(callId)
    const payload: DiffAppliedPayload = {
      kind: DIFF_EVENT,
      path,
      diffs,
      callId,
      sessionId: session.sessionId,
      source: 'replay',
    }
    if (session.cwd !== undefined && session.cwd !== '') payload.cwd = session.cwd
    payload.tool = tool
    out.push(payload)
  }
  return out
}

/**
 * Narrow a `ConversationSnapshot` to the pure subset the replay reads.
 *
 * Kept here (not in the component) so the narrowing rules are unit-testable:
 * a snapshot without a usable session id yields null, and a missing/odd `nodes`
 * field degrades to an empty scan rather than throwing inside render.
 *
 * @param session snapshot-like object (structural: only sessionId / nodes / cwd are read)
 * @returns a ReplaySessionLike, or null when there is nothing to replay against
 */
export function toReplaySession(
  session: { readonly sessionId?: unknown; readonly nodes?: unknown; readonly cwd?: unknown } | null | undefined,
): ReplaySessionLike | null {
  if (session === null || session === undefined) return null
  const sessionId = typeof session.sessionId === 'string' ? session.sessionId : ''
  if (sessionId === '') return null
  const nodes = Array.isArray(session.nodes) ? (session.nodes as readonly ReplayNodeLike[]) : []
  const view: ReplaySessionLike = { sessionId, nodes }
  if (typeof session.cwd === 'string' && session.cwd !== '') {
    return { ...view, cwd: session.cwd }
  }
  return view
}
