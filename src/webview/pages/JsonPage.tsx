import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import {
  parseJsonLoose, toYaml, toXml, toCsv, csvToJson, generateTypes, jsonPath,
} from '../../logic/jsonx';
import { buildDiffPairs } from '../../logic/diffx';
import { CopyBtn, Section, Btn, useHistory, usePersistentState, clipPrefill } from '../components';
import { Prefill } from '../app';

type Tab = 'format' | 'convert' | 'codegen' | 'path' | 'tree' | 'diff';

export function JsonPage({ prefill }: { prefill?: Prefill }) {
  const [input, setInput] = usePersistentState('json.input', '{"name":"张三","age":28,"tags":["a","b"],"address":{"city":"杭州"},"vip":true}');
  const [tab, setTab] = useState<Tab>('format');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [repaired, setRepaired] = useState(false);
  const [path, setPath] = useState('$.address.city');
  const [diffB, setDiffB] = useState('');
  const history = useHistory('json');

  useEffect(() => {
    if (prefill && prefill.toolId === 'json') setInput(clipPrefill(prefill.text));
  }, [prefill]);

  // 输入防抖：大 JSON 逐键解析会卡顿
  const [debouncedInput, setDebouncedInput] = useState(input);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedInput(input), 300);
    return () => clearTimeout(timer);
  }, [input]);

  const parsed = useMemo(() => parseJsonLoose(debouncedInput), [debouncedInput]);

  useEffect(() => {
    if (!parsed.ok) {
      setError(parsed.error || 'JSON 无效');
      setOutput('');
      setRepaired(false);
      return;
    }
    setError('');
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
    const { pairs, stats } = buildDiffPairs(JSON.stringify(a.data, null, 2), JSON.stringify(b.data, null, 2));
    return { pairs, stats };
  }, [tab, debouncedInput, diffB]);

  return (
    <div>
      <textarea class="code" value={input} onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)} placeholder="粘贴 JSON（支持自动修复：注释/单引号/尾逗号/裸 key）" />
      <div class="toolbar">
        {error ? <span class="badge err">✗ {error}</span> : <span class="badge ok">✓ JSON 合法{repaired ? '（已自动修复）' : ''}</span>}
        {history.items.length > 0 && (
          <select onChange={(e) => setInput(history.items[Number((e.target as HTMLSelectElement).value)])} value="">
            <option value="" disabled>最近使用…</option>
            {history.items.map((hst, i) => <option value={i}>{hst.slice(0, 40)}</option>)}
          </select>
        )}
      </div>

      <div class="toolbar">
        {(['format', 'convert', 'codegen', 'path', 'tree', 'diff'] as Tab[]).map((t) => (
          <button class={`btn${tab === t ? ' primary' : ''}`} onClick={() => setTab(t)}>
            {({ format: '格式化', convert: '互转', codegen: '生成代码', path: 'JSONPath', tree: '树视图', diff: '结构对比' } as Record<Tab, string>)[t]}
          </button>
        ))}
      </div>

      {tab === 'format' && (
        <div>
          <div class="toolbar">
            <Btn onClick={() => doAction((d) => JSON.stringify(d, null, 2))}>美化</Btn>
            <Btn onClick={() => doAction((d) => JSON.stringify(d))}>压缩</Btn>
            <Btn onClick={() => doAction((d) => JSON.stringify(d, Object.keys(d as any ?? {}).sort(), 2))}>Key 排序</Btn>
            <Btn onClick={() => { setInput(toYaml(parsed.data!)); }}>转 YAML 编辑</Btn>
          </div>
          <pre class="out">{output}</pre>
          <CopyBtn text={() => output} label="复制结果" />
        </div>
      )}

      {tab === 'convert' && (
        <div>
          <div class="toolbar">
            <select value={convertFmt} onInput={(e) => setConvertFmt((e.target as HTMLSelectElement).value)}>
              <option value="yaml">YAML</option><option value="xml">XML</option><option value="csv">CSV</option>
            </select>
            <Btn primary onClick={() => doAction((d) =>
              convertFmt === 'yaml' ? toYaml(d) : convertFmt === 'xml' ? toXml(d) : toCsv(d))}>转换</Btn>
            {convertFmt === 'csv' && <Btn onClick={() => { try { setInput(JSON.stringify(csvToJson(input), null, 2)); } catch { setError('CSV 解析失败'); } }}>CSV → JSON（用左侧输入）</Btn>}
          </div>
          <pre class="out">{output}</pre>
          <CopyBtn text={() => output} label="复制结果" />
        </div>
      )}

      {tab === 'codegen' && (
        <div>
          <div class="toolbar">
            <select value={codegenLang} onInput={(e) => setCodegenLang((e.target as HTMLSelectElement).value)}>
              <option value="ts">TypeScript</option><option value="java">Java</option>
              <option value="go">Go</option><option value="kotlin">Kotlin</option>
            </select>
            <Btn primary onClick={() => doAction((d) => (generateTypes(d) as any)[codegenLang])}>生成</Btn>
          </div>
          <pre class="out">{output}</pre>
          <CopyBtn text={() => output} label="复制代码" />
        </div>
      )}

      {tab === 'path' && (
        <div>
          <div class="toolbar">
            <input type="text" class="mono grow" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} placeholder="$.a.b[0].c" />
          </div>
          <pre class="out">{output}</pre>
          <CopyBtn text={() => output} label="复制结果" />
        </div>
      )}

      {tab === 'tree' && parsed.ok && <JsonTree data={parsed.data} />}

      {tab === 'diff' && (
        <div>
          <textarea class="code" style="min-height:90px" value={diffB} onInput={(e) => setDiffB((e.target as HTMLTextAreaElement).value)} placeholder="粘贴第二份 JSON 进行结构对比" />
          {diffOut && 'error' in (diffOut as any) && <div class="error-text">{(diffOut as any).error}</div>}
          {diffOut && 'pairs' in (diffOut as any) && (
            <div>
              <div class="row small">
                <span class="badge added">+{diffOut.stats!.added}</span>
                <span class="badge deleted">-{diffOut.stats!.removed}</span>
                <span class="badge modified">~{diffOut.stats!.changed}</span>
              </div>
              <pre class="out">{diffOut.pairs!.filter((p: any) => p.type !== 'equal').map((p: any) =>
                `${p.type === 'ins' ? '+' : p.type === 'del' ? '-' : '~'} ${(p.right || p.left || []).map((w: any) => w.text).join('')}`
              ).join('\n') || '两份 JSON 格式化后完全一致'}</pre>
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
