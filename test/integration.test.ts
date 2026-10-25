/**
 * 契约一致性测试：防止"注册了命令但没有命令处理""工具没有对应页面""菜单指向不存在的命令"
 * 这类只在真实 IDE 里点击才暴露的问题。做法是对源文件做静态解析后交叉校验。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOOLS, CATEGORIES } from '../src/core/tool-registry';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const pkg = JSON.parse(read('package.json'));
const appSrc = read('src/webview/app.tsx');
const extSrc = read('src/extension.ts');
const pagesDir = path.join(ROOT, 'src/webview/pages');
const pageFiles = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.tsx'));

/** app.tsx 里 PAGES 映射的 key */
function pageKeys(src: string): string[] {
  const m = src.match(/const PAGES[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*(\w+):\s*\w+Page,/gm)].map((x) => x[1]);
}

/** package.json 里声明的所有命令 id（含菜单引用） */
function declaredCommands(): Set<string> {
  const ids = new Set<string>();
  for (const c of pkg.contributes?.commands ?? []) ids.add(c.command);
  const menus = pkg.contributes?.menus ?? {};
  for (const items of Object.values<any>(menus)) {
    for (const it of items as any[]) if (it?.command) ids.add(it.command);
  }
  return ids;
}

/** extension.ts 实际 registerCommand 的命令 id */
function registeredCommands(): Set<string> {
  const ids = new Set<string>();
  // 动态注册：devToolbox.open.<toolId>
  for (const t of TOOLS) ids.add(`devToolbox.open.${t.id}`);
  // 字面量：editorToTool / tabToTool 的 key 与 openPanel
  for (const m of extSrc.matchAll(/'(devToolbox\.[A-Za-z0-9.]+)'/g)) ids.add(m[1]);
  return ids;
}

describe('工具注册表', () => {
  it('id 唯一且字段齐全', () => {
    const ids = TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TOOLS) {
      expect(t.label && t.icon && t.description).toBeTruthy();
      expect(CATEGORIES as readonly string[]).toContain(t.category);
    }
  });
  it('每个工具都有对应页面组件（否则点了是空白页）', () => {
    const keys = pageKeys(appSrc);
    for (const t of TOOLS) expect(keys).toContain(t.id);
    // 反向：PAGES 里没有多余项
    const toolIds = TOOLS.map((t) => t.id);
    for (const k of keys) expect(toolIds).toContain(k);
  });
});

describe('命令契约', () => {
  const declared = declaredCommands();
  const registered = registeredCommands();

  it('package.json 声明的命令，extension.ts 都要注册（防死菜单）', () => {
    for (const cmd of declared) expect(registered).toContain(cmd);
  });
  it('extension.ts 注册的命令，package.json 都要声明（防不可见命令）', () => {
    for (const cmd of registered) expect(declared).toContain(cmd);
  });
  it('每个工具都有 devToolbox.open.<id> 命令', () => {
    for (const t of TOOLS) expect(declared).toContain(`devToolbox.open.${t.id}`);
  });
});

describe('prefill 契约', () => {
  it('页面里判断的 toolId 都存在于注册表（否则右键送入内容永远不生效）', () => {
    const ids = new Set(TOOLS.map((t) => t.id));
    for (const f of pageFiles) {
      const src = read(`src/webview/pages/${f}`);
      for (const m of src.matchAll(/prefill\.toolId\s*===\s*'(\w+)'/g)) {
        expect(ids, `${f} 里的 ${m[1]}`).toContain(m[1]);
      }
      for (const m of src.matchAll(/prefill\?\.toolId\s*===\s*'(\w+)'/g)) {
        expect(ids, `${f} 里的 ${m[1]}`).toContain(m[1]);
      }
    }
  });
  it('所有接收 prefill 的页面都走 clipPrefill 统一截断', () => {
    for (const f of pageFiles) {
      const src = read(`src/webview/pages/${f}`);
      if (/prefill\.toolId\s*===/.test(src)) expect(src, f).toContain('clipPrefill');
    }
  });
});

describe('字典持久化（项目库）', () => {
  const page = read('src/webview/pages/DictionaryPage.tsx');

  it('字典存到项目库文件，而不是只靠 workspaceState', () => {
    expect(page).toContain('host.projectSave(');
    expect(page).toContain('host.projectLoad(');
    expect(page).toContain('host.projectList()');
  });
  it('旧版 workspaceState 字典会自动迁移成项目（不让用户重选文件）', () => {
    expect(page).toContain('migrateDict');
    expect(page).toContain("host.projectCreate(old.name || '默认项目')");
  });
  it('导入走合并而不是整份覆盖', () => {
    expect(page).toContain('mergeDictionaries(');
    expect(page).toContain('applyResolutions(');
  });
});

describe('持久化键', () => {
  it('usePersistentState 的 key 全局唯一（避免不同工具互相覆盖输入）', () => {
    const keys: string[] = [];
    for (const f of pageFiles) {
      const src = read(`src/webview/pages/${f}`);
      for (const m of src.matchAll(/usePersistentState\(\s*'([^']+)'/g)) keys.push(m[1]);
    }
    expect(keys.length).toBeGreaterThan(5);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
