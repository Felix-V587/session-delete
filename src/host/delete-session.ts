/**
 * 会话物理删除主流程。
 *
 * 这是插件的核心逻辑，顺序不能随意调整：
 *   1. 先 inspect，拒绝“不存在”和“仍活跃”的会话；
 *   2. 以 `write` 模式打开会话，原子抢占单写锁；拿不到锁就说明有别的写入者，
 *      此时删除不安全，直接拒绝；
 *   3. 持锁期间删除日志文件，再删除会话目录；
 *   4. 释放写锁；
 *   5. 清理关联元数据；
 *   6. 复核持久化层是否仍报告该会话；
 *   7. 返回删除摘要与告警。
 *
 * 为什么先删日志、后删目录：如果进程在中途崩溃，留下的“空目录”会被会话扫描器
 * 跳过；而先删目录再删日志，则可能留下悬空的 generation log。目录删除仍在写锁
 * 持有期间进行，避免其他写入者在此期间追加新日志。
 *
 * @module host/delete-session
 */

import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { DeletePayload } from '../protocol.ts'
import { cleanupMetadata } from './cleanup.ts'
import type { HostContext, SessionHandle } from './context.ts'
import { inspectSession } from './inspect.ts'
import { errorMessage, errorName } from './util.ts'

/** 删除流程的结果：HTTP 状态码 + 响应体。 */
export interface DeleteOutcome {
  readonly status: number
  readonly payload: DeletePayload
}

/** 会话仍活跃时的提示文案。 */
const LIVE_MESSAGE = '该会话仍在当前 DSH 进程内活跃。请先归档，重启 DSH Web 后再删除。'

/** 会话被其他写入者持有时的提示文案。 */
const OWNED_MESSAGE = '该会话正被另一个写入者占用。请先归档，重启 DSH Web 后再删除。'

/**
 * 删除一个冷会话。
 *
 * @param ctx 宿主上下文
 * @param sessionId 已通过白名单校验的会话 id
 * @returns HTTP 状态码与响应体；调用方负责序列化
 */
export async function deleteSession(ctx: HostContext, sessionId: string): Promise<DeleteOutcome> {
  const before = await inspectSession(ctx, sessionId)

  if (!before.exists) {
    return { status: 404, payload: { ok: false, code: 'not-found' } }
  }
  if (before.live) {
    return { status: 409, payload: { ok: false, code: 'live', message: LIVE_MESSAGE } }
  }

  // 抢占写锁。错误按 name 字符串识别，兼容跨包实例。
  let handle: SessionHandle
  try {
    handle = await ctx.sessionPersistence.open(sessionId, 'write')
  } catch (error) {
    switch (errorName(error)) {
      case 'SessionAlreadyOwnedError':
        return { status: 409, payload: { ok: false, code: 'live', message: OWNED_MESSAGE } }
      case 'SessionPersistenceNotFoundError':
        return { status: 404, payload: { ok: false, code: 'not-found' } }
      case 'SessionFormatUnsupportedError':
        return {
          status: 422,
          payload: {
            ok: false,
            code: 'unsupported-format',
            message: `该会话的日志格式不受支持，无法安全删除：${errorMessage(error)}`,
          },
        }
      default:
        return { status: 500, payload: { ok: false, code: 'claim-failed', message: errorMessage(error) } }
    }
  }

  const warnings: string[] = []

  try {
    // 持锁期间读取一次会话位置；读不到位置说明只剩元数据，退化为“仅清理元数据”。
    let logPath: string | null = null
    let directory: string | null = null
    try {
      const snapshot = await ctx.sessionPersistence.stat(sessionId)
      const locationPath = snapshot?.location?.path
      if (locationPath !== undefined) {
        logPath = locationPath
        directory = dirname(locationPath)
      }
    } catch {
      // 位置读取失败时按“无日志文件”处理，后续仍会尝试清理元数据。
    }

    if (logPath === null) {
      warnings.push('未找到会话日志文件，仅清理元数据。')
    } else {
      let removeError: string | null = null
      try {
        await rm(logPath, { force: true })
      } catch (error) {
        removeError = errorMessage(error)
      }

      if (removeError === null && directory !== null) {
        try {
          await rm(directory, { recursive: true, force: true })
        } catch (error) {
          warnings.push(`删除会话目录失败：${errorMessage(error)}`)
        }
      }

      // 日志文件本身删不掉时，不能继续走“成功”分支：会话仍然存在。
      if (removeError !== null) {
        return {
          status: 500,
          payload: {
            ok: false,
            code: 'filesystem-error',
            message: `无法删除会话日志文件：${removeError}`,
            warnings,
          },
        }
      }
    }
  } finally {
    // 无论删除成功与否都必须释放写锁，否则该会话会一直被标记为“被占用”。
    try {
      await handle.close()
    } catch (error) {
      warnings.push(`释放写入锁失败：${errorMessage(error)}`)
    }
  }

  // 日志已删除：继续做 best-effort 元数据清理。
  const cleanup = await cleanupMetadata(ctx, sessionId)
  warnings.push(...cleanup.warnings)

  // 复核：若持久化层仍报告该会话，提示用户刷新后确认（不回滚，也无法回滚）。
  try {
    const remaining = await ctx.sessionPersistence.stat(sessionId)
    if (remaining !== undefined) {
      warnings.push('删除后持久化层仍报告该会话，可能在下次刷新时重新出现。')
    }
  } catch {
    warnings.push('删除后校验失败，请刷新页面确认。')
  }

  return {
    status: 200,
    payload: {
      ok: true,
      deleted: {
        sessionId,
        archived: before.archived,
        eventCount: before.eventCount,
        sizeBytes: before.sizeBytes,
      },
      warnings,
    },
  }
}
