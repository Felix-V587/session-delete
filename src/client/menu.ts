/**
 * 会话右键菜单贡献。
 *
 * 只在“会话已落盘且当前不活跃”时展示删除入口：
 * - `status === null`：接口不可用或会话不存在，静默不展示；
 * - `live`：活跃会话不能删除，静默不展示（而不是展示一个注定失败的动作）。
 *
 * @module client/menu
 */

import { fetchStatus } from './api.ts'
import type { ClientContext } from './context.ts'
import type { ConfirmController } from './overlay.tsx'

/** 菜单贡献 id。 */
export const MENU_ID = 'session-delete'

/** 菜单排序权重：放在 DSH 内置会话动作之后。 */
export const MENU_ORDER = 900

/**
 * 注册会话右键菜单贡献。
 *
 * @param ctx 客户端上下文
 * @param controller 对话框控制器（菜单动作打开它）
 * @returns 注销该菜单贡献的 disposer
 */
export function registerSessionDeleteMenu(ctx: ClientContext, controller: ConfirmController): () => void {
  return ctx.contextMenus.register({
    id: MENU_ID,
    target: 'session',
    order: MENU_ORDER,
    resolve: async (target, signal) => {
      const status = await fetchStatus(target.sessionId, signal)

      if (status === null || status.exists !== true || status.live !== false) return []

      return [
        {
          id: 'delete',
          label: controller.translator('menu.delete'),
          danger: true,
          separatorBefore: true,
          failureLabel: controller.translator('menu.failure'),
          run: () => {
            controller.open({
              sessionId: target.sessionId,
              displayTitle: target.displayTitle,
              archived: status.archived === true,
              onDeleted: (warnings) => {
                ctx.contextMenus.notify(controller.translator('notify.deleted'), true)

                if (warnings.length > 0) {
                  console.warn('session-delete: cleanup warnings', warnings)
                }

                try {
                  // 刷新左侧会话列表，让已删除的会话立即消失；失败不影响删除结果。
                  void Promise.resolve(ctx.sessions.refresh()).catch(() => {})
                } catch {
                  // refresh 同步抛错同样忽略：删除已经成功，刷新只是尽力而为。
                }
              },
            })
          },
        },
      ]
    },
  })
}
