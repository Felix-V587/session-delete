/**
 * 宿主 HTTP 接口的客户端封装。
 *
 * 客户端不直接操作文件系统，所有变更都必须经过宿主的认证路由；这里负责：
 * - 拼接请求地址（相对 `document.baseURI` 解析，兼容反向代理子路径）；
 * - 把状态响应解析成稳定的 `SessionSummary`；
 * - 把删除响应翻译成“成功 + 告警”或“本地化错误文案”。
 *
 * @module client/api
 */

import { API_ROOT, isRecord, parseStatusPayload, type SessionSummary } from '../protocol.ts'
import type { Translator } from './i18n.ts'

/** 失败码 → 本地化键；未知失败码由调用方回退到 message 或 error.unknown。 */
export const FAILURE_KEYS: Readonly<Record<string, string>> = {
  'live': 'error.live',
  'not-found': 'error.notFound',
  'not-materialized': 'error.notMaterialized',
  'unsupported-format': 'error.unsupportedFormat',
  'filesystem-error': 'error.filesystem',
  'claim-failed': 'error.filesystem',
  'body-too-large': 'error.unknown',
  'invalid-session-id': 'error.unknown',
}

/**
 * 把路由路径拼成绝对地址。
 *
 * @param path 相对 API_ROOT 的路径，例如 `status?sessionId=…`
 * @param base 解析基准，默认取 `document.baseURI`
 */
export function apiUrl(path: string, base: string = document.baseURI): string {
  return new URL(API_ROOT + path, base).href
}

/**
 * 查询会话概览。
 *
 * 任何异常（网络错误、非 2xx、结构不符、请求被中止）都返回 null，
 * 调用方据此选择“不展示入口”，而不是把错误抛到菜单渲染流程里。
 *
 * @param sessionId 会话 id
 * @param signal 目标变化时的中止信号
 */
export async function fetchStatus(sessionId: string, signal?: AbortSignal): Promise<SessionSummary | null> {
  try {
    const response = await fetch(apiUrl(`status?sessionId=${encodeURIComponent(sessionId)}`), {
      credentials: 'include',
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return null

    const payload: unknown = await response.json()
    const status = parseStatusPayload(payload)
    if (status === null || status.ok !== true) return null
    return status.session
  } catch {
    return null
  }
}

/** 删除请求的原始返回：HTTP 响应 + 已解析（可能为 null）的响应体。 */
export interface DeleteRequestResult {
  readonly response: Response
  readonly payload: unknown
}

/**
 * 发起删除请求。
 *
 * 这里不判断成败，交给 {@link interpretDeleteResult} 统一解释，
 * 这样“HTTP 失败但响应体是错误 JSON”的情况也能拿到 code。
 *
 * @param sessionId 会话 id
 */
export async function requestDelete(sessionId: string): Promise<DeleteRequestResult> {
  const response = await fetch(apiUrl('delete'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  return { response, payload }
}

/** 删除结果解释：成功时带告警列表，失败时带可直接展示的本地化文案。 */
export type DeleteInterpretation =
  | { readonly ok: true; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly message: string }

/**
 * 把删除响应翻译成界面可直接使用的结论。
 *
 * 规则与宿主契约一致：
 * - 只有 `HTTP 2xx` 且响应体 `ok === true` 才算成功；
 * - 失败时优先按 `code` 查本地化文案，其次使用宿主给的 `message`，
 *   最后回退到通用文案——确保任何情况下对话框里都有可读信息。
 *
 * @param responseOk HTTP 响应是否成功
 * @param payload 已解析的响应体（可能为 null）
 * @param t 翻译函数
 */
export function interpretDeleteResult(
  responseOk: boolean,
  payload: unknown,
  t: Translator,
): DeleteInterpretation {
  const record = isRecord(payload) ? payload : null

  if (responseOk && record !== null && record.ok === true) {
    const rawWarnings = record.warnings
    const warnings = Array.isArray(rawWarnings)
      ? rawWarnings.filter((item): item is string => typeof item === 'string')
      : []
    return { ok: true, warnings }
  }

  const code = record !== null && typeof record.code === 'string' ? record.code : ''
  const key = FAILURE_KEYS[code]
  const message =
    key !== undefined
      ? t(key)
      : record !== null && typeof record.message === 'string' && record.message.length > 0
        ? record.message
        : t('error.unknown')

  return { ok: false, message }
}
