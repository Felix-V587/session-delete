/**
 * 对话框插槽控制器。
 *
 * DSH 的插槽只能注册组件，而“打开对话框”发生在菜单回调里；控制器负责把
 * 这两者连接起来：维护当前待删除请求、注册/注销 `shell.overlay` 插槽，
 * 并把翻译函数传给组件。
 *
 * @module client/overlay
 */

import type { ComponentType, ReactElement } from 'react'

import type { SlotProps, SlotsService } from './context.ts'
import { SessionDeleteDialog, type PendingDeleteRequest } from './dialog.tsx'
import { fallbackTranslate, NS, type Translator } from './i18n.ts'

/** 控制器构造参数。 */
export interface ConfirmControllerOptions {
  /** 插槽服务。 */
  readonly slots: SlotsService
  /** 翻译函数；缺省使用内置英文兜底。 */
  readonly translate?: Translator
}

/**
 * 单例式确认对话框控制器。
 *
 * 同一时刻只允许存在一个对话框：再次打开会先关闭旧的（即先注销插槽）。
 */
export class ConfirmController {
  private readonly slots: SlotsService
  private readonly translate: Translator
  private pending: PendingDeleteRequest | null = null
  private disposeEntry: (() => void) | null = null

  constructor(options: ConfirmControllerOptions) {
    this.slots = options.slots
    this.translate = options.translate ?? fallbackTranslate
  }

  /** 当前使用的翻译函数（菜单文案直接复用）。 */
  get translator(): Translator {
    return this.translate
  }

  /**
   * 打开删除确认对话框。
   *
   * @param request 待删除的会话上下文
   */
  open(request: PendingDeleteRequest): void {
    this.close()
    this.pending = request
    this.disposeEntry = this.slots.register(
      {
        name: 'shell.overlay',
        id: 'session-delete.dialog',
        order: 60,
        locale: NS,
      },
      this.renderOverlay,
    )
  }

  /** 关闭对话框并注销插槽。可安全重复调用。 */
  readonly close = (): void => {
    const dispose = this.disposeEntry
    this.disposeEntry = null
    this.pending = null
    if (dispose === null) return

    try {
      dispose()
    } catch {
      // 页面卸载时插槽服务可能已经销毁，注销失败不影响用户体验，忽略即可。
    }
  }

  /** 插槽组件：把当前的 pending 请求渲染成对话框。 */
  private readonly renderOverlay: ComponentType<SlotProps> = (props): ReactElement | null => {
    const request = this.pending
    if (request === null) return null

    const t = typeof props.t === 'function' ? props.t : this.translate
    return <SessionDeleteDialog t={t} request={request} onClose={this.close} />
  }
}
