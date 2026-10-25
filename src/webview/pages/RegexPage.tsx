import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import { runRegex, explainRegex, REGEX_LIBRARY } from '../../logic/regexx';
import { CopyBtn, Section, Btn, usePersistentState, clipPrefill } from '../components';
import { Prefill } from '../app';

export function RegexPage({ prefill }: { prefill?: Prefill }) {
  const [pattern, setPattern] = useState('(\\w+)@(\\w+)\\.(\\w+)');
  const [flags, setFlags] = useState('gi');
  const [subject, setSubject] = usePersistentState('regex.subject', '联系 support@example.com 或 sales@company.co.uk；错误写法 foo@bar');
  const [replacement, setReplacement] = useState('$1 [at] $2.$3');
  const [current, setCurrent] = useState(0);
  const [showExplain, setShowExplain] = useState(false);

  useEffect(() => {
    if (prefill && prefill.toolId === 'regex') setSubject(clipPrefill(prefill.text));
  }, [prefill]);

  const { matches, error } = useMemo(() => runRegex(pattern, flags, subject), [pattern, flags, subject]);
  useEffect(() => setCurrent(0), [matches.length]);

  const replacePreview = useMemo(() => {
    if (!pattern || error) return '';
    try {
      return subject.replace(new RegExp(pattern, flags.includes('g') ? flags : flags + 'g'), replacement);
    } catch {
      return '';
    }
  }, [pattern, flags, subject, replacement, error]);

  // 高亮视图
  const highlighted = useMemo(() => {
    const parts: any[] = [];
    let last = 0;
    matches.forEach((m, i) => {
      if (m.index > last) parts.push(subject.slice(last, m.index));
      parts.push(<mark class={`hl-match${i === current ? ' current' : ''}`}>{m.text}</mark>);
      last = m.index + m.text.length;
    });
    parts.push(subject.slice(last));
    return <pre class="out" style="white-space:pre-wrap">{parts}</pre>;
  }, [matches, subject, current]);

  return (
    <div>
      <div class="row">
        <span class="nowrap mono">/</span>
        <input type="text" class="mono grow" value={pattern} onInput={(e) => setPattern((e.target as HTMLInputElement).value)} placeholder="正则表达式" />
        <span class="nowrap mono">/</span>
        <input type="text" class="mono" style="width:60px" value={flags} onInput={(e) => setFlags((e.target as HTMLInputElement).value)} placeholder="flags" />
      </div>
      {error && <div class="error-text" style="margin:6px 0">✗ {error}</div>}

      <div class="toolbar">
        <span class="small muted">正则库：</span>
        {REGEX_LIBRARY.map((r) => (
          <button class="btn" title={`${r.pattern}\n${r.desc}`} onClick={() => setPattern(r.pattern)}>{r.name}</button>
        ))}
      </div>

      <textarea class="code" placeholder="测试文本" value={subject} onInput={(e) => setSubject((e.target as HTMLTextAreaElement).value)} style="min-height:100px" />

      <div class="row" style="margin:8px 0">
        <span class="badge info">{matches.length} 处匹配</span>
        {matches.length > 0 && (
          <Btn onClick={() => setCurrent((current + matches.length - 1) % matches.length)}>◀ 上一处</Btn>
        )}
        {matches.length > 0 && (
          <Btn onClick={() => setCurrent((current + 1) % matches.length)}>下一处 ▶</Btn>
        )}
        {matches[current] && <span class="small mono muted">当前: {JSON.stringify(matches[current].text)} @ {matches[current].index}</span>}
        <Btn onClick={() => setShowExplain(!showExplain)}>{showExplain ? '收起解释' : '解释这个正则'}</Btn>
      </div>

      {highlighted}

      {showExplain && pattern && (
        <Section title="正则含义解释">
          <table class="tbl">
            <tbody>
              {explainRegex(pattern).map((e) => (
                <tr><td class="mono" style="width:120px">{e.token}</td><td>{e.meaning}</td></tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <div class="grid2">
        <Section title="匹配明细">
          <div style="max-height:280px;overflow:auto">
            <table class="tbl">
              <thead><tr><th>#</th><th>匹配</th><th>位置</th><th>分组</th></tr></thead>
              <tbody>
                {matches.slice(0, 200).map((m, i) => (
                  <tr onClick={() => setCurrent(i)} style="cursor:pointer">
                    <td>{i + 1}</td>
                    <td class="mono">{m.text.length > 40 ? m.text.slice(0, 40) + '…' : m.text}</td>
                    <td>{m.index}</td>
                    <td class="mono small">{m.groups.map((g, gi) => `${g.name ?? gi + 1}=${JSON.stringify(g.text)}`).join(' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
        <Section title="替换预览">
          <input type="text" class="mono" style="width:100%" value={replacement} onInput={(e) => setReplacement((e.target as HTMLInputElement).value)} placeholder="替换模板，$1 表示第 1 组" />
          <pre class="out" style="max-height:220px">{replacePreview}</pre>
          <CopyBtn text={() => replacePreview} label="复制替换结果" />
        </Section>
      </div>
    </div>
  );
}
