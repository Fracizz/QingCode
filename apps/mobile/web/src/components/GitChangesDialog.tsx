import { t } from '@qn/codex-client'
import { useEffect, useState } from 'react'
import { getGateway } from '../client'
import { useApp } from '../store'
import { viewerError } from '../viewer'
import { DiffView } from './FileViewer'
import { Button, Dialog, Loading, Note } from './ui'

type GitDiff = { diff: string; truncated: boolean }
type ReadResult = { staged: boolean; diff: GitDiff } | { staged: boolean; error: string }

export function GitChangesDialog({ targetId, cwd, onClose }: { targetId: string; cwd: string; onClose: () => void }) {
  const connection = useApp((state) => state.connections.find((item) => item.id === state.activeId))
  const [staged, setStaged] = useState(false)
  const [result, setResult] = useState<ReadResult>()
  useEffect(() => {
    if (!connection) return
    let current = true
    void getGateway().rpc<GitDiff>(connection, 'server.req', {
      targetId, method: 'git.diff', params: { cwd, staged },
    }).then((diff) => {
      if (!current) return
      setResult(typeof diff?.diff === 'string' ? { staged, diff } : { staged, error: t('电脑返回的 Git 差异格式不正确') })
    }, (error: unknown) => {
      if (current) setResult({ staged, error: viewerError(error, t('读取 Git 差异失败')) })
    })
    return () => { current = false }
  }, [connection, targetId, cwd, staged])

  return <Dialog title={t('Git 差异')} onClose={onClose} placement="full">
    <div className="qn-segment mb-3" aria-label={t('差异范围')}>
      <Button aria-pressed={!staged} onClick={() => setStaged(false)}>{t('未暂存')}</Button>
      <Button aria-pressed={staged} onClick={() => setStaged(true)}>{t('已暂存')}</Button>
    </div>
    {!connection ? <Note tone="error" message={t('请先连接电脑')} />
      : result?.staged !== staged ? <Loading text={t('正在读取 Git 差异…')} />
        : 'error' in result ? <Note tone="error" message={result.error} />
          : result.diff.diff ? <>
            {result.diff.truncated && <Note tone="warn" message={t('差异已截断')} />}
            <DiffView text={result.diff.diff} />
          </> : <p className="py-4 text-center text-sm text-qn-muted">{t('暂无差异')}</p>}
  </Dialog>
}
