import {
  initialUserInputDraft,
  pickUserInputOption,
  t,
  translateMessage,
  typeUserInputOther,
  userInputAnswers,
  userInputComplete,
  type ApprovalView,
  type UserInputDraft,
  type UserInputQuestion,
} from '@qn/codex-client'
import { Check, MessageCircleQuestion } from 'lucide-react'
import { useState } from 'react'
import { twoColumnOptions } from '../userInputLayout'
import { Badge, Button, Card } from './ui'

/**
 * 手机端回答 Agent 的提问（含 Claude 的 AskUserQuestion、pi 扩展对话框与 MCP 表单）。
 * 手机屏幕矮，多个问题分页显示，一次只看一题；"跳过"或"拒绝"提交空答案。
 */
export function UserInputCard({ approval, submitting, offline, onSubmit, allowSkip = true }: {
  approval: Pick<ApprovalView, 'title' | 'questions' | 'intro' | 'skipLabel'>
  submitting: boolean
  offline: boolean
  onSubmit: (answers: Record<string, string[]>) => void
  allowSkip?: boolean
}) {
  const questions = approval.questions ?? []
  const [drafts, setDrafts] = useState<Record<string, UserInputDraft>>({})
  const answers = userInputAnswers(questions, drafts)
  const complete = userInputComplete(questions, answers)
  const disabled = submitting || offline
  const [step, setStep] = useState(0)
  const index = Math.max(0, Math.min(step, questions.length - 1))
  const paged = questions.length > 1
  const showNext = !complete && index < questions.length - 1

  const update = (question: UserInputQuestion, change: (draft: UserInputDraft) => UserInputDraft) =>
    setDrafts((current) => ({ ...current, [question.id]: change(current[question.id] ?? initialUserInputDraft(question)) }))

  return (
    <Card className="qn-approval">
      <div className="mb-2 flex items-center gap-2">
        <MessageCircleQuestion size={16} className="shrink-0 text-qn-accent" aria-hidden />
        <span className="min-w-0 flex-1 text-sm font-medium break-words">{translateMessage(approval.title)}</span>
        <Badge tone="warn">{submitting ? t('正在提交') : t('等待回答')}</Badge>
      </div>
      {approval.intro && (
        <p className="mb-2 max-h-20 overflow-auto whitespace-pre-wrap break-words text-xs text-qn-muted">{approval.intro}</p>
      )}
      {paged && (
        <div className="mb-2 flex gap-1.5 overflow-x-auto" role="tablist">
          {questions.map((question, position) => (
            <button key={question.id} type="button" role="tab" aria-selected={position === index}
              className={`qn-chip shrink-0${position === index ? ' qn-chip-active' : ''}`} onClick={() => setStep(position)}>
              {answers[question.id]?.length ? <Check size={12} className="shrink-0 text-qn-accent" aria-label={t('已回答')} /> : null}
              <span className="max-w-32 truncate">{question.header || t('第 {index} 题', { index: position + 1 })}</span>
            </button>
          ))}
        </div>
      )}
      <div>
        {questions.slice(index, index + 1).map((question) => {
          const draft = drafts[question.id] ?? initialUserInputDraft(question)
          return (
            <fieldset key={question.id} className="min-w-0" disabled={disabled}>
              <legend className="mb-2 whitespace-pre-wrap text-compact break-words">
                {!paged && question.header && <span className="mr-2 text-xs text-qn-muted">{question.header}</span>}
                {question.question}
                {/* 标记不折行：宁可整体换到下一行，也不拆成「可多 / 选」。 */}
                {question.multiSelect && <span className="ml-1 whitespace-nowrap text-xs text-qn-muted">{t('（可多选）')}</span>}
                {question.optional && <span className="ml-1 whitespace-nowrap text-xs text-qn-muted">{t('（选填）')}</span>}
              </legend>
              {question.options.length > 0 && (
                <div className={twoColumnOptions(question.options) ? 'grid grid-cols-2 gap-1.5' : 'flex flex-col gap-1.5'}
                  role={question.multiSelect ? 'group' : 'radiogroup'}>
                  {question.options.map((option) => {
                    const selected = draft.picked.includes(option.label)
                    return (
                      <button
                        key={option.label}
                        type="button"
                        role={question.multiSelect ? 'checkbox' : 'radio'}
                        aria-checked={selected}
                        onClick={() => update(question, (value) => pickUserInputOption(question, value, option.label))}
                        className="qn-choice"
                      >
                        {/* 选中换青色描边、浅青底并打勾，样式见 .qn-choice。 */}
                        {selected && <Check size={14} strokeWidth={2.25} className="qn-choice-check" aria-hidden />}
                        <div className="text-compact break-words">{question.localizedOptions ? translateMessage(option.label) : option.label}</div>
                        {/* 说明始终显示全文：选中时再展开会让卡片高度跳动。 */}
                        {option.description && <div className="text-xs text-qn-muted break-words">{option.description}</div>}
                      </button>
                    )
                  })}
                </div>
              )}
              {question.isOther && question.multiline && (
                <textarea
                  className={`qn-input min-h-24 w-full py-2 font-mono${question.options.length > 0 ? ' mt-1.5' : ''}`}
                  value={draft.other}
                  aria-label={question.question}
                  onChange={(event) => update(question, (value) => typeUserInputOther(question, value, event.target.value))}
                />
              )}
              {question.isOther && !question.multiline && (
                <input
                  className={`qn-input${question.options.length > 0 ? ' mt-1.5' : ''}`}
                  type={question.isSecret ? 'password' : 'text'}
                  value={draft.other}
                  placeholder={question.options.length > 0 ? t('其他（自行输入）') : t('输入你的回答')}
                  aria-label={question.question}
                  enterKeyHint="done"
                  inputMode={question.inputType ? 'decimal' : undefined}
                  onChange={(event) => update(question, (value) => typeUserInputOther(question, value, event.target.value))}
                />
              )}
            </fieldset>
          )
        })}
      </div>
      <div className={`mt-3 grid gap-2${allowSkip ? ' grid-cols-2' : ''}`} aria-busy={submitting}>
        {allowSkip && <Button className="px-2 text-compact" disabled={disabled} onClick={() => onSubmit({})}>
          {approval.skipLabel ?? t('跳过')}
        </Button>}
        {/* 两个主按钮用不同 key：避免同一次点击先翻到末题、又落在提交按钮上。 */}
        {showNext ? (
          <Button key="next" variant="primary" className="px-2 text-compact" onClick={() => setStep(index + 1)}>
            {t('下一题')}
          </Button>
        ) : (
          <Button key="submit" variant="primary" className="px-2 text-compact" disabled={disabled || !complete} onClick={() => onSubmit(answers)}>
            {t('提交回答')}
          </Button>
        )}
      </div>
    </Card>
  )
}
