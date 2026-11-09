import { h } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Btn } from './components';
import { allFoldStarts, buildJsonFoldModel, visibleFoldRows } from '../logic/json-fold';

const ROW_H = 20;

export function JsonFoldArea(p: {
  value: string;
  minHeight?: number;
  class?: string;
}) {
  const model = useMemo(() => buildJsonFoldModel(p.value || ''), [p.value]);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(240);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);
  const scrollInfoRef = useRef({ top: 0, h: 240 });

  const rows = useMemo(() => visibleFoldRows(model, collapsed), [model, collapsed]);
  const totalHeight = rows.length * ROW_H;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 6);
  const slice = rows.slice(start, end);

  useEffect(() => {
    setCollapsed(new Set());
    setScrollTop(0);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [p.value]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight || 240;
      scrollInfoRef.current.h = h;
      setViewH(h);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const onBodyScroll = (e: any) => {
    const el = e.currentTarget as HTMLDivElement;
    scrollInfoRef.current.top = el.scrollTop;
    if (gutterRef.current) gutterRef.current.scrollTop = el.scrollTop;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setScrollTop(scrollInfoRef.current.top);
    });
  };

  const toggle = (line: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });
  };

  const collapseLevel = (level: number) => {
    setCollapsed(new Set(model.allRanges.filter((r) => r.depth >= level).map((r) => r.start)));
  };

  return (
    <div class={`json-fold-area${p.class ? ` ${p.class}` : ''}`} style={p.minHeight ? `--dt-json-fold-min-h:${p.minHeight}px` : undefined}>
      <div class="toolbar json-fold-toolbar">
        <Btn onClick={() => setCollapsed(new Set())}>展开全部</Btn>
        <Btn onClick={() => setCollapsed(new Set(allFoldStarts(model)))}>折叠全部</Btn>
        <label class="row" style="gap:4px">
          <span class="small muted">按层级折叠</span>
          <select value="" onChange={(e: any) => {
            const v = Number(e.target.value || 0);
            if (v > 0) collapseLevel(v);
            e.target.value = '';
          }}>
            <option value="">选择…</option>
            <option value="1">第 1 层</option>
            <option value="2">第 2 层</option>
            <option value="3">第 3 层</option>
            <option value="4">第 4 层</option>
          </select>
        </label>
        <span class="small muted">{rows.length} / {model.lines.length} 行</span>
      </div>
      <div class="json-fold-wrap">
        <div class="json-fold-gutter" ref={gutterRef} aria-hidden="true">
          <div class="json-fold-inner" style={`height:${totalHeight}px`}>
            {slice.map((row, i) => (
              <div key={row.line} class="json-fold-line-number" style={`top:${(start + i) * ROW_H}px`}>
                {row.line + 1}
              </div>
            ))}
          </div>
        </div>
        <div class="json-fold-body" ref={bodyRef} onScroll={onBodyScroll}>
          <div class="json-fold-inner" style={`height:${totalHeight}px`}>
            {slice.map((row, i) => (
              <div key={row.line} class="json-fold-row" style={`top:${(start + i) * ROW_H}px`}>
                <button
                  type="button"
                  class={`fold-toggle${row.foldable ? '' : ' placeholder'}`}
                  title={row.foldable ? (row.collapsed ? '展开' : '折叠') : undefined}
                  onClick={() => row.foldable && toggle(row.line)}
                >
                  {row.foldable ? (row.collapsed ? '▸' : '▾') : ''}
                </button>
                <span class="json-fold-text">{row.text}</span>
                {row.collapsed && <span class="json-fold-summary">… {row.hidden} 行</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
