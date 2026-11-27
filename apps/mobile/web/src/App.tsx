import { useEffect, useRef, useState } from 'react'
import { callDevice } from './client'
import { ChatPage } from './components/ChatPage'
import { ConnectionFormPage, ConnectionsPage } from './components/ConnectionPages'
import { CredentialDialog, DirectoryDialog } from './components/Dialogs'
import { FileViewer } from './components/FileViewer'
import { ProjectsPage } from './components/ProjectsPage'
import { TargetsPage } from './components/TargetsPage'
import { ThreadsPage } from './components/ThreadsPage'
import { WorkspaceHome, WorkspaceNav } from './components/WorkspaceHome'
import { parsePairingLink } from './link'
import { getWindowNativePort } from './native'
import { useApp } from './store'
import { closeTopSheet, startWorkspaceObserver, useWorkspace } from './workspace'

const PAGE_DEPTH: Record<string, number> = { workspace: 0, connections: 0, form: 1, targets: 1, projects: 2, threads: 3, chat: 4 }
type PageMotion = 'none' | 'forward' | 'back' | 'tab'

function pageMotion(from: string, to: string): PageMotion {
  const [fromPage] = from.split(':')
  const [toPage] = to.split(':')
  if (fromPage === 'workspace' && toPage === 'workspace') return 'tab'
  return (PAGE_DEPTH[toPage!] ?? 0) >= (PAGE_DEPTH[fromPage!] ?? 0) ? 'forward' : 'back'
}

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
  const pageRef = useRef<HTMLDivElement>(null)
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
    useWorkspace.setState({ tab: 'sessions' })
  }, [activeId])

  const workspace = paired && page === 'workspace'
  const showWorkspaceNav = workspace || (page === 'connections' && paired && activeId !== null)
  const pageKey = showWorkspaceNav ? `workspace:${workspace ? tab : 'connections'}` : page
  // 动效随页面变化一次性算出，避免其他状态更新时重新播放。
  const [nav, setNav] = useState<{ key: string; motion: PageMotion }>({ key: pageKey, motion: 'none' })
  if (nav.key !== pageKey) setNav({ key: pageKey, motion: pageMotion(nav.key, pageKey) })
  const glow = !activeId ? 'off' : eventsConnected ? 'online' : 'connecting'

  return (
    <div className="qn-app">
      {(page === 'connections' || (workspace && tab === 'connections')) && <div className="qn-glow" data-state={glow} aria-hidden />}
      <div key={pageKey} ref={pageRef} className="qn-page" data-motion={nav.key === pageKey ? nav.motion : 'none'}>
        {page === 'connections' && <ConnectionsPage />}
        {workspace && (tab === 'connections' ? <ConnectionsPage /> : <WorkspaceHome />)}
        {page === 'form' && <ConnectionFormPage />}
        {page === 'targets' && <TargetsPage />}
        {page === 'projects' && <ProjectsPage />}
        {page === 'threads' && <ThreadsPage />}
        {page === 'chat' && <ChatPage />}
      </div>
      {showWorkspaceNav && <WorkspaceNav onScrollTop={() => pageRef.current?.querySelector('main.qn-scroll')?.scrollTo({ top: 0 })} />}
      <CredentialDialog />
      <DirectoryDialog />
      <FileViewer />
    </div>
  )
}
