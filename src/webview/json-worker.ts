/**
 * JSON 处理 Web Worker：大文件（>100KB）时卸载主线程。
 * 宿主通过 postMessage 发送请求，Worker 完成后 postMessage 返回结果。
 */
import { parseJsonLoose, toYaml, toXml, toCsv, generateTypes, jsonPath } from '../logic/jsonx';

export interface WorkerRequest {
  id: number;
  action: 'parse' | 'format' | 'convert' | 'codegen' | 'path' | 'diff';
  input: string;
  options?: {
    tab?: string;
    convertFmt?: string;
    codegenLang?: string;
    path?: string;
    diffB?: string;
    indent?: number;
  };
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
  elapsedMs: number;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, action, input, options } = e.data;
  const start = performance.now();
  try {
    let result: unknown;
    switch (action) {
      case 'parse': {
        result = parseJsonLoose(input);
        break;
      }
      case 'format': {
        const parsed = parseJsonLoose(input);
        if (!parsed.ok) { result = parsed; break; }
        const indent = options?.indent ?? 2;
        if (options?.tab === 'compress') {
          result = { ok: true, output: JSON.stringify(parsed.data) };
        } else if (options?.tab === 'sort') {
          result = { ok: true, output: JSON.stringify(parsed.data, sortedKeys(parsed.data), indent) };
        } else {
          result = { ok: true, output: JSON.stringify(parsed.data, null, indent) };
        }
        break;
      }
      case 'convert': {
        const parsed = parseJsonLoose(input);
        if (!parsed.ok) { result = parsed; break; }
        const fmt = options?.convertFmt || 'yaml';
        result = {
          ok: true,
          output: fmt === 'yaml' ? toYaml(parsed.data) : fmt === 'xml' ? toXml(parsed.data) : toCsv(parsed.data),
        };
        break;
      }
      case 'codegen': {
        const parsed = parseJsonLoose(input);
        if (!parsed.ok) { result = parsed; break; }
        const lang = (options?.codegenLang || 'ts') as 'ts' | 'java' | 'go' | 'kotlin';
        const types = generateTypes(parsed.data);
        result = { ok: true, output: types[lang] };
        break;
      }
      case 'path': {
        const parsed = parseJsonLoose(input);
        if (!parsed.ok) { result = parsed; break; }
        const pathResult = jsonPath(parsed.data, options?.path || '$');
        result = { ok: true, output: JSON.stringify(pathResult, null, 2) };
        break;
      }
      case 'diff': {
        const a = parseJsonLoose(input);
        const b = parseJsonLoose(options?.diffB || '');
        if (!a.ok || !b.ok) { result = { ok: false, error: '两侧都需要是合法 JSON' }; break; }
        const aStr = JSON.stringify(a.data, null, 2);
        const bStr = JSON.stringify(b.data, null, 2);
        result = { ok: true, output: aStr === bStr ? '两份 JSON 完全一致' : diffSimple(aStr, bStr) };
        break;
      }
      default:
        result = { ok: false, error: '未知操作: ' + action };
    }
    const resp: WorkerResponse = { id, ok: true, data: result, elapsedMs: performance.now() - start };
    self.postMessage(resp);
  } catch (err: any) {
    const resp: WorkerResponse = { id, ok: false, error: err?.message || String(err), elapsedMs: performance.now() - start };
    self.postMessage(resp);
  }
};

function sortedKeys(obj: unknown): string[] | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  return Object.keys(obj as object).sort();
}

function diffSimple(a: string, b: string): string {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const out: string[] = [];
  const maxLines = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < maxLines; i++) {
    const al = aLines[i], bl = bLines[i];
    if (al === bl) out.push('  ' + (al ?? ''));
    else {
      if (al !== undefined) out.push('- ' + al);
      if (bl !== undefined) out.push('+ ' + bl);
    }
  }
  return out.join('\n');
}
