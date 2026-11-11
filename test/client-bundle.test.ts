/**
 * 客户端 bundle 集成测试。
 *
 * 客户端源码是 TSX，Node 无法直接执行，因此这里测试的是“构建产物”——
 * 与 DSH 实际加载的文件完全一致：
 *   1. 用 jsdom 提供 DOM 环境；
 *   2. 用一段假 `window.__ModuleLoader__` 执行 `lib/client.js`，拿到 factory；
 *   3. 用真实 React（`react` / `react-dom/client`）与一个 Modal 桩渲染对话框；
 *   4. 断言词典注册、菜单 gating、两步确认、成功 / 失败反馈。
 *
 * 运行：`node --test test/client-bundle.test.ts`
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { JSDOM } from 'jsdom'
import { act, createElement, type ComponentType, type ReactElement, type ReactNode } from 'react'

import type {
  ClientContext,
  MenuContribution,
  SlotProps,
  SlotsService,
} from '../src/client/context.ts'
import { ZH, interpolate, type Translator } from '../src/client/i18n.ts'

// ---------------------------------------------------------------------------
// DOM 环境（在加载 react-dom 之前准备）
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:3080/',
})

const globals = globalThis as unknown as Record<string, unknown>
globals.window = dom.window
globals.document = dom.window.document
globals.HTMLElement = dom.window.HTMLElement
globals.Event = dom.window.Event
globals.MouseEvent = dom.window.MouseEvent
globals.IS_REACT_ACT_ENVIRONMENT = true

const { createRoot } = await import('react-dom/client')

after(() => {
  dom.window.close()
})

// ---------------------------------------------------------------------------
// 加载构建产物
// ---------------------------------------------------------------------------

/** bundle 导出的插件接口。 */
interface BundleExports {
  readonly inject: readonly string[]
  apply(ctx: ClientContext): void
}

/** 模块加载器的注册信息。 */
interface LoaderRegistration {
  readonly id: string
  factory(require: (id: string) => unknown): BundleExports
}

/** 假 Modal：把 title / description / footer / children 都渲染出来，便于断言。 */
function FakeModal(props: {
  readonly open?: boolean
  readonly onClose?: () => void
  readonly closeLabel?: string
  readonly title?: ReactNode
  readonly description?: ReactNode
  readonly footer?: ReactNode
  readonly children?: ReactNode
}): ReactElement {
  return createElement(
    'div',
    {
      'data-testid': 'modal',
      'data-open': props.open === true ? 'true' : 'false',
      'aria-label': props.closeLabel,
    },
    createElement('div', { 'data-testid': 'title' }, props.title),
    props.description === undefined
      ? null
      : createElement('div', { 'data-testid': 'description' }, props.description),
    createElement('div', { 'data-testid': 'body' }, props.children),
    createElement('div', { 'data-testid': 'footer' }, props.footer),
  )
}

const nodeRequire = createRequire(import.meta.url)

/** bundle 里的 `require` 桩：react 系列走真实包，UI 原语用假 Modal。 */
function requireStub(id: string): unknown {
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: FakeModal }
  return nodeRequire(id)
}

const clientCode = await readFile(join(process.cwd(), 'lib', 'client.js'), 'utf8')

/** 当前测试的 fetch 实现；每个测试按需替换。 */
let currentFetch: (input: string, init?: RequestInit) => Promise<Response> = async () => {
  throw new Error('未设置 fetch 桩')
}

let captured: LoaderRegistration | null = null
const fakeWindow = {
  __ModuleLoader__: {
    load(registration: LoaderRegistration): void {
      captured = registration
    },
  },
}

// 执行 bundle 顶层代码：它只应“注册 factory”，不应立即 require 依赖。
const runBundle = new Function('window', 'document', 'fetch', 'URL', 'console', clientCode)
runBundle(
  fakeWindow,
  dom.window.document,
  (input: string, init?: RequestInit) => currentFetch(input, init),
  URL,
  console,
)

assert.ok(captured !== null, 'bundle 没有调用 window.__ModuleLoader__.load')
const bundle: BundleExports = (captured as LoaderRegistration).factory(requireStub)

