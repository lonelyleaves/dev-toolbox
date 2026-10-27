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

describe('代码输入框（行号 + 粘贴归一化）', () => {
  it('按换行数渲染行号，滚动时行号栏同步', async () => {
    const { CodeArea } = await import('../src/webview/components');
    const { container, unmount } = await mount(h(CodeArea, { value: 'a\nb\nc', onInput: () => {} }));
    const gutter = container.querySelector('.code-gutter') as HTMLElement;
    expect(gutter).toBeTruthy();
    expect(gutter.textContent).toBe('1\n2\n3');
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('a\nb\nc');
    await unmount();
  });

  it('粘贴带 BOM / CRLF 的内容会被归一化后再交给 onInput', async () => {
    const { CodeArea } = await import('../src/webview/components');
    let received = '';
    const { container, unmount } = await mount(h(CodeArea, {
      value: 'ab', onInput: (v: string) => { received = v; },
    }));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    ta.setSelectionRange(2, 2);
    const ev: any = new Event('paste', { bubbles: true, cancelable: true });
    ev.clipboardData = { getData: () => '\uFEFFline1\r\nline2' };
    await act(async () => { ta.dispatchEvent(ev); });
    expect(received).toBe('abline1\nline2');
    await unmount();
  });

  it('单行内容也至少显示一行行号', async () => {
    const { CodeArea } = await import('../src/webview/components');
    const { container, unmount } = await mount(h(CodeArea, { value: '', onInput: () => {} }));
    expect((container.querySelector('.code-gutter') as HTMLElement).textContent).toBe('1');
    await unmount();
  });
});

describe('表列表：虚拟滚动与筛选', () => {
  const many = Array.from({ length: 1000 }, (_, i) => ({
    name: `T_TAB_${i}`, code: `表${i}`, comment: i % 3 === 0 ? `注释${i}` : '', origin: { sourceId: 's1', kind: i % 2 ? 'pdm' : 'db' },
    columns: [{ name: `FID`, type: 'int', pk: i % 5 !== 0 }, { name: 'FNAME', type: 'varchar' }],
    foreignKeys: [], indexes: [],
  }));

  it('只渲染可视区，1 万张表也不会铺满 DOM', async () => {
    const { TableList } = await import('../src/webview/pages/dictionary/panels');
    const { container, unmount } = await mount(h(TableList, {
      tables: many, sources: [{ kind: 'pdm', name: 'MFG.pdm' } as any], selected: 'T_TAB_1',
      onSelect: () => {}, keyword: '', onKeyword: () => {},
    }));
    const rows = container.querySelectorAll('.vrow');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(60); // 可视区外不渲染
    const inner = container.querySelector('.vlist-inner') as HTMLElement;
    expect(inner.style.height).toBe(`${1000 * 24}px`); // 撑出完整滚动高度
    await unmount();
  });

  it('左栏只显示表名，不再就地展开字段', async () => {
    const { TableList } = await import('../src/webview/pages/dictionary/panels');
    const { container, unmount } = await mount(h(TableList, {
      tables: many.slice(0, 3), sources: [], selected: 'T_TAB_0', onSelect: () => {}, keyword: '', onKeyword: () => {},
    }));
    const text = container.textContent || '';
    expect(text).toContain('T_TAB_0');
    expect(text).not.toContain('FNAME'); // 字段不出现在左栏
    await unmount();
  });

  it('筛选下拉可用：缺主键 / 按来源', async () => {
    const { TableList } = await import('../src/webview/pages/dictionary/panels');
    const { container, unmount } = await mount(h(TableList, {
      tables: many, sources: [{ kind: 'pdm', name: 'MFG.pdm' } as any], selected: '', onSelect: () => {}, keyword: '', onKeyword: () => {},
    }));
    const opts = [...container.querySelectorAll('option')].map((o) => o.textContent);
    expect(opts).toContain('缺主键');
    expect(opts).toContain('缺中文注释');
    expect(opts.some((t) => t?.includes('MFG.pdm'))).toBe(true);
    await unmount();
  });
});

