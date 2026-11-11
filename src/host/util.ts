/**
 * 宿主半的通用小工具。
 *
 * @module host/util
 */

/**
 * 把任意抛出值转成可读文本。
 *
 * 不用 `String(error)` 直接拼接，是为了在 `Error` 实例上优先取 `message`，
 * 避免出现 "Error: xxx" 这类重复前缀。
 *
 * @param error 任意抛出值
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 安全读取错误的 `name` 字段。
 *
 * DSH 的持久化层错误是跨包实例，不能依赖 `instanceof`；原实现就是按 error.name
 * 字符串判断，这里保持同样的兼容策略。
 *
 * @param error 任意抛出值
 */
export function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' ? name : undefined
}
