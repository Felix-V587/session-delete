/**
 * 客户端插件入口。
 *
 * 只做三件事：注册词典、绑定翻译函数、注册会话右键菜单。
 * 具体逻辑分散在 `api.ts`（HTTP）、`dialog.tsx`（界面）、`overlay.tsx`（插槽）、
 * `menu.ts`（菜单）中，便于测试与复用。
 *
 * 构建后本模块被 esbuild 打包成 `lib/client.js`，由 DSH 的模块加载器以
 * `window.__ModuleLoader__.load({ id, factory })` 形式懒注册。
 *
 * @module client/index
 */

import type { ClientContext } from './context.ts'
import { DICTS, fallbackTranslate, NS, type Translator } from './i18n.ts'
import { registerSessionDeleteMenu } from './menu.ts'
import { ConfirmController } from './overlay.tsx'

/** 客户端注入的服务名。 */
export const inject: readonly string[] = ['slots', 'locale', 'contextMenus', 'sessions']

/**
 * 客户端插件入口：DSH 在 `inject` 列出的服务全部就绪后调用。
 *
 * @param ctx 客户端上下文
 */
export function apply(ctx: ClientContext): void {
  // 词典按语言逐个注册；register 返回 disposer，交给 effect 在插件卸载时调用。
  for (const [locale, dictionary] of Object.entries(DICTS)) {
    ctx.effect(() => ctx.locale.register(NS, locale, dictionary))
  }

  // 优先使用宿主国际化服务；服务异常时退回内置英文词典，保证菜单始终可读。
  let translate: Translator = fallbackTranslate
  try {
    translate = ctx.locale.bind(NS)
  } catch {
    translate = fallbackTranslate
  }

  const controller = new ConfirmController({ slots: ctx.slots, translate })
  ctx.effect(() => registerSessionDeleteMenu(ctx, controller))
}