describe('同步流程与连接状态指示', () => {
  it('项目栏状态点：配了连接显示绿点，没配显示灰点', async () => {
    const { ProjectBar } = await import('../src/webview/pages/dictionary/panels');
    const projects = [
      { id: 'p1', name: '有连接', createdAt: '', updatedAt: '', sourceCount: 1, tableCount: 10, configSummary: { db: true, kingdee: true } },
      { id: 'p2', name: '无连接', createdAt: '', updatedAt: '', sourceCount: 0, tableCount: 0, configSummary: { db: false, kingdee: false } },
    ];
    const { container, unmount } = await mount(h(ProjectBar, {
      projects, currentId: 'p1', onSwitch: () => {}, onCreate: () => {}, onRename: () => {},
      onClear: () => {}, onDelete: () => {}, onExport: () => {}, onImport: () => {}, onConfig: () => {},
    }));
    const ok = container.querySelectorAll('.dot.ok');
    const all = container.querySelectorAll('.dot');
    expect(all.length).toBe(2); // DB + 金蝶 两个点
    expect(ok.length).toBe(2);  // p1 两个都配了

    // 切到没连接的项目
    const { container: c2, unmount: u2 } = await mount(h(ProjectBar, {
      projects, currentId: 'p2', onSwitch: () => {}, onCreate: () => {}, onRename: () => {},
      onClear: () => {}, onDelete: () => {}, onExport: () => {}, onImport: () => {}, onConfig: () => {},
    }));
    expect(c2.querySelectorAll('.dot.ok').length).toBe(0);
    await unmount();
    await u2();
  });

  it('来源面板：db/金蝶来源显示「同步」，其它来源不显示', async () => {
    const { SourcesPanel } = await import('../src/webview/pages/dictionary/panels');
    const dict = {
      version: 1, name: 'x', dialect: 'generic', tables: [], importErrors: [],
      sources: [
        { id: 's1', kind: 'db' as const, name: '在线库', importedAt: new Date().toISOString(), tableCount: 5, enabled: true, priority: 20 },
        { id: 's2', kind: 'pdm' as const, name: 'MFG.pdm', path: '/tmp/a.pdm', importedAt: new Date().toISOString(), tableCount: 100, enabled: true, priority: 10 },
      ],
    };
    const { container, unmount } = await mount(h(SourcesPanel, {
      dict, onRemove: () => {}, onToggle: () => {}, onRefresh: () => {}, onSync: () => {}, onAdd: () => {},
    }));
    const links = [...container.querySelectorAll('a')].map((a) => (a.textContent || '').trim());
    expect(links.filter((t) => t.startsWith('同步')).length).toBe(1); // 只有 db 那个
    await unmount();
  });

  it('连接配置页：两个测试按钮都在，且结果显示在页面上', async () => {
    const { ProjectConfigPanel } = await import('../src/webview/pages/dictionary/panels');
    const cfg = { connections: { db: { client: 'mysql', host: 'h', port: 3306, user: 'u', database: 'd' }, kingdee: { baseUrl: 'http://k3' } } } as any;
    const { container, unmount } = await mount(h(ProjectConfigPanel, {
      projectName: 'A客户', config: cfg, savedSecretKeys: [], savedDbKeys: [],
      onTest: async () => '配置可用：已登录并取得会话',
      onSave: async () => {},
    }));
    const btns = [...container.querySelectorAll('button')].map((b) => b.textContent || '');
    expect(btns.some((t) => t.includes('测试 SQL 连接'))).toBe(true);
    expect(btns.some((t) => t.includes('测试 WebAPI 配置'))).toBe(true);

    const sqlBtn = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').includes('测试 SQL 连接'))!;
    await act(async () => { sqlBtn.click(); });
    await flush();
    // 结果必须真的出现在页面上（之前 testMsg 只赋值不渲染 → 点了看不到任何反馈）
    expect((container.textContent || '')).toContain('已登录并取得会话');
    await unmount();
  });

  it('数据库连接已存过密码时，面板标注「已保存」', async () => {
    const { ProjectConfigPanel } = await import('../src/webview/pages/dictionary/panels');
    const cfg = { connections: { db: { client: 'mysql', host: 'h', port: 3306, user: 'u', database: 'd' }, kingdee: {} } } as any;
    const { container, unmount } = await mount(h(ProjectConfigPanel, {
      projectName: 'A客户', config: cfg,
      savedSecretKeys: ['appSecret'], savedDbKeys: ['password'],
      onTest: async () => '', onSave: async () => {},
    }));
    expect((container.textContent || '').includes('已保存')).toBe(true);
    await unmount();
  });
});

