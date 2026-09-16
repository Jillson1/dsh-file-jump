/**
 * Diff notification (A 组 · 编辑区修改可视化): when a settled edit/write tool
 * call carries an applied diff, notify the host (via the bridge) so the VS Code
 * extension can highlight the changed lines in the editor.
 *
 * The row render is the observation point: a settled block re-renders once when
 * it lands, and the caller dedupes by callId so each applied mutation yields
 * exactly one notification. Pure derivation here keeps the logic unit-testable;
 * DOM/bridge wiring lives in JumpRow.
 *
 * Wire shape (window-level event, same namespace as `injectComposer`, decoupled
 * from the bridge bundle — the bridge decides whether to forward to the host):
 *   { kind: 'dsh-file-jump:diffApplied', path, diffs: [{oldText, newText}], cwd, callId }
 */

import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'

/** Window-level event name the bridge inside this iframe listens for. */
export const DIFF_EVENT = 'dsh-file-jump:diffApplied'

/** One applied hunk: the before/after snippet pair the extension locates + reverts by. */
export interface AppliedDiff {
  oldText: string
  newText: string
}

/** The full notification payload carried on the window event. */
export interface DiffAppliedPayload {
  kind: typeof DIFF_EVENT
  /** Absolute (cwd-resolved) target path. */
  path: string
  /** Applied hunks; empty when the tool settled with no usable diff (write null). */
  diffs: AppliedDiff[]
  /** Session cwd (fallback resolution on the host side). */
  cwd?: string
  /** Stable tool-call identity — the dedupe key. */
  callId: string
}

/** One hunk from the wire `card:'diff'` view (oldText may be null for create/overwrite). */
interface DiffHunkLike {
  path?: unknown
  oldText?: unknown
  newText?: unknown
}

/** Narrow the wire `card: 'diff'` view's hunks to usable before/after pairs. */
function narrowDiffs(view: unknown): AppliedDiff[] {
  if (typeof view !== 'object' || view === null) return []
  const v = view as Record<string, unknown>
  if (v.card !== 'diff' || !Array.isArray(v.diffs)) return []
  const out: AppliedDiff[] = []
  for (const hunk of v.diffs) {
    if (typeof hunk !== 'object' || hunk === null) continue
    const { oldText, newText } = hunk as DiffHunkLike
    if (typeof newText !== 'string' || newText === '') continue
    // Create/overwrite (oldText null): no revert anchor, and whole-file writes
    // are better served by the open-file path — keep the tracker strictly
    // reversible by only notifying edits with a before-snippet.
    if (typeof oldText !== 'string' || oldText === '') continue
    out.push({ oldText, newText })
  }
  return out
}

/** Resolve a workspace-relative path into the Host-facing spelling (same rule as parse.ts). */
function resolveWorkspacePath(cwd: string | undefined, path: string): string {
  if (path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')) return path
  if (cwd === undefined || cwd === '') return path
  const base = cwd.replace(/[/\\]+$/, '')
  const rel = path.replace(/^[/\\]+/, '')
  return `${base}/${rel}`
}

/** Tool names whose blocks carry an applied diff. */
const MUTATION_TOOLS = new Set(['edit', 'write'])

/**
 * Extract the applied diffs from a tool block, or null when the block carries
 * no usable diff card.
 *
 * Deliberately lenient (mirrors parse.ts's editOldTextFrom): the diff may live
 * on the call view (intended change while running) or the result view (applied
 * hunks once settled). The extension re-locates the change by reading the file
 * and matching newText, so a running-card notification highlights once the file
 * has been written; settled resultView remains authoritative when present.
 */
export function extractAppliedDiffs(block: ToolCallBlock): AppliedDiff[] | null {
  if (!MUTATION_TOOLS.has(blockName(block))) return null
  const callView = 'callView' in block ? block.callView : undefined
  const resultView = 'resultView' in block ? block.resultView : undefined
  const callDiffs = narrowDiffs(callView)
  const diffs = callDiffs.length > 0 ? callDiffs : narrowDiffs(resultView)
  return diffs.length === 0 ? null : diffs
}

/** Tool name for a block: settled keeps it on `call`, running on the block itself. */
function blockName(block: ToolCallBlock): string {
  if ('kind' in block && block.kind === 'tool-result') return block.call?.name ?? ''
  return 'name' in block ? block.name : ''
}

/** Read the raw args envelope off a block (running uses live argsRaw; settled the persisted call head). */
function blockArgsRaw(block: ToolCallBlock): string | null | undefined {
  if ('argsRaw' in block) return block.argsRaw
  return block.call?.argsRaw
}

/** Read the file path off parsed args (file_path on write/edit, path on read). */
function filePathFromArgs(argsRaw: string | null | undefined): string | undefined {
  if (typeof argsRaw !== 'string' || argsRaw === '') return undefined
  try {
    const parsed = JSON.parse(argsRaw) as Record<string, unknown>
    for (const key of ['file_path', 'path'] as const) {
      const v = parsed[key]
      if (typeof v === 'string' && v !== '') return v
    }
  } catch {
    /* non-JSON args (mid-stream truncation) → no path */
  }
  return undefined
}

/** Derive the absolute path for a settled mutation block (same rule as parse.ts). */
export function diffTargetPath(cwd: string | undefined, block: ToolCallBlock): string | undefined {
  const filePath = filePathFromArgs(blockArgsRaw(block))
  if (filePath === undefined || filePath === '') return undefined
  return resolveWorkspacePath(cwd, filePath)
}

/**
 * Idempotent per-callId pending-diff picker: returns the notification payload
 * on first sight of a settled mutation, mutating `notified` so later renders of
 * the same call stay silent. Returns null when there is nothing new.
 */
export function takePendingDiff(
  cwd: string | undefined,
  block: ToolCallBlock,
  notified: Set<string>,
): DiffAppliedPayload | null {
  // RunningToolCall 与 ToolResultNode 都携带 callId，直接读取（union 共享字段）。
  const callId = block.callId
  if (callId === undefined || callId === '') return null
  if (notified.has(callId)) return null
  const diffs = extractAppliedDiffs(block)
  if (diffs === null) return null
  const path = diffTargetPath(cwd, block)
  if (path === undefined) return null
  notified.add(callId)
  return { kind: DIFF_EVENT, path, diffs, cwd, callId }
}
