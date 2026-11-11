/**
 * 删除确认对话框。
 *
 * 交互刻意做成两步，避免误触即删：
 * 1. `risk`：说明删除的不可逆后果与副作用；
 * 2. `confirm`：显示会话标题，要求再次确认。
 *
 * 请求失败时对话框保持打开并显示本地化错误，用户可以取消或重试。
 *
 * @module client/dialog
 */

import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import { interpretDeleteResult, requestDelete } from './api.ts'
import { interpolate, type Translator } from './i18n.ts'
import { styles } from './styles.ts'

/** 一次待执行的删除请求。 */
export interface PendingDeleteRequest {
  /** 会话 id。 */
  readonly sessionId: string
  /** 会话标题（用于两步确认里的“{title}”占位符）。 */
  readonly displayTitle: string
  /** 删除前该会话是否处于归档状态（仅用于日志/调试上下文）。 */
  readonly archived: boolean
  /**
   * 删除成功后的回调。
   *
   * @param warnings 宿主在删除后执行的清理步骤产生的告警
   */
  onDeleted(warnings: readonly string[]): void
}

/** 对话框属性。 */
export interface SessionDeleteDialogProps {
  /** 翻译函数。 */
  readonly t: Translator
  /** 待删除的会话上下文。 */
  readonly request: PendingDeleteRequest
  /** 关闭对话框。 */
  readonly onClose: () => void
}

/** 风险条目在词典中的键，顺序即展示顺序。 */
const RISK_KEYS: readonly string[] = ['risk.item1', 'risk.item2', 'risk.item3', 'risk.item4']

/**
 * 删除确认对话框组件。
 */
export function SessionDeleteDialog({ t, request, onClose }: SessionDeleteDialogProps): ReactElement {
  const [step, setStep] = useState<'risk' | 'confirm'>('risk')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 请求关闭：删除进行中时忽略，避免请求还在飞就卸载对话框。 */
  const close = (): void => {
    if (busy) return
    onClose()
  }

  /** 真正发起删除。 */
  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const { response, payload } = await requestDelete(request.sessionId)
      const outcome = interpretDeleteResult(response.ok, payload, t)

      if (!outcome.ok) {
        setError(outcome.message)
        setBusy(false)
        return
      }

      // 先关闭对话框再通知刷新：销毁插槽后本组件不再渲染，可避免卸载后 setState。
      onClose()
      request.onDeleted(outcome.warnings)
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setBusy(false)
    }
  }

  /** 正文随步骤变化：风险说明 / 最后确认。 */
  const body: ReactNode =
    step === 'risk' ? (
      <>
        <div style={styles.riskLead}>{t('risk.lead')}</div>
        <ul style={styles.riskList}>
          {RISK_KEYS.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
      </>
    ) : (
      <div style={styles.finalBody}>{interpolate(t('finalBody'), { title: request.displayTitle })}</div>
    )

  /** 底部操作区：取消 + 继续 / 永久删除。 */
  const footer: ReactNode = (
    <div style={styles.footer}>
      <button type="button" style={styles.baseButton} disabled={busy} onClick={close}>
        {t('cancel')}
      </button>
      {step === 'risk' ? (
        <button type="button" style={styles.primaryButton} onClick={() => setStep('confirm')}>
          {t('continue')}
        </button>
      ) : (
        <button
          type="button"
          style={styles.dangerButton}
          disabled={busy}
          onClick={() => {
            void confirm()
          }}
        >
          {busy ? t('deleting') : t('deletePermanent')}
        </button>
      )}
    </div>
  )

  const description =
    step === 'risk' ? interpolate(t('desc'), { title: request.displayTitle }) : undefined

  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={step === 'risk' ? t('title') : t('finalTitle')}
      description={description}
      footer={footer}
    >
      {body}
      {error !== null ? (
        <div role="alert" style={styles.errorText}>
          {error}
        </div>
      ) : null}
    </Modal>
  )
}
