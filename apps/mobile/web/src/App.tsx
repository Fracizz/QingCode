import { useEffect, useRef, useState } from 'react'
import { useCalmWarning } from './calmWarning'
import { callDevice } from './client'
import { ChatPage } from './components/ChatPage'
import { ConnectionFormPage, ConnectionsPage } from './components/ConnectionPages'
import { CredentialDialog, DirectoryDialog } from './components/Dialogs'
import { FileViewer } from './components/FileViewer'
import { ProjectsPage } from './components/ProjectsPage'
import { TargetsPage } from './components/TargetsPage'
import { Toaster } from './components/Toaster'
import { ThreadsPage } from './components/ThreadsPage'
import { UsageHome } from './components/UsagePage'
import { WorkspaceHome, WorkspaceNav } from './components/WorkspaceHome'
import { Note } from './components/ui'
import { parsePairingLink } from './link'
import { useMobileAppearance } from './mobilePreferences'
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
  useMobileAppearance()
  const page = useApp((s) => s.page)
  const unanimatedNavigation = useApp((s) => s.unanimatedNavigation)
  const booting = useApp((s) => s.booting)
  const savingPair = useApp((s) => s.form?.saving)
  const paired = useApp((s) => s.connections.length > 0)
  const activeId = useApp((s) => s.activeId)
  const init = useApp((s) => s.init)
  const tab = useWorkspace((s) => s.tab)
  const pageRef = useRef<HTMLDivElement>(null)
  const [pairLink, setPairLink] = useState<string | null>(null)
  const eventsConnected = useApp((s) => s.eventsConnected)
  const rawConnectionWarning = useApp((s) => s.activeId && !s.needsRepair[s.activeId] ? s.eventsError : null)
  // 记录当前电脑本次是否连上过：连上过的短暂失联延迟提示，从未连上则立即提示。
  const [connectedDesktop, setConnectedDesktop] = useState<string | null>(null)
  useEffect(() => { if (eventsConnected && activeId) setConnectedDesktop(activeId) }, [eventsConnected, activeId])
  const connectionWarning = useCalmWarning(rawConnectionWarning, connectedDesktop !== null && connectedDesktop === activeId)

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
  const showConnections = page === 'connections' || (workspace && tab === 'connections')
  const showWorkspaceNav = workspace || (page === 'connections' && paired && activeId !== null)
  const pageKey = showWorkspaceNav ? `workspace:${workspace ? tab : 'connections'}` : page
  // 冷启动恢复工作台或会话时由进场页完成转场，手动导航才播放页面动画。
  const [nav, setNav] = useState<{ key: string; motion: PageMotion; unanimatedNavigation: number }>(
    { key: pageKey, motion: 'none', unanimatedNavigation },
  )
  if (nav.key !== pageKey || nav.unanimatedNavigation !== unanimatedNavigation) {
    const motion = nav.key !== pageKey && nav.unanimatedNavigation === unanimatedNavigation ? pageMotion(nav.key, pageKey) : 'none'
    setNav({ key: pageKey, motion, unanimatedNavigation })
  }
  const glow = !activeId ? 'off' : eventsConnected ? 'online' : 'connecting'

  return (
    <div className="qn-app">
      {showConnections && <div className="qn-connection-art" aria-hidden />}
      {workspace && !showConnections && <div className="qn-glow" data-state={glow} aria-hidden />}
      {connectionWarning && page !== 'form' && (
        <div className="qn-app-banner shrink-0 border-b border-qn-border bg-qn-panel px-3 pt-2" role="status">
          <Note message={connectionWarning} tone="warn" />
        </div>
      )}
      <div key={pageKey} ref={pageRef} className="qn-page" data-motion={nav.key === pageKey ? nav.motion : 'none'}>
        {showConnections && <ConnectionsPage />}
        {workspace && !showConnections && (tab === 'usage' ? <UsageHome /> : <WorkspaceHome />)}
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
      <Toaster />
    </div>
  )
}
