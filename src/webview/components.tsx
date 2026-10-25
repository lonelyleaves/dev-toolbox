import { h, ComponentChildren, JSX } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { host } from './bridge';

/** 复制按钮：调用宿主剪贴板 */
export function CopyBtn({ text, label }: { text: () => string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      class="btn"
      onClick={async () => {
        try {
          await host.copyText(text());
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        } catch {
          /* ignore */
        }
      }}
    >
      {ok ? '✓ 已复制' : label || '复制'}
    </button>
  );
}

export function Btn({
  children, onClick, primary, disabled, title,
}: { children: ComponentChildren; onClick?: () => void; primary?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button class={`btn${primary ? ' primary' : ''}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="card">
      <div class="card-title">{title}</div>
      {children}
    </div>
  );
}

/** 简易本地历史（存宿主 workspaceState） */
export function useHistory(key: string, maxSize = 20) {
  const [items, setItems] = useState<string[]>([]);
  useEffect(() => {
    host.readState<string[]>(`history:${key}`).then((v) => Array.isArray(v) && setItems(v)).catch(() => undefined);
  }, [key]);
  const push = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      setItems((prev) => {
        const next = [text, ...prev.filter((p) => p !== text)].slice(0, maxSize);
        void host.persistState(`history:${key}`, next);
        return next;
      });
    },
    [key, maxSize]
  );
  const clear = useCallback(() => {
    setItems([]);
    void host.persistState(`history:${key}`, []);
  }, [key]);
  return { items, push, clear };
}

/** prefill 统一截断上限：超过该长度的内容送入工具页时截断，避免大文件拖垮渲染 */
export const PREFILL_MAX_CHARS = 20000;

/** 统一截断策略：所有工具页共用，超长时尾部追加省略标记 */
export function clipPrefill(text: string, max = PREFILL_MAX_CHARS): string {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + `\n…（已截断，原文 ${text.length} 字符，上限 ${max}）`;
}

/**
 * 跨面板关闭保持的输入状态（存宿主 workspaceState）。
 * 设计要点：
 * - 首次读取为异步，读取完成前不写回，避免用初始值覆盖已存内容
 * - 一旦用户（或 prefill）改过值就置 dirty，异步读取结果不再覆盖，
 *   保证「右键送入内容」优先于「上次残留内容」
 */
export function usePersistentState(key: string, initial: string) {
  const [value, setValue] = useState(initial);
  const [loaded, setLoaded] = useState(false);
  const dirty = useRef(false);

  useEffect(() => {
    let alive = true;
    dirty.current = false;
    setLoaded(false);
    host.readState<string>(`state:${key}`).then((v) => {
      if (!alive) return;
      if (!dirty.current && typeof v === 'string') setValue(v);
      setLoaded(true);
    }).catch(() => alive && setLoaded(true));
    return () => { alive = false; };
  }, [key]);

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      host.persistState(`state:${key}`, value).catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [key, value, loaded]);

  const set = useCallback((v: string | ((prev: string) => string)) => {
    dirty.current = true;
    setValue(v);
  }, []);

  return [value, set] as const;
}

export function downloadText(filename: string, content: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function copyViaHost(text: string) {
  try {
    await host.copyText(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}
