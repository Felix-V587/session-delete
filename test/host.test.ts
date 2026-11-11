/**
 * 宿主半集成测试。
 *
 * 不启动完整 DSH 宿主：用真实 `http.createServer` 挂上插件的 `routeRequest`，
 * 再用 mock 上下文替换持久化层、工作区、存储域与定时任务。这样既能验证
 * 完整 HTTP 行为（状态码、响应体、请求体上限），又不需要触碰真实会话数据。
 *
 * 运行：`node --test test/host.test.ts`
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import type {
  HostContext,
  ScheduleCatalogEntry,
  SessionPersistenceSnapshot,
  WorkspaceEntity,
} from '../src/host/context.ts'
import { routeRequest } from '../src/host/routes.ts'
import { ROUTE_PREFIX, type SessionSummary } from '../src/protocol.ts'

// ---------------------------------------------------------------------------
// 测试用临时目录：放在系统临时目录下，测试结束后统一清理。
// ---------------------------------------------------------------------------

const TEMP_DIRECTORIES: string[] = []

after(async () => {
  await Promise.all(TEMP_DIRECTORIES.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** 创建一个测试专用临时目录。 */
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-delete-test-'))
  TEMP_DIRECTORIES.push(dir)
  return dir
}

// ---------------------------------------------------------------------------
// mock 上下文
// ---------------------------------------------------------------------------

/** mock 上下文的行为选项。 */
interface MockOptions {
  /** `stat` 依次返回的快照；用尽后重复最后一项，空数组表示始终 undefined。 */
  readonly snapshots?: readonly (SessionPersistenceSnapshot | undefined)[]
  /** 会话是否被当前进程持有（决定 live）。 */
  readonly live?: boolean
  /** 是否处于归档状态。 */
  readonly archived?: boolean
  /** `open` 抛出的错误。 */
  readonly openError?: unknown
  /** `handle.close` 抛出的错误。 */
  readonly closeError?: unknown
  /** `unarchiveSession` 抛出的错误。 */
  readonly unarchiveError?: unknown
  /** `unpinSession` 抛出的错误。 */
  readonly unpinError?: unknown
  /** 工作区分组列表。 */
  readonly workspaces?: readonly WorkspaceEntity[]
  /** 连接层拒绝码。 */
  readonly rejection?: 401 | 403
  /** 定时任务目录。 */
  readonly scheduleCatalog?: readonly ScheduleCatalogEntry[]
  /** 定时任务服务是否缺省（模拟宿主未提供）。 */
  readonly withoutSchedule?: boolean
  /** `requestRejection` 是否抛错（用于内部错误兜底）。 */
  readonly rejectionThrows?: boolean
}

/** mock 上下文及其调用记录。 */
interface MockContext {
  readonly ctx: HostContext
  readonly calls: {
    readonly stat: number
    readonly opened: string[]
    readonly closed: number
    readonly unarchived: string[]
    readonly unpinned: string[]
    readonly detached: string[]
    readonly storageDeleted: string[]
    readonly scheduledDeleted: string[]
  }
}

/** 构造一个 mock 宿主上下文。 */
function createMockContext(options: MockOptions = {}): MockContext {
  const { live = false, archived = false } = options
  const calls = {
    stat: 0,
    opened: [] as string[],
    closed: 0,
    unarchived: [] as string[],
    unpinned: [] as string[],
    detached: [] as string[],
    storageDeleted: [] as string[],
    scheduledDeleted: [] as string[],
  }

  const snapshots = options.snapshots ?? []
  const statAt = (index: number): SessionPersistenceSnapshot | undefined => {
    if (snapshots.length === 0) return undefined
    return snapshots[Math.min(index, snapshots.length - 1)]
  }

  const ctx: HostContext = {
    webServer: {
      register(route) {
        return () => {
          void route
        }
      },
    },
    connection: {
      requestRejection() {
        if (options.rejectionThrows === true) throw new Error('连接服务异常')
        return options.rejection
      },
    },
    sessions: {
      get: () => (live ? { id: 'live-session' } : undefined),
    },
    agents: {
      get: () => undefined,
    },
    sessionPersistence: {
      async stat() {
        const snapshot = statAt(calls.stat)
        calls.stat += 1
        return snapshot
      },
      async open(sessionId) {
        if (options.openError !== undefined) throw options.openError
        calls.opened.push(sessionId)
        return {
          async close() {
            calls.closed += 1
            if (options.closeError !== undefined) throw options.closeError
          },
        }
      },
    },
    workspaceRegistry: {
      archivedSessionIds: archived ? ['session-1'] : [],
      list: () => options.workspaces ?? [],
      async unarchiveSession(sessionId) {
        if (options.unarchiveError !== undefined) throw options.unarchiveError
        calls.unarchived.push(sessionId)
      },
      async unpinSession(sessionId) {
        if (options.unpinError !== undefined) throw options.unpinError
        calls.unpinned.push(sessionId)
      },
    },
    storageDomain: {
      get(name) {
        if (name !== 'session_projcache') return undefined
        return {
          table() {
            return {
              async delete(key) {
                calls.storageDeleted.push(key)
                return true
              },
            }
          },
        }
      },
    },
    effect(run) {
      const disposer = run()
      void disposer
    },
    ...(options.withoutSchedule === true
      ? {}
      : {
          schedule: {
            async catalog() {
              return options.scheduleCatalog ?? []
            },
            async edit(request) {
              calls.scheduledDeleted.push(request.id)
              return undefined
            },
          },
        }),
  }

  return { ctx, calls }
}

