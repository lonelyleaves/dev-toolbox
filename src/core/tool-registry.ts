export interface ToolDef {
  id: string;
  label: string;
  icon: string; // codicon id
  category: string;
  description: string;
}

export const CATEGORIES = ['时间', '编码转换', '文本', '网络', '数据库', '图像', '生成器'] as const;

export const TOOLS: ToolDef[] = [
  { id: 'timestamp', label: '时间戳转换', icon: 'history', category: '时间', description: '秒/毫秒/微秒/纳秒互转、多时区、批量转换' },
  { id: 'cron', label: 'Cron 表达式', icon: 'clock', category: '时间', description: '解析/生成 Cron，未来执行时间预览' },
  { id: 'json', label: 'JSON 工具箱', icon: 'bracket', category: '编码转换', description: '格式化、互转、代码生成、JSONPath、修复' },
  { id: 'javaToJson', label: 'Java 类转 JSON', icon: 'coffee', category: '编码转换', description: 'Java 源码解析生成示例 JSON' },
  { id: 'diff', label: '文本对比', icon: 'merge', category: '文本', description: '双栏/行内差异、词级高亮、忽略选项' },
  { id: 'regex', label: '正则测试', icon: 'search', category: '文本', description: '实时高亮、分组明细、替换预览、正则库' },
  { id: 'sqlFormat', label: 'SQL 格式化', icon: 'output', category: '文本', description: '多方言 SQL 美化' },
  { id: 'sqlRestore', label: 'SQL 还原', icon: 'database', category: '文本', description: 'INSERT 语句还原为数据表格' },
  { id: 'curl', label: 'cURL 客户端', icon: 'globe', category: '网络', description: '解析 curl 命令、发送请求、导出代码' },
  { id: 'dictionary', label: '数据字典中心', icon: 'book', category: '数据库', description: 'PDM/DDL/Excel/在线库导入、浏览、扩展、修复、导出' },
  { id: 'qrcode', label: '二维码', icon: 'gist-secret', category: '图像', description: '生成/解码二维码、批量、自定义样式' },
  { id: 'encode', label: '编码转换', icon: 'replace', category: '编码转换', description: 'Base64 / URL / Hex / Unicode / HTML 实体 / JWT 解码' },
  { id: 'colorHash', label: '颜色/哈希/UUID', icon: 'symbol-color', category: '生成器', description: '颜色格式转换、WCAG 对比度、哈希计算、UUID 生成' },
];

export function toolById(id: string): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id);
}
