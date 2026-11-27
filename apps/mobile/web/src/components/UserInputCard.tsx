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
import { MessageCircleQuestion } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card } from './ui'

/**
 * 手机端回答 Agent 的提问（含 Claude 的 AskUserQuestion、pi 扩展对话框与 MCP 表单）。
 * 选项做成整行按钮便于点按；"跳过"或"拒绝"提交空答案。
 */
export function UserInputCard({ approval, submitting, offline, onSubmit }: {
  approval: ApprovalView
  submitting: boolean
  offline: boolean
  onSubmit: (answers: Record<string, string[]>) => void
}) {
  const questions = approval.questions ?? []
  const [drafts, setDrafts] = useState<Record<string, UserInputDraft>>({})
  const answers = userInputAnswers(questions, drafts)
  const complete = userInputComplete(questions, answers)
  const disabled = submitting || offline

  const update = (question: UserInputQuestion, change: (draft: UserInputDraft) => UserInputDraft) =>
    setDrafts((current) => ({ ...current, [question.id]: change(current[question.id] ?? initialUserInputDraft(question)) }))

  return (
    <Card className="qn-approval">
      <div className="mb-3 flex items-center gap-2">
        <MessageCircleQuestion size={16} className="shrink-0 text-qn-accent" aria-hidden />
        <span className="min-w-0 flex-1 text-sm font-medium break-words">{translateMessage(approval.title)}</span>
        <Badge tone="warn">{submitting ? t('正在提交') : t('等待回答')}</Badge>
      </div>
      {approval.intro && (
        <p className="mb-3 max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs text-qn-muted">{approval.intro}</p>
      )}
      <div className="flex flex-col gap-4">
        {questions.map((question) => {
          const draft = drafts[question.id] ?? initialUserInputDraft(question)
          return (
            <fieldset key={question.id} className="min-w-0" disabled={disabled}>
              <legend className="mb-2 whitespace-pre-wrap text-sm break-words">
                {question.header && <span className="mr-2 text-xs text-qn-muted">{question.header}</span>}
                {question.question}
                {question.multiSelect && <span className="ml-1 text-xs text-qn-muted">{t('（可多选）')}</span>}
                {question.optional && <span className="ml-1 text-xs text-qn-muted">{t('（选填）')}</span>}
              </legend>
              {question.options.length > 0 && (
                <div className="mb-2 flex flex-col gap-2" role={question.multiSelect ? 'group' : 'radiogroup'}>
                  {question.options.map((option) => {
                    const selected = draft.picked.includes(option.label)
                    return (
                      <button
                        key={option.label}
                        type="button"
                        role={question.multiSelect ? 'checkbox' : 'radio'}
                        aria-checked={selected}
                        onClick={() => update(question, (value) => pickUserInputOption(question, value, option.label))}
                        className={`rounded-lg border px-3 py-2.5 text-left ${selected ? 'border-qn-accent bg-qn-accent/10' : 'border-qn-outline'}`}
                      >
                        <div className="text-sm break-words">{question.localizedOptions ? translateMessage(option.label) : option.label}</div>
                        {option.description && <div className="mt-0.5 text-xs text-qn-muted break-words">{option.description}</div>}
                      </button>
                    )
                  })}
                </div>
              )}
              {question.isOther && question.multiline && (
                <textarea
                  className="qn-input min-h-32 w-full py-2 font-mono"
                  value={draft.other}
                  aria-label={question.question}
                  onChange={(event) => update(question, (value) => typeUserInputOther(question, value, event.target.value))}
                />
              )}
              {question.isOther && !question.multiline && (
                <input
                  className="qn-input"
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
      <div className="mt-3 grid grid-cols-2 gap-2" aria-busy={submitting}>
        <Button variant="primary" className="px-2 text-[13px]" disabled={disabled || !complete} onClick={() => onSubmit(answers)}>
          {t('提交回答')}
        </Button>
        <Button className="px-2 text-[13px]" disabled={disabled} onClick={() => onSubmit({})}>
          {approval.skipLabel ?? t('跳过')}
        </Button>
      </div>
    </Card>
  )
}
