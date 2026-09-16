/**
 * Minimal tool row for the dsh-file-jump plugin: renders the file path as a
 * clickable link carrying the data attributes the bridge reads on click.
 *
 * This replaces the shipped read/edit/write rows (a keyed slot takeover). It
 * deliberately drops the full chrome (diff card, read card, expand, state
 * sweep) and focuses on the plugin's one job: file jump + precise line. The
 * visual is a compact path link so the conversation stays scannable.
 */

import { useEffect, useRef, type MouseEvent } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import {
  blockArgsRaw,
  editOldTextFrom,
  editNewTextFrom,
  filePathFromArgs,
  isErrorBlock,
  readOffsetFrom,
  resolveAbsPath,
} from './parse.ts'
import { takePendingDiff } from './diffNotify.ts'
import css from './jump.module.css'

type JumpRowProps = ToolCallViewProps & { openFile: (path: string) => void }

/** Tool names this plugin owns (wire names). */
const READ_TOOLS = new Set(['read'])
const EDIT_TOOLS = new Set(['edit'])

/** Open the file through the host; the bridge intercepts the click and uses data attrs. */
function openFileWithAttrs(e: MouseEvent<HTMLButtonElement>, path: string, openFile: (p: string) => void): void {
  e.stopPropagation()
  openFile(path)
}

/** One summary line: the tool name + the path (matching the shipped rows' title shape). */
function titleFor(toolName: string, displayPath: string): string {
  const verb = toolName === 'read' ? 'Read' : toolName === 'edit' ? 'Edit' : 'Write'
  return `${verb} · ${displayPath}`
}

/**
 * The jump row: a path link (title + path) that opens through the host.
 * - read: data-abs-path (cwd-resolved) + data-line (result offset, precise)
 * - edit: data-abs-path + data-old-text (extension locates the changed line)
 * - write: data-abs-path only (open, no line)
 *
 * Diff notification (A 组): each time a settled edit/write block first appears
 * in a render, notify the host via the bridge so the VS Code extension can
 * highlight the applied change in the editor. Dedupe by callId (stable across
 * re-renders), so one mutation → exactly one notification.
 */
export function JumpRow({ toolName, block, cwd, openFile }: JumpRowProps) {
  const argsRaw = blockArgsRaw(block)
  const filePath = filePathFromArgs(argsRaw)
  const absPath = resolveAbsPath(cwd, filePath)
  const isError = isErrorBlock(block)

  // A 组 diff 通知：settled mutation 首次渲染时向宿主广播 applied diff。
  // notifiedRef 跨渲染持久，callId 去重保证同一次修改只通知一次。
  const notifiedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const pending = takePendingDiff(cwd, block, notifiedRef.current)
    if (pending !== null) {
      // 调试探针：供浏览器验证 dispatch 是否发生（无需桥接）
      ;(window as unknown as Record<string, unknown>).__lastDiffDispatched = {
        path: pending.path,
        diffs: pending.diffs,
        callId: pending.callId,
        at: Date.now(),
      }
      window.dispatchEvent(
        new CustomEvent(pending.kind, { detail: pending }),
      )
    }
  }, [block, cwd])

  // Only render the jump affordance for a known file tool on a settled non-error call.
  if (filePath === undefined || isError) {
    // Keep a minimal row so the call is still visible in the flow.
    return <div className={css.plain}>{titleFor(toolName, filePath ?? '')}</div>
  }

  const oldText = EDIT_TOOLS.has(toolName) ? editOldTextFrom(block) : undefined
  const newText = EDIT_TOOLS.has(toolName) ? editNewTextFrom(block) : undefined
  const line = READ_TOOLS.has(toolName) ? readOffsetFrom(block) : undefined
  const display = titleFor(toolName, filePath)

  const dataAttrs: Record<string, string> = {}
  if (absPath !== undefined) dataAttrs['data-abs-path'] = absPath
  if (oldText !== undefined) dataAttrs['data-old-text'] = oldText
  // 改后片段：桥接/扩展用它做跳行兜底（改前片段落盘后已不在文件里）
  if (newText !== undefined) dataAttrs['data-new-text'] = newText
  if (line !== undefined) dataAttrs['data-line'] = String(line)

  return (
    <button
      type="button"
      className={css.fileLink}
      {...dataAttrs}
      onClick={(e) => openFileWithAttrs(e, absPath ?? filePath, openFile)}
      title={display}
    >
      {display}
    </button>
  )
}
