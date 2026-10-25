import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import { analyzeCron, CRON_TEMPLATES, buildCron, CronResult } from '../../logic/cronx';
import { COMMON_TIMEZONES } from '../../logic/timestamp';
import { CopyBtn, Section, Btn, usePersistentState, clipPrefill } from '../components';
import { Prefill } from '../app';

export function CronPage({ prefill }: { prefill?: Prefill }) {
  const localTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', []);
  const [expr, setExpr] = usePersistentState('cron.expr', '0 9 * * 1-5');
  const [tz, setTz] = useState(localTz);
  const [result, setResult] = useState<CronResult | null>(null);
  const [builder, setBuilder] = useState({ minutes: '0', hours: '9', daysOfMonth: '*', months: '*', daysOfWeek: '1-5' });

  useEffect(() => {
    // 表达式很短，统一截断策略下取更小上限（原为硬编码 80 字符）
    if (prefill && prefill.toolId === 'cron') setExpr(clipPrefill(prefill.text.trim(), 80));
  }, [prefill]);

  useEffect(() => {
    const t = setTimeout(() => setResult(analyzeCron(expr, tz)), 200);
    return () => clearTimeout(t);
  }, [expr, tz]);

  const maxHeat = result ? Math.max(...result.heat24h, 1) : 1;

  return (
    <div>
      <div class="row">
        <input type="text" class="mono grow" style="font-size:14px" placeholder="Cron 表达式（5 或 6 段）"
          value={expr} onInput={(e) => setExpr((e.target as HTMLInputElement).value)} />
        <select value={tz} onInput={(e) => setTz((e.target as HTMLSelectElement).value)}>
          {COMMON_TIMEZONES.map((z) => <option value={z}>{z}</option>)}
        </select>
      </div>

      <div class="row" style="margin:8px 0">
        {CRON_TEMPLATES.map((t) => (
          <button class="btn" onClick={() => setExpr(t.expr)} title={t.expr}>{t.name}</button>
        ))}
      </div>

      {result && !result.ok && <div class="error-text" style="margin:8px 0">✗ {result.error}</div>}

      {result?.ok && (
        <div class="grid2">
          <div>
            <Section title="人话描述">
              <div style="font-size:14px">{result.description}</div>
            </Section>
            <Section title="未来 24 小时执行密度">
              <div class="row" style="align-items:flex-end;gap:2px;height:60px">
                {result.heat24h.map((v, i) => (
                  <div title={`${i}:00 执行 ${v} 次`} style={{
                    width: '3.5%', height: `${Math.max((v / maxHeat) * 100, v ? 8 : 2)}%`,
                    background: 'var(--vscode-charts-blue, #3794ff)', opacity: v ? 0.9 : 0.2, minHeight: '2px',
                  }} />
                ))}
              </div>
              <div class="small muted" style="display:flex;justify-content:space-between"><span>0 点</span><span>12 点</span><span>23 点</span></div>
            </Section>
            <Section title={`未来执行时间（前 ${result.nextRuns.length} 次）`}>
              <ul class="plain mono small" style="max-height:260px;overflow:auto">
                {result.nextRuns.map((r) => <li>{r}</li>)}
              </ul>
              <CopyBtn text={() => result.nextRuns.join('\n')} label="复制全部时间" />
            </Section>
          </div>
          <Section title="可视化生成器">
            {([
              ['分钟', 'minutes'], ['小时', 'hours'], ['日', 'daysOfMonth'], ['月', 'months'], ['星期', 'daysOfWeek'],
            ] as const).map(([label, key]) => (
              <div class="row" style="margin-bottom:6px">
                <label style="width:48px">{label}</label>
                <input type="text" class="mono" value={builder[key] as string} style="flex:1"
                  onInput={(e) => setBuilder({ ...builder, [key]: (e.target as HTMLInputElement).value })} />
              </div>
            ))}
            <div class="small muted">支持 * , / - 组合，如 0,30 或 */5 或 1-5</div>
            <div class="row" style="margin-top:8px">
              <Btn primary onClick={() => setExpr(buildCron(builder))}>生成表达式</Btn>
            </div>
            <div class="small muted" style="margin-top:8px">
              提示：粘贴 6 段 Quartz 表达式（含秒）时会自动按秒解析
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}