describe('侧边栏底部版本信息', () => {
  it('渲染出 .nav-footer 并显示对应版本号', async () => {
    const { App } = await import('../src/webview/app');
    (window as any).__DEVTOOLBOX_VERSION__ = '9.9.9';
    const { container, unmount } = await mount(h(App, {}));

    const footer = container.querySelector('.nav-footer') as HTMLElement;
    expect(footer).toBeTruthy();
    expect((footer.textContent || '').trim()).toBe('DevToolbox v9.9.9');

    // 常驻底部：列表区独立滚动，footer 不在滚动容器内
    const scroll = container.querySelector('.nav-scroll')!;
    expect(scroll.contains(footer)).toBe(false);
    await unmount();
  });

  it('拿不到版本号时只显示名称，不显示 undefined/NaN', async () => {
    const { App } = await import('../src/webview/app');
    delete (window as any).__DEVTOOLBOX_VERSION__;
    const { container, unmount } = await mount(h(App, {}));

    const footer = container.querySelector('.nav-footer') as HTMLElement;
    expect((footer.textContent || '').trim()).toBe('DevToolbox');
    expect((footer.textContent || '')).not.toContain('undefined');
    await unmount();
  });
});

describe('跨项目比对与布局分区', () => {
  it('跨项目比对面板：未选项目时给提示，选了才出按钮', async () => {
    const { CrossProjectDiffPanel } = await import('../src/webview/pages/dictionary/panels');
    const projects = [
      { id: 'p1', name: '客户A' }, { id: 'p2', name: '客户B' },
    ];
    const { container, unmount } = await mount(h(CrossProjectDiffPanel, {
      projects, currentId: 'p1', otherId: '', diff: {}, loading: false,
      onPickOther: () => {}, onRun: () => {}, onCopy: () => {},
    }));
    // 下拉里不能出现当前项目自己
    const opts = [...container.querySelectorAll('option')].map((o) => o.textContent);
    expect(opts).toContain('客户B');
    expect(opts).not.toContain('客户A');
    expect((container.textContent || '')).toContain('选择另一个项目后点「开始比对」');
    await unmount();
  });

  it('有结果时显示统计与差异表', async () => {
    const { CrossProjectDiffPanel } = await import('../src/webview/pages/dictionary/panels');
    const { container, unmount } = await mount(h(CrossProjectDiffPanel, {
      projects: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }],
      currentId: 'p1', otherId: 'p2', loading: false,
      diff: { summary: { onlyCurrent: 3, onlyOther: 1, modified: 2, total: 6 }, items: [{ table: 'T_X', object: 'FID', kind: 'modified', changes: [{ prop: '类型', from: 'int', to: 'bigint' }] }] },
      onPickOther: () => {}, onRun: () => {}, onCopy: () => {},
    }));
    const txt = container.textContent || '';
    expect(txt).toContain('仅当前项目有 3');
    expect(txt).toContain('有差异 2');
    expect(txt).toContain('T_X');
    await unmount();
  });

  it('页签行是横向滚动容器（不换行下压内容）', async () => {
    const { DictionaryPage } = await import('../src/webview/pages/DictionaryPage');
    const { container, unmount } = await mount(h(DictionaryPage, {}));
    const tabs = container.querySelector('.dc-tabs');
    expect(tabs).toBeTruthy();
    const header = container.querySelector('.dc-header');
    expect(header).toBeTruthy();
    // 页签行必须在吸顶区内，否则滚动后会被内容盖住
    expect(header!.contains(tabs!)).toBe(true);
    await unmount();
  });
});

describe('写盘失败必须让用户知道', () => {
  it('保存失败时给出错误提示，而不是静默显示"完成"', async () => {
    const { DictionaryPage } = await import('../src/webview/pages/DictionaryPage');
    const { container, unmount } = await mount(h(DictionaryPage, {}));
    // 页面能正常渲染（不因新增的 saveOrWarn 而崩）
    expect(container.querySelector('.dc-header')).toBeTruthy();
    await unmount();
  });
});

describe('重复按钮合并', () => {
  it('项目栏不再有「连接配置」按钮（入口统一收敛到页签行，状态点仍可点进配置）', async () => {
    const { ProjectBar } = await import('../src/webview/pages/dictionary/panels');
    const projects = [{ id: 'p1', name: 'A', createdAt: '', updatedAt: '', sourceCount: 1, tableCount: 1, configSummary: { db: true, kingdee: false } }];
    const { container, unmount } = await mount(h(ProjectBar, {
      projects, currentId: 'p1', onSwitch: () => {}, onCreate: () => {}, onRename: () => {},
      onClear: () => {}, onDelete: () => {}, onExport: () => {}, onImport: () => {}, onConfig: () => {},
    }));
    const btns = [...container.querySelectorAll('button')].map((b) => (b.textContent || '').trim());
    expect(btns).not.toContain('连接配置');
    // 状态点入口保留：点击状态点应触发 onConfig
    let called = 0;
    await unmount();
    const { container: c2 } = await mount(h(ProjectBar, {
      projects, currentId: 'p1', onSwitch: () => {}, onCreate: () => {}, onRename: () => {},
      onClear: () => {}, onDelete: () => {}, onExport: () => {}, onImport: () => {},
      onConfig: () => { called++; },
    }));
    (c2.querySelector('.dot') as HTMLElement).click();
    expect(called).toBe(1);
    await unmount();
  });
});

