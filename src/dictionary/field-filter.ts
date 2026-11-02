import { ColumnDef } from './model';

export interface FieldFilters {
  type?: string;
  required?: 'yes' | 'no';
  key?: 'pk' | 'non';
  hasDefault?: 'yes' | 'no';
  hasComment?: 'yes' | 'no';
}

export function hasDefaultValue(c: ColumnDef): boolean {
  return c.defaultValue !== undefined && c.defaultValue !== null && String(c.defaultValue).trim() !== '';
}

export function hasCommentValue(c: ColumnDef): boolean {
  return !!(c.comment || '').trim();
}

/** 当前表头筛选生效条件数（不含关键字搜索） */
export function activeFilterCount(filters: FieldFilters): number {
  return [filters.type, filters.required, filters.key, filters.hasDefault, filters.hasComment].filter(Boolean).length;
}

/** 当前表出现过的字段类型，供类型下拉使用 */
export function distinctTypes(columns: ColumnDef[]): string[] {
  const out = new Set<string>();
  for (const c of columns) {
    const t = String(c.type || '').trim();
    if (t) out.add(t);
  }
  return [...out].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }));
}

/** 单个字段是否同时满足关键字和表头筛选；所有条件按 AND 组合 */
export function matchesColumnFilter(c: ColumnDef, keyword: string, filters: FieldFilters): boolean {
  const kw = (keyword || '').trim().toLowerCase();
  if (kw) {
    const haystack = [c.name || '', c.code || '', c.comment || ''].join(' ').toLowerCase();
    if (!haystack.includes(kw)) return false;
  }
  if (filters.type && String(c.type || '') !== filters.type) return false;
  if (filters.required === 'yes' && c.nullable !== false) return false;
  if (filters.required === 'no' && c.nullable === false) return false;
  if (filters.key === 'pk' && !c.pk) return false;
  if (filters.key === 'non' && c.pk) return false;
  if (filters.hasDefault === 'yes' && !hasDefaultValue(c)) return false;
  if (filters.hasDefault === 'no' && hasDefaultValue(c)) return false;
  if (filters.hasComment === 'yes' && !hasCommentValue(c)) return false;
  if (filters.hasComment === 'no' && hasCommentValue(c)) return false;
  return true;
}

/** 返回满足条件的字段下标，保留原始序号用于展示 */
export function filterColumnIndexes(columns: ColumnDef[], keyword: string, filters: FieldFilters): number[] {
  const out: number[] = [];
  for (let i = 0; i < columns.length; i++) {
    if (matchesColumnFilter(columns[i], keyword, filters)) out.push(i);
  }
  return out;
}
