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
import { installComposerInjection } from './composerInject.ts'
import { registerReplayDock } from './ReplayDock.tsx'
import { registerSessionPulse } from './SessionPulse.tsx'
import { installCheckpointBridge } from './checkpointBridge.ts'

/** Required service: slots for the toolview keyed-slot takeover. */
export const inject = ['slots']

/** Register one keyed toolview entry (a keyed hit replaces the shipped row). */
function registerToolview(ctx: ClientContext, key: 'read' | 'edit' | 'write'): void {
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key, priority: OVERRIDE_PRIORITY }, JumpRow))
}

// ui-tool 内部已用默认 priority 0 注册 read/edit/write 原生行；keyed slot 的
// winner 是 priority 最低者（lowest renders），同 key 同 priority 会直接 throw。
// 因此覆盖必须用更低的负 priority（DSH 惯例 ui-subagent 用 -10）。
const OVERRIDE_PRIORITY = -10

/** Apply the browser half: register the three toolviews once the slots service is up. */
export function apply(ctx: ClientContext): void {
  ctx.inject(['slots'], (scope) => {
    registerToolview(scope, 'read')
    registerToolview(scope, 'edit')
    registerToolview(scope, 'write')
    // F1：输入区 dock 上的无头回放入口（会话快照 → 重播 applied diff → 账本跨 Reload 存活）
    registerReplayDock(scope)
    // F6/F7：会话脉冲（pending 审批转发 + 会话状态上行）——另一个无头 dock 条目，
    // 与回放分开：回放坏了只是丢高亮，脉冲坏了是"用户盯着一个不会回答的模态框"，故障要能各自定位
    registerSessionPulse(scope)
  })
  // "Add to DSH" 下行注入：把 VS Code 右键发来的文件引用写入当前会话 composer。
  installComposerInjection(ctx)
  // F9：检查点恢复走廊（扩展下发预览/应用 → 本插件调 /turn-rewind → 回执上行）。
  // 放在浏览器半边的理由：该端点是 DSH web 的**同源**路由，扩展宿主没有会话可达它。
  installCheckpointBridge()
}
