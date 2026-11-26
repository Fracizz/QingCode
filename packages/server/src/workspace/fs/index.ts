import type { WorkspaceHandlers } from '../registry'
import { fsCreateFile, fsDelete, fsMkdir, fsRead, fsRename, fsStat, fsWrite } from './ops'
import { fsSearch, fsSearchCancel } from './search'
import { listProjectFiles, readProjectFile, searchProjectFiles } from './projectFiles'
import { fsWatch } from './watch'

export const fsHandlers: WorkspaceHandlers = {
  'fs.stat': fsStat,
  'fs.read': fsRead,
  'fs.write': fsWrite,
  'fs.mkdir': fsMkdir,
  'fs.createFile': fsCreateFile,
  'fs.rename': fsRename,
  'fs.delete': fsDelete,
  'fs.search': fsSearch,
  'fs.searchCancel': fsSearchCancel,
  'fs.project.list': listProjectFiles,
  'fs.project.search': searchProjectFiles,
  'fs.project.read': readProjectFile,
  'fs.watch': fsWatch,
}
