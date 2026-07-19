import { create } from 'zustand'
import {
  getPropertiesLocation,
  loadFileProperties,
  loadFolderEntryCounts,
  type FileProperties,
  type FolderEntryCounts,
} from '../lib/fileProperties'

interface PropertiesState {
  open: boolean
  /** file_stat / ctime / mtime — row-level loading for size (files) and timestamps */
  metaLoading: boolean
  /** recursive folder walk — row-level loading for size / file count / folder count */
  countsLoading: boolean
  title: string
  properties: FileProperties | null
  folderCounts: FolderEntryCounts | null
  error: string | null
  show: (path: string, name: string, isDir: boolean) => Promise<void>
  close: () => void
}

let requestSeq = 0

function shellProperties(path: string, name: string, isDir: boolean): FileProperties {
  return {
    name,
    path,
    location: getPropertiesLocation(path),
    kind: isDir ? 'folder' : 'file',
    createdMs: null,
    modifiedMs: null,
  }
}

export const usePropertiesStore = create<PropertiesState>((set, get) => ({
  open: false,
  metaLoading: false,
  countsLoading: false,
  title: '',
  properties: null,
  folderCounts: null,
  error: null,
  show: async (path, name, isDir) => {
    const seq = ++requestSeq
    const kind = isDir ? 'folder' : 'file'
    set({
      open: true,
      metaLoading: true,
      countsLoading: kind === 'folder',
      title: name,
      properties: shellProperties(path, name, isDir),
      folderCounts: null,
      error: null,
    })

    const metaPromise = loadFileProperties(path, name, isDir)
      .then(properties => {
        if (!get().open || seq !== requestSeq) return
        set({ metaLoading: false, properties, error: null })
      })
      .catch(e => {
        if (!get().open || seq !== requestSeq) return
        set({ metaLoading: false, error: String(e) })
      })

    const countsPromise =
      kind === 'folder'
        ? loadFolderEntryCounts(path)
            .then(folderCounts => {
              if (!get().open || seq !== requestSeq) return
              set({ countsLoading: false, folderCounts })
            })
            .catch(() => {
              if (!get().open || seq !== requestSeq) return
              set({ countsLoading: false, folderCounts: null })
            })
        : Promise.resolve()

    await Promise.all([metaPromise, countsPromise])
  },
  close: () => {
    requestSeq += 1
    set({
      open: false,
      metaLoading: false,
      countsLoading: false,
      properties: null,
      folderCounts: null,
      error: null,
      title: '',
    })
  },
}))

export function showPropertiesDialog(path: string, name: string, isDir: boolean) {
  return usePropertiesStore.getState().show(path, name, isDir)
}
