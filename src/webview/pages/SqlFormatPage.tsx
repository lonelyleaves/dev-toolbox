import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { format } from 'sql-formatter';
import { Btn, CopyBtn, CodeArea, usePersistentState, clipPrefill } from '../components';
import { host } from '../bridge';
import { Prefill } from '../app';

const DIALECTS = ['sql', 'mysql', 'postgresql', 'plsql', 'oracle', 'hive', 'bigquery', 'db2', 'transactsql', 'singlestoredb', 'snowflake', 'spark'];

export function SqlFormatPage({ prefill }: { prefill?: Prefill }) {
  const [sql, setSql] = usePersistentState('sqlFormat.sql', "select u.id,u.name,o.amount from t_user u join t_order o on o.user_id=u.id where u.status=1 and o.created_at>'2026-01-01' order by o.amount desc limit 10;");
  const [dialect, setDialect] = useState('sql');
  const [keywordCase, setKeywordCase] = useState<'upper' | 'lower' | 'preserve'>('upper');
  const [indent, setIndent] = useState(2);
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    host.getSettings().then((s: any) => {
      if (s?.sqlFormat?.dialect) setDialect(s.sqlFormat.dialect);
      if (s?.sqlFormat?.keywordCase) setKeywordCase(s.sqlFormat.keywordCase);
    }).catch(() => undefined);
    if (prefill && prefill.toolId === 'sqlFormat') setSql(clipPrefill(prefill.text));
  }, [prefill]);

  const doFormat = () => {
    if (!sql.trim()) {
      setError('');
      setOutput('');
      return;
    }
    try {
      setError('');
      setOutput(format(sql, {
        language: dialect as any,
        keywordCase,
        tabWidth: indent,
      }));
    } catch (e: any) {
      setError(String(e?.message || e));
      setOutput('');
    }
  };

  // 输入/方言变化后自动重排（防抖），打开页面即有结果；之前只有首次进来是空的
  useEffect(() => {
    const t = setTimeout(doFormat, 250);
    return () => clearTimeout(t);
  }, [sql, dialect, keywordCase, indent]);

  const stmtCount = sql.split(';').filter((s) => s.trim()).length;

  return (
    <div>
      <CodeArea value={sql} onInput={setSql} placeholder="粘贴 SQL…" />
      <div class="toolbar">
        <select value={dialect} onInput={(e) => setDialect((e.target as HTMLSelectElement).value)}>
          {DIALECTS.map((d) => <option value={d}>{d}</option>)}
        </select>
        <select value={keywordCase} onInput={(e) => setKeywordCase((e.target as HTMLSelectElement).value as any)}>
          <option value="upper">关键字大写</option><option value="lower">关键字小写</option><option value="preserve">保持原样</option>
        </select>
        <label class="small">缩进</label>
        <select value={indent} onInput={(e) => setIndent(Number((e.target as HTMLSelectElement).value))}>
          <option value={2}>2 空格</option><option value={4}>4 空格</option>
        </select>
        <Btn primary onClick={doFormat}>格式化</Btn>
        <span class="small muted">{stmtCount} 条语句 · {sql.length} 字符</span>
      </div>
      {error && <div class="error-text">✗ {error}</div>}
      {output && (
        <div>
          <pre class="out">{output}</pre>
          <div class="row">
            <CopyBtn text={() => output} label="复制结果" />
            <Btn onClick={() => setSql(output)}>用结果替换输入</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
