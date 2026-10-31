import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectStore, projectSecretKey } from '../src/host/project-store';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-proj-'));
  return { dir, store: new ProjectStore({ fsPath: dir } as any) };
}

describe('项目连接配置存储（多配置 + 旧单配置迁移）', () => {
  it('读空配置返回空数组结构', () => {
    const { store } = makeStore();
    const p = store.create('A客户');
    expect(store.loadConfig(p.id)).toEqual({ connections: { db: [], kingdee: [] } });
  });

  it('旧单对象配置自动迁移为数组，赋 id=default', () => {
    const { store } = makeStore();
    const p = store.create('B客户');
    store.saveConfig(p.id, {
      connections: {
        db: { client: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', database: 'erp' },
        kingdee: { baseUrl: 'http://k3/a', dbId: '001', user: 'admin', lcid: 2052, argStyle: 'named' },
      },
    } as any);
    const cfg = store.loadConfig(p.id);
    expect(Array.isArray(cfg.connections.db)).toBe(true);
    expect(cfg.connections.db![0].id).toBe('default');
    expect(cfg.connections.db![0].database).toBe('erp');
    expect(cfg.connections.kingdee![0].baseUrl).toBe('http://k3/a');
    expect(cfg.connections.kingdee![0].argStyle).toBe('named');
  });

  it('autoName 标记持久化：用户重命名后不会被重新自动命名', () => {
    const { store } = makeStore();
    const p = store.create('D客户');
    store.saveConfig(p.id, {
      connections: { db: [{ id: 'd1', name: '生产库', autoName: false, host: '10.0.3.60', database: 'ERP' }] },
    });
    const db = store.loadConfig(p.id).connections.db![0];
    expect(db.name).toBe('生产库');
    expect(db.autoName).toBe(false);
  });

  it('多配置数组原样保存读回', () => {
    const { store } = makeStore();
    const p = store.create('C客户');
    store.saveConfig(p.id, {
      connections: {
        db: [
          { id: 'd1', name: '生产', client: 'mysql', host: 'h1', port: 3306, user: 'u1', database: 'db1' },
          { id: 'd2', name: '测试', client: 'postgres', host: 'h2', port: 5432, user: 'u2', database: 'db2' },
        ],
        kingdee: [{ id: 'k1', name: '星空A', baseUrl: 'http://k3/a' }],
      },
    });
    const cfg = store.loadConfig(p.id);
    expect(cfg.connections.db!.length).toBe(2);
    expect(cfg.connections.db!.find((x) => x.id === 'd2')?.host).toBe('h2');
    expect(cfg.connections.kingdee![0].name).toBe('星空A');
  });

  it('白名单过滤：凭据字段永远不会被写进 config.json', () => {
    const { dir, store } = makeStore();
    const p = store.create('D客户');
    store.saveConfig(p.id, {
      connections: {
        db: [{ id: 'd1', name: 'x', host: 'h', password: 'p@ss', secretKey: 'devtoolbox.db.x' }],
        kingdee: [{ id: 'k1', name: 'y', baseUrl: 'http://k3', appSecret: 's3cret', password: 'pwd' }],
      },
    } as any);
    const raw = fs.readFileSync(path.join(dir, 'projects', p.id, 'config.json'), 'utf8');
    expect(raw).not.toContain('p@ss');
    expect(raw).not.toContain('s3cret');
    expect(raw).not.toContain('secretKey');
    const kd = store.loadConfig(p.id).connections.kingdee![0];
    expect(kd.baseUrl).toBe('http://k3');
    expect((kd as any).appSecret).toBeUndefined();
  });

  it('切换项目后各自的连接互不干扰', () => {
    const { store } = makeStore();
    const a = store.create('A');
    const b = store.create('B');
    store.saveConfig(a.id, { connections: { db: [{ id: 'default', name: 'd', host: 'a-host', database: 'a_db' }] } });
    store.saveConfig(b.id, { connections: { db: [{ id: 'default', name: 'd', host: 'b-host', database: 'b_db' }] } });
    expect(store.loadConfig(a.id).connections.db![0].host).toBe('a-host');
    expect(store.loadConfig(b.id).connections.db![0].host).toBe('b-host');
    store.setCurrent(b.id);
    expect(store.list().currentId).toBe(b.id);
  });

  it('导出包带连接配置但不带密码，导入后配置还原', () => {
    const { store } = makeStore();
    const p = store.create('待导出');
    store.saveConfig(p.id, { connections: { db: [{ id: 'default', name: 'd', host: '10.0.0.9', port: 3306, user: 'u', database: 'erp' }], kingdee: [{ id: 'default', name: 'k', baseUrl: 'http://k3', dbId: '01' }] } });
    const bundle = store.exportBundle(p.id);
    expect(bundle.config?.connections?.db?.[0]?.host).toBe('10.0.0.9');
    expect(JSON.stringify(bundle)).not.toContain('password');
    const imported = store.importBundle(bundle);
    expect(store.loadConfig(imported.id).connections.db?.[0]?.host).toBe('10.0.0.9');
    expect(store.loadConfig(imported.id).connections.kingdee?.[0]?.dbId).toBe('01');
  });

  it('项目栏摘要按配置条数统计（多配置）', () => {
    const { store } = makeStore();
    const p = store.create('多条');
    store.saveConfig(p.id, {
      connections: {
        db: [
          { id: 'd1', name: 'a', host: 'h1', database: 'db1' },
          { id: 'd2', name: 'b', host: 'h2', database: 'db2' },
        ],
        kingdee: [{ id: 'k1', name: 'k', baseUrl: 'http://k3' }],
      },
    } as any);
    const listed = store.list().projects.find((x) => x.id === p.id);
    expect(listed?.configSummary?.db).toBe(2);
    expect(listed?.configSummary?.kingdee).toBe(1);
  });

  it('项目级凭据键：default 沿用旧格式，新配置拼 configId', () => {
    expect(projectSecretKey('p1', 'db')).toBe('devtoolbox.project.p1.db');
    expect(projectSecretKey('p1', 'db', 'default')).toBe('devtoolbox.project.p1.db');
    expect(projectSecretKey('p1', 'db', 'c_x')).toBe('devtoolbox.project.p1.db.c_x');
    expect(projectSecretKey('p2', 'db')).not.toBe(projectSecretKey('p1', 'db'));
  });
});
