/**
 * 对话框样式。
 *
 * 颜色全部使用 DSH 设计令牌（`--dsw-*`），并带 fallback，保证在亮/暗主题下
 * 都能正确反色；不写死背景色，避免与宿主主题冲突。
 *
 * @module client/styles
 */

import type { CSSProperties } from 'react'

/** 普通按钮。 */
export const baseButton: CSSProperties = {
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  padding: '7px 14px',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.4,
  cursor: 'pointer',
  color: 'inherit',
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.35))',
}

/** 主按钮（继续）。 */
export const primaryButton: CSSProperties = {
  ...baseButton,
  background: 'var(--dsw-alias-button-elevated-fill, rgba(127,127,127,0.16))',
}

/** 危险按钮（永久删除）。 */
export const dangerButton: CSSProperties = {
  ...baseButton,
  background: 'var(--dsw-alias-state-error-primary, #d93025)',
  borderColor: 'transparent',
  color: '#ffffff',
}

/** 风险说明的引导句。 */
export const riskLead: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-secondary, inherit)',
}

/** 风险条目列表。 */
export const riskList: CSSProperties = {
  margin: '10px 0 0',
  paddingInlineStart: 18,
  display: 'grid',
  gap: 6,
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--dsw-alias-label-secondary, inherit)',
}

/** 最后确认页的正文。 */
export const finalBody: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-secondary, inherit)',
}

/** 底部按钮区。 */
export const footer: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
}

/** 错误提示（role="alert"）。 */
export const errorText: CSSProperties = {
  marginTop: 10,
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-state-error-primary, #d93025)',
}

/** 汇总导出，便于对话框按“样式对象”引用。 */
export const styles = {
  baseButton,
  primaryButton,
  dangerButton,
  riskLead,
  riskList,
  finalBody,
  footer,
  errorText,
} as const
