import { DictionaryModel, TableDef } from './model';

export interface NamingRules {
  tablePrefix?: string;
  requireComment?: boolean;
  requirePrimaryKey?: boolean;
  forbiddenTypes?: string[];
}

export interface Violation {
  table: string;
  column?: string;
  rule: string;
  message: string;
  /** 可自动修复的动作类型 */
  fix?: { type: 'renameTable' | 'renameColumn' | 'snakeCase'; to: string };
}

const isSnake = (s: string) => /^[a-z][a-z0-9_]*$/.test(s);

/** 命名规范批量扫描 */
export function lintDictionary(dict: DictionaryModel, rules: NamingRules): Violation[] {
  const out: Violation[] = [];
  for (const t of dict.tables) {
    if (rules.tablePrefix && !t.name.toLowerCase().startsWith(rules.tablePrefix.toLowerCase())) {
      out.push({
        table: t.name, rule: '表名前缀',
        message: `表 ${t.name} 缺少前缀 ${rules.tablePrefix}`,
        fix: { type: 'renameTable', to: rules.tablePrefix + t.name },
      });
    }
    if (rules.requireComment && !t.comment) {
      out.push({ table: t.name, rule: '表注释', message: `表 ${t.name} 缺少注释` });
    }
    if (rules.requirePrimaryKey && !t.columns.some((c) => c.pk)) {
      out.push({ table: t.name, rule: '主键', message: `表 ${t.name} 没有主键` });
    }
    for (const c of t.columns) {
      if (!isSnake(c.name)) {
        const snake = c.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
        out.push({
          table: t.name, column: c.name, rule: 'snake_case',
          message: `字段 ${t.name}.${c.name} 不符合 snake_case`,
          fix: { type: 'renameColumn', to: snake },
        });
      }
      if (rules.requireComment && !c.comment) {
        out.push({ table: t.name, column: c.name, rule: '字段注释', message: `字段 ${t.name}.${c.name} 缺少注释` });
      }
      const baseType = c.type.replace(/\(.*\)/, '').toUpperCase();
      if (rules.forbiddenTypes?.some((f) => f.toUpperCase() === baseType)) {
        out.push({ table: t.name, column: c.name, rule: '禁用类型', message: `字段 ${t.name}.${c.name} 使用了禁用类型 ${c.type}` });
      }
    }
  }
  return out;
}

/** 一键修复：应用可自动修复项（改名），返回新字典 */
export function applyFixes(dict: DictionaryModel, violations: Violation[]): DictionaryModel {
  const next: DictionaryModel = JSON.parse(JSON.stringify(dict));
  for (const v of violations) {
    if (!v.fix) continue;
    const t = next.tables.find((x) => x.name === v.table);
    if (!t) continue;
    if (v.fix.type === 'renameTable') {
      // 同步更新所有指向该表的外键
      t.name = v.fix.to;
      for (const other of next.tables) {
        for (const fk of other.foreignKeys) if (fk.refTable === v.table) fk.refTable = v.fix.to;
      }
    } else if (v.fix.type === 'renameColumn' && v.column) {
      const c = t.columns.find((x) => x.name === v.column);
      if (c) c.name = v.fix.to;
      for (const idx of t.indexes) idx.columns = idx.columns.map((x) => (x === v.column ? v.fix!.to : x));
      for (const fk of t.foreignKeys) fk.columns = fk.columns.map((x) => (x === v.column ? v.fix!.to : x));
    }
  }
  return next;
}

// ---------- 注释补全助手：词根 → 中文 ----------

export const ROOT_WORDS: Record<string, string> = {
  id: 'ID', uid: '用户ID', user_id: '用户ID', order_id: '订单ID', order_no: '订单号',
  name: '名称', nick_name: '昵称', title: '标题', desc: '描述', description: '描述', remark: '备注',
  status: '状态', state: '状态', type: '类型', kind: '类别', level: '等级', source: '来源',
  amount: '金额', price: '价格', fee: '费用', cost: '成本', count: '数量', num: '编号', no: '编号',
  mobile: '手机号', phone: '电话', email: '邮箱', address: '地址', city: '城市', province: '省份',
  country: '国家', zip_code: '邮编', ip: 'IP地址', url: '链接', avatar: '头像', logo: '图标',
  parent_id: '父级ID', tenant_id: '租户ID', company_id: '公司ID', dept_id: '部门ID', role_id: '角色ID',
  created_at: '创建时间', updated_at: '更新时间', deleted_at: '删除时间', create_time: '创建时间',
  update_time: '更新时间', gmt_create: '创建时间', gmt_modified: '修改时间', expire_time: '过期时间',
  is_deleted: '删除标记', deleted: '删除标记', is_default: '是否默认', enabled: '启用标记',
  version: '版本号', ext: '扩展信息', extra: '扩展信息', config: '配置', content: '内容',
  category_id: '分类ID', product_id: '商品ID', sku_id: 'SKU ID', pay_type: '支付方式',
  channel: '渠道', scene: '场景', code: '编码', key: '键', value: '值', sort: '排序', seq: '序号',
  weight: '权重', priority: '优先级', token: '令牌', session: '会话', batch_no: '批次号',
};

/** 为缺注释字段生成建议（人工确认采纳） */
export function suggestComments(dict: DictionaryModel): { table: string; column: string; suggestion: string }[] {
  const out: { table: string; column: string; suggestion: string }[] = [];
  for (const t of dict.tables) {
    for (const c of t.columns) {
      if (c.comment) continue;
      const key = c.name.toLowerCase();
      let hit = ROOT_WORDS[key];
      if (!hit) {
        const parts = key.split('_');
        const mapped = parts.map((p) => ROOT_WORDS[p]).filter(Boolean);
        if (mapped.length) hit = Array.from(new Set(mapped)).join('');
      }
      if (!hit && key.startsWith('is_')) hit = `是否${ROOT_WORDS[key.slice(3)] || key.slice(3)}`;
      if (hit) out.push({ table: t.name, column: c.name, suggestion: hit });
    }
  }
  return out;
}

/** 采纳建议写回字典 */
export function acceptSuggestions(dict: DictionaryModel, accepted: { table: string; column: string; suggestion: string }[]): DictionaryModel {
  const next: DictionaryModel = JSON.parse(JSON.stringify(dict));
  for (const a of accepted) {
    const c = next.tables.find((t) => t.name === a.table)?.columns.find((x) => x.name === a.column);
    if (c) {
      c.comment = a.suggestion;
      c.changeTag = c.changeTag || 'modified';
    }
  }
  return next;
}
