/**
 * 协议模块单元测试。
 *
 * 协议是宿主与客户端之间的“公共契约”，两端都依赖它的常量与校验函数，
 * 因此这里的断言必须足够严格：任何一个字段类型放宽，都可能让不可信的网络
 * 数据进入业务逻辑。
 *
 * 运行：`node --test test/protocol.test.ts`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  API_ROOT,
  BODY_LIMIT,
  ROUTE_PREFIX,
  isRecord,
  isValidSessionId,
  parseDeletePayload,
  parseFailurePayload,
  parseSessionSummary,
  parseStatusPayload,
} from '../src/protocol.ts'

test('常量：路由前缀与客户端相对前缀保持一致', () => {
  assert.equal(ROUTE_PREFIX, '/session-delete/api')
  // 客户端前缀去掉开头的斜杠，再补结尾斜杠，避免出现双斜杠。
  assert.equal(API_ROOT, 'session-delete/api/')
  assert.equal(BODY_LIMIT, 8 * 1024)
})

test('isValidSessionId：接受字母、数字、点、下划线、连字符', () => {
  assert.equal(isValidSessionId('abc'), true)
  assert.equal(isValidSessionId('a.b_c-D'), true)
  assert.equal(isValidSessionId('2026.11.11-session_01'), true)
  assert.equal(isValidSessionId('a'.repeat(160)), true)
})

test('isValidSessionId：拒绝空串、非法字符、超长与非字符串', () => {
  assert.equal(isValidSessionId(''), false)
  assert.equal(isValidSessionId('a b'), false)
  assert.equal(isValidSessionId('../etc/passwd'), false)
  assert.equal(isValidSessionId('a/b'), false)
  assert.equal(isValidSessionId('a'.repeat(161)), false)
  assert.equal(isValidSessionId(123), false)
  assert.equal(isValidSessionId(null), false)
  assert.equal(isValidSessionId(undefined), false)
})

test('isRecord：只接受普通对象', () => {
  assert.equal(isRecord({}), true)
  assert.equal(isRecord({ a: 1 }), true)
  assert.equal(isRecord([]), false)
  assert.equal(isRecord(null), false)
  assert.equal(isRecord('x'), false)
  assert.equal(isRecord(1), false)
  assert.equal(isRecord(() => {}), false)
})

test('parseSessionSummary：接受完整且类型正确的对象', () => {
  const summary = {
    id: 's1',
    exists: true,
    live: false,
    archived: true,
    formatStatus: 'current',
    eventCount: 3,
    sizeBytes: 42,
  }
  assert.deepEqual(parseSessionSummary(summary), summary)
})

test('parseSessionSummary：字段缺失或类型不符时返回 null', () => {
  const valid = {
    id: 's1',
    exists: true,
    live: false,
    archived: false,
    formatStatus: null,
    eventCount: null,
    sizeBytes: null,
  }

  assert.equal(parseSessionSummary(null), null)
  assert.equal(parseSessionSummary('s1'), null)
  // 缺少 live 字段
  const { live: _live, ...missingLive } = valid
  assert.equal(parseSessionSummary(missingLive), null)
  // formatStatus 取值不在枚举内
  assert.equal(parseSessionSummary({ ...valid, formatStatus: 'legacy' }), null)
  // eventCount 为 NaN（JSON 不会产生，但校验函数仍需防御）
  assert.equal(parseSessionSummary({ ...valid, eventCount: Number.NaN }), null)
  // sizeBytes 为字符串
  assert.equal(parseSessionSummary({ ...valid, sizeBytes: '42' }), null)
})

test('parseFailurePayload：接受最小失败体与带 message / warnings 的失败体', () => {
  assert.deepEqual(parseFailurePayload({ ok: false, code: 'live' }), { ok: false, code: 'live' })
  assert.deepEqual(
    parseFailurePayload({ ok: false, code: 'live', message: '活跃', warnings: ['a'] }),
    { ok: false, code: 'live', message: '活跃', warnings: ['a'] },
  )
})

test('parseFailurePayload：拒绝空 code、ok 非 false、warnings 含非字符串', () => {
  assert.equal(parseFailurePayload({ ok: false, code: '' }), null)
  assert.equal(parseFailurePayload({ ok: true, code: 'live' }), null)
  assert.equal(parseFailurePayload({ ok: false, code: 'live', message: 1 }), null)
  assert.equal(parseFailurePayload({ ok: false, code: 'live', warnings: ['a', 2] }), null)
  assert.equal(parseFailurePayload(null), null)
})

test('parseStatusPayload：解析成功与失败两种响应', () => {
  const session = {
    id: 's1',
    exists: true,
    live: false,
    archived: false,
    formatStatus: 'current',
    eventCount: 1,
    sizeBytes: 2,
  }

  assert.deepEqual(parseStatusPayload({ ok: true, session }), { ok: true, session })
  assert.deepEqual(parseStatusPayload({ ok: false, code: 'not-found' }), { ok: false, code: 'not-found' })
  // session 结构不合法时整体视为不可用
  assert.equal(parseStatusPayload({ ok: true, session: { id: 's1' } }), null)
  assert.equal(parseStatusPayload({ ok: true }), null)
  assert.equal(parseStatusPayload('nope'), null)
})

test('parseDeletePayload：解析成功体并过滤非字符串告警', () => {
  const deleted = { sessionId: 's1', archived: true, eventCount: 4, sizeBytes: 128 }

  assert.deepEqual(
    parseDeletePayload({ ok: true, deleted, warnings: ['目录删除失败'] }),
    { ok: true, deleted, warnings: ['目录删除失败'] },
  )

  // warnings 不是数组时按“无告警”处理；数组中非字符串项会被过滤掉
  const withoutWarnings = parseDeletePayload({ ok: true, deleted })
  if (withoutWarnings === null || withoutWarnings.ok !== true) assert.fail('应解析为删除成功')
  assert.deepEqual(withoutWarnings.warnings, [])

  const mixedWarnings = parseDeletePayload({ ok: true, deleted, warnings: ['ok', 1] })
  if (mixedWarnings === null || mixedWarnings.ok !== true) assert.fail('应解析为删除成功')
  assert.deepEqual(mixedWarnings.warnings, ['ok'])

  // 失败体同样可解析
  assert.deepEqual(parseDeletePayload({ ok: false, code: 'live' }), { ok: false, code: 'live' })

  // deleted 字段结构不合法
  assert.equal(parseDeletePayload({ ok: true, deleted: { sessionId: 's1' }, warnings: [] }), null)
})
