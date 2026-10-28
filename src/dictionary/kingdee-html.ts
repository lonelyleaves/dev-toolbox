/**
 * 金蝶云星空「数据字典」导出的 HTML 解析。
 *
 * 结构（每个实体一节 <h4>实体名</h4>）：
 *   概述表：表名称 | 实体名称 | ORM实体名
 *   字段表：标题 | 标识 | 实体属性 | 名称 | 数据类型 | 长度 | 精度 | 小数精度 | 允许空值 | 默认值 | 系统预设
 *   索引表 / 主外键表：名称 | 类型 | 字段（类型=CLUSTERED/NONCLUSTERED 为索引，PK/FK 为主外键）
 *
 * 枚举值在「默认值」列，形如 `(' ') 注：Z=暂存,A=创建,B=审核中`，
 * 解析时拆成「默认值」与「枚举」，并把枚举并入字段注释（`标题；枚举：Z=暂存,…`）。
 */
import { DictionaryModel, TableDef, ColumnDef, IndexDef, emptyDictionary } from './model';

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '');
const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
const norm = (s: string) => decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim();

/** 一行 → 单元格文本数组 */
function rowsOf(tableHtml: string): string[][] {
  return [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => norm(c[1])),
  );
}

/** 默认值列 → { defaultValue, enumText } */
export function splitDefault(raw: string): { defaultValue?: string; enumText?: string } {
  const s = (raw || '').trim();
  if (!s) return {};
  const m = s.match(/注\s*[：:]\s*([\s\S]*)$/);
  const enumText = m ? m[1].trim().replace(/[。.;；,，]\s*$/, '').replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2') : undefined;
  let dv = (m && m.index !== undefined ? s.slice(0, m.index) : s).trim();
  // 去掉 SQL 括号字面量：((0)) / (' ') / ('')
  dv = dv.replace(/^\(+/, '').replace(/\)+$/, '').trim();
  if (/^'.*'$/.test(dv)) dv = dv.slice(1, -1);
  dv = dv.trim();
  return { defaultValue: dv || undefined, enumText: enumText || undefined };
}

/** 数据类型 + 长度/精度 → 类型串（金蝶里「精度」是字符数，char 族优先用它） */
export function buildHtmlType(dataType: string, len: string, prec: string, scale: string): string {
  const t = (dataType || '').trim();
  if (!t) return 'varchar';
  const lower = t.toLowerCase();
  const p = Number(prec);
  const l = Number(len);
  const s = Number(scale);
  if (/decimal|numeric/.test(lower) && Number.isFinite(p) && p > 0) {
    return `${t}(${p},${Number.isFinite(s) && s >= 0 ? s : 0})`;
  }
  if (/char|varchar|binary/.test(lower)) {
    if (Number.isFinite(p) && p > 0) return `${t}(${p})`;
    if (Number.isFinite(l) && l > 0) return `${t}(${l})`;
  }
  return t;
}

