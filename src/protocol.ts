/**
 * 协议模块：宿主半与客户端半共享的常量、数据结构与运行时校验。
 *
 * 设计约束：
 * - 本文件会被打进客户端 bundle，因此必须是“浏览器安全”的：不得 import 任何 `node:*` 模块；
 * - 字段名与 DSH 0.2.2-rc.1 的 HTTP 契约保持一致，任意一端改动都必须同步兼容另一端；
 * - 所有校验函数的入参都是 `unknown`：来自网络的 JSON 必须先过校验，再进入业务逻辑。
 *
 * @module protocol
 */

/** 宿主注册的前缀路由：所有会话删除相关接口都挂在这个前缀下。 */
export const ROUTE_PREFIX = '/session-delete/api'

/**
 * 客户端拼接请求地址时使用的相对前缀。
 * 从 {@link ROUTE_PREFIX} 派生，避免两端常量漂移；相对 `document.baseURI` 解析，
 * 因此即使 DSH Web 部署在反向代理子路径下也能正确请求。
 */
export const API_ROOT = `${ROUTE_PREFIX.replace(/^\//, '')}/`

/** 请求体上限（字节）。超过后宿主返回 413 `body-too-large`。 */
export const BODY_LIMIT = 8 * 1024

/** 会话 id 白名单：字母、数字、点、下划线、连字符，长度 1～160。 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/

/**
 * 判断一个值是否为合法的会话 id。
 *
 * 该白名单同时用于“查询参数”和“请求体”两条入口，防止 `../` 之类的路径片段
 * 或超长字符串进入持久化层。
 *
 * @param value 待校验的值
 * @returns 是合法会话 id 时返回 true，并收窄类型为 string
 */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/** 持久化层报告的日志格式状态。 */
export type SessionFormatStatus = 'current' | 'migration-required'

/**
 * 会话概览：状态查询接口的返回体，也是右键菜单决定是否展示“删除”入口的依据。
 */
export interface SessionSummary {
  /** 会话 id。 */
  readonly id: string
  /** 持久化层是否存在该会话（存在文件或元数据）。 */
  readonly exists: boolean
  /** 是否仍活着（被当前进程的 SessionStore 或 AgentRegistry 持有）。 */
  readonly live: boolean
  /** 是否处于归档状态。 */
  readonly archived: boolean
  /** 日志格式状态；持久化层未报告时为 null。 */
  readonly formatStatus: SessionFormatStatus | null
  /** 事件条数；未知时为 null。 */
  readonly eventCount: number | null
  /** 日志体积（字节）；未知时为 null。 */
  readonly sizeBytes: number | null
}

/** 删除成功后回显的会话摘要，用于客户端提示与审计。 */
export interface DeletedSessionSummary {
  /** 被删除的会话 id。 */
  readonly sessionId: string
  /** 删除前是否处于归档状态。 */
  readonly archived: boolean
  /** 删除前的事件条数；未知时为 null。 */
  readonly eventCount: number | null
  /** 删除前的日志体积（字节）；未知时为 null。 */
  readonly sizeBytes: number | null
}

/** 已知的失败码，仅用于文档与类型提示；运行时允许出现未知码。 */
export type KnownFailureCode =
  | 'unauthorized'
  | 'forbidden'
  | 'bad-request'
  | 'bad-json'
  | 'body-too-large'
  | 'invalid-session-id'
  | 'not-found'
  | 'live'
  | 'unsupported-format'
  | 'claim-failed'
  | 'filesystem-error'
  | 'internal-error'

/**
 * 失败响应体。
 *
 * `code` 刻意声明为宽松的 `string`：宿主未来新增失败码时，旧客户端仍应能
 * 回退到 `message` 或通用文案，而不是整体解析失败。
 */
export interface FailurePayload {
  readonly ok: false
  readonly code: string
  /** 面向开发者的细节；客户端优先按 code 映射本地化文案。 */
  readonly message?: string
  /** 删除流程中的非致命告警（例如清理归档标记失败）。 */
  readonly warnings?: readonly string[]
}

