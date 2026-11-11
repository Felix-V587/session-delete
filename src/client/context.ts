/**
 * 客户端半的最小服务契约。
 *
 * 与宿主半同理：不从 `@deepseek-ai/*` 私有类型包导入，只声明本插件用到的成员。
 * 契约字段取自 DSH 0.2.2-rc.1 客户端的 slots / locale / contextMenus / sessions 服务。
 *
 * @module client/context
 */

import type { ComponentType } from 'react'

import type { LocaleDictionary, Translator } from './i18n.ts'

/** 插槽组件收到的属性。`t` 是宿主按插槽 locale 绑定的本地化函数。 */
export interface SlotProps {
  /** 本地化函数；宿主未提供时插件会回退到自己的词典。 */
  readonly t?: Translator
}

/** 插槽注册声明。 */
export interface SlotRegistration {
  /** 插槽名，例如 `shell.overlay`。 */
  readonly name: string
  /** 注册项 id，插件内唯一。 */
  readonly id: string
  /** 排序权重。 */
  readonly order?: number
  /** 注册项所属的语言命名空间。 */
  readonly locale?: string
}

/** 插槽服务：允许插件向界面固定位置挂载组件。 */
export interface SlotsService {
  /**
   * 注册一个插槽组件。
   *
   * @returns 注销该插槽的 disposer
   */
  register(registration: SlotRegistration, component: ComponentType<SlotProps>): () => void
}

/** 本地化服务。 */
export interface LocaleService {
  /**
   * 注册某个语言的词典。
   *
   * @returns 注销该词典的 disposer
   */
  register(namespace: string, locale: string, dictionary: LocaleDictionary): () => void
  /** 绑定命名空间，返回可直接调用的翻译函数。 */
  bind(namespace: string): Translator
}

/** 右键菜单命中的会话目标。 */
export interface ContextMenuTarget {
  /** 会话 id。 */
  readonly sessionId: string
  /** 菜单展示用的会话标题（可能已被截断）。 */
  readonly displayTitle: string
}

/** 一个菜单动作。 */
export interface MenuAction {
  /** 动作 id。 */
  readonly id: string
  /** 菜单项文本。 */
  readonly label: string
  /** 是否使用危险样式（红色）。 */
  readonly danger?: boolean
  /** 是否在该项之前插入分隔线。 */
  readonly separatorBefore?: boolean
  /** 动作执行失败时由宿主展示的兜底文案。 */
  readonly failureLabel?: string
  /** 执行动作。 */
  run(): void
}

/** 右键菜单贡献声明。 */
export interface MenuContribution {
  /** 贡献点 id。 */
  readonly id: string
  /** 作用目标：会话右键菜单。 */
  readonly target: 'session'
  /** 排序权重，数值越大越靠后。 */
  readonly order?: number
  /**
   * 解析当前目标下应展示的菜单项。
   *
   * @param target 会话目标
   * @param signal 目标变化时由宿主中止
   * @returns 菜单项；返回空数组表示不展示
   */
  resolve(target: ContextMenuTarget, signal: AbortSignal): Promise<readonly MenuAction[]>
}

/** 右键菜单服务。 */
export interface ContextMenusService {
  /**
   * 注册菜单贡献。
   *
   * @returns 注销该贡献的 disposer
   */
  register(contribution: MenuContribution): () => void
  /** 弹出轻量通知。 */
  notify(message: string, success?: boolean, action?: unknown): void
}

/** 会话服务：删除成功后刷新左侧会话列表。 */
export interface SessionsService {
  refresh(): unknown
}

/**
 * 客户端插件上下文。
 *
 * DSH 会按插件 `inject` 列表等待这些服务就绪后再调用 `apply`。
 */
export interface ClientContext {
  readonly slots: SlotsService
  readonly locale: LocaleService
  readonly contextMenus: ContextMenusService
  readonly sessions: SessionsService
  /** 注册副作用，返回的 disposer 会在插件卸载时调用。 */
  effect(run: () => void | (() => void)): void
}
