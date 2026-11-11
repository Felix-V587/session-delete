/**
 * 客户端国际化的资源与插值工具。
 *
 * 词典键与宿主失败码的映射关系见 `api.ts`；这里只负责“文本 + 占位符替换”。
 * 文案同时内置英文与中文：英文作为兜底（locale 服务尚未就绪时使用），
 * 中文由 `locale.register` 注册给 DSH。
 *
 * @module client/i18n
 */

/** 本插件拥有的语言命名空间。 */
export const NS = '@local/session-delete'

/** 语言到词典的映射类型。 */
export type LocaleDictionary = Readonly<Record<string, string>>

/** 翻译函数：把键转换成当前语言的文本，并替换 `{name}` 占位符。 */
export type Translator = (key: string, vars?: Readonly<Record<string, string | number>>) => string

/** 内置英文词典（兜底）。 */
export const EN: LocaleDictionary = {
  'menu.delete': 'Delete session…',
  'menu.failure': 'Could not delete this session',
  'title': 'Delete this session permanently?',
  'desc': '“{title}” will be erased from disk. This cannot be undone.',
  'risk.lead': 'This permanently removes the session record. Read this before continuing:',
  'risk.item1': 'Every message, tool output, and fork of this session is erased from disk. There is no recycle bin and no undo.',
  'risk.item2': 'Its archive state, pin, projection cache, and reminders that deliver into it are cleared as well.',
  'risk.item3': 'Shared attachments are content-addressed and are not deleted.',
  'risk.item4': 'If the session is still live in the current DSH process, the delete is refused: archive it, restart DSH Web, then delete.',
  'continue': 'Continue',
  'cancel': 'Cancel',
  'deletePermanent': 'Delete permanently',
  'deleting': 'Deleting…',
  'finalTitle': 'Last confirmation',
  'finalBody': 'You are about to permanently delete “{title}”. This action cannot be undone.',
  'close': 'Close',
  'notify.deleted': 'Session deleted',
  'error.live': 'This session is still live in the current DSH process. Archive it, restart DSH Web, then delete it.',
  'error.notFound': 'This session no longer exists.',
  'error.notMaterialized': 'This session has no stored log yet. Try again after restarting DSH Web.',
  'error.unsupportedFormat': 'This session uses an unsupported historical format and cannot be deleted here.',
  'error.filesystem': 'The session files could not be removed. Nothing else was changed.',
  'error.unknown': 'The delete failed for an unknown reason.',
}

/** 内置中文词典。 */
export const ZH: LocaleDictionary = {
  'menu.delete': '删除会话…',
  'menu.failure': '无法删除该会话',
  'title': '永久删除该会话？',
  'desc': '“{title}” 将被从磁盘上抹除，且无法恢复。',
  'risk.lead': '此操作永久删除会话记录，继续前请确认：',
  'risk.item1': '该会话的全部消息、工具输出与分叉记录都会从磁盘删除，不进入回收站，也无法撤销。',
  'risk.item2': '同时清除其归档状态、置顶、投影缓存，并删除投递到该会话的提醒/定时任务。',
  'risk.item3': '共享附件库中的文件不会被删除。',
  'risk.item4': '若该会话仍在当前 DSH 进程内活跃，删除会被拒绝：请先归档，重启 DSH Web 后再删除。',
  'continue': '继续',
  'cancel': '取消',
  'deletePermanent': '永久删除',
  'deleting': '正在删除…',
  'finalTitle': '最后确认',
  'finalBody': '你将永久删除“{title}”。此操作不可撤销。',
  'close': '关闭',
  'notify.deleted': '已删除会话',
  'error.live': '该会话仍在当前 DSH 进程内活跃。请先归档，重启 DSH Web 后再删除。',
  'error.notFound': '该会话已不存在。',
  'error.notMaterialized': '该会话还没有落盘日志，请重启 DSH Web 后再试。',
  'error.unsupportedFormat': '该会话使用不受支持的旧格式，无法在此删除。',
  'error.filesystem': '无法删除会话文件，其他内容未作改动。',
  'error.unknown': '删除失败，原因未知。',
}

/** 注册给 DSH 的词典集合，顺序即注册顺序。 */
export const DICTS: Readonly<Record<string, LocaleDictionary>> = { en: EN, zh: ZH }

/**
 * 替换文本中的 `{name}` 占位符。
 *
 * 占位符对应的值为 `undefined` / `null` 时保留原样，避免出现 “undefined” 字样。
 *
 * @param text 模板文本；非字符串会被安全地转成字符串
 * @param vars 占位符取值
 */
export function interpolate(
  text: unknown,
  vars?: Readonly<Record<string, string | number>> | null,
): string {
  if (typeof text !== 'string') return text === undefined || text === null ? '' : String(text)
  if (vars === undefined || vars === null) return text

  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined || value === null ? match : String(value)
  })
}

/**
 * 基于一个词典创建翻译函数。
 *
 * 词典里没有的键原样返回，便于开发期发现漏翻的文案。
 *
 * @param dictionary 词典
 */
export function createTranslator(dictionary: LocaleDictionary): Translator {
  return (key, vars) => interpolate(dictionary[key] ?? key, vars)
}

/** locale 服务不可用时的兜底翻译函数（英文）。 */
export const fallbackTranslate: Translator = createTranslator(EN)
