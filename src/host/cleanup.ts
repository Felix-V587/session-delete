/**
 * 删除会话后的元数据清理。
 *
 * 日志文件删除成功后，会话在以下位置可能仍有“残留引用”：
 * 归档标记、置顶标记、工作区分组、投影缓存、投递到该会话的定时任务。
 * 这些清理全部是 best-effort：任何一步失败都只记录告警，不回滚、不阻塞删除结果。
 * 这样做的理由是——日志已经删除，会话本身已不可用，残留元数据最多造成界面噪声，
 * 而回滚在物理删除之后并不可行。
 *
 * @module host/cleanup
 */

import type { HostContext } from './context.ts'
import { errorMessage } from './util.ts'

/** 元数据清理结果。 */
export interface CleanupResult {
  /** 非致命告警，每条以“步骤名：原因”的形式呈现。 */
  readonly warnings: string[]
}

/**
 * 清理会话的关联元数据。
 *
 * @param ctx 宿主上下文
 * @param sessionId 已删除的会话 id
 * @returns 清理过程中产生的告警
 */
export async function cleanupMetadata(ctx: HostContext, sessionId: string): Promise<CleanupResult> {
  const warnings: string[] = []

  /**
   * 执行一个 best-effort 清理步骤，失败时收集中文告警。
   *
   * @param label 中文步骤名
   * @param run 实际清理动作
   */
  const attempt = async (label: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run()
    } catch (error) {
      warnings.push(`${label}：${errorMessage(error)}`)
    }
  }

  // 1) 归档标记：清除后会话不会再出现在“已归档”分组。
  await attempt('清理归档标记', () => ctx.workspaceRegistry.unarchiveSession(sessionId))

  // 2) 置顶标记。
  await attempt('清理置顶标记', () => ctx.workspaceRegistry.unpinSession(sessionId))

  // 3) 工作区分组：会话可能同时属于多个分组，需要逐个摘除。
  await attempt('清理工作区分组', async () => {
    for (const workspace of ctx.workspaceRegistry.list()) {
      if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
        await workspace.detachSession(sessionId)
      }
    }
  })

  // 4) 投影缓存：会话列表的投影结果，不清会残留“幽灵条目”。
  await attempt('清理投影缓存', async () => {
    const domain = ctx.storageDomain.get('session_projcache')
    if (domain === undefined) return
    const table = domain.table('sessions')
    if (table === undefined) return
    await table.delete(sessionId)
  })

  // 5) 定时任务：只删除“投递目标正是该会话”的任务；新建会话类任务不动。
  await attempt('清理定时任务', async () => {
    const schedule = ctx.schedule
    if (schedule === undefined) return
    for (const entry of await schedule.catalog()) {
      const target = entry.target
      if (target.kind === 'session' && target.sessionId === sessionId) {
        await schedule.edit({ id: entry.id, action: 'delete' })
      }
    }
  })

  return { warnings }
}