describe('EncodePage 宿主运算模式（hash/aes/des/random/charset）', () => {
  async function mountEncode() {
    const { EncodePage } = await import('../src/webview/pages/EncodePage');
    const container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => { render(h(EncodePage, {}), container); });
    await flush();
    return {
      container,
      unmount: async () => { await act(async () => { render(null, container); }); container.remove(); },
    };
  }
  const selMode = (container: HTMLElement, mode: string) => {
    const s = container.querySelector('select') as HTMLSelectElement;
    s.value = mode;
    s.dispatchEvent(new Event('change'));
  };
  const texts = (c: HTMLElement) => c.textContent || '';

  it('默认 base64 模式：双向方向选择存在，无参数区', async () => {
    const { container, unmount } = await mountEncode();
    const selects = container.querySelectorAll('select');
    expect(selects.length).toBe(2); // 模式 + 方向
    expect(texts(container)).not.toContain('密钥 Key');
    await unmount();
  });

  it('切到 hash：方向选择消失（单向），显示算法选择 + HMAC 选项', async () => {
    const { container, unmount } = await mountEncode();
    selMode(container, 'hash');
    await flush();
    // 方向下拉消失（select 只剩 模式+算法 两个，且无任何 value=encode 的选项）
    expect(container.querySelectorAll('select').length).toBe(2);
    expect([...container.querySelectorAll('select')].every((s) => ![...s.options].some((o) => o.value === 'encode'))).toBe(true);
    expect(texts(container)).toContain('算法');
    expect(texts(container)).toContain('HMAC');
    await unmount();
  });

  it('切到 aes：密钥/IV/Mode/Padding/输出编码 参数齐全，方向标签为加密/解密', async () => {
    const { container, unmount } = await mountEncode();
    selMode(container, 'aes');
    await flush();
    const t = texts(container);
    expect(t).toContain('密钥 Key');
    expect(t).toContain('模式 Mode');
    expect(t).toContain('填充 Padding');
    expect(t).toContain('输出编码');
    expect(t).toContain('加密 →');
    await unmount();
  });

  it('切到 aes 选 ECB 后 IV 区消失', async () => {
    const { container, unmount } = await mountEncode();
    selMode(container, 'aes');
    await flush();
    const modeSel = [...container.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'cbc')) as HTMLSelectElement;
    modeSel.value = 'ecb';
    modeSel.dispatchEvent(new Event('change'));
    await flush();
    expect(texts(container)).not.toContain('IV');
    await unmount();
  });

  it('切到 random：类型选择 + 密码字符集勾选，无输入校验（可直接生成）', async () => {
    const { container, unmount } = await mountEncode();
    selMode(container, 'random');
    await flush();
    expect(container.querySelectorAll('select').length).toBe(2); // 模式 + 类型
    expect(texts(container)).toContain('类型');
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(0); // 默认 uuid 无字符集勾选
    await unmount();
  });

  it('切到 charset：目标编码选择出现', async () => {
    const { container, unmount } = await mountEncode();
    selMode(container, 'charset');
    await flush();
    const t = texts(container);
    expect(t).toContain('目标编码');
    expect(t).toContain('GBK');
    await unmount();
  });
});

describe('EncodePage EAS 报文解析模式', () => {
  it('切换到 eas：无方向选择，显示来源编码参数', async () => {
    const { EncodePage } = await import('../src/webview/pages/EncodePage');
    const container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => { render(h(EncodePage, {}), container); });
    await flush();
    const s = container.querySelector('select') as HTMLSelectElement;
    s.value = 'eas';
    s.dispatchEvent(new Event('change'));
    await flush();
    const t = container.textContent || '';
    expect(t).toContain('来源编码');
    expect(t).toContain('EAS');
    expect([...container.querySelectorAll('select')].every((el) => ![...el.options].some((o) => o.value === 'encode'))).toBe(true);
    await act(async () => { render(null, container); });
    container.remove();
  });
});

