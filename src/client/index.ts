/**
 * Browser-half entry for the dsh-file-jump plugin: registers the file jump
 * rows for read / edit / write into the keyed `tool.call.toolview` slot.
 *
 * The row renders the file path as a clickable link carrying data-abs-path /
 * data-old-text / data-line; the dsh-vscode-bridge intercepts the click in the
 * capture phase, reads those attributes, and tells the VS Code extension to
 * open the file (and, for edit, locate the changed line).
 */

import type { Context } from '@deepseek-ai/cordis'
import { JumpRow } from './JumpRow.tsx'

/** Register one keyed toolview entry (a keyed hit replaces the shipped row). */
function registerToolview(ctx: Context, key: 'read' | 'edit' | 'write'): void {
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key }, JumpRow))
}

/** Apply the browser half. */
export function apply(ctx: Context): void {
  registerToolview(ctx, 'read')
  registerToolview(ctx, 'edit')
  registerToolview(ctx, 'write')
}
