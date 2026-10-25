import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { parseInserts, InsertTable, generateUpdates, generateDeletes, toCsv, toJsonArray, splitToSingleRowInserts } from '../../logic/sqlrestore';
import { Btn, CopyBtn, Section, usePersistentState, clipPrefill } from '../components';
import { host } from '../bridge';
import { Prefill } from '../app';

const SAMPLE = `INSERT INTO t_user (id, name, email, created_at, remark) VALUES
(1, '张三', 'zhangsan@example.com', '2026-01-02 10:00:00', NULL),
(2, '李四', 'lisi@test.cn', NOW(), 'it\\'s ok');
INSERT INTO t_user (id, name, email, created_at, remark) VALUES (3, '王五', 'wangwu@x.com', '2026-02-01 08:30:00', 'VIP');`;

export function SqlRestorePage({ prefill }: { prefill?: Prefill }) {
  const [sql, setSql] = usePersistentState('sqlRestore.sql', SAMPLE);
  const [result, setResult] = useState<{ tables: InsertTable[]; errors: string[] }>({ tables: [], errors: [] });
  const [activeIdx, setActiveIdx] = useState(0);
  const [pkInput, setPkInput] = useState('id');

  useEffect(() => {
    if (prefill && prefill.toolId === 'sqlRestore') setSql(clipPrefill(prefill.text));
  }, [prefill]);

  const run = () => setResult(parseInserts(sql));
  useEffect(() => { run(); }, [sql]);

  const table = result.tables[Math.min(activeIdx, Math.max(result.tables.length - 1, 0))];
  const pkCols = table ? pkInput.split(',').map((s) => s.trim()).filter((s) => table.columns.includes(s)) : [];

  return (
    <div>
      <textarea class="code" style="min-height:120px" value={sql} onInput={(e) => setSql((e.target as HTMLTextAreaElement).value)} placeholder="粘贴 INSERT 语句（支持多行 VALUES、转义引号、NULL、函数值）" />
      <div class="toolbar">
        <Btn primary onClick={run}>解析</Btn>
        {result.errors.map((er) => <span class="badge warn" title={er}>{er.slice(0, 40)}</span>)}
      </div>

      {result.tables.length > 1 && (
        <div class="toolbar">
          {result.tables.map((t, i) => (
            <button class={`btn${i === activeIdx ? ' primary' : ''}`} onClick={() => setActiveIdx(i)}>{t.table} ({t.rows.length} 行)</button>
          ))}
        </div>
      )}

      {table && (
        <div>
          <Section title={`${table.table} · ${table.rows.length} 行 × ${table.columns.length} 列`}>
            <div style="max-height:320px;overflow:auto">
              <table class="tbl">
                <thead>
                  <tr>
                    <th>#</th>
                    {table.columns.map((c) => (
                      <th>
                        <label>
                          <input type="checkbox" checked={pkCols.includes(c)} onChange={() => {
                            const next = pkCols.includes(c) ? pkCols.filter((x) => x !== c) : [...pkCols, c];
                            setPkInput(next.join(','));
                          }} /> {c}
                        </label>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((r, i) => (
                    <tr>
                      <td class="muted">{i + 1}</td>
                      {table.columns.map((_, ci) => {
                        const v = r[ci] ?? '';
                        return <td class={v === 'NULL' ? 'muted mono' : 'mono'}>{v}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div class="small muted">勾选表头复选框可标记主键列（用于生成 UPDATE/DELETE）</div>
          </Section>

          <div class="toolbar">
            <Btn onClick={async () => host.saveTextFile(`${table.table}.csv`, toCsv(table))}>导出 CSV</Btn>
            <Btn onClick={async () => host.saveTextFile(`${table.table}.json`, toJsonArray(table))}>导出 JSON</Btn>
            <CopyBtn text={() => toCsv(table)} label="复制 CSV" />
          </div>

          <div class="grid2">
            <Section title="还原为单行 INSERT">
              <pre class="out" style="max-height:220px">{splitToSingleRowInserts(table).join('\n')}</pre>
              <CopyBtn text={() => splitToSingleRowInserts(table).join('\n')} />
            </Section>
            <Section title="生成 UPDATE / DELETE（需勾选主键）">
              {pkCols.length === 0 ? <div class="muted small">请先在表头勾选主键列</div> : (
                <div>
                  <h4 class="small">UPDATE</h4>
                  <pre class="out" style="max-height:140px">{generateUpdates(table, pkCols).join('\n')}</pre>
                  <CopyBtn text={() => generateUpdates(table, pkCols).join('\n')} label="复制 UPDATE" />
                  <h4 class="small">DELETE</h4>
                  <pre class="out" style="max-height:140px">{generateDeletes(table, pkCols).join('\n')}</pre>
                  <CopyBtn text={() => generateDeletes(table, pkCols).join('\n')} label="复制 DELETE" />
                </div>
              )}
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}
