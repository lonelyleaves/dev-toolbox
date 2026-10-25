import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import { buildDiffPairs, DiffLinePair, changedBlocks } from '../../logic/diffx';
import { CopyBtn, Section, Btn, usePersistentState, clipPrefill } from '../components';
import { host } from '../bridge';
import { Prefill } from '../app';

const MAX_RENDER = 2000;

export function DiffPage({ prefill }: { prefill?: Prefill }) {
  const [left, setLeft] = usePersistentState('diff.left', '');
  const [right, setRight] = usePersistentState('diff.right', '');
  const [mode, setMode] = useState<'side' | 'inline'>('side');
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [showEqual, setShowEqual] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (prefill && prefill.toolId === 'diff') {
      if (!left) setLeft(clipPrefill(prefill.text));
      else setRight((r) => (r ? r : clipPrefill(prefill.text)));
    }
  }, [prefill]);

  const { pairs, stats } = useMemo(() => {
    if (!left && !right) return { pairs: [] as DiffLinePair[], stats: null as any };
    try {
      return buildDiffPairs(left, right, { ignoreWhitespace: ignoreWs, ignoreCase });
    } catch {
      return { pairs: [] as DiffLinePair[], stats: null as any };
    }
  }, [left, right, ignoreWs, ignoreCase]);

  const visible = useMemo(() => {
    let ps = pairs;
    if (!showEqual) ps = ps.filter((p) => p.type !== 'equal');
    if (!expanded && ps.length > MAX_RENDER) ps = ps.slice(0, MAX_RENDER);
    return ps;
  }, [pairs, showEqual, expanded]);

  const total = pairs.length;

  const wordSpans = (words: { text: string; changed: boolean }[] | undefined, cls: string) =>
    (words || []).map((w, i) => (w.changed ? <span class={cls}>{w.text}</span> : <span>{w.text}</span>));

  return (
    <div>
      <div class="grid2">
        <textarea class="code" placeholder="左侧文本（基准）" value={left} onInput={(e) => setLeft((e.target as HTMLTextAreaElement).value)} />
        <textarea class="code" placeholder="右侧文本（对比）" value={right} onInput={(e) => setRight((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div class="toolbar">
        <Btn onClick={async () => { const t = await host.getClipboard(); setRight(t); }}>剪贴板 → 右侧</Btn>
        <Btn onClick={async () => { const t = await host.getClipboard(); setLeft(t); }}>剪贴板 → 左侧</Btn>
        <Btn onClick={() => { const t = left; setLeft(right); setRight(t); }}>左右互换</Btn>
        <span style="width:12px" />
        <label><input type="radio" name="diffmode" checked={mode === 'side'} onChange={() => setMode('side')} /> 双栏</label>
        <label><input type="radio" name="diffmode" checked={mode === 'inline'} onChange={() => setMode('inline')} /> 行内</label>
        <label><input type="checkbox" checked={ignoreWs} onChange={() => setIgnoreWs(!ignoreWs)} /> 忽略空白</label>
        <label><input type="checkbox" checked={ignoreCase} onChange={() => setIgnoreCase(!ignoreCase)} /> 忽略大小写</label>
        <label><input type="checkbox" checked={showEqual} onChange={() => setShowEqual(!showEqual)} /> 显示相同行</label>
      </div>

      {stats && (
        <div class="row small" style="margin-bottom:8px">
          <span class="badge added">+{stats.added}</span>
          <span class="badge deleted">-{stats.removed}</span>
          <span class="badge modified">~{stats.changed}</span>
          <span class="badge">={stats.equal}</span>
          <span class="muted">共 {total} 行</span>
        </div>
      )}

      {mode === 'side' ? (
        <table class="diff-table">
          <tbody>
            {visible.map((p) => (
              <tr>
                <td class="ln">{p.leftNo ?? ''}</td>
                <td class={p.type === 'ins' ? 'diff-empty' : p.type === 'mod' ? 'diff-del' : p.type === 'del' ? 'diff-del' : ''}>
                  {p.left ? wordSpans(p.left, 'diff-word-del') : ''}
                </td>
                <td class="ln">{p.rightNo ?? ''}</td>
                <td class={p.type === 'del' ? 'diff-empty' : p.type === 'mod' ? 'diff-ins' : p.type === 'ins' ? 'diff-ins' : ''}>
                  {p.right ? wordSpans(p.right, 'diff-word-ins') : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table class="diff-table">
          <tbody>
            {visible.map((p) => {
              if (p.type === 'equal') return <tr><td class="ln">{p.leftNo}</td><td>{p.left?.[0]?.text}</td></tr>;
              if (p.type === 'del') return <tr><td class="ln">{p.leftNo}</td><td class="diff-del">{p.left?.[0]?.text}</td></tr>;
              if (p.type === 'ins') return <tr><td class="ln">{p.rightNo}</td><td class="diff-ins">{p.right?.[0]?.text}</td></tr>;
              return (
                <tr>
                  <td class="ln">{p.leftNo}/{p.rightNo}</td>
                  <td>
                    <span>删除: </span>{wordSpans(p.left, 'diff-word-del')}
                    <br /><span>新增: </span>{wordSpans(p.right, 'diff-word-ins')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {total > MAX_RENDER && !expanded && (
        <div class="toolbar"><Btn onClick={() => setExpanded(true)}>仅渲染前 {MAX_RENDER} 行，点击展开全部 {total} 行</Btn></div>
      )}

      {pairs.length > 0 && (
        <div class="row" style="margin-top:10px">
          <CopyBtn text={() => changedBlocks(pairs, 'left').join('\n\n')} label="复制左侧差异块" />
          <CopyBtn text={() => changedBlocks(pairs, 'right').join('\n\n')} label="复制右侧差异块" />
          <CopyBtn text={() => pairs.map((p) => `${p.type === 'equal' ? ' ' : p.type === 'ins' ? '+' : p.type === 'del' ? '-' : '~'}${(p.right || p.left || [])[0]?.text ?? ''}`).join('\n')} label="复制统一格式" />
        </div>
      )}
    </div>
  );
}

