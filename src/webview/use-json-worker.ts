/** Worker 通信 hook：大 JSON 操作卸载到 Web Worker */
import { useRef, useCallback, useEffect } from 'preact/hooks';
import type { WorkerRequest, WorkerResponse } from './json-worker';

const LARGE_THRESHOLD = 100 * 1024; // 100KB

let workerInstance: Worker | null = null;
let requestId = 0;
const pending = new Map<number, { resolve: (r: WorkerResponse) => void; timer: ReturnType<typeof setTimeout> }>();

function failAll(error: string) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ id, ok: false, error, elapsedMs: 0 });
  }
  pending.clear();
  workerInstance?.terminate();
  workerInstance = null;
}

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (workerInstance) return workerInstance;
  try {
    // esbuild 会将 json-worker.ts 打包为独立 chunk
    const workerUrl = new URL('./json-worker.js', import.meta.url);
    workerInstance = new Worker(workerUrl, { type: 'module' });
    workerInstance.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const p = pending.get(e.data.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(e.data.id);
        p.resolve(e.data);
      }
    };
    workerInstance.onerror = (e) => { failAll(e.message || 'Worker 运行失败'); };
    workerInstance.onmessageerror = () => { failAll('Worker 消息反序列化失败'); };
    return workerInstance;
  } catch {
    return null;
  }
}

export function callWorker(req: Omit<WorkerRequest, 'id'>): Promise<WorkerResponse> {
  return new Promise((resolve) => {
    const worker = getWorker();
    if (!worker) {
      resolve({ id: -1, ok: false, error: 'Worker 不可用', elapsedMs: 0 });
      return;
    }
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, ok: false, error: 'Worker 超时', elapsedMs: 0 });
    }, 30000);
    pending.set(id, { resolve, timer });
    worker.postMessage({ ...req, id });
  });
}

export function shouldUseWorker(input: string): boolean {
  return input.length > LARGE_THRESHOLD;
}

/** 清理 Worker 引用 */
export function disposeWorker(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
  }
  for (const [, p] of pending) clearTimeout(p.timer);
  pending.clear();
}
