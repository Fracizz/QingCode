/**
 * Worker Pool - 管理 Web Worker 池
 *
 * 提供统一的 Worker 创建、复用和销毁管理
 */

export type WorkerTask<TRequest, TResponse> = {
  id: number
  request: TRequest
  resolve: (value: TResponse) => void
  reject: (reason: Error) => void
  timeout: ReturnType<typeof setTimeout>
  worker?: Worker
}

export class WorkerPool<TRequest, TResponse> {
  private workers: Worker[] = []
  private tasks: Map<number, WorkerTask<TRequest, TResponse>> = new Map()
  private taskId = 0
  private workerUrl: string
  private maxWorkers: number
  private idleWorkers: Worker[] = []

  constructor(workerUrl: string, maxWorkers = navigator.hardwareConcurrency || 4) {
    this.workerUrl = workerUrl
    this.maxWorkers = maxWorkers
  }

  /** 获取或创建一个 Worker */
  private getWorker(): Worker {
    if (this.idleWorkers.length > 0) {
      return this.idleWorkers.pop()!
    }
    if (this.workers.length < this.maxWorkers) {
      const worker = new Worker(this.workerUrl, { type: 'module' })
      worker.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data)
      }
      worker.onerror = (error) => {
        console.error('[WorkerPool] Worker error:', error)
      }
      this.workers.push(worker)
      return worker
    }
    // 达到上限，复用第一个（简单轮询）
    return this.workers[0]
  }

  /** 处理 Worker 返回的消息 */
  private handleMessage(data: TResponse & { id: number }) {
    const task = this.tasks.get(data.id)
    if (!task) return
    clearTimeout(task.timeout)
    this.tasks.delete(data.id)
    // 将 Worker 标记为空闲
    const worker = this.workers.find(w => w === task.worker)
    if (worker) {
      this.idleWorkers.push(worker)
    }
    // 这里假设 response 包含 success 字段
    if ((data as any).success) {
      task.resolve(data)
    } else {
      task.reject(new Error((data as any).error || 'Worker task failed'))
    }
  }

  /** 执行任务 */
  execute(request: TRequest, timeoutMs = 30000): Promise<TResponse> {
    return new Promise((resolve, reject) => {
      this.taskId++
      const id = this.taskId
      const worker = this.getWorker()

      const timeout = setTimeout(() => {
        this.tasks.delete(id)
        reject(new Error(`Worker task timeout after ${timeoutMs}ms`))
      }, timeoutMs)

      const task: WorkerTask<TRequest, TResponse> = {
        id,
        request,
        resolve: resolve as any,
        reject,
        timeout,
      }
      ;(task as any).worker = worker

      this.tasks.set(id, task)
      worker.postMessage({ ...request, id })
    })
  }

  /** 销毁所有 Worker */
  destroy() {
    this.workers.forEach(w => w.terminate())
    this.workers = []
    this.idleWorkers = []
    this.tasks.forEach(task => {
      clearTimeout(task.timeout)
      task.reject(new Error('Worker pool destroyed'))
    })
    this.tasks.clear()
  }
}

/** 格式化 Worker 池 */
let formatWorkerPool: WorkerPool<any, any> | null = null

export function getFormatWorkerPool(): WorkerPool<any, any> {
  if (!formatWorkerPool) {
    formatWorkerPool = new WorkerPool('/src/workers/formatWorker.ts')
  }
  return formatWorkerPool
}

/** 编码检测 Worker 池 */
let encodingWorkerPool: WorkerPool<any, any> | null = null

export function getEncodingWorkerPool(): WorkerPool<any, any> {
  if (!encodingWorkerPool) {
    encodingWorkerPool = new WorkerPool('/src/workers/encodingWorker.ts')
  }
  return encodingWorkerPool
}

/** 销毁所有 Worker 池 */
export function destroyAllWorkerPools() {
  formatWorkerPool?.destroy()
  formatWorkerPool = null
  encodingWorkerPool?.destroy()
  encodingWorkerPool = null
}