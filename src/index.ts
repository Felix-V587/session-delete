/**
 * Session Delete —— 宿主半入口。
 *
 * 本文件由 DSH 以 Node ESM 方式加载（package.json `exports["."]` 指向构建后的
 * `lib/index.js`）。插件只做一件事：把 `/session-delete/api` 前缀路由注册到宿主
 * Web 服务器上；真正的删除逻辑在 `host/delete-session.ts`。
 *
 * 安全边界：
 * - 所有请求先经过 DSH 连接层的 `requestRejection`，未认证请求不会到达业务逻辑；
 * - 会话 id 必须通过白名单校验，避免路径穿越与超长输入；
 * - 只有“存在且不在当前进程内活跃”的冷会话才允许删除。
 *
 * @module @local/session-delete
 */

import type { HostContext } from './host/context.ts'
import { registerRoutes } from './host/routes.ts'

/** 插件 id（同时作为 cordis 服务名）。 */
export const name = 'session-delete'

/**
 * 依赖的宿主服务。
 *
 * DSH 会等到这些服务全部就绪后才调用 {@link apply}；顺序不影响使用。
 * `schedule` 允许在运行时缺省（清理定时任务时会跳过）。
 */
export const inject: readonly string[] = [
  'webServer',
  'connection',
  'sessions',
  'sessionPersistence',
  'agents',
  'workspaceRegistry',
  'storageDomain',
  'schedule',
]

/**
 * 激活插件：注册宿主路由。
 *
 * `ctx.effect` 返回的 disposer 由 DSH 在插件卸载或热重载时调用，用于注销路由。
 *
 * @param ctx 宿主上下文
 */
export function apply(ctx: HostContext): void {
  ctx.effect(() => registerRoutes(ctx), 'session-delete: 宿主路由')
}
