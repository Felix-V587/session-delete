/**
 * 会话状态查询。
 *
 * `inspect` 是整个插件的判断中枢：右键菜单是否出现、删除请求是否被拒绝，
 * 都基于这里返回的概览。它同时把三个来源的信息合并成一份稳定的数据结构：
 * - 持久化层：会话是否落盘、格式状态、事件数、体积；
 * - 会话存储 / Agent 注册表：会话是否仍被当前进程持有（live）；
 * - 工作区注册表：会话是否处于归档状态。
 *
 * @module host/inspect
 */

import type { SessionSummary } from '../protocol.ts'
import type { HostContext } from './context.ts'

/**
 * 汇总一个会话的当前状态。
 *
 * @param ctx 宿主上下文
 * @param sessionId 已通过白名单校验的会话 id
 * @returns 会话概览；会话不存在时 `exists` 为 false，其余统计字段为 null
 */
export async function inspectSession(ctx: HostContext, sessionId: string): Promise<SessionSummary> {
  const snapshot = await ctx.sessionPersistence.stat(sessionId)

  return {
    id: sessionId,
    exists: snapshot !== undefined,
    // 只要仍被进程内的会话存储或 Agent 注册表持有，就视为活跃；活跃会话拒绝删除。
    live: ctx.sessions.get(sessionId) !== undefined || ctx.agents.get(sessionId) !== undefined,
    archived: ctx.workspaceRegistry.archivedSessionIds.includes(sessionId),
    formatStatus: snapshot?.formatStatus ?? null,
    eventCount: snapshot?.eventCount ?? null,
    sizeBytes: snapshot?.sizeBytes ?? null,
  }
}
