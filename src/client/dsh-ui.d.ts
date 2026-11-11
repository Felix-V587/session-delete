/**
 * DSH 客户端 UI 基础组件的最小类型声明。
 *
 * 契约取自 DSH 0.2.2-rc.1 的 `@deepseek-ai/dsh-client-ui-primitives` 运行时。
 * 只声明本插件实际使用的 Modal：引入整个私有类型包会带来大量版本锁定的 peer
 * 依赖，对一个本地插件来说不划算。
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, ReactNode } from 'react'

  /** 模态框属性（只声明本插件用到的字段）。 */
  export interface ModalProps {
    /** 是否打开。 */
    readonly open: boolean
    /** 请求关闭（Esc、遮罩点击、关闭按钮都会触发）。 */
    readonly onClose: () => void
    /** 关闭按钮的无障碍文案。 */
    readonly closeLabel?: string
    /** 标题。 */
    readonly title?: ReactNode
    /** 标题下方的说明文本。 */
    readonly description?: ReactNode | undefined
    /** 底部操作区。 */
    readonly footer?: ReactNode
    /** 正文内容。 */
    readonly children?: ReactNode
  }

  /** DSH 提供的模态框组件。 */
  export const Modal: ComponentType<ModalProps>
}