// ---------------------------------------------------------------------------
// mock 客户端上下文
// ---------------------------------------------------------------------------

/** 上下文调用记录。 */
interface ClientCalls {
  localeRegistered: { locale: string; dictionary: Record<string, string> }[]
  slotsRegistered: { id: string; component: ComponentType<SlotProps> }[]
  slotsDisposed: number
  menuContributions: MenuContribution[]
  notifies: { message: string; success: boolean | undefined }[]
  refreshes: number
  effects: ((() => void) | undefined)[]
}

/** 构造 mock 客户端上下文。 */
function createMockContext(): { ctx: ClientContext; calls: ClientCalls } {
  const calls: ClientCalls = {
    localeRegistered: [],
    slotsRegistered: [],
    slotsDisposed: 0,
    menuContributions: [],
    notifies: [],
    refreshes: 0,
    effects: [],
  }

  const slots: SlotsService = {
    register(registration, component) {
      calls.slotsRegistered.push({ id: registration.id, component })
      return () => {
        calls.slotsDisposed += 1
      }
    },
  }

  const ctx: ClientContext = {
    slots,
    locale: {
      register(_namespace, locale, dictionary) {
        calls.localeRegistered.push({ locale, dictionary: { ...dictionary } })
        return () => {}
      },
      bind() {
        return (key, vars) => interpolate(ZH[key] ?? key, vars)
      },
    },
    contextMenus: {
      register(contribution) {
        calls.menuContributions.push(contribution)
        return () => {}
      },
      notify(message, success) {
        calls.notifies.push({ message, success })
      },
    },
    sessions: {
      refresh() {
        calls.refreshes += 1
      },
    },
    effect(run) {
      const disposer = run()
      calls.effects.push(typeof disposer === 'function' ? disposer : undefined)
    },
  }

  return { ctx, calls }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------


/** 插槽注册的是 ComponentType，测试里按函数式组件调用。 */
function renderOverlay(component: ComponentType<SlotProps>, t: Translator): ReactElement | null {
  const Callable = component as (props: SlotProps) => ReactElement | null
  return Callable({ t })
}

/** 构造一个 Response 桩。 */
function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    },
  } as unknown as Response
}

/** 构造一个会话概览响应。 */
function statusPayload(options: { exists: boolean; live: boolean; archived?: boolean }): unknown {
  return {
    ok: true,
    session: {
      id: 'session-1',
      exists: options.exists,
      live: options.live,
      archived: options.archived ?? false,
      formatStatus: 'current',
      eventCount: 3,
      sizeBytes: 42,
    },
  }
}

/** 挂载一个元素并返回容器与卸载函数。 */
async function render(element: ReactElement): Promise<{ container: HTMLElement; unmount(): Promise<void> }> {
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(element)
  })

  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/** 点击文案匹配的按钮。 */
