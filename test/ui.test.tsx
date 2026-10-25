// @vitest-environment jsdom
/**
 * UI 冒烟测试：在 jsdom 里真实渲染 Preact 组件，验证只有"点开面板用一下"才会暴露的问题。
 * 宿主 API 用 acquireVsCodeApi 桩替代（postMessage 不回包，host 调用自然超时但不影响渲染断言）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

beforeAll(() => {
  (globalThis as any).acquireVsCodeApi = () => ({
    postMessage: () => undefined,
    getState: () => undefined,
    setState: () => undefined,
  });
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** 渲染到容器并返回容器与卸载函数 */
async function mount(node: any) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => { render(node, container); });
  await flush();
  return {
    container,
    unmount: async () => { await act(async () => { render(null, container); }); container.remove(); },
  };
}

const prefill = (toolId: string, text: string) => ({ toolId, text, ts: Date.now() } as any);

describe('prefill 生效（含二次送入回归）', () => {
  it('EncodePage：首次渲染即带上送入内容', async () => {
    const { EncodePage } = await import('../src/webview/pages/EncodePage');
    const { container, unmount } = await mount(h(EncodePage, { prefill: prefill('encode', 'hello') }));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    expect(ta.value).toBe('hello');
    await unmount();
  });

  it('EncodePage：面板停留时再次送入不同内容要刷新（useState 初始化写法的回归测试）', async () => {
    const { EncodePage } = await import('../src/webview/pages/EncodePage');
    const container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => { render(h(EncodePage, { prefill: prefill('encode', 'first') } as any), container); });
    await flush();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('first');

    // 同一组件实例（未卸载）再次送入 —— 正是以前"第二次右键没反应"的场景
    await act(async () => { render(h(EncodePage, { prefill: prefill('encode', 'second') } as any), container); });
    await flush();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('second');
    container.remove();
  });

  it('CronPage：送入内容生效且按 80 字符上限截断（原为硬编码 slice）', async () => {
    const { CronPage } = await import('../src/webview/pages/CronPage');
    const long = '0 9 * * 1-5 ' + 'x'.repeat(500);
    const { container, unmount } = await mount(h(CronPage, { prefill: prefill('cron', long) }));
    const inputs = [...container.querySelectorAll('input, textarea')] as HTMLInputElement[];
    const exprInput = inputs.find((i) => i.value.includes('0 9 * * 1-5'))!;
    expect(exprInput).toBeTruthy();
    expect(exprInput.value.length).toBeLessThanOrEqual(80 + 40); // 截断 + 省略标记
    expect(exprInput.value).toContain('已截断');
    await unmount();
  });
});

