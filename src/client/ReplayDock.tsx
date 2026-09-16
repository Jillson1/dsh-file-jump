/**
 * ReplayDock (F1): a headless dock entry on `conversation.input.dock` that scans
 * the current session snapshot and re-broadcasts applied diffs to the host, so
 * the VS Code change book keeps its records across "Reload Window" and across
 * fresh windows.
 *
 * Why this slot (and not the tool rows):
 *   `conversation.input.dock` is a per-session list slot owned by the input zone,
 *   so it mounts exactly once per session and re-renders on every conversation
 *   change — a stable, always-present observation point. `JumpRow` cannot serve
 *   this role: it only exists while a tool card is rendered, and after a reload
 *   the historical cards may render before the bridge handshake is up (their
 *   notifications are dropped). Rendering nothing also keeps the dock clean.
 *
 * Props contract (verified against DSH 0.1.0-rc.8):
 *   PropsRuntime<'conversation.input.dock'> = InputZone owner share ({ session, input })
 *   + SessionStandardProps ({ sessionId, useSession }) + global seat. The owner
 *   share is a point-in-time snapshot re-rendered for us — no subscribing needed.
 */

import { useEffect, useRef } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge so 'conversation.input.dock' resolves.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { collectReplayPayloads, toReplaySession, FIRST_SCAN_LIMIT, TAIL_SCAN_LIMIT } from './replayScan.ts'

/** Full props of this dock entry (owner share + session standard kit). */
type ReplayDockProps = PropsRuntime<'conversation.input.dock'>

/**
 * List-slot entry id. A list slot keys entries by `id` (same id + same priority
 * throws), so a plugin-unique id is all that is needed — unlike the keyed
 * toolview takeover this does NOT shadow anyone else's entry.
 */
export const REPLAY_DOCK_ID = 'dsh-file-jump-replay'

/**
 * Headless replay entry: renders nothing, dispatches on snapshot change.
 *
 * Idempotence: `seen` (per instance) dedupes by callId, so the same mutation is
 * dispatched once per dock lifetime; the first scan is generous (a reload must
 * find changes made long before it), later scans stay on the tail window.
 */
export function ReplayDock({ session }: ReplayDockProps): null {
  const seenRef = useRef<Set<string>>(new Set())
  const firstScanRef = useRef(true)

  useEffect(() => {
    const view = toReplaySession(session)
    if (view === null) return
    const limit = firstScanRef.current ? FIRST_SCAN_LIMIT : TAIL_SCAN_LIMIT
    firstScanRef.current = false
    for (const payload of collectReplayPayloads(view, seenRef.current, limit)) {
      // 与 JumpRow 的 relay 路径走同一个 window 事件：桥接只认事件名，不区分来源；
      // 扩展按 callId 去重，因此同一处改动经两条通道到达也只会留一条账本记录。
      window.dispatchEvent(new CustomEvent(payload.kind, { detail: payload }))
    }
  }, [session])

  return null
}

/**
 * Register the replay entry on the input dock.
 *
 * `order: 30` keeps it after the shipped queue strip (order 20) — irrelevant for
 * a headless entry today, but it keeps any future visible content at the bottom
 * of the dock instead of pushing the queue around.
 *
 * @param ctx plugin client context (already injected with `slots`)
 */
export function registerReplayDock(scope: ClientContext): void {
  scope.slots.inject('conversation.input.dock', () =>
    scope.slots.register({ name: 'conversation.input.dock', id: REPLAY_DOCK_ID, order: 30 }, ReplayDock),
  )
}