async function clickButton(container: HTMLElement, label: string): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  assert.ok(button !== undefined, `找不到按钮：${label}`)

  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    // 让 confirm() 里的 await 链在 act 内完成。
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** 读取界面文本。 */
function text(container: HTMLElement, testId: string): string {
  const element = container.querySelector(`[data-testid="${testId}"]`)
  assert.ok(element !== null, `找不到节点：${testId}`)
  return element.textContent ?? ''
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

test('bundle 结构：注册 factory、导出 apply/inject、带 source map 尾注', () => {
  assert.ok(clientCode.startsWith('window.__ModuleLoader__.load('))
  assert.match(clientCode, /id: '@local\/session-delete'/)
  assert.match(clientCode, /\/\/# sourceMappingURL=client\.js\.map\s*$/)
  assert.deepEqual(bundle.inject, ['slots', 'locale', 'contextMenus', 'sessions'])
  assert.equal(typeof bundle.apply, 'function')
})

test('apply：注册中英两份词典与一个菜单贡献，初始不打开对话框', () => {
  const { ctx, calls } = createMockContext()
  bundle.apply(ctx)

  assert.equal(calls.localeRegistered.length, 2)
  assert.deepEqual(calls.localeRegistered.map((entry) => entry.locale).sort(), ['en', 'zh'])

  const zh = calls.localeRegistered.find((entry) => entry.locale === 'zh')
  assert.ok(zh !== undefined)
  assert.equal(zh.dictionary['menu.delete'], '删除会话…')
  assert.equal(zh.dictionary['title'], '永久删除该会话？')
  assert.equal(Object.keys(zh.dictionary).length, 23)

  assert.equal(calls.menuContributions.length, 1)
  const menu = calls.menuContributions[0]
  assert.ok(menu !== undefined)
  assert.equal(menu.id, 'session-delete')
  assert.equal(menu.target, 'session')
  assert.equal(menu.order, 900)

  // 只有点击菜单动作后才会注册 overlay。
  assert.equal(calls.slotsRegistered.length, 0)
})

test('菜单：冷会话展示一条危险动作，中文文案', async () => {
  currentFetch = async () => jsonResponse(200, statusPayload({ exists: true, live: false, archived: true }))
  const { ctx, calls } = createMockContext()
  bundle.apply(ctx)

  const menu = calls.menuContributions[0]
  assert.ok(menu !== undefined)
  const actions = await menu.resolve(
    { sessionId: 'session-1', displayTitle: '删除已归档会话方法' },
    new AbortController().signal,
  )

  assert.equal(actions.length, 1)
  const action = actions[0]
  assert.ok(action !== undefined)
  assert.equal(action.id, 'delete')
  assert.equal(action.label, '删除会话…')
  assert.equal(action.danger, true)
  assert.equal(action.separatorBefore, true)
  assert.equal(action.failureLabel, '无法删除该会话')
})

test('菜单：活跃会话、已不存在、接口异常都不展示', async () => {
  const cases: (() => Promise<Response>)[] = [
    async () => jsonResponse(200, statusPayload({ exists: true, live: true })),
    async () => jsonResponse(200, statusPayload({ exists: false, live: false })),
    async () => jsonResponse(404, { ok: false, code: 'not-found' }),
    async () => {
      throw new Error('网络中断')
    },
  ]

  for (const fetchImpl of cases) {
    currentFetch = fetchImpl
    const { ctx, calls } = createMockContext()
    bundle.apply(ctx)
    const menu = calls.menuContributions[0]
    assert.ok(menu !== undefined)

    const actions = await menu.resolve(
      { sessionId: 'session-1', displayTitle: '任意' },
      new AbortController().signal,
    )
    assert.deepEqual(actions, [])
  }
})

test('对话框：两步确认，成功删除后关闭并通知刷新', async () => {
  // 第一次请求：菜单解析时的状态查询；第二次：删除。
  const requests: { url: string; init: RequestInit | undefined }[] = []
  currentFetch = async (input, init) => {
    requests.push({ url: input, init })
    if (init?.method === 'POST') {
      return jsonResponse(200, {
        ok: true,
        deleted: { sessionId: 'session-1', archived: true, eventCount: 3, sizeBytes: 42 },
        warnings: [],
      })
    }
    return jsonResponse(200, statusPayload({ exists: true, live: false, archived: true }))
  }

  const { ctx, calls } = createMockContext()
  bundle.apply(ctx)

  const menu = calls.menuContributions[0]
  assert.ok(menu !== undefined)
  const actions = await menu.resolve(
    { sessionId: 'session-1', displayTitle: '删除已归档会话方法' },
    new AbortController().signal,
  )
  const action = actions[0]
  assert.ok(action !== undefined)
  action.run()

  // 动作执行后应注册 overlay。
  assert.equal(calls.slotsRegistered.length, 1)
  const overlay = calls.slotsRegistered[0]
  assert.ok(overlay !== undefined)
  assert.equal(overlay.id, 'session-delete.dialog')

  const element = renderOverlay(overlay.component, (key, vars) => interpolate(ZH[key] ?? key, vars))
  assert.ok(element !== null)
  const { container, unmount } = await render(element)

  try {
    // 第 1 步：风险说明。
    assert.equal(text(container, 'title'), '永久删除该会话？')
    assert.match(text(container, 'description'), /删除已归档会话方法/)
    const riskBody = text(container, 'body')
    assert.match(riskBody, /不进入回收站/)
    assert.match(riskBody, /共享附件库中的文件不会被删除/)

    // 第 2 步：最后确认。
    await clickButton(container, '继续')
    assert.equal(text(container, 'title'), '最后确认')
    assert.match(text(container, 'body'), /你将永久删除“删除已归档会话方法”/)

    // 第 3 步：执行删除。
    await clickButton(container, '永久删除')

    const post = requests.find((entry) => entry.init?.method === 'POST')
    assert.ok(post !== undefined)
    assert.match(post.url, /\/session-delete\/api\/delete$/)
    assert.deepEqual(JSON.parse(String(post.init?.body)), { sessionId: 'session-1' })

    // 成功后：关闭对话框（注销插槽）、弹出通知、刷新会话列表。
    assert.equal(calls.slotsDisposed, 1)
    assert.deepEqual(calls.notifies, [{ message: '已删除会话', success: true }])
    assert.equal(calls.refreshes, 1)
  } finally {
    await unmount()
  }
})

test('对话框：删除失败时保持打开并展示本地化错误', async () => {
  currentFetch = async (_input, init) => {
    if (init?.method === 'POST') {
      return jsonResponse(409, { ok: false, code: 'live', message: '宿主原始消息' })
    }
    return jsonResponse(200, statusPayload({ exists: true, live: false }))
  }

  const { ctx, calls } = createMockContext()
  bundle.apply(ctx)
  const menu = calls.menuContributions[0]
  assert.ok(menu !== undefined)
  const actions = await menu.resolve(
    { sessionId: 'session-1', displayTitle: '会话' },
    new AbortController().signal,
  )
  const action = actions[0]
  assert.ok(action !== undefined)
  action.run()

  const overlay = calls.slotsRegistered[0]
  assert.ok(overlay !== undefined)
  const element = renderOverlay(overlay.component, (key, vars) => interpolate(ZH[key] ?? key, vars))
  assert.ok(element !== null)
  const { container, unmount } = await render(element)

  try {
    await clickButton(container, '继续')
    await clickButton(container, '永久删除')

    const alert = container.querySelector('[role="alert"]')
    assert.ok(alert !== null)
    // 失败码 live 优先映射到本地化文案，而不是宿主 message。
    assert.equal(alert.textContent, '该会话仍在当前 DSH 进程内活跃。请先归档，重启 DSH Web 后再删除。')

    assert.equal(calls.slotsDisposed, 0)
    assert.equal(calls.notifies.length, 0)
    assert.equal(calls.refreshes, 0)
  } finally {
    await unmount()
  }
})

test('对话框：未知失败码回退到宿主 message', async () => {
  currentFetch = async (_input, init) => {
    if (init?.method === 'POST') {
      return jsonResponse(500, { ok: false, code: 'weird-code', message: '内部故障' })
    }
    return jsonResponse(200, statusPayload({ exists: true, live: false }))
  }

  const { ctx, calls } = createMockContext()
  bundle.apply(ctx)
  const menu = calls.menuContributions[0]
  assert.ok(menu !== undefined)
  const actions = await menu.resolve(
    { sessionId: 'session-1', displayTitle: '会话' },
    new AbortController().signal,
  )
  const action = actions[0]
  assert.ok(action !== undefined)
  action.run()

  const overlay = calls.slotsRegistered[0]
  assert.ok(overlay !== undefined)
  const element = renderOverlay(overlay.component, (key, vars) => interpolate(ZH[key] ?? key, vars))
  assert.ok(element !== null)
  const { container, unmount } = await render(element)

  try {
    await clickButton(container, '继续')
    await clickButton(container, '永久删除')

    const alert = container.querySelector('[role="alert"]')
    assert.ok(alert !== null)
    assert.equal(alert.textContent, '内部故障')
  } finally {
    await unmount()
  }
})
