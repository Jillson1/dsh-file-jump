/**
 * Composer injection: listens for the VS Code "Add to DSH" downlink forwarded
 * by the dsh-vscode-bridge inside this iframe (`dsh-file-jump:injectComposer`)
 * and seeds the active session's composer draft with the `@path[:start-end]`
 * reference. Session resolution uses the in-memory sessions.list (`current`
 * is the active session) — no HTTP round-trip, and it always targets the
 * session the user is currently looking at.
 *
 * Draft splicing reuses the same rule as dsh-aionui-panel's drag-to-composer
 * (`insertPathIntoDraft`): append at the caret, keeping whitespace sane.
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge so `conversation` and
// its `.input.for(actx).setDraft` surface are visible on the client Context.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Downlink event name the bridge broadcasts inside this iframe. */
export const INJECT_EVENT = 'dsh-file-jump:injectComposer'

/** Draft-splice rule (same as aionui-panel): space-pad around the inserted text. */
export function spliceIntoDraft(draft: string, text: string): string {
  if (draft === '') return text
  return /\s$/.test(draft) ? `${draft}${text}` : `${draft} ${text}`
}

/** Narrow injected session services to the two methods injection needs (unit-testable). */
export interface SessionsLike {
  list: { getSnapshot(): { current?: string | undefined } }
  scope(id: string): ClientContext | undefined
}

/** Write the text into the active session's composer; true on success. */
export function injectIntoActive(
  sessions: SessionsLike,
  conversation: ClientContext['conversation'],
  text: string,
): boolean {
  const sessionId = sessions.list.getSnapshot().current as SessionId | undefined
  if (sessionId === undefined) return false
  const actx = sessions.scope(sessionId)
  if (actx === undefined) return false // session not materialized yet
  const input = conversation.input
  if (input === undefined) return false
  const shell = input.for(actx)
  shell.setDraft(spliceIntoDraft(shell.state.getSnapshot().draft, text))
  return true
}

/** Install the downlink listener (idempotent per apply; cleaned up on teardown). */
export function installComposerInjection(ctx: ClientContext): void {
  ctx.inject(['sessions', 'conversation'], (scope) => {
    const onMessage = (e: MessageEvent): void => {
      const d = e.data
      if (d && typeof d === 'object' && d.kind === INJECT_EVENT && typeof d.text === 'string') {
        if (!injectIntoActive(scope.sessions, scope.conversation, d.text)) {
          // Best-effort: nothing to inject into (no active session / not materialized).
          console.warn('[dsh-file-jump] injectComposer: no active session to write into')
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  })
}