/** 一组默认快照：便于构造“会话存在”的测试。 */
function snapshotWith(logPath: string | undefined, overrides: Partial<SessionPersistenceSnapshot> = {}): SessionPersistenceSnapshot {
  return {
    header: {},
    revision: 1,
    formatStatus: 'current',
    eventCount: 3,
    sizeBytes: 42,
    ...(logPath === undefined ? {} : { location: { kind: 'file', path: logPath } }),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// HTTP 测试服务器
// ---------------------------------------------------------------------------

/** 测试服务器句柄。 */
interface TestServer {
  readonly url: string
  close(): Promise<void>
}

/** 启动只挂载插件路由的临时服务器。 */
async function startServer(ctx: HostContext): Promise<TestServer> {
  const server = createServer((request, response) => {
    void routeRequest(ctx, request, response)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('无法获取测试服务器的监听端口')
  }

  return {
    url: `http://127.0.0.1:${address.port}${ROUTE_PREFIX}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      }),
  }
}

/** 发送请求并解析 JSON 响应。 */
async function callJson(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(baseUrl + path, init)
  const body = (await response.json()) as Record<string, unknown>
  return { status: response.status, body }
}

// ---------------------------------------------------------------------------
// 查询接口
// ---------------------------------------------------------------------------

test('GET /status：返回会话概览', async () => {
  const mock = createMockContext({ snapshots: [snapshotWith('/tmp/whatever.log')], archived: true })
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/status?sessionId=session-1')
    assert.equal(status, 200)
    assert.equal(body.ok, true)

    const session = body.session as SessionSummary
    assert.equal(session.id, 'session-1')
    assert.equal(session.exists, true)
    assert.equal(session.live, false)
    assert.equal(session.archived, true)
    assert.equal(session.formatStatus, 'current')
    assert.equal(session.eventCount, 3)
    assert.equal(session.sizeBytes, 42)
  } finally {
    await server.close()
  }
})

test('GET /status：非法会话 id 返回 400', async () => {
  const mock = createMockContext()
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, `/status?sessionId=${encodeURIComponent('../etc')}`)
    assert.equal(status, 400)
    assert.deepEqual(body, { ok: false, code: 'invalid-session-id' })
  } finally {
    await server.close()
  }
})

test('连接层拒绝：401 / 403 原样返回', async () => {
  for (const rejection of [401, 403] as const) {
    const mock = createMockContext({ rejection })
    const server = await startServer(mock.ctx)
    try {
      const { status, body } = await callJson(server.url, '/status?sessionId=s1')
      assert.equal(status, rejection)
      assert.equal(body.ok, false)
      assert.equal(body.code, rejection === 401 ? 'unauthorized' : 'forbidden')
    } finally {
      await server.close()
    }
  }
})

test('未知路由返回 404 not-found', async () => {
  const mock = createMockContext()
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/nope')
    assert.equal(status, 404)
    assert.deepEqual(body, { ok: false, code: 'not-found' })
  } finally {
    await server.close()
  }
})

// ---------------------------------------------------------------------------
// 删除接口：请求体校验
// ---------------------------------------------------------------------------

test('POST /delete：请求体不是合法 JSON 时返回 400 bad-json', async () => {
  const mock = createMockContext()
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(status, 400)
    assert.deepEqual(body, { ok: false, code: 'bad-json' })
  } finally {
    await server.close()
  }
})

test('POST /delete：请求体超过 8KB 时返回 413 body-too-large', async () => {
  const mock = createMockContext()
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', padding: 'x'.repeat(9000) }),
    })
    assert.equal(status, 413)
    assert.deepEqual(body, { ok: false, code: 'body-too-large' })
  } finally {
    await server.close()
  }
})

test('POST /delete：缺少 sessionId 或 id 非法时返回 400 invalid-session-id', async () => {
  const mock = createMockContext()
  const server = await startServer(mock.ctx)
  try {
    for (const payload of [{}, { sessionId: '' }, { sessionId: '../x' }, { sessionId: 1 }]) {
      const { status, body } = await callJson(server.url, '/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      assert.equal(status, 400)
      assert.deepEqual(body, { ok: false, code: 'invalid-session-id' })
    }
  } finally {
    await server.close()
  }
})

// ---------------------------------------------------------------------------
// 删除接口：失败分支
// ---------------------------------------------------------------------------

test('POST /delete：会话不存在返回 404', async () => {
  const mock = createMockContext({ snapshots: [] })
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    })
    assert.equal(status, 404)
    assert.deepEqual(body, { ok: false, code: 'not-found' })
  } finally {
    await server.close()
  }
})

test('POST /delete：会话仍活跃返回 409 live', async () => {
  const mock = createMockContext({ snapshots: [snapshotWith('/tmp/whatever.log')], live: true })
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    })
    assert.equal(status, 409)
    assert.equal(body.code, 'live')
    assert.match(String(body.message), /该会话仍在当前 DSH 进程内活跃/)
  } finally {
    await server.close()
  }
})

test('POST /delete：写锁被占用返回 409 live（独占提示）', async () => {
  const owned = Object.assign(new Error('已被占用'), { name: 'SessionAlreadyOwnedError' })
  const mock = createMockContext({ snapshots: [snapshotWith('/tmp/whatever.log')], openError: owned })
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    })
    assert.equal(status, 409)
    assert.equal(body.code, 'live')
    assert.match(String(body.message), /该会话正被另一个写入者占用/)
  } finally {
    await server.close()
  }
})

test('POST /delete：持久化层报告不存在返回 404', async () => {
  const missing = Object.assign(new Error('不存在'), { name: 'SessionPersistenceNotFoundError' })
  const mock = createMockContext({ snapshots: [snapshotWith('/tmp/whatever.log')], openError: missing })
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    })
    assert.equal(status, 404)
    assert.deepEqual(body, { ok: false, code: 'not-found' })
  } finally {
    await server.close()
  }
})

test('POST /delete：旧格式返回 422 unsupported-format', async () => {
  const unsupported = Object.assign(new Error('v2'), { name: 'SessionFormatUnsupportedError' })
  const mock = createMockContext({ snapshots: [snapshotWith('/tmp/whatever.log')], openError: unsupported })
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    })
    assert.equal(status, 422)
    assert.equal(body.code, 'unsupported-format')
    assert.match(String(body.message), /日志格式不受支持/)
  } finally {
    await server.close()
  }
})

test('POST /delete：其它打开错误返回 500 claim-failed', async () => {
  const mock = createMockContext({
    snapshots: [snapshotWith('/tmp/whatever.log')],
    openError: new Error('磁盘故障'),
  })
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    })
    assert.equal(status, 500)
    assert.equal(body.code, 'claim-failed')
    assert.equal(body.message, '磁盘故障')
  } finally {
    await server.close()
  }
})

test('内部异常兜底为 500 internal-error', async () => {
  const mock = createMockContext({ rejectionThrows: true })
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/status?sessionId=s1')
    assert.equal(status, 500)
    assert.equal(body.code, 'internal-error')
    assert.match(String(body.message), /连接服务异常/)
  } finally {
    await server.close()
  }
})

// ---------------------------------------------------------------------------
// 删除接口：成功分支
// ---------------------------------------------------------------------------

test('POST /delete：成功删除日志文件与会话目录，并清理元数据', async () => {
  const root = await makeTempDir()
  const sessionDir = join(root, 'session-1')
  const logPath = join(sessionDir, 'events.log')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(logPath, 'fake log data')

  const matchEntry: ScheduleCatalogEntry = { id: 'task-1', target: { kind: 'session', sessionId: 'session-1' } }
  const otherEntry: ScheduleCatalogEntry = { id: 'task-2', target: { kind: 'new_once', sessionId: 'other', create: {} } }
  const detached: string[] = []

  const mock = createMockContext({
    // 第 1 次 stat（inspect）、第 2 次 stat（持锁读位置）都返回快照，第 3 次（复核）返回 undefined。
    snapshots: [snapshotWith(logPath), snapshotWith(logPath), undefined],
    workspaces: [
      { sessionIds: ['session-1'], detachSession: async (id: string) => { detached.push(id) } },
      { sessionIds: ['other'], detachSession: async () => {} },
    ],
    scheduleCatalog: [matchEntry, otherEntry],
  })

  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    })

    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.deepEqual(body.deleted, {
      sessionId: 'session-1',
      archived: false,
      eventCount: 3,
      sizeBytes: 42,
    })
    assert.deepEqual(body.warnings, [])

    // 日志文件与会话目录都应被物理删除。
    await assert.rejects(stat(logPath))
    await assert.rejects(stat(sessionDir))

    // 元数据清理：归档/置顶/分组/投影缓存/定时任务各走一遍。
    assert.deepEqual(mock.calls.opened, ['session-1'])
    assert.equal(mock.calls.closed, 1)
    assert.deepEqual(mock.calls.unarchived, ['session-1'])
    assert.deepEqual(mock.calls.unpinned, ['session-1'])
    assert.deepEqual(detached, ['session-1'])
    assert.deepEqual(mock.calls.storageDeleted, ['session-1'])
    assert.deepEqual(mock.calls.scheduledDeleted, ['task-1'])
  } finally {
    await server.close()
  }
})

test('POST /delete：没有日志位置时仅清理元数据并给出告警', async () => {
  const mock = createMockContext({ snapshots: [snapshotWith(undefined), snapshotWith(undefined), undefined] })
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    })
    assert.equal(status, 200)
    const warnings = body.warnings as readonly string[]
    assert.deepEqual(warnings, ['未找到会话日志文件，仅清理元数据。'])
  } finally {
    await server.close()
  }
})

test('POST /delete：元数据清理失败只记录告警，不影响删除成功', async () => {
  const mock = createMockContext({
    snapshots: [snapshotWith(undefined), snapshotWith(undefined), undefined],
    unarchiveError: new Error('工作区只读'),
    unpinError: new Error('钉住失败'),
  })
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    })
    assert.equal(status, 200)
    const warnings = body.warnings as readonly string[]
    assert.equal(warnings[0], '未找到会话日志文件，仅清理元数据。')
    assert.equal(warnings[1], '清理归档标记：工作区只读')
    assert.equal(warnings[2], '清理置顶标记：钉住失败')
  } finally {
    await server.close()
  }
})

test('POST /delete：释放写锁失败记录告警', async () => {
  const mock = createMockContext({
    snapshots: [snapshotWith(undefined), snapshotWith(undefined), undefined],
    closeError: new Error('句柄已失效'),
  })
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    })
    assert.equal(status, 200)
    const warnings = body.warnings as readonly string[]
    assert.ok(warnings.includes('释放写入锁失败：句柄已失效'))
  } finally {
    await server.close()
  }
})

test('POST /delete：删除后复核仍存在时给出刷新提示', async () => {
  const root = await makeTempDir()
  const sessionDir = join(root, 's1')
  const logPath = join(sessionDir, 'events.log')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(logPath, 'x')

  const mock = createMockContext({
    // 复核的 stat 仍返回快照，模拟持久化层缓存未刷新。
    snapshots: [snapshotWith(logPath), snapshotWith(logPath), snapshotWith(logPath)],
  })
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    })
    assert.equal(status, 200)
    const warnings = body.warnings as readonly string[]
    assert.ok(warnings.includes('删除后持久化层仍报告该会话，可能在下次刷新时重新出现。'))
  } finally {
    await server.close()
  }
})

test('POST /delete：日志文件不可删除时返回 500 filesystem-error', async () => {
  const root = await makeTempDir()
  // 把“会话目录”的位置放成一个普通文件，于是 logPath 的父级不是目录，
  // rm(logPath) 会以 ENOTDIR 失败——与测试进程的权限无关，结果稳定。
  const sessionDirAsFile = join(root, 's1')
  await writeFile(sessionDirAsFile, '不是目录')
  const logPath = join(sessionDirAsFile, 'events.log')

  const mock = createMockContext({
    snapshots: [snapshotWith(logPath), snapshotWith(logPath), snapshotWith(logPath)],
  })
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    })
    assert.equal(status, 500)
    assert.equal(body.code, 'filesystem-error')
    assert.match(String(body.message), /无法删除会话日志文件/)
  } finally {
    await server.close()
  }
})

test('GET /status：读不到快照仍返回 exists=false', async () => {
  const mock = createMockContext({ snapshots: [] })
  const server = await startServer(mock.ctx)
  try {
    const { status, body } = await callJson(server.url, '/status?sessionId=ghost')
    assert.equal(status, 200)
    const session = body.session as SessionSummary
    assert.equal(session.exists, false)
    assert.equal(session.formatStatus, null)
    assert.equal(session.eventCount, null)
    assert.equal(session.sizeBytes, null)
  } finally {
    await server.close()
  }
})
