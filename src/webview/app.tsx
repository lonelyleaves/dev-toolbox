import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { CATEGORIES, TOOLS } from '../core/tool-registry';
import { WvPush } from '../core/messaging';
import { bridge, host } from './bridge';
import { TimestampPage } from './pages/TimestampPage';
import { CronPage } from './pages/CronPage';
import { DiffPage } from './pages/DiffPage';
import { RegexPage } from './pages/RegexPage';
import { JsonPage } from './pages/JsonPage';
import { QrcodePage } from './pages/QrcodePage';
import { CurlPage } from './pages/CurlPage';
import { SqlFormatPage } from './pages/SqlFormatPage';
import { JavaToJsonPage } from './pages/JavaToJsonPage';
import { SqlRestorePage } from './pages/SqlRestorePage';
import { DictionaryPage } from './pages/DictionaryPage';
import { EncodePage } from './pages/EncodePage';
import { ColorHashPage } from './pages/ColorHashPage';

const PAGES: Record<string, any> = {
  timestamp: TimestampPage,
  cron: CronPage,
  diff: DiffPage,
  regex: RegexPage,
  json: JsonPage,
  qrcode: QrcodePage,
  curl: CurlPage,
  sqlFormat: SqlFormatPage,
  javaToJson: JavaToJsonPage,
  sqlRestore: SqlRestorePage,
  dictionary: DictionaryPage,
  encode: EncodePage,
  colorHash: ColorHashPage,
};

export interface Prefill {
  toolId: string;
  text: string;
  ts: number;
}

/** 扩展版本号：由宿主生成 webview HTML 时注入；取不到就返回空串（宁可不显示，也不显示假的） */
function appVersion(): string {
  return String((window as any).__DEVTOOLBOX_VERSION__ || '');
}

/** 工具检索：命中 id / 名称 / 描述 / 分类（大小写不敏感） */
function matchTools(query: string) {
  const kw = query.trim().toLowerCase();
  if (!kw) return TOOLS;
  return TOOLS.filter((t) =>
    [t.id, t.label, t.description, t.category].some((f) => f.toLowerCase().includes(kw))
  );
}

export function App() {
  const [active, setActive] = useState('timestamp');
  const [prefill, setPrefill] = useState<Prefill | undefined>();
  const [query, setQuery] = useState('');
  const visibleTools = matchTools(query);
  /** 当前页是否为"填充式"布局（如字典浏览的双栏）：填充式页面自己管滚动，外层不再滚 */
  const [fill, setFill] = useState(false);

  // 面板标题跟随当前工具（避免停留在上次打开的标题）
  useEffect(() => {
    void host.setPanelTitle(active).catch(() => undefined);
  }, [active]);

  // 注册 openTool 监听（宿主推送）
  useEffect(() => {
    const handler = (p: WvPush) => {
      if (p.event === 'openTool' && p.toolId) {
        setActive(p.toolId);
        const payload = p.payload as { text?: string } | undefined;
        if (payload && typeof payload.text === 'string') {
          setPrefill({ toolId: p.toolId, text: payload.text, ts: Date.now() });
        }
      }
    };
    bridge.pushHandlers.push(handler);
    return () => {
      const i = bridge.pushHandlers.indexOf(handler);
      if (i >= 0) bridge.pushHandlers.splice(i, 1);
    };
  }, []);

  const Page = PAGES[active];
  const tool = TOOLS.find((t) => t.id === active);

  return (
    <div class="app">
      <div class="nav">
        <div class="nav-scroll">
        <input
          class="nav-search"
          type="text"
          placeholder="搜索工具…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        {visibleTools.length === 0 && <div class="cat">无匹配工具</div>}
        {CATEGORIES.map((cat) => {
          const items = visibleTools.filter((t) => t.category === cat);
          if (items.length === 0) return null;
          return (
            <div key={cat}>
              <div class="cat">{cat}</div>
              {items.map((t) => (
                <div key={t.id} class={`item${active === t.id ? ' active' : ''}`} onClick={() => setActive(t.id)} title={t.description}>
                  <span class={`codicon codicon-${t.icon}`}></span>
                  <span>{t.label}</span>
                </div>
              ))}
            </div>
          );
        })}
        </div>
        <div class="nav-footer" title={appVersion() ? `DevToolbox v${appVersion()}` : 'DevToolbox'}>
          {appVersion() ? `DevToolbox v${appVersion()}` : 'DevToolbox'}
        </div>
      </div>
      <div class="page">
        <div class="page-head">
          <span class={`codicon codicon-${tool?.icon || 'tools'} page-icon`}></span>
          <div>
            <h2 class="page-title">{tool?.label}</h2>
            <p class="page-desc">{tool?.description}</p>
          </div>
        </div>
        {/* page-body 独立滚动：双栏视图（字典浏览）会让出滚动权，由左右两栏各自滚 */}
        <div class={`page-body${fill ? ' fill' : ''}`}>
          {Page ? <Page prefill={prefill} setFill={setFill} /> : null}
        </div>
      </div>
    </div>
  );
}
