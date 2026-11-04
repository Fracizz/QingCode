import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ScmBranchMenu from '../components/ScmBranchMenu'
import type { GitBranchList } from '../lib/git/git'
import { useLocaleStore } from '../lib/i18n'
import '../App.css'

const branches: GitBranchList = {
  local: Array.from({ length: 30 }, (_, index) => ({
    name: `topic-${String(index).padStart(2, '0')}`,
    current: index === 0,
    upstream: index % 2 === 0 ? `origin/topic-${String(index).padStart(2, '0')}` : null,
  })),
  remote: Array.from(
    { length: 20 },
    (_, index) => `origin/remote-${String(index).padStart(2, '0')}`
  ),
}

function Page() {
  const menuRef = useRef<HTMLDivElement>(null)
  const [list, setList] = useState<GitBranchList | null>(branches)
  const [switched, setSwitched] = useState('')
  return (
    <main className="h-full bg-bg p-4 text-fg">
      <div className="flex flex-wrap gap-4">
        <button onClick={() => setList(branches)}>大量分支</button>
        <button onClick={() => setList({ local: branches.local.slice(0, 2), remote: [] })}>
          少量分支
        </button>
        <button onClick={() => setList({ local: [], remote: [] })}>空仓库</button>
        <button onClick={() => setList(null)}>加载中</button>
      </div>
      <output data-testid="switched">{switched}</output>
      <ScmBranchMenu
        menuRef={menuRef}
        style={{
          left: 16,
          top: 90,
          width: 'min(320px, calc(100vw - 32px))',
          maxHeight: 'calc(100vh - 106px)',
        }}
        branchList={list}
        loading={list === null}
        disabled={false}
        onSwitch={setSwitched}
      />
    </main>
  )
}

if (import.meta.env.MODE === 'web-test') {
  useLocaleStore.getState().setLanguage('zh-CN')
  createRoot(document.getElementById('root')!).render(<Page />)
}
