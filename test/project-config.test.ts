import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectStore, projectSecretKey } from '../src/host/project-store';
import { emptyProjectConfig } from '../src/core/messaging';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-proj-'));
  return { dir, store: new ProjectStore({ fsPath: dir } as any) };
}

describe('项目连接配置存储', () => {
  it('读空配置返回空对象，保存后可原样读回', () => {
    const { store } = makeStore();
    const p = store.create('A客户');
    expect(store.loadConfig(p.id)).toEqual(emptyProjectConfig());
    store.saveConfig(p.id, {
      connections: {
        db: { client: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', database: 'erp' },
        kingdee: { baseUrl: 'http://k3/a', dbId: '001', user: 'admin', lcid: 2052, argStyle: 'named' },
      },
    });
    const cfg = store.loadConfig(p.id);
    expect(cfg.connections.db?.database).toBe('erp');
    expect(cfg.connections.kingdee?.baseUrl).toBe('http://k3/a');
    expect(cfg.connections.kingdee?.argStyle).toBe('named');
  });

  it('白名单过滤：凭据字段永远不会被写进 config.json', () => {
    const { dir, store } = makeStore();
    const p = store.create('B客户');
    store.saveConfig(p.id, {
      connections: {
        db: { client: 'mssql', host: 'h', port: 1433, user: 'sa', database: 'db' } as any,
        kingdee: { baseUrl: 'http://k3', user: 'u' } as any,
      },
    } as any);
    // 模拟上游误传（应被白名单丢弃）
    store.saveConfig(p.id, {
      connections: {
        db: { host: 'h', password: 'p@ss', secretKey: 'devtoolbox.db.x' },
        kingdee: { baseUrl: 'http://k3', appSecret: 's3cret', password: 'pwd' },
      },
    } as any);
    const raw = fs.readFileSync(path.join(dir, 'projects', p.id, 'config.json'), 'utf8');
    expect(raw).not.toContain('p@ss');
    expect(raw).not.toContain('s3cret');
    expect(raw).not.toContain('secretKey');
    expect(store.loadConfig(p.id).connections.kingdee).toEqual({ baseUrl: 'http://k3', user: undefined, lcid: undefined });
  });

  it('切换项目后各自的连接互不干扰', () => {
    const { store } = makeStore();
    const a = store.create('A');
    const b = store.create('B');
    store.saveConfig(a.id, { connections: { db: { host: 'a-host', database: 'a_db' } } });
    store.saveConfig(b.id, { connections: { db: { host: 'b-host', database: 'b_db' } } });
    expect(store.loadConfig(a.id).connections.db?.host).toBe('a-host');
    expect(store.loadConfig(b.id).connections.db?.host).toBe('b-host');
    store.setCurrent(b.id);
    expect(store.list().currentId).toBe(b.id);
  });

  it('导出包带连接配置但不带密码，导入后配置还原', () => {
    const { store } = makeStore();
    const p = store.create('待导出');
    store.saveConfig(p.id, { connections: { db: { host: '10.0.0.9', port: 3306, user: 'u', database: 'erp' }, kingdee: { baseUrl: 'http://k3', dbId: '01' } } });
    const bundle = store.exportBundle(p.id);
    expect(bundle.config?.connections?.db?.host).toBe('10.0.0.9');
    expect(JSON.stringify(bundle)).not.toContain('password');

    const imported = store.importBundle(bundle);
    expect(store.loadConfig(imported.id).connections.db?.host).toBe('10.0.0.9');
    expect(store.loadConfig(imported.id).connections.kingdee?.dbId).toBe('01');
  });

  it('项目级凭据键带 projectId，天然隔离', () => {
    expect(projectSecretKey('p1', 'db')).toBe('devtoolbox.project.p1.db');
    expect(projectSecretKey('p1', 'kingdee')).toBe('devtoolbox.project.p1.kingdee');
    expect(projectSecretKey('p2', 'db')).not.toBe(projectSecretKey('p1', 'db'));
  });
});
