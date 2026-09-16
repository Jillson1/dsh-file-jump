/**
 * Pure derivation for the dsh-file-jump row: pull the file path, the edit
 * old-text, and the read line offset off a frozen tool call, then build the
 * data attributes the bridge reads on click. Kept free of React/DOM (and of
 * the runtime client bundle) so the logic is unit-testable.
 */

import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'

/** The args we care about, read off the raw JSON envelope (edit uses file_path, read/write use file_path too). */
const PATH_KEYS = ['file_path', 'path'] as const

/** One file diff from a diff-card view (oldText may be null for create/overwrite). */
interface DiffHunkLike {
  path?: unknown
  oldText?: unknown
  newText?: unknown
}

/**
 * Resolve a workspace-relative path into the Host-facing spelling (same rule
 * as DSH's resolveWorkspacePath): an absolute / Windows / UNC path passes
 * through; a relative path joins onto the session cwd.
 */
function resolveWorkspacePath(cwd: string | undefined, path: string): string {
  if (path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')) return path
  if (cwd === undefined || cwd === '') return path
  const base = cwd.replace(/[/\\]+$/, '')
  const rel = path.replace(/^[/\\]+/, '')
  return `${base}/${rel}`
}

/** Narrow the wire `card: 'diff'` view's diffs to the first usable hunk. */
function firstDiffHunk(view: unknown): DiffHunkLike | null {
  if (typeof view !== 'object' || view === null) return null
  const v = view as Record<string, unknown>
  if (v.card !== 'diff' || !Array.isArray(v.diffs)) return null
  const first = v.diffs[0]
  return typeof first === 'object' && first !== null ? first as DiffHunkLike : null
}

/** Parse a raw JSON args envelope; non-JSON (mid-stream truncation) yields null. */
function parseArgs(argsRaw: string | null | undefined): Record<string, unknown> | null {
  if (typeof argsRaw !== 'string' || argsRaw === '') return null
  try {
    const parsed = JSON.parse(argsRaw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Read the file path off parsed args (file_path on write/edit, path on read). */
export function filePathFromArgs(argsRaw: string | null | undefined): string | undefined {
  const args = parseArgs(argsRaw)
  if (args === null) return undefined
  for (const key of PATH_KEYS) {
    const v = args[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

/** Resolve the click target: absolute path when cwd is known, else the raw path. */
export function resolveAbsPath(cwd: string | undefined, path: string | undefined): string | undefined {
  if (path === undefined || path === '') return undefined
  return resolveWorkspacePath(cwd, path)
}

/**
 * Edit old-text (the before-snippet the extension uses to locate the changed
 * line): taken from the call-time diff view's first hunk. write/create carry
 * oldText null (no reliable line), so this returns undefined for them.
 */
export function editOldTextFrom(block: ToolCallBlock): string | undefined {
  const callView = 'callView' in block ? block.callView : undefined
  const resultView = 'resultView' in block ? block.resultView : undefined
  const hunk = firstDiffHunk(callView) ?? firstDiffHunk(resultView)
  if (hunk === null) return undefined
  return typeof hunk.oldText === 'string' && hunk.oldText !== '' ? hunk.oldText : undefined
}

/**
 * Edit new-text (the after-snippet): taken from the call-time diff view's first hunk.
 * Used as the jump fallback — once the edit is applied the before-snippet is gone
 * from the file, so the extension locates the line by this after-snippet instead.
 */
export function editNewTextFrom(block: ToolCallBlock): string | undefined {
  const callView = 'callView' in block ? block.callView : undefined
  const resultView = 'resultView' in block ? block.resultView : undefined
  const hunk = firstDiffHunk(callView) ?? firstDiffHunk(resultView)
  if (hunk === null) return undefined
  return typeof hunk.newText === 'string' && hunk.newText !== '' ? hunk.newText : undefined
}

/**
 * Read line offset (1-based first line shown), for read result cards: the
 * read tool already persists `offset`, so we pass it through directly.
 */
export function readOffsetFrom(block: ToolCallBlock): number | undefined {
  const result = 'resultView' in block ? block.resultView : undefined
  if (typeof result !== 'object' || result === null) return undefined
  const r = result as unknown as Record<string, unknown>
  if (r.card !== 'read') return undefined
  return typeof r.offset === 'number' && Number.isFinite(r.offset) && r.offset >= 1 ? r.offset : undefined
}

/** True when the settled call is an error (no path link affordance). */
export function isErrorBlock(block: ToolCallBlock): boolean {
  return 'isError' in block ? block.isError === true : false
}

/** The block's raw args (running uses the live argsRaw; settled the persisted call head). */
export function blockArgsRaw(block: ToolCallBlock): string | null | undefined {
  if ('argsRaw' in block) return block.argsRaw
  return block.call?.argsRaw
}
