/**
 * Browser-half entry for the dsh-file-jump plugin: registers the file jump
 * rows for read / edit / write into the keyed `tool.call.toolview` slot.
 *
 * The row renders the file path as a clickable link carrying data-abs-path /
 * data-old-text / data-line; the dsh-vscode-bridge intercepts the click in the
 * capture phase, reads those attributes, and tells the VS Code extension to
 * open the file (and, for edit, locate the changed line).
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { JumpRow } from './JumpRow.tsx'

/** Required service: slots for the toolview keyed-slot takeover. */
export const inject = ['slots']

/** Register one keyed toolview entry (a keyed hit replaces the shipped row). */
function registerToolview(ctx: ClientContext, key: 'read' | 'edit' | 'write'): void {
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key }, JumpRow))
}

/** Apply the browser half: register the three toolviews once the slots service is up. */
export function apply(ctx: ClientContext): void {
  ctx.inject(['slots'], (scope) => {
    registerToolview(scope, 'read')
    registerToolview(scope, 'edit')
    registerToolview(scope, 'write')
  })
}