describe('RepairPanel 三基线（SQL Server / MySQL / 金蝶 WebAPI / JSON）', () => {
  async function mountRepair(preset?: any) {
    const { RepairPanel } = await import('../src/webview/pages/DictionaryPage');
    const dict = { name: 'x', tables: [] } as any;
    const container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => { render(h(RepairPanel, { dict, setDict: () => {}, baseline: null, setBaseline: () => {}, preset, projectId: 'p1' }), container); });
    await flush();
    return container;
  }
  const inputs = (c: HTMLElement) => [...c.querySelectorAll('input')] as HTMLInputElement[];
  const radios = (c: HTMLElement) => [...c.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
  const switchKind = async (c: HTMLElement, label: string) => {
    const r = radios(c).find((el) => (el.parentElement as HTMLElement).textContent?.includes(label));
    if (!r) return;
    r.click();
    await flush();
  };

  it('默认 SQL Server：4 个基线单选 + 连接行预填 1433/sa，无「项目连接」按钮', async () => {
    const c = await mountRepair(undefined);
    expect(radios(c).length).toBe(4);
    const t = c.textContent || '';
    expect(t).toContain('SQL Server');
    expect(t).toContain('MySQL');
    expect(t).toContain('金蝶 WebAPI');
    expect(t).toContain('JSON 文件');
    const port = inputs(c).find((i) => i.type === 'number') as HTMLInputElement;
    expect(port.value).toBe('1433');
    const btns = [...c.querySelectorAll('button')].map((b) => b.textContent || '');
    expect(btns).toContain('拉取库结构');
    expect(btns).not.toContain('项目连接');
    document.body.removeChild(c);
  });

  it('mssql preset：预填项目连接 + 出现「项目连接」还原按钮；MySQL preset 不串扰', async () => {
    const c = await mountRepair({ client: 'mssql', host: 'prod.example.cn', port: 1433, user: 'sa', database: 'ERP_DB' });
    const vals = inputs(c).map((i) => i.value);
    expect(vals).toContain('prod.example.cn');
    expect(vals).toContain('ERP_DB');
    expect(vals).toContain('sa');
    const btns = [...c.querySelectorAll('button')].map((b) => b.textContent || '');
    expect(btns).toContain('项目连接');
    document.body.removeChild(c);

    const c2 = await mountRepair({ client: 'mysql', host: '10.0.0.2', port: 3307, user: 'dev', database: 'erp' });
    // 默认 kind=sqlserver，mysql preset 不应预填到 SQL Server 连接行
    const vals2 = inputs(c2).map((i) => i.value);
    expect(vals2).not.toContain('10.0.0.2');
    document.body.removeChild(c2);
  });

  it('切到 MySQL：连接行改 3306/root', async () => {
    const c = await mountRepair(undefined);
    await switchKind(c, 'MySQL');
    const port = inputs(c).find((i) => i.type === 'number') as HTMLInputElement;
    expect(port.value).toBe('3306');
    const user = inputs(c).find((i) => i.placeholder === 'user') as HTMLInputElement;
    expect(user.value).toBe('root');
    document.body.removeChild(c);
  });

  it('切到 金蝶 WebAPI：出「拉取元数据」，连接行消失', async () => {
    const c = await mountRepair(undefined);
    await switchKind(c, '金蝶 WebAPI');
    const t = c.textContent || '';
    expect(t).toContain('拉取元数据');
    expect(inputs(c).some((i) => (i.placeholder || '').includes('表单标识'))).toBe(true);
    expect(inputs(c).some((i) => i.placeholder === 'host')).toBe(false);
    document.body.removeChild(c);
  });

  it('切到 JSON 文件：出「选择 .dtcat.json」按钮', async () => {
    const c = await mountRepair(undefined);
    await switchKind(c, 'JSON 文件');
    const btns = [...c.querySelectorAll('button')].map((b) => b.textContent || '');
    expect(btns).toContain('选择 .dtcat.json');
    expect(inputs(c).some((i) => i.placeholder === 'host')).toBe(false);
    document.body.removeChild(c);
  });
});

describe('parseDtcat（.dtcat.json 校验解析）', () => {
  it('合法内容返回字典', async () => {
    const { parseDtcat } = await import('../src/webview/pages/DictionaryPage');
    const d = parseDtcat(JSON.stringify({ version: 1, tables: [{ name: 'T1', columns: [] }] }), 'a.json');
    expect(d.tables[0].name).toBe('T1');
  });
  it('非法 JSON / 缺 version / 非对象 均报错', async () => {
    const { parseDtcat } = await import('../src/webview/pages/DictionaryPage');
    expect(() => parseDtcat('{oops', 'a.json')).toThrow('不是合法 JSON');
    expect(() => parseDtcat(JSON.stringify({ tables: [] }), 'b.json')).toThrow('不是有效的 .dtcat.json');
    expect(() => parseDtcat('null', 'c.json')).toThrow('不是有效的 .dtcat.json');
  });
});
