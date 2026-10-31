import { h, ComponentChildren, JSX } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { host } from './bridge';
import { normalizeInput } from '../logic/text';
import { buildGutterText, countWrappedRows } from '../logic/wrap';

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

/**
 * 页面内确认弹窗。
 * VS Code Webview 不支持原生 confirm()/prompt()（调用会被忽略），
 * 所以项目清空/删除、配置删除等操作必须用页面内弹窗。
 */
export function useConfirm() {
  const [state, setState] = useState<{ message: string; resolve: (ok: boolean) => void } | null>(null);
  const confirm = useCallback((message: string) => new Promise<boolean>((resolve) => setState({ message, resolve })), []);
  const close = (ok: boolean) => {
    const s = state;
    setState(null);
    s?.resolve(ok);
  };
  const node = state ? (
    <div class="modal-mask" onClick={() => close(false)}>
      <div class="modal-card" onClick={(e) => e.stopPropagation()}>
        <div class="modal-title">请确认</div>
        <div class="modal-body">{state.message}</div>
        <div class="row" style="justify-content:flex-end">
          <Btn onClick={() => close(false)}>取消</Btn>
          <Btn primary onClick={() => close(true)}>确定</Btn>
        </div>
      </div>
    </div>
  ) : null;
  return { confirm, confirmNode: node };
}

/** 页面内输入弹窗（替代原生 prompt） */
export function usePrompt() {
  const [state, setState] = useState<{ message: string; value: string; resolve: (v: string | null) => void } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const open = !!state;
  useEffect(() => {
    // 只在打开时聚焦一次；输入过程中 state 变化不要重复 focus
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);
  const prompt = useCallback((message: string, initial = '') => new Promise<string | null>((resolve) => setState({ message, value: initial, resolve })), []);
  const close = (ok: boolean) => {
    const s = state;
    setState(null);
    s?.resolve(ok ? s.value : null);
  };
  const node = state ? (
    <div class="modal-mask" onClick={() => close(false)}>
      <div class="modal-card" onClick={(e) => e.stopPropagation()}>
        <div class="modal-title">请输入</div>
        <div class="modal-body">{state.message}</div>
        <input
          ref={inputRef}
          type="text"
          value={state.value}
          onInput={(e) => setState({ ...state, value: (e.target as HTMLInputElement).value })}
          onKeyDown={(e) => { if (e.key === 'Enter') close(true); if (e.key === 'Escape') close(false); }}
        />
        <div class="row" style="justify-content:flex-end">
          <Btn onClick={() => close(false)}>取消</Btn>
          <Btn primary onClick={() => close(true)}>确定</Btn>
        </div>
      </div>
    </div>
  ) : null;
  return { prompt, promptNode: node };
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
    let alive = true;
    host.readState<string[]>(`history:${key}`).then((v) => {
      if (alive && Array.isArray(v)) setItems(v);
    }).catch(() => undefined);
    return () => { alive = false; };
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
  // 右键/标签页送入的内容同样可能带 BOM、CRLF，先归一化
  const t = normalizeInput(text);
  if (!t || t.length <= max) return t;
  return t.slice(0, max) + `\n…（已截断，原文 ${t.length} 字符，上限 ${max}）`;
}

/**
 * 带行号的代码输入框。
 * - 支持软换行：超宽内容在框内折行，不再横向滚动
 * - 行号按"视觉行"对齐：逻辑行折行后只在首行显示编号，续行留空
 * - 左侧行号栏与文本区共用字体/行高，滚动时同步
 * - 粘贴时自动归一化（去 BOM、CRLF → LF、去零宽字符），避免"复制内容带换行符解析失败"
 */
export function CodeArea(p: {
  value: string;
  onInput?: (v: string) => void;
  placeholder?: string;
  /** 最小高度（px），默认沿用 .code 的 140px */
  minHeight?: number;
  rows?: number;
  /** 关闭行号栏（内容很短的场景） */
  gutter?: boolean;
  /** 只读：用于展示结果（仍保留行号与选择/复制） */
  readOnly?: boolean;
  class?: string;
  style?: string;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const logicalLines = Math.max((p.value || '').split('\n').length, 1);
  const [rowCounts, setRowCounts] = useState<number[]>(() => new Array(logicalLines).fill(1));

  /**
   * 按当前可用宽度计算每个逻辑行折成了几个视觉行。
   * 用 canvas 量出等宽字体下 '0' 与 '中' 的步进宽度，再按字符贪心折行，
   * 与 textarea 的 break-all 折行规则保持一致。
   */
  const measure = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const width = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    // 还没布局（宽度为 0 / 面板隐藏）时不做字符测量，全部按 1 行占位，等 ResizeObserver 再算
    if (!(width > 0)) {
      const fallback = new Array(Math.max((p.value || '').split('\n').length, 1)).fill(1);
      setRowCounts((prev) => (prev.length === fallback.length ? prev : fallback));
      return;
    }
    const ctx = (canvasRef.current ?? (canvasRef.current = document.createElement('canvas'))).getContext('2d');
    let ch = 0;
    let wide = 0;
    if (ctx) {
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      ch = ctx.measureText('0').width;
      wide = ctx.measureText('中').width;
    }
    if (!ch) ch = (parseFloat(cs.fontSize) || 13) * 0.6;
    if (!wide) wide = ch * 2;
    const next = countWrappedRows(p.value || '', width, ch, wide, 4);
    // 折行结果没变就不触发重绘
    setRowCounts((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next));
  }, [p.value]);

  useEffect(() => { measure(); }, [measure]);

  useEffect(() => {
    const el = taRef.current;
    let alive = true;
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => { if (alive) measure(); })
      : null;
    if (el && ro) ro.observe(el);
    // 编辑器字体可能异步加载，加载后重新量一次字符宽度
    document.fonts?.ready.then(() => { if (alive) measure(); }).catch(() => {});
    return () => { alive = false; ro?.disconnect(); };
  }, [measure]);

  const lineText = rowCounts.length === logicalLines
    ? buildGutterText(rowCounts)
    : Array.from({ length: logicalLines }, (_, i) => String(i + 1)).join('\n');

  const syncScroll = (e: JSX.TargetedEvent<HTMLTextAreaElement>) => {
    const g = gutterRef.current;
    if (g) g.scrollTop = (e.currentTarget as HTMLTextAreaElement).scrollTop;
  };

  const onPaste = (e: JSX.TargetedClipboardEvent<HTMLTextAreaElement>) => {
    if (p.readOnly || !p.onInput) return;
    const raw = e.clipboardData?.getData('text/plain');
    if (raw == null) return;
    const text = normalizeInput(raw);
    // 内容本身没问题就交给浏览器默认处理（保留撤销栈）
    if (text === raw) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLTextAreaElement;
    const start = el.selectionStart ?? p.value.length;
    const end = el.selectionEnd ?? start;
    p.onInput(p.value.slice(0, start) + text + p.value.slice(end));
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + text.length;
    });
  };

  return (
    <div
      class="code-wrap"
      style={p.minHeight ? `--dt-code-min-h:${p.minHeight}px` : undefined}
      onClick={(e) => { if (e.target === e.currentTarget) taRef.current?.focus(); }}
    >
      {p.gutter !== false && (
        <div class="code-gutter" ref={gutterRef} aria-hidden="true">{lineText}</div>
      )}
      <textarea
        ref={taRef}
        class={`code${p.readOnly ? ' readonly' : ''}${p.class ? ` ${p.class}` : ''}`}
        style={p.style}
        rows={p.rows}
        value={p.value}
        placeholder={p.placeholder}
        readOnly={p.readOnly}
        spellcheck={false}
        onInput={(e) => p.onInput?.((e.target as HTMLTextAreaElement).value)}
        onPaste={onPaste}
        onScroll={syncScroll}
      />
    </div>
  );
}

