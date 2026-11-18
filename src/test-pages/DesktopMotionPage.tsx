import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import ModalOverlay from '../components/ModalOverlay'
import ContextMenu from '../components/ContextMenu'
import ConfirmDialog from '../components/ConfirmDialog'
import Toaster from '../components/Toaster'
import AppearanceSettingsSection from '../components/settings/AppearanceSettingsSection'
import { DEFAULT_FONT_SETTINGS } from '../lib/fontSettings'
import { applyMotionPreference, loadMotionPreference } from '../lib/motionPreferences'
import { useProjectStore } from '../store/projectStore'
import { confirmDialog } from '../store/confirmStore'
import '../App.css'

// 与 main.tsx 一致：首帧前写入 html[data-motion]。
applyMotionPreference(loadMotionPreference())

type Layer = 'none' | 'draft' | 'replacement' | 'menu-dialog'

function DraftDialog({ title, onClose, onReplace }: { title: string; onClose: () => void; onReplace?: () => void }) {
  return (
    <ModalOverlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="modal-content-enter relative w-full max-w-[420px] rounded-lg border border-border-strong bg-bg-elevated p-4 shadow-elevation-3"
      >
        <h2 className="mb-3 text-ui-lg">{title}</h2>
        <input data-testid="draft" className="setting-control w-full" defaultValue="" />
        <div className="mt-3 h-24 overflow-auto" data-testid="scroller">
          {Array.from({ length: 20 }, (_, i) => <p key={i}>第 {i + 1} 行</p>)}
        </div>
        <div className="mt-3 flex gap-2">
          {onReplace && <button type="button" onClick={onReplace}>换成另一个弹窗</button>}
          <button type="button" onClick={onClose}>关闭</button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function Page() {
  const [layer, setLayer] = useState<Layer>('none')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <main className="h-full overflow-auto bg-bg p-5 text-fg">
      <h1 className="mb-4 text-ui-lg">电脑端浮层动效 Web 验收</h1>
      <div className="mb-4 flex flex-wrap gap-3">
        <button type="button" data-testid="open-draft" onClick={() => setLayer('draft')}>打开弹窗</button>
        <button type="button" data-testid="open-confirm" onClick={() => { void confirmDialog({ title: '删除文件？', message: '此操作不可撤销。', kind: 'danger', confirmLabel: '删除' }) }}>打开确认框</button>
        <button
          type="button"
          data-testid="open-menu"
          onClick={event => setMenu({ x: event.clientX, y: event.clientY + 12 })}
        >
          打开菜单
        </button>
        <button type="button" data-testid="push-toast" onClick={() => {
          // test:web 把 projectStore 换成只记录调用的替身，这里直接写入通知列表，渲染真实 Toaster。
          useProjectStore.setState(s => ({ toasts: [...s.toasts, { id: crypto.randomUUID(), kind: 'info', text: `已保存 ${s.toasts.length + 1} 个文件` }] }))
        }}>推送通知</button>
      </div>
      <section className="max-w-[720px]">
        <AppearanceSettingsSection
          match={() => true}
          workspaceLocked={false}
          theme="dark"
          onThemeChange={() => {}}
          fonts={DEFAULT_FONT_SETTINGS}
          onFontChange={() => {}}
        />
      </section>
      {layer === 'draft' && (
        <DraftDialog title="编辑草稿" onClose={() => setLayer('none')} onReplace={() => setLayer('replacement')} />
      )}
      {layer === 'replacement' && <DraftDialog title="替换后的弹窗" onClose={() => setLayer('none')} />}
      {layer === 'menu-dialog' && <DraftDialog title="从菜单打开" onClose={() => setLayer('none')} />}
      <ConfirmDialog />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: '从菜单打开弹窗', action: () => setLayer('menu-dialog') },
            { label: '什么也不做', action: () => {} },
          ]}
        />
      )}
      <Toaster />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Page />)
