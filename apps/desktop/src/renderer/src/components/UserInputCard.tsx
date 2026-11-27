import { MessageCircleQuestion } from 'lucide-react'
import { useState } from 'react'
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
import { cn } from '../lib/cn'
import { Badge } from './ui'

type Answers = Record<string, string[]>

/**
 * Agent 向用户提问（含 Claude 的 AskUserQuestion、pi 扩展对话框与 MCP 表单）：
 * 逐题选择或填写，提交后把答案原样交还给对方；"跳过"或"拒绝"表示不回答。
 */
export function UserInputCard({
  approval,
  onSubmit,
}: {
  approval: ApprovalView
  onSubmit: (answers: Answers) => void
}) {
  const questions = approval.questions ?? []
  const [drafts, setDrafts] = useState<Record<string, UserInputDraft>>({})
  const answers: Answers = userInputAnswers(questions, drafts)
  const complete = userInputComplete(questions, answers)

  const update = (question: UserInputQuestion, change: (draft: UserInputDraft) => UserInputDraft) =>
    setDrafts((current) => ({ ...current, [question.id]: change(current[question.id] ?? initialUserInputDraft(question)) }))
  const pick = (question: UserInputQuestion, label: string) =>
    update(question, (draft) => pickUserInputOption(question, draft, label))
  const type = (question: UserInputQuestion, other: string) =>
    update(question, (draft) => typeUserInputOther(question, draft, other))

  return (
    <div className="rounded-lg border border-qn-border-strong bg-qn-accent/5 p-3">
      <div className="mb-3 flex items-center gap-2">
        <MessageCircleQuestion size={15} className="text-qn-accent" />
        <span className="text-ui-md font-medium">{approval.title}</span>
        <Badge tone="warn">{t('等待回答')}</Badge>
      </div>
      {approval.intro && (
        <p className="mb-3 max-h-32 overflow-auto whitespace-pre-wrap break-words text-ui-sm text-qn-muted">{approval.intro}</p>
      )}
      <div className="flex flex-col gap-4">
        {questions.map((question) => {
          const draft = drafts[question.id] ?? initialUserInputDraft(question)
          return (
            <fieldset key={question.id} className="min-w-0">
              <legend className="mb-2 whitespace-pre-wrap break-words text-ui-md">
                {question.header && <span className="mr-2 text-ui-sm text-qn-muted">{question.header}</span>}
                {question.question}
                {question.multiSelect && <span className="ml-1 text-ui-sm text-qn-muted">{t('（可多选）')}</span>}
                {question.optional && <span className="ml-1 text-ui-sm text-qn-muted">{t('（选填）')}</span>}
              </legend>
              {question.options.length > 0 && (
                <div className="mb-2 flex flex-col gap-1.5" role={question.multiSelect ? 'group' : 'radiogroup'}>
                  {question.options.map((option) => {
                    const selected = draft.picked.includes(option.label)
                    return (
                      <button
                        key={option.label}
                        type="button"
                        role={question.multiSelect ? 'checkbox' : 'radio'}
                        aria-checked={selected}
                        onClick={() => pick(question, option.label)}
                        className={cn(
                          'rounded-lg border px-3 py-2 text-left transition-colors',
                          selected ? 'border-qn-accent bg-qn-accent/10' : 'border-qn-outline hover:bg-qn-hover',
                        )}
                      >
                        <div className="text-ui-md">{question.localizedOptions ? translateMessage(option.label) : option.label}</div>
                        {option.description && <div className="mt-0.5 text-ui-sm text-qn-muted">{option.description}</div>}
                      </button>
                    )
                  })}
                </div>
              )}
              {question.isOther && question.multiline && (
                <textarea
                  className="qn-input min-h-32 w-full resize-y py-2 font-mono"
                  value={draft.other}
                  aria-label={question.question}
                  onChange={(event) => type(question, event.target.value)}
                />
              )}
              {question.isOther && !question.multiline && (
                <input
                  className="qn-input"
                  type={question.isSecret ? 'password' : 'text'}
                  inputMode={question.inputType ? 'decimal' : undefined}
                  value={draft.other}
                  placeholder={question.options.length > 0 ? t('其他（自行输入）') : t('输入你的回答')}
                  aria-label={question.question}
                  onChange={(event) => type(question, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing && complete) onSubmit(answers)
                  }}
                />
              )}
            </fieldset>
          )
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="qn-button disabled:opacity-50" disabled={!complete} onClick={() => onSubmit(answers)}>
          {t('提交回答')}
        </button>
        <button className="qn-button-subtle" onClick={() => onSubmit({})}>
          {approval.skipLabel ?? t('跳过')}
        </button>
      </div>
    </div>
  )
}
