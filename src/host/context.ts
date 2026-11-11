/**
 * 宿主半的最小服务契约。
 *
 * 这些接口是“手写”的 DSH 运行时契约，而非从 `@deepseek-ai/*` 私有类型包导入：
 * 私有包版本锁定严格、peer 依赖复杂，对一个本地插件来说成本过高。这里只声明
 * 本插件真正用到的成员，字段名与语义对齐 DSH 0.2.2-rc.1 运行时；升级 DSH 后
 * 若契约变化，编译器会在调用点直接报错，便于快速修正。
 *
 * @module host/context
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { SessionFormatStatus } from '../protocol.ts'

/** DSH 的 effect 清理函数：插件卸载或依赖变化时由宿主调用。 */
export type EffectDisposer = () => void

/** 宿主 Web 服务器上的一条路由声明。 */
export interface WebRoute {
  /** `prefix` 表示按路径前缀匹配。 */
  readonly kind: 'exact' | 'prefix'
  /** 绝对路径，不含结尾斜杠。 */
  readonly path: string
  /** 请求处理器；可以直接返回 Promise。 */
  handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>
}

/** Web 服务器服务（宿主注入）。 */
export interface WebServerService {
  /**
   * 注册路由。
   *
   * @returns 注销该路由的 disposer
   */
  register(route: WebRoute): EffectDisposer
}

/** 连接信任检查的请求视图（只用到请求头）。 */
export interface ConnectionTrustRequest {
  readonly headers: IncomingMessage['headers']
}

/** 连接层拒绝码：401（未认证）或 403（无权限）。 */
export type ConnectionRequestRejection = 401 | 403 | undefined

/** 连接/认证服务（宿主注入）。 */
export interface ConnectionService {
  /**
   * 判断请求是否应被连接层拒绝。
   *
   * @returns 拒绝码；通过检查时返回 undefined
   */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection
}

/** 会话存储：这里只关心“该会话是否仍被进程持有”。 */
export interface SessionStoreService {
  get(sessionId: string): unknown
}

/** Agent 注册表：同样只关心“该会话是否仍被进程持有”。 */
export interface AgentRegistryService {
  get(sessionId: string): unknown
}

/** 持久化层报告的会话日志位置。 */
export interface SessionLocation {
  /** 位置类型（目录、文件等，由持久化层定义）。 */
  readonly kind: string
  /** 日志文件的绝对路径。 */
  readonly path: string
}

/** 持久化层的会话快照（只声明本插件使用到的字段）。 */
export interface SessionPersistenceSnapshot {
  /** 会话头信息（本插件不读取具体字段）。 */
  readonly header: unknown
  /** 日志格式状态；持久化层未报告时缺省。 */
  readonly formatStatus?: SessionFormatStatus
  /** 修订号。 */
  readonly revision: number
  /** 事件条数；未知时缺省。 */
  readonly eventCount?: number
  /** 日志体积（字节）；未知时缺省。 */
  readonly sizeBytes?: number
  /** 日志位置；尚未落盘时缺省。 */
  readonly location?: SessionLocation
}

/**
 * 已打开的会话句柄。
 *
 * 以 `write` 方式打开时，持久化层会原子地抢占单写锁；`close` 释放该锁。
 */
export interface SessionHandle {
  close(): Promise<void>
}

/** 会话持久化服务（宿主注入）。 */
export interface SessionPersistenceService {
  /**
   * 读取会话快照。
   *
   * @returns 会话不存在时返回 undefined
   */
  stat(sessionId: string): Promise<SessionPersistenceSnapshot | undefined>

  /**
   * 以指定模式打开会话。
   *
   * `write` 模式会在失败时抛出以下（按 `error.name` 识别）错误：
   * - `SessionPersistenceNotFoundError`：会话不存在；
   * - `SessionAlreadyOwnedError`：已有其他写入者持有写锁；
   * - `SessionFormatUnsupportedError`：历史日志格式不支持安全删除。
   */
  open(sessionId: string, access: 'read' | 'write'): Promise<SessionHandle>
}

/** 工作区实体（只声明分组相关的成员）。 */
export interface WorkspaceEntity {
  /** 该工作区分组包含的会话 id。 */
  readonly sessionIds: readonly string[]
  /** 把会话从该工作区分组中移除。 */
  detachSession(sessionId: string): Promise<void>
}

/** 工作区注册表（宿主注入）。 */
export interface WorkspaceRegistryService {
  /** 当前处于归档状态的会话 id 列表。 */
  readonly archivedSessionIds: readonly string[]
  /** 列出全部工作区实体。 */
  list(): readonly WorkspaceEntity[]
  /** 取消归档标记。 */
  unarchiveSession(sessionId: string): Promise<void>
  /** 取消置顶标记。 */
  unpinSession(sessionId: string): Promise<void>
}

/** 键值表（只声明删除操作）。 */
export interface KeyValueTable {
  /**
   * 删除一条记录。
   *
   * @returns 记录原先存在时返回 true
   */
  delete(key: string): Promise<boolean>
}

/** 存储域实例。 */
export interface StorageDomain {
  /**
   * 获取键值表。
   *
   * 注意：DSH 类型上未声明的表会在调用时抛错，这里仍按“可能返回 undefined”
   * 声明，以匹配原实现的防御式写法。
   */
  table(name: string): KeyValueTable | undefined
}

/** 存储域注册表（宿主注入）。 */
export interface StorageDomainService {
  get(name: string): StorageDomain | undefined
}

/** 定时任务的投递目标。 */
export type ScheduleTarget =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'new_once'; readonly sessionId: string; readonly create: unknown }
  | { readonly kind: 'new'; readonly create: unknown }

/** 定时任务目录项（只声明本插件使用到的字段）。 */
export interface ScheduleCatalogEntry {
  /** 定时任务 id。 */
  readonly id: string
  /** 投递目标。 */
  readonly target: ScheduleTarget
}

/** 删除定时任务的请求。 */
export interface ScheduleDeleteRequest {
  readonly id: string
  readonly action: 'delete'
}

/** 定时任务服务（宿主注入）。 */
export interface ScheduleService {
  /** 列出全部定时任务。 */
  catalog(): Promise<readonly ScheduleCatalogEntry[]>
  /** 修改（这里是删除）定时任务。 */
  edit(request: ScheduleDeleteRequest): Promise<unknown>
}

/**
 * 宿主注入给插件的上下文。
 *
 * 只需要声明本插件实际使用的服务与 `effect`；DSH 会按 `inject` 列表等待这些
 * 服务就绪后再调用 `apply`。
 */
export interface HostContext {
  readonly webServer: WebServerService
  readonly connection: ConnectionService
  readonly sessions: SessionStoreService
  readonly agents: AgentRegistryService
  readonly sessionPersistence: SessionPersistenceService
  readonly workspaceRegistry: WorkspaceRegistryService
  readonly storageDomain: StorageDomainService
  /** 定时任务服务；宿主未提供时允许缺省（此时跳过定时任务清理）。 */
  readonly schedule?: ScheduleService
  /**
   * 注册一个副作用，并返回其清理逻辑。
   *
   * @param run 执行副作用的回调，可返回 disposer
   * @param label 用于诊断的中文标签
   */
  effect(run: () => void | EffectDisposer, label?: string): void
}
