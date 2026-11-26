import { useEffect } from 'react'
import { ChatPage } from './components/ChatPage'
import { ConnectionFormPage, ConnectionsPage } from './components/ConnectionPages'
import { CredentialDialog, DirectoryDialog } from './components/Dialogs'
import { FileViewer } from './components/FileViewer'
import { ProjectsPage } from './components/ProjectsPage'
import { TargetsPage } from './components/TargetsPage'
import { ThreadsPage } from './components/ThreadsPage'
import { useApp } from './store'

export function App() {
  const page = useApp((s) => s.page)
  const init = useApp((s) => s.init)

  useEffect(() => init(), [init])

  return (
    <div className="qn-app">
      {page === 'connections' && <ConnectionsPage />}
      {page === 'form' && <ConnectionFormPage />}
      {page === 'targets' && <TargetsPage />}
      {page === 'projects' && <ProjectsPage />}
      {page === 'threads' && <ThreadsPage />}
      {page === 'chat' && <ChatPage />}
      <CredentialDialog />
      <DirectoryDialog />
      <FileViewer />
    </div>
  )
}