/** 金蝶数据字典 HTML → DictionaryModel */
export function parseKingdeeHtml(text: string): DictionaryModel {
  const dict = emptyDictionary('kingdee-html', 'mssql');
  dict.meta = { source: 'kingdee-html' };
  const html = text || '';
  if (!/<table/i.test(html)) {
    dict.importErrors.push({ source: 'html', message: '未找到表格，请确认是金蝶导出的数据字典 HTML' });
    return dict;
  }

  // 按 <h4> 分节：每节是一个实体（单据头 / 明细 / 子实体…）
  const sections = html.split(/<h4[^>]*>/i).slice(1);
  for (const sec of sections) {
    try {
      const h4End = sec.search(/<\/h4>/i);
      const title = norm(h4End >= 0 ? sec.slice(0, h4End) : '');
      const body = h4End >= 0 ? sec.slice(h4End) : sec;
      const tables = [...body.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
      if (!tables.length) continue;

      let tableName = '';
      let entityName = '';
      let fieldRows: string[][] | null = null;
      const pkCols = new Set<string>();
      const indexes: IndexDef[] = [];

      for (const tb of tables) {
        const rows = rowsOf(tb);
        if (!rows.length) continue;
        const header = rows[0];
        const has = (label: string) => header.indexOf(label);

        // 概述表
        if (!tableName && has('表名称') >= 0) {
          const r = rows[1] || [];
          tableName = (r[has('表名称')] || '').trim();
          entityName = (r[has('实体名称')] ?? r[1] ?? '').trim();
          continue;
        }
        // 字段表
        if (has('标识') >= 0 && has('数据类型') >= 0) {
          fieldRows = rows;
          continue;
        }
        // 索引表 / 主外键表：名称 | 类型 | 字段
        if (has('名称') >= 0 && has('类型') >= 0 && has('字段') >= 0) {
          for (const r of rows.slice(1)) {
            const name = (r[has('名称')] || '').trim();
            const type = (r[has('类型')] || '').trim().toUpperCase();
            const cols = (r[has('字段')] || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
            if (!name || !cols.length) continue;
            if (type === 'PK' || /^PK_/i.test(name)) {
              cols.forEach((c) => pkCols.add(c.toUpperCase()));
              continue;
            }
            if (type === 'CLUSTERED' || type === 'NONCLUSTERED') {
              indexes.push({ name, unique: /UNIQUE/i.test(name), columns: cols });
            }
            // FK 行（类型=FK）暂不解析引用表（HTML 未给出）
          }
        }
      }

      if (!tableName) tableName = title.replace(/[-－].*$/, '').trim();
      if (!tableName || !fieldRows) continue;

      const header = fieldRows[0];
      const idx = (label: string) => header.findIndex((h) => h === label || h.includes(label));
      const iTitle = idx('标题');
      const iFlag = idx('标识');
      const iName = idx('名称');
      const iType = idx('数据类型');
      const iLen = idx('长度');
      const iPrec = idx('精度');
      const iScale = idx('小数精度');
      const iNull = idx('允许空值');
      const iDef = idx('默认值');

      const columns: ColumnDef[] = [];
      for (const r of fieldRows.slice(1)) {
        const physical = (iName >= 0 ? r[iName] : '') || (iFlag >= 0 ? r[iFlag] : '');
        const name = (physical || '').trim();
        if (!name) continue;
        const cap = (iTitle >= 0 ? r[iTitle] || '' : '').trim();
        const { defaultValue, enumText } = splitDefault(iDef >= 0 ? r[iDef] || '' : '');
        const comment = [cap, enumText ? `枚举：${enumText}` : ''].filter(Boolean).join('；') || undefined;
        const rawNull = iNull >= 0 ? (r[iNull] || '').trim() : '';
        const nullable = rawNull === '是' ? true : rawNull === '否' ? false : undefined;
        columns.push({
          name,
          code: cap || undefined,
          type: buildHtmlType(iType >= 0 ? r[iType] || '' : '', iLen >= 0 ? r[iLen] || '' : '', iPrec >= 0 ? r[iPrec] || '' : '', iScale >= 0 ? r[iScale] || '' : ''),
          nullable,
          defaultValue,
          comment,
          pk: pkCols.has(name.toUpperCase()) || undefined,
        });
      }
      if (!columns.length) continue;

      // 金蝶导出有时不把主键列放进字段表（如 FSUPPLIERID），按主外键/索引表补出来
      const existing = new Set(columns.map((c) => c.name.toUpperCase()));
      for (const pkName of pkCols) {
        if (existing.has(pkName)) continue;
        columns.unshift({ name: pkName, type: 'int', nullable: false, pk: true, comment: '主键（导出未列出字段定义，类型按 int 推测）' });
        existing.add(pkName);
      }

      const table: TableDef = {
        name: tableName,
        code: entityName || undefined,
        comment: title || entityName || undefined,
        columns,
        indexes,
        foreignKeys: [],
      };
      dict.tables.push(table);
    } catch (e: any) {
      dict.importErrors.push({ source: 'html', message: `实体解析失败：${e?.message || e}` });
    }
  }

  if (!dict.tables.length && !dict.importErrors.length) {
    dict.importErrors.push({ source: 'html', message: '未识别到实体/字段表，请确认为金蝶导出的数据字典 HTML' });
  }
  return dict;
}
