import { parseExpression } from 'cron-parser';
import cronstrue from 'cronstrue/i18n';

export interface CronResult {
  ok: boolean;
  error?: string;
  description?: string;
  nextRuns: string[];
  /** 未来 24 小时按小时聚合的执行次数（热力条） */
  heat24h: number[];
}

/** 5 段自动补成 6 段（前置秒 0） */
export function normalizeExpr(expr: string, quartz: boolean): string {
  const parts = expr.trim().split(/\s+/);
  if (quartz) {
    if (parts.length === 5) return `0 ${parts.join(' ')}`;
    if (parts.length === 6) return parts.join(' ');
    if (parts.length === 7) return parts.slice(0, 6).join(' '); // 忽略 year 段
  } else {
    if (parts.length === 5) return `0 ${parts.join(' ')}`;
  }
  return parts.join(' ');
}

export function analyzeCron(expr: string, timeZone: string, count = 20, now = new Date()): CronResult {
  const normalized = normalizeExpr(expr, false);
  try {
    const it = parseExpression(normalized, { tz: timeZone, currentDate: now });
    const nextRuns: string[] = [];
    const heat = new Array(24).fill(0);
    const fmt = (d: Date) =>
      new Intl.DateTimeFormat('zh-CN', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(d);
    const windowEnd = now.getTime() + 24 * 3600 * 1000;
    for (let collected = 0; collected < count; collected++) {
      const d = it.next().toDate();
      nextRuns.push(fmt(d));
      if (d.getTime() < windowEnd) {
        const hourIdx = Number(
          new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false }).format(d)
        );
        heat[hourIdx % 24]++;
      } else if (collected >= 5) {
        break;
      }
    }
    let description: string;
    try {
      description = cronstrue.toString(normalized, { locale: 'zh_CN', use24HourTimeFormat: true });
    } catch {
      description = cronstrue.toString(expr, { locale: 'zh_CN' });
    }
    return { ok: true, description, nextRuns, heat24h: heat };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), nextRuns: [], heat24h: [] };
  }
}

export const CRON_TEMPLATES: { name: string; expr: string }[] = [
  { name: '每分钟', expr: '* * * * *' },
  { name: '每 5 分钟', expr: '*/5 * * * *' },
  { name: '每小时整点', expr: '0 * * * *' },
  { name: '每天 0:30', expr: '30 0 * * *' },
  { name: '每天 9:00', expr: '0 9 * * *' },
  { name: '工作日 9:00', expr: '0 9 * * 1-5' },
  { name: '每周一 8:00', expr: '0 8 * * 1' },
  { name: '每月 1 日 0:00', expr: '0 0 1 * *' },
  { name: '每季度首日', expr: '0 0 1 1,4,7,10 *' },
  { name: '工作日早晚各一次', expr: '0 9,18 * * 1-5' },
];

/** 可视化生成器状态 → 表达式 */
export function buildCron(s: {
  minutes: string; hours: string; daysOfMonth: string; months: string; daysOfWeek: string;
}): string {
  return [s.minutes || '*', s.hours || '*', s.daysOfMonth || '*', s.months || '*', s.daysOfWeek || '*'].join(' ');
}
