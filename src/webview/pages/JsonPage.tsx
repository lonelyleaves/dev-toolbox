import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import {
  parseJsonLoose, toYaml, toXml, toCsv, csvToJson, generateTypes, jsonPath,
} from '../../logic/jsonx';
import { buildDiffPairs } from '../../logic/diffx';
import { diffJson, jsonDiffMarkdown } from '../../logic/json-diff';
import { JsonErrorInfo } from '../../logic/json-error';
import { CopyBtn, Section, Btn, CodeArea, useHistory, usePersistentState, clipPrefill } from '../components';
import { JsonFoldArea } from '../json-fold-area';
import { Prefill } from '../app';

type Tab = 'format' | 'convert' | 'codegen' | 'path' | 'tree' | 'diff';

export function JsonPage({ prefill, setFill }: { prefill?: Prefill; setFill?: (v: boolean) => void }) {
  const [input, setInput] = usePersistentState('json.input', '{"name":"张三","age":28,"tags":["a","b"],"address":{"city":"杭州"},"vip":true}');
  const [tab, setTab] = useState<Tab>('format');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  /** 结构化错误：位置 + 出错片段 + 排查建议 */
  const [errorInfo, setErrorInfo] = useState<JsonErrorInfo | undefined>();
  const [repaired, setRepaired] = useState(false);
  const [path, setPath] = useState('$.address.city');
  const [diffB, setDiffB] = useState('');
  /** 结构对比：语义路径视图 / 文本行视图 */
  const [diffView, setDiffView] = useState<'semantic' | 'line'>('semantic');
  const [diffPathFilter, setDiffPathFilter] = useState('');
  const [diffIgnore, setDiffIgnore] = useState('');
  const [diffArrayKey, setDiffArrayKey] = useState('');
  const history = useHistory('json');

  useEffect(() => {
    if (prefill && prefill.toolId === 'json') setInput(clipPrefill(prefill.text));
  }, [prefill]);

  // 上下两个区各自滚动：整页不滚，避免滚输入框时把结果区一起推走
  useEffect(() => {
    setFill?.(true);
    return () => setFill?.(false);
  }, [setFill]);

  // 输入防抖：大 JSON 逐键解析会卡顿
  const [debouncedInput, setDebouncedInput] = useState(input);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedInput(input), 300);
    return () => clearTimeout(timer);
  }, [input]);

  const parsed = useMemo(() => parseJsonLoose(debouncedInput), [debouncedInput]);

  useEffect(() => {
    // 空输入不算错误（之前会一直显示 "Unexpected end of JSON input"）
    if (!debouncedInput.trim()) {
      setError('');
      setErrorInfo(undefined);
      setOutput('');
      setRepaired(false);
      return;
    }
    if (!parsed.ok) {
      setError(parsed.error || 'JSON 无效');
      setErrorInfo(parsed.errorInfo);
      setOutput('');
      setRepaired(false);
      return;
    }
    setError('');
    setErrorInfo(undefined);
    setRepaired(!!parsed.repaired);
    try {
      switch (tab) {
        case 'format': setOutput(JSON.stringify(parsed.data, null, 2)); break;
        case 'convert': setOutput(toYaml(parsed.data)); break;
        case 'codegen': setOutput(generateTypes(parsed.data).ts); break;
        case 'path': setOutput(JSON.stringify(jsonPath(parsed.data, path), null, 2)); break;
        case 'diff': setOutput(''); break;
        default: setOutput('');
      }
    } catch (e: any) {
      setError(String(e?.message || e));
      setErrorInfo(undefined);
    }
  }, [debouncedInput, tab, path, parsed]);

  const doAction = (fn: (d: unknown) => string) => {
    if (!parsed.ok) return;
    history.push(input.slice(0, 2000));
    try {
      setOutput(fn(parsed.data));
      setRepaired(!!parsed.repaired);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  };

  const [convertFmt, setConvertFmt] = useState('yaml');
  const [codegenLang, setCodegenLang] = useState('ts');

  const diffOut = useMemo(() => {
    if (tab !== 'diff') return null;
    const a = parseJsonLoose(debouncedInput);
    const b = parseJsonLoose(diffB);
    if (!a.ok || !b.ok) return { error: '两侧都需要是合法（或可修复的）JSON' };
    const ignoreKeys = diffIgnore.split(',').map((s) => s.trim()).filter(Boolean);
    const semantic = diffJson(a.data, b.data, {
      ignoreKeys,
      arrayKey: diffArrayKey.trim() || undefined,
    });
    const { pairs, stats } = buildDiffPairs(JSON.stringify(a.data, null, 2), JSON.stringify(b.data, null, 2));
    return { semantic, pairs, stats };
  }, [tab, debouncedInput, diffB, diffIgnore, diffArrayKey]);

  // 大差异量先截屏，避免几百行一次性渲染卡住
  const diffRows = useMemo(() => {
    const s = diffOut?.semantic;
    if (!s) return [];
    const kw = diffPathFilter.trim().toLowerCase();
    const list = kw ? s.entries.filter((e) => e.path.toLowerCase().includes(kw)) : s.entries;
    return list.slice(0, 300);
  }, [diffOut, diffPathFilter]);

  return (
    <div class="json-page">
      <CodeArea
        value={input}
        onInput={setInput}
        minHeight={180}
        placeholder="粘贴 JSON（支持自动修复：注释/单引号/尾逗号/裸 key）"
      />
      <div class="toolbar">
        {!input.trim() ? <span class="badge">等待输入</span>
          : error ? <span class="badge err" title={errorInfo?.raw || error}>✗ JSON 无法解析</span>
            : <span class="badge ok">✓ JSON 合法{repaired ? '（已自动修复）' : ''}</span>}
        {history.items.length > 0 && (
          <select onChange={(e) => setInput(history.items[Number((e.target as HTMLSelectElement).value)])} value="">
            <option value="" disabled>最近使用…</option>
            {history.items.map((hst, i) => <option value={i}>{hst.slice(0, 40)}</option>)}
          </select>
        )}
      </div>

      {errorInfo && (
        <div class="json-error-detail">
          <div class="small"><b>✗ {errorInfo.title}</b></div>
          {errorInfo.snippet && (
            <pre class="json-error-snippet mono small">{errorInfo.snippet}{errorInfo.caret ? `\n${errorInfo.caret}` : ''}</pre>
          )}
          {errorInfo.hint && <div class="small muted">→ {errorInfo.hint}</div>}
          {errorInfo.raw && <div class="small muted json-error-raw">原始信息：{errorInfo.raw}</div>}
        </div>
      )}

      <div class="toolbar">
        {(['format', 'convert', 'codegen', 'path', 'tree', 'diff'] as Tab[]).map((t) => (
          <button class={`btn${tab === t ? ' primary' : ''}`} onClick={() => setTab(t)}>
            {({ format: '格式化', convert: '互转', codegen: '生成代码', path: 'JSONPath', tree: '树视图', diff: '结构对比' } as Record<Tab, string>)[t]}
          </button>
        ))}
      </div>

      {tab === 'format' && (
        <div class="json-pane noscroll">
          <div class="toolbar">
            <Btn onClick={() => doAction((d) => JSON.stringify(d, null, 2))}>美化</Btn>
            <Btn onClick={() => doAction((d) => JSON.stringify(d))}>压缩</Btn>
            <Btn onClick={() => doAction((d) => JSON.stringify(d, Object.keys(d as any ?? {}).sort(), 2))}>Key 排序</Btn>
            <Btn onClick={() => { setInput(toYaml(parsed.data!)); }}>转 YAML 编辑</Btn>
          </div>
          <JsonFoldArea value={output} minHeight={160} />
        </div>
      )}

      {tab === 'convert' && (
        <div class="json-pane">
          <div class="toolbar">
            <select value={convertFmt} onInput={(e) => setConvertFmt((e.target as HTMLSelectElement).value)}>
              <option value="yaml">YAML</option><option value="xml">XML</option><option value="csv">CSV</option>
            </select>
            <Btn primary onClick={() => doAction((d) =>
              convertFmt === 'yaml' ? toYaml(d) : convertFmt === 'xml' ? toXml(d) : toCsv(d))}>转换</Btn>
            {convertFmt === 'csv' && <Btn onClick={() => { try { setInput(JSON.stringify(csvToJson(input), null, 2)); } catch { setError('CSV 解析失败'); } }}>CSV → JSON（用左侧输入）</Btn>}
          </div>
          <CodeArea value={output} readOnly minHeight={160} />
          <div class="row"><CopyBtn text={() => output} label="复制完整结果" /></div>
        </div>
      )}

      {tab === 'codegen' && (
        <div class="json-pane">
          <div class="toolbar">
            <select value={codegenLang} onInput={(e) => setCodegenLang((e.target as HTMLSelectElement).value)}>
              <option value="ts">TypeScript</option><option value="java">Java</option>
              <option value="go">Go</option><option value="kotlin">Kotlin</option>
            </select>
            <Btn primary onClick={() => doAction((d) => (generateTypes(d) as any)[codegenLang])}>生成</Btn>
          </div>
          <CodeArea value={output} readOnly minHeight={160} />
          <div class="row"><CopyBtn text={() => output} label="复制代码" /></div>
        </div>
      )}

      {tab === 'path' && (
        <div class="json-pane noscroll">
          <div class="toolbar">
            <input type="text" class="mono grow" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} placeholder="$.a.b[0].c" />
          </div>
          <JsonFoldArea value={output} minHeight={160} />
        </div>
      )}

      {tab === 'tree' && parsed.ok && (
        <div class="json-pane"><JsonTree data={parsed.data} /></div>
      )}

      {tab === 'diff' && (
        <div class="json-pane noscroll">
          <div class="json-diff-input">
            <CodeArea value={diffB} onInput={setDiffB} minHeight={90} placeholder="粘贴第二份 JSON 进行结构对比" />
          </div>
          {diffOut && 'error' in (diffOut as any) && <div class="error-text">{(diffOut as any).error}</div>}
          {diffOut && 'semantic' in (diffOut as any) && (
            <div class="json-diff-panel">
              <div class="toolbar">
                <button class={`btn${diffView === 'semantic' ? ' primary' : ''}`} onClick={() => setDiffView('semantic')}>语义路径</button>
                <button class={`btn${diffView === 'line' ? ' primary' : ''}`} onClick={() => setDiffView('line')}>文本行</button>
                <input class="mono" style="width:150px" value={diffPathFilter} onInput={(e) => setDiffPathFilter((e.target as HTMLInputElement).value)} placeholder="按路径过滤" />
                <input class="mono" style="width:180px" value={diffIgnore} onInput={(e) => setDiffIgnore((e.target as HTMLInputElement).value)} placeholder="忽略字段，逗号分隔" />
                <input class="mono" style="width:140px" value={diffArrayKey} onInput={(e) => setDiffArrayKey((e.target as HTMLInputElement).value)} placeholder="数组匹配字段" />
                <span class="badge modified">变更 {diffOut.semantic!.stats.changed}</span>
                <span class="badge added">新增 {diffOut.semantic!.stats.added}</span>
                <span class="badge deleted">删除 {diffOut.semantic!.stats.removed}</span>
                <CopyBtn text={() => jsonDiffMarkdown(diffOut.semantic!)} label="复制差异报告" />
              </div>
              {diffOut.semantic!.arrayKeys.length > 0 && (
                <div class="small muted">
                  数组已按稳定标识对齐：{diffOut.semantic!.arrayKeys.map((a) => `${a.path} → ${a.key}`).join('；')}
                </div>
              )}
              {diffView === 'semantic' ? (
                <div class="json-diff-table-wrap">
                  <table class="tbl small">
                    <thead><tr><th style="width:88px">类型</th><th>路径</th><th>左值</th><th>右值</th></tr></thead>
                    <tbody>
                      {diffRows.map((e, i) => (
                        <tr key={`${e.path}-${i}`}>
                          <td>
                            <span class={`badge ${e.kind === 'added' ? 'added' : e.kind === 'removed' ? 'deleted' : 'modified'}`}>
                              {e.kind === 'added' ? '新增' : e.kind === 'removed' ? '删除' : '变更'}
                            </span>
                            {e.typeChanged && <span class="small muted"> 类型变</span>}
                          </td>
                          <td class="mono json-diff-path" title={e.path}>{e.path}</td>
                          <td class="mono">{e.leftText || '—'}</td>
                          <td class="mono">{e.rightText || '—'}</td>
                        </tr>
                      ))}
                      {!diffRows.length && (
                        <tr><td colSpan={4} class="muted">{diffPathFilter ? '没有匹配该路径的差异' : '两份 JSON 语义一致（字段值全部相同）'}</td></tr>
                      )}
                    </tbody>
                  </table>
                  {(diffOut.semantic!.truncated || diffRows.length >= 300) && (
                    <div class="small muted" style="padding:4px 6px">
                      共 {diffOut.semantic!.totalDiffs} 处差异，当前最多展示 300 行；用路径过滤或忽略字段缩小范围
                    </div>
                  )}
                </div>
              ) : (
                <CodeArea
                  readOnly
                  minHeight={120}
                  value={diffOut.pairs!.filter((p: any) => p.type !== 'equal').map((p: any) =>
                    `${p.type === 'ins' ? '+' : p.type === 'del' ? '-' : '~'} ${(p.right || p.left || []).map((w: any) => w.text).join('')}`
                  ).join('\n') || '两份 JSON 格式化后完全一致'}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function JsonTree({ data }: { data: unknown }) {
  const renderNode = (key: string, value: unknown, depth = 0): any => {
    if (value !== null && typeof value === 'object') {
      const entries = Array.isArray(value)
        ? value.map((v, i) => [String(i), v] as [string, unknown])
        : Object.entries(value as object);
      return (
        <details open={depth < 2}>
          <summary>
            <b>{key}</b> <span class="muted small">{Array.isArray(value) ? `Array(${entries.length})` : `{${entries.length}}`}</span>
          </summary>
          {entries.map(([k, v]) => renderNode(k, v, depth + 1))}
        </details>
      );
    }
    const t = value === null ? 'null' : typeof value;
    const colorMap: Record<string, string> = { string: 'var(--vscode-charts-green, #73c991)', number: 'var(--vscode-charts-purple, #c678dd)' };
    return (
      <div style={`padding-left:${depth ? 0 : 0}px`}>
        <b>{key}</b>: <span class="mono" style={colorMap[t] || 'inherit'}>{JSON.stringify(value)}</span>
      </div>
    );
  };
  return <Section title="树视图">{renderNode('$', data)}</Section>;
}
