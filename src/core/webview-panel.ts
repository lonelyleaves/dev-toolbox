import * as vscode from 'vscode';
import { WebviewMsg, WvRequest } from './messaging';
import { toolById } from './tool-registry';
import { handleHostCommand } from '../host/dispatcher';

/**
 * 全局单例工具面板：Tab 式承载所有工具页。
 * 打开某个工具 = 显示面板并推送 openTool。
 */
export class ToolboxPanel {
  public static current: ToolboxPanel | undefined;
  private pendingPrefill: { toolId: string; payload?: unknown } | undefined;
  private webviewReady = false;

  private constructor(private panel: vscode.WebviewPanel) {
    panel.onDidDispose(() => {
      ToolboxPanel.current = undefined;
      this.webviewReady = false;
    });
    panel.webview.onDidReceiveMessage(async (msg: WebviewMsg) => {
      if (msg.kind === 'request') {
        await this.dispatch(msg);
      } else if (msg.kind === 'push' && (msg as any).event === 'ready') {
        this.webviewReady = true;
        if (this.pendingPrefill) {
          this.push(this.pendingPrefill.toolId, this.pendingPrefill.payload);
          this.pendingPrefill = undefined;
        }
      }
    });
  }

  static show(toolId: string, prefill?: unknown): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (!ToolboxPanel.current) {
      const panel = vscode.window.createWebviewPanel('devToolbox', 'DevToolbox 工具箱', column, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(ToolboxPanel.extUri, 'dist', 'webview')],
      });
      ToolboxPanel.current = new ToolboxPanel(panel);
      panel.webview.html = ToolboxPanel.current.buildHtml();
    } else {
      ToolboxPanel.current.panel.reveal(column);
    }
    const inst = ToolboxPanel.current;
    const payload = prefill === undefined ? undefined : prefill;
    if (inst.webviewReady) {
      inst.push(toolId, payload);
    } else {
      inst.pendingPrefill = { toolId, payload };
    }
  }

  private push(toolId: string, payload?: unknown) {
    const tool = toolById(toolId);
    this.panel.webview.postMessage({ kind: 'push', event: 'openTool', toolId, payload });
    if (tool) {
      this.panel.title = `${tool.label} - DevToolbox`;
    }
  }

  private async dispatch(req: WvRequest) {
    let resp: WebviewMsg;
    try {
      const data = await handleHostCommand(req.cmd, req.payload, this.panel);
      resp = { kind: 'response', id: req.id, ok: true, data };
    } catch (e: any) {
      resp = { kind: 'response', id: req.id, ok: false, error: e?.message || String(e) };
    }
    void this.panel.webview.postMessage(resp);
  }

  private static extUri: vscode.Uri = undefined as unknown as vscode.Uri;
  static init(extUri: vscode.Uri) {
    ToolboxPanel.extUri = extUri;
  }

  private buildHtml(): string {
    const wv = this.panel.webview;
    const dist = vscode.Uri.joinPath(ToolboxPanel.extUri, 'dist', 'webview');
    const jsUri = wv.asWebviewUri(vscode.Uri.joinPath(dist, 'main.js'));
    const cssUri = wv.asWebviewUri(vscode.Uri.joinPath(dist, 'main.css'));
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${wv.cspSource} data: blob:; style-src ${wv.cspSource} 'unsafe-inline'; font-src ${wv.cspSource}; script-src 'nonce-${nonce}' ${wv.cspSource}; worker-src ${wv.cspSource} blob:;">
<link href="${cssUri}" rel="stylesheet">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" type="module" src="${jsUri}"></script>
</body>
</html>`;
  }
}
