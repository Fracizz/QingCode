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
import { closeTopSheet, startWorkspaceObserver, useWorkspace } from './workspace'

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

  return (
    <div className="qn-app">
      {page === 'connections' && <ConnectionsPage />}
      {workspace && (tab === 'connections' ? <ConnectionsPage /> : <WorkspaceHome key={tab} />)}
      {(workspace || (page === 'connections' && paired && activeId)) && <WorkspaceNav />}
      {page === 'form' && <ConnectionFormPage />}
      {page === 'targets' && <TargetsPage />}
      {page === 'projects' && <ProjectsPage />}
      {page === 'threads' && <ThreadsPage />}
      {page === 'chat' && (
        <Suspense fallback={<Loading text="正在打开会话…" />}>
          <ChatPage />
        </Suspense>
      )}
      <CredentialDialog />
      <DirectoryDialog />
      <FileViewer />
    </div>
  )
}