/**
 * 跨面板关闭保持的输入状态（存宿主 workspaceState）。
 * 设计要点：
 * - 首次读取为异步，读取完成前不写回，避免用初始值覆盖已存内容
 * - 一旦用户（或 prefill）改过值就置 dirty，异步读取结果不再覆盖，
 *   保证「右键送入内容」优先于「上次残留内容」
 */
export function usePersistentState(key: string, initial: string, sanitize?: (v: string) => string) {
  const [value, setValue] = useState(initial);
  const [loaded, setLoaded] = useState(false);
  const dirty = useRef(false);
  const loadedRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    let alive = true;
    dirty.current = false;
    loadedRef.current = false;
    setLoaded(false);
    host.readState<string>(`state:${key}`).then((v) => {
      if (!alive) return;
      if (!dirty.current && typeof v === 'string') {
        valueRef.current = v;
        setValue(v);
      }
      loadedRef.current = true;
      setLoaded(true);
    }).catch(() => {
      if (alive) {
        loadedRef.current = true;
        setLoaded(true);
      }
    });
    return () => { alive = false; };
  }, [key]);

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      const stored = sanitize ? sanitize(value) : value;
      host.persistState(`state:${key}`, stored).catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [key, value, loaded, sanitize]);

  // 切页签/关面板时 flush，避免最后 400ms 的输入被 clearTimeout 丢掉
  useEffect(() => () => {
    if (loadedRef.current) {
      const stored = sanitize ? sanitize(valueRef.current) : valueRef.current;
      host.persistState(`state:${key}`, stored).catch(() => undefined);
    }
  }, [key, sanitize]);

  const set = useCallback((v: string | ((prev: string) => string)) => {
    dirty.current = true;
    setValue((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      valueRef.current = next;
      return next;
    });
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
