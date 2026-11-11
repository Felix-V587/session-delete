/**
 * 宿主半的路由分发。
 *
 * 接口一览（前缀 `/session-delete/api`）：
 * - `GET  /status?sessionId=…`：查询会话概览，供右键菜单判断是否展示入口；
 * - `POST /delete`：请求体 `{ "sessionId": "…" }`，永久删除冷会话。
 *
 * 所有响应都是 JSON，且带 `no-store`。错误统一为
 * `{ ok: false, code, message?, warnings? }`。
 *
 * @module host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { ROUTE_PREFIX, isRecord, isValidSessionId } from '../protocol.ts'
import type { HostContext } from './context.ts'
import { deleteSession } from './delete-session.ts'
import { inspectSession } from './inspect.ts'
import { isRequestBodyTooLargeError, readJsonBody, writeJson } from './http.ts'
import { errorMessage } from './util.ts'

/**
 * 把路由注册到宿主 Web 服务器。
 *
 * @param ctx 宿主上下文
 * @returns 注销路由的 disposer
 */
export function registerRoutes(ctx: HostContext): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (request, response) => routeRequest(ctx, request, response),
  })
}

/**
 * 处理一次请求。
 *
 * 该函数被刻意导出，方便测试直接挂在临时 HTTP 服务器上验证完整行为，
 * 而不必启动整个 DSH 宿主。
 *
 * @param ctx 宿主上下文
 * @param request Node HTTP 请求
 * @param response Node HTTP 响应
 */
export async function routeRequest(
  ctx: HostContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    // 1) 连接层信任检查：由 DSH 的认证体系决定请求是否可信。
    const rejection = ctx.connection.requestRejection(request)
    if (rejection !== undefined) {
      writeJson(response, rejection, {
        ok: false,
        code: rejection === 401 ? 'unauthorized' : 'forbidden',
      })
      return
    }

    // 2) 解析 URL；失败说明请求行本身非法。
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://dsh.internal')
    } catch {
      writeJson(response, 400, { ok: false, code: 'bad-request' })
      return
    }

    const method = request.method ?? 'GET'
    // 去掉前缀与结尾斜杠，得到 `/status`、`/delete` 这样的路由名。
    const routePath = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'

    // ---- GET /status -----------------------------------------------------
    if (method === 'GET' && routePath === '/status') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (!isValidSessionId(sessionId)) {
        writeJson(response, 400, { ok: false, code: 'invalid-session-id' })
        return
      }
      const session = await inspectSession(ctx, sessionId)
      writeJson(response, 200, { ok: true, session })
      return
    }

    // ---- POST /delete ----------------------------------------------------
    if (method === 'POST' && routePath === '/delete') {
      let body: unknown
      try {
        body = await readJsonBody(request)
      } catch (error) {
        const tooLarge = isRequestBodyTooLargeError(error)
        writeJson(response, tooLarge ? 413 : 400, {
          ok: false,
          code: tooLarge ? 'body-too-large' : 'bad-json',
        })
        return
      }

      const sessionId = isRecord(body) && typeof body.sessionId === 'string' ? body.sessionId : ''
      if (!isValidSessionId(sessionId)) {
        writeJson(response, 400, { ok: false, code: 'invalid-session-id' })
        return
      }

      const outcome = await deleteSession(ctx, sessionId)
      writeJson(response, outcome.status, outcome.payload)
      return
    }

    // ---- 其它路径 --------------------------------------------------------
    writeJson(response, 404, { ok: false, code: 'not-found' })
  } catch (error) {
    // 兜底：任何未预期异常都转成 500，避免连接悬挂。
    writeJson(response, 500, { ok: false, code: 'internal-error', message: errorMessage(error) })
  }
}
