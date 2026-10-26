import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import {
  detectTimestamp, formatMillis, formatVariants, relativeTime, nowByUnit,
  parseDateInTz, batchConvert, COMMON_TIMEZONES, TsUnit,
} from '../../logic/timestamp';
import { normalizeInput } from '../../logic/text';
import { CopyBtn, Section, Btn, clipPrefill } from '../components';
import { Prefill } from '../app';

export function TimestampPage({ prefill }: { prefill?: Prefill }) {
  const localTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', []);
  const [tz, setTz] = useState(localTz);
  const [tsInput, setTsInput] = useState('');
  const [dateInput, setDateInput] = useState('');
  const [now, setNow] = useState(Date.now());
  const [extraDays, setExtraDays] = useState(0);

  useEffect(() => {
    // 与其余工具页统一截断策略（原为硬编码 32 字符，长文本里的时间戳会被切掉）
    if (prefill && prefill.toolId === 'timestamp') setTsInput(clipPrefill(prefill.text.trim()));
  }, [prefill]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const det = detectTimestamp(tsInput);
  const millis = det ? det.millis : null;
  const shifted = millis !== null ? millis + extraDays * 86400000 : null;

  const dateToMillis = parseDateInTz(dateInput, tz);

  const batch = tsInput && /\d{9,19}/.test(tsInput) && tsInput.length > 20 ? batchConvert(tsInput, tz) : [];

  return (
    <div>
      <Section title="当前时间（每秒刷新）">
        <div class="row">
          {(['s', 'ms', 'us', 'ns'] as TsUnit[]).map((u) => (
            <div class="card grow" style="margin:0">
              <div class="small muted">{u}</div>
              <div class="mono">{nowByUnit(u)}</div>
              <CopyBtn text={() => nowByUnit(u)} label="复制" />
            </div>
          ))}
        </div>
      </Section>

      <div class="row" style="margin-bottom:10px">
        <label>时区</label>
        <select value={tz} onInput={(e) => setTz((e.target as HTMLSelectElement).value)}>
          {COMMON_TIMEZONES.map((z) => <option value={z}>{z}</option>)}
        </select>
      </div>

      <div class="grid2">
        <Section title="时间戳 → 日期">
          <input type="text" class="mono" style="width:100%" placeholder="粘贴时间戳（自动识别 s/ms/us/ns）"
            value={tsInput} onInput={(e) => setTsInput(normalizeInput((e.target as HTMLInputElement).value))} />
          {det && (
            <div style="margin-top:8px">
              <div class="kv">
                <span class="k">识别单位</span><span class="v">{det.unit}</span>
                <span class="k">本地时间</span><span class="v">{formatMillis(det.millis, tz)}</span>
                <span class="k">相对时间</span><span class="v">{relativeTime(det.millis, now)}</span>
              </div>
              <table class="tbl" style="margin-top:6px">
                <tbody>
                  {formatVariants(det.millis, tz).map((v) => (
                    <tr><td style="width:130px">{v.label}</td><td class="mono">{v.value}</td><td style="width:56px"><CopyBtn text={() => v.value} /></td></tr>
                  ))}
                </tbody>
              </table>
              <div class="row" style="margin-top:8px">
                <label class="small">偏移天数</label>
                <input type="number" value={extraDays} style="width:70px" onInput={(e) => setExtraDays(Number((e.target as HTMLInputElement).value) || 0)} />
                {shifted !== null && <span class="mono small">→ {formatMillis(shifted, tz)}</span>}
                {shifted !== null && <CopyBtn text={() => formatMillis(shifted, tz)} label="复制结果" />}
              </div>
            </div>
          )}
          {batch.length > 1 && (
            <div style="margin-top:8px">
              <div class="small muted">批量识别（{batch.length} 个）</div>
              <table class="tbl"><tbody>
                {batch.map((b) => <tr><td class="mono">{b.original}</td><td class="mono">{b.converted}</td></tr>)}
              </tbody></table>
            </div>
          )}
        </Section>

        <Section title="日期 → 时间戳">
          <input type="text" class="mono" style="width:100%" placeholder="2026-01-31 12:00:00"
            value={dateInput} onInput={(e) => setDateInput((e.target as HTMLInputElement).value)} />
          {dateInput && (
            dateToMillis === null
              ? <div class="error-text" style="margin-top:8px">无法解析该日期</div>
              : (
                <table class="tbl" style="margin-top:8px">
                  <tbody>
                    {(['s', 'ms', 'us', 'ns'] as TsUnit[]).map((u) => {
                      const f = { s: 1 / 1000, ms: 1, us: 1000, ns: 1000000 }[u];
                      const val = u === 's' ? String(Math.floor(dateToMillis / 1000)) : String(BigInt(Math.round(dateToMillis)) * BigInt(f));
                      return <tr><td style="width:60px">{u}</td><td class="mono">{val}</td><td style="width:56px"><CopyBtn text={() => val} /></td></tr>;
                    })}
                  </tbody>
                </table>
              )
          )}
          <div class="small muted" style="margin-top:6px">按所选时区 ({tz}) 解释输入的日期时间</div>
          <div class="row" style="margin-top:6px">
            <Btn onClick={() => { setDateInput(formatMillis(Date.now(), tz)); }}>填入当前时间</Btn>
          </div>
        </Section>
      </div>
    </div>
  );
}
