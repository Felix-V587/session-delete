/**
 * 宿主半的 HTTP 工具：JSON 请求体读取与 JSON 响应写出。
 *
 * @module host/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { BODY_LIMIT } from '../protocol.ts'

/** 请求体超过 {@link BODY_LIMIT} 时抛出的错误。 */
export class RequestBodyTooLargeError extends Error {
  /** 稳定错误码，路由层据此返回 413。 */
  readonly code = 'body-too-large'

  constructor(limit: number) {
    super(`request body too large: limit ${limit} bytes`)
    this.name = 'RequestBodyTooLargeError'
  }
}

/**
 * 判断错误是否为“请求体过大”。
 *
 * 同时兼容类实例与带 `code` 字段的普通对象，避免跨模块实例问题。
 *
 * @param error 任意抛出值
 */
export function isRequestBodyTooLargeError(error: unknown): boolean {
  if (error instanceof RequestBodyTooLargeError) return true
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'body-too-large'
  )
}

/**
 * 读取并解析 JSON 请求体。
 *
 * - 空请求体返回 `{}`；
 * - 超过 {@link BODY_LIMIT} 抛 {@link RequestBodyTooLargeError}；
 * - JSON 语法错误会原样抛出 `SyntaxError`，由路由层映射为 400 `bad-json`。
 *
 * @param request Node HTTP 请求
 */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.length
    if (total > BODY_LIMIT) {
      throw new RequestBodyTooLargeError(BODY_LIMIT)
    }
    chunks.push(buffer)
  }

  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/**
 * 写出 JSON 响应。
 *
 * 统一带上 `no-store`，避免浏览器或中间层缓存“会话是否活跃 / 是否已删除”这类
 * 强时效性结果。
 *
 * @param response Node HTTP 响应
 * @param status HTTP 状态码
 * @param payload 可被 JSON 序列化的响应体
 */
export function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}