/** `GET /status` 成功响应。 */
export interface StatusSuccessPayload {
  readonly ok: true
  readonly session: SessionSummary
}

/** `POST /delete` 成功响应。 */
export interface DeleteSuccessPayload {
  readonly ok: true
  readonly deleted: DeletedSessionSummary
  /** 删除完成但清理步骤有问题的提示；为空数组表示一切正常。 */
  readonly warnings: readonly string[]
}

/** `GET /status` 的完整响应体。 */
export type StatusPayload = StatusSuccessPayload | FailurePayload

/** `POST /delete` 的完整响应体。 */
export type DeletePayload = DeleteSuccessPayload | FailurePayload

/** 判断值是否为普通对象（排除 null、数组、函数）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断值是否为“数字或 null”（有限数字才接受）。 */
function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/** 判断值是否为合法的格式状态（或 null）。 */
function isFormatStatus(value: unknown): value is SessionFormatStatus | null {
  return value === null || value === 'current' || value === 'migration-required'
}

/** 解析会话概览；结构不符时返回 null。 */
export function parseSessionSummary(value: unknown): SessionSummary | null {
  if (!isRecord(value)) return null

  const { id, exists, live, archived, formatStatus, eventCount, sizeBytes } = value
  if (typeof id !== 'string') return null
  if (typeof exists !== 'boolean') return null
  if (typeof live !== 'boolean') return null
  if (typeof archived !== 'boolean') return null
  if (!isFormatStatus(formatStatus)) return null
  if (!isNullableFiniteNumber(eventCount)) return null
  if (!isNullableFiniteNumber(sizeBytes)) return null

  return { id, exists, live, archived, formatStatus, eventCount, sizeBytes }
}

/** 解析失败响应体；结构不符时返回 null。 */
export function parseFailurePayload(value: unknown): FailurePayload | null {
  if (!isRecord(value)) return null
  if (value.ok !== false) return null

  const { code, message, warnings } = value
  if (typeof code !== 'string' || code.length === 0) return null
  if (message !== undefined && typeof message !== 'string') return null
  if (warnings !== undefined && (!Array.isArray(warnings) || !warnings.every((item) => typeof item === 'string'))) {
    return null
  }

  return {
    ok: false,
    code,
    ...(message === undefined ? {} : { message }),
    ...(warnings === undefined ? {} : { warnings }),
  }
}

/** 解析删除成功响应体；结构不符时返回 null。 */
function parseDeleteSuccessPayload(value: unknown): DeleteSuccessPayload | null {
  if (!isRecord(value)) return null
  if (value.ok !== true) return null

  const deleted = value.deleted
  if (!isRecord(deleted)) return null
  const { sessionId, archived, eventCount, sizeBytes } = deleted
  if (typeof sessionId !== 'string') return null
  if (typeof archived !== 'boolean') return null
  if (!isNullableFiniteNumber(eventCount)) return null
  if (!isNullableFiniteNumber(sizeBytes)) return null

  const rawWarnings = value.warnings
  const warnings = Array.isArray(rawWarnings) ? rawWarnings.filter((item): item is string => typeof item === 'string') : []

  return { ok: true, deleted: { sessionId, archived, eventCount, sizeBytes }, warnings }
}

/** 解析 `GET /status` 响应体；结构不符时返回 null（调用方应回退到“不展示入口”）。 */
export function parseStatusPayload(value: unknown): StatusPayload | null {
  const failure = parseFailurePayload(value)
  if (failure !== null) return failure

  if (isRecord(value) && value.ok === true) {
    const session = parseSessionSummary(value.session)
    return session === null ? null : { ok: true, session }
  }

  return null
}

/** 解析 `POST /delete` 响应体；结构不符时返回 null。 */
export function parseDeletePayload(value: unknown): DeletePayload | null {
  return parseFailurePayload(value) ?? parseDeleteSuccessPayload(value)
}
