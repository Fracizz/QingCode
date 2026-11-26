import { lazy, Suspense, useEffect, useState } from 'react'
import { callDevice } from './client'
import { ConnectionFormPage, ConnectionsPage } from './components/ConnectionPages'
import { CredentialDialog, DirectoryDialog } from './components/Dialogs'
import { FileViewer } from './components/FileViewer'
import { ProjectsPage } from './components/ProjectsPage'
import { TargetsPage } from './components/TargetsPage'
import { ThreadsPage } from './components/ThreadsPage'
import { WorkspaceHome, WorkspaceNav } from './components/WorkspaceHome'
import { Loading } from './components/ui'
import { parsePairingLink } from './link'
import { getWindowNativePort } from './native'
import { useApp } from './store'
import { closeTopSheet, startWorkspaceObserver, useWorkspace, type WorkspaceTab } from './workspace'

// 页面层级决定切换方向：进入更深一层从右侧推入，返回从左侧滑入；底部导航按左右顺序滑入。
const PAGE_DEPTH: Record<string, number> = { workspace: 0, connections: 0, form: 1, targets: 1, projects: 2, threads: 3, chat: 4 }
const TAB_ORDER: WorkspaceTab[] = ['sessions', 'projects', 'connections']
type PageDir = 'none' | 'forward' | 'back' | 'left' | 'right'

function pageDirection(from: string, to: string): PageDir {
  const [fromPage, fromTab] = from.split(':')
  const [toPage, toTab] = to.split(':')
  if (fromPage === 'workspace' && toPage === 'workspace') {
    return TAB_ORDER.indexOf(toTab as WorkspaceTab) > TAB_ORDER.indexOf(fromTab as WorkspaceTab) ? 'right' : 'left'
  }
  return (PAGE_DEPTH[toPage!] ?? 0) >= (PAGE_DEPTH[fromPage!] ?? 0) ? 'forward' : 'back'
}

const ChatPage = lazy(async () => ({ default: (await import('./components/ChatPage')).ChatPage }))

declare global {
  interface Window {
    __qnPairLink?: (value: string) => boolean
  }
}

export function App() {
  const page = useApp((s) => s.page)
  const booting = useApp((s) => s.booting)
  const savingPair = useApp((s) => s.form?.saving)
  const paired = useApp((s) => s.connections.length > 0)
  const activeId = useApp((s) => s.activeId)
  const init = useApp((s) => s.init)
  const tab = useWorkspace((s) => s.tab)
  const [pairLink, setPairLink] = useState<string | null>(null)
  const eventsConnected = useApp((s) => s.eventsConnected)

  useEffect(() => {
    const stopObserving = startWorkspaceObserver()
    const dispose = init()
    const goBack = () => closeTopSheet() || useApp.getState().goBack()
    window.__qnBack = goBack
    return () => {
      stopObserving()
      dispose()
      if (window.__qnBack === goBack) delete window.__qnBack
    }
  }, [init])

  useEffect(() => {
    if (!getWindowNativePort()) return
    let disposed = false
    const receive = (link: string) => {
      if (disposed || !parsePairingLink(link)) return false
      setPairLink(link)
      return true
    }
    window.__qnPairLink = receive
    void callDevice<string | null>('pair.pending', {}).then((link) => {
      if (link) receive(link)
    }).catch(() => undefined)
    return () => {
      disposed = true
      if (window.__qnPairLink === receive) delete window.__qnPairLink
    }
  }, [])

  useEffect(() => {
    if (booting || !pairLink) return
    if (savingPair) return
    closeTopSheet()
    const state = useApp.getState()
    if (state.form?.mode !== 'repair') state.openAddForm()
    useApp.getState().setFormPaste(pairLink)
    useApp.getState().parsePaste()
    setPairLink(null)
  }, [booting, pairLink, savingPair])

  useEffect(() => {
    useWorkspace.getState().setTab('sessions')
  }, [activeId])

  const workspace = paired && page === 'workspace'
  const pageKey = workspace ? `workspace:${tab}` : page
  // 方向随页面变化一次性算出，之后的重渲染沿用，避免动画被重复触发。
  const [nav, setNav] = useState<{ key: string; dir: PageDir }>({ key: pageKey, dir: 'none' })
  if (nav.key !== pageKey) setNav({ key: pageKey, dir: pageDirection(nav.key, pageKey) })
  const glow = !activeId ? 'off' : eventsConnected ? 'online' : 'connecting'

  return (
    <div className="qn-app">
      {(workspace || page === 'connections') && <div className="qn-glow" data-state={glow} aria-hidden />}
      <div key={pageKey} className="qn-page" data-dir={nav.key === pageKey ? nav.dir : 'none'}>
        {page === 'connections' && <ConnectionsPage />}
        {workspace && (tab === 'connections' ? <ConnectionsPage /> : <WorkspaceHome />)}
        {page === 'form' && <ConnectionFormPage />}
        {page === 'targets' && <TargetsPage />}
        {page === 'projects' && <ProjectsPage />}
        {page === 'threads' && <ThreadsPage />}
        {page === 'chat' && (
          <Suspense fallback={<Loading text="正在打开会话…" />}>
            <ChatPage />
          </Suspense>
        )}
      </div>
      {(workspace || (page === 'connections' && paired && activeId)) && <WorkspaceNav />}
      <CredentialDialog />
      <DirectoryDialog />
      <FileViewer />
    </div>
  )
}