describe('导航搜索', () => {
  it('输入关键词后只保留命中的工具', async () => {
    const { App } = await import('../src/webview/app');
    const { container, unmount } = await mount(h(App, {}));
    const all = [...container.querySelectorAll('.nav .item')].map((e) => e.textContent || '');
    expect(all.length).toBeGreaterThan(10);

    const input = container.querySelector('.nav-search') as HTMLInputElement;
    input.value = 'json';
    await act(async () => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const filtered = [...container.querySelectorAll('.nav .item')].map((e) => e.textContent || '');
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(all.length);
    expect(filtered.join('|')).toContain('JSON');
    expect(filtered.join('|')).not.toContain('时间戳');
    await unmount();
  });
});

describe('全部工具页可挂载（防"点了是空白/直接崩"）', () => {
  it('13 个工具逐个切换都能渲染出页面标题', async () => {
    const { App } = await import('../src/webview/app');
    const { bridge } = await import('../src/webview/bridge');
    const { TOOLS } = await import('../src/core/tool-registry');
    const { container, unmount } = await mount(h(App, {}));

    expect(TOOLS.length).toBe(13);
    for (const t of TOOLS) {
      await act(async () => {
        for (const h of [...bridge.pushHandlers]) {
          h({ kind: 'push', event: 'openTool', toolId: t.id } as any);
        }
      });
      await flush();
      const title = container.querySelector('.page-title')?.textContent || '';
      expect(title, `工具 ${t.id} 切换后标题`).toBe(t.label);
      expect(container.querySelector('.page')?.children.length, `工具 ${t.id} 有内容`).toBeGreaterThan(0);
    }
    await unmount();
  });
});

describe('数据字典：项目栏 / 冲突面板 / 来源面板 冒烟', () => {
  it('ProjectBar 渲染项目下拉与操作按钮', async () => {
    const { ProjectBar } = await import('../src/webview/pages/dictionary/panels');
    const projects = [{ id: 'p1', name: '制造库', createdAt: '', updatedAt: '', sourceCount: 2, tableCount: 1006 }];
    const { container, unmount } = await mount(h(ProjectBar, {
      projects, currentId: 'p1', onSwitch: () => {}, onCreate: () => {}, onRename: () => {},
      onClear: () => {}, onDelete: () => {}, onExport: () => {}, onImport: () => {}, onConfig: () => {},
    }));
    const sel = container.querySelector('select') as HTMLSelectElement;
    expect(sel).toBeTruthy();
    expect(sel.options.length).toBe(1);
    expect(sel.textContent).toContain('制造库');
    const btns = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(btns.some((t) => t?.includes('新建项目'))).toBe(true);
    expect(btns.some((t) => t?.includes('清空'))).toBe(true);
    expect(btns.some((t) => t?.includes('导出项目包'))).toBe(true);
    await unmount();
  });

  it('MergePanel 展示冲突并提供批量按钮', async () => {
    const { MergePanel } = await import('../src/webview/pages/dictionary/panels');
    const conflicts = [{
      id: 'T_A|FID|comment', table: 'T_A', column: 'FID', field: 'comment' as const,
      baseValue: '主键', incomingValue: '内码', incomingSourceName: '在线库',
    }];
    const { container, unmount } = await mount(h(MergePanel, {
      conflicts, resolutions: {}, setResolutions: () => {}, sourceName: '在线库',
      stats: { tablesAdded: 1, columnsAdded: 2, tablesMatched: 3 }, onApply: () => {}, onCancel: () => {},
    }));
    expect(container.textContent).toContain('主键');
    expect(container.textContent).toContain('内码');
    const btns = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(btns.some((t) => t?.includes('全部保留原值'))).toBe(true);
    expect(btns.some((t) => t?.includes('全部采用新值'))).toBe(true);
    expect(btns.some((t) => t?.includes('应用并合并'))).toBe(true);
    await unmount();
  });

  it('SourcesPanel 列出来源并给出刷新/禁用/移除操作', async () => {
    const { SourcesPanel } = await import('../src/webview/pages/dictionary/panels');
    const dict = {
      version: 1, name: 'x', dialect: 'generic', tables: [], importErrors: [],
      sources: [{ id: 's1', kind: 'pdm' as const, name: 'MFG制造.pdm', path: '/tmp/a.pdm', importedAt: new Date().toISOString(), tableCount: 1006, enabled: true, priority: 10 }],
    };
    const { container, unmount } = await mount(h(SourcesPanel, {
      dict, onRemove: () => {}, onToggle: () => {}, onRefresh: () => {}, onAdd: () => {},
    }));
    expect(container.textContent).toContain('MFG制造.pdm');
    expect(container.textContent).toContain('1006');
    const links = [...container.querySelectorAll('a')].map((a) => a.textContent);
    expect(links).toContain('刷新');
    expect(links).toContain('禁用');
    expect(links).toContain('移除');
    await unmount();
  });
});

describe('项目连接配置面板', () => {
  const cfg = {
    connections: {
      db: { client: 'mysql', host: '10.0.0.5', port: 3306, user: 'root', database: 'erp' } as const,
      kingdee: { baseUrl: 'http://k3/a', dbId: '001', user: 'admin' } as const,
    },
  };

  it('渲染已有连接配置，并标注凭据"已保存"', async () => {
    const { ProjectConfigPanel } = await import('../src/webview/pages/dictionary/panels');
    const { container, unmount } = await mount(h(ProjectConfigPanel, {
      projectName: '制造库', config: cfg, savedSecretKeys: ['password', 'appSecret'], onSave: async () => {},
    }));
    expect(container.textContent).toContain('制造库');
    const vals = [...container.querySelectorAll('input')].map((i) => (i as HTMLInputElement).value);
    expect(vals).toContain('10.0.0.5');
    expect(vals).toContain('http://k3/a');
    expect(container.textContent).toContain('已保存');
    expect(container.textContent).toContain('不带密码');
    await unmount();
  });

  it('保存时把表单值传给回调，未填写的密码不回传', async () => {
    const { ProjectConfigPanel } = await import('../src/webview/pages/dictionary/panels');
    let saved: any = null;
    const { container, unmount } = await mount(h(ProjectConfigPanel, {
      projectName: '制造库', config: cfg, savedSecretKeys: [], onSave: async (c: any, s: any) => { saved = { c, s }; },
    }));
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('保存到此项目'))!;
    expect(btn).toBeTruthy();
    btn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(saved).toBeTruthy();
    expect(saved.c.connections.db.host).toBe('10.0.0.5');
    expect(saved.c.connections.db.port).toBe(3306);
    expect(saved.c.connections.kingdee.baseUrl).toBe('http://k3/a');
    expect(saved.s.dbPassword).toBeUndefined();
    expect(saved.s.appSecret).toBeUndefined();
    await unmount();
  });
});
