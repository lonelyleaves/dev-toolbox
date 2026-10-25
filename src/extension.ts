import * as vscode from 'vscode';
import { ToolboxPanel } from './core/webview-panel';
import { TOOLS } from './core/tool-registry';
import { initHost } from './host/dispatcher';

export function activate(context: vscode.ExtensionContext) {
  initHost(context);
  ToolboxPanel.init(context.extensionUri);

  // 每个工具一个命令 + 通用打开命令
  for (const tool of TOOLS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`devToolbox.open.${tool.id}`, () => ToolboxPanel.show(tool.id))
    );
  }
  // 右上角标题栏常驻按钮：打开工具箱（默认落在当前激活编辑器的语言对应工具，否则时间戳）
  context.subscriptions.push(
    vscode.commands.registerCommand('devToolbox.openPanel', () => {
      const lang = vscode.window.activeTextEditor?.document.languageId;
      const byLang: Record<string, string> = { json: 'json', sql: 'sqlFormat', java: 'javaToJson' };
      ToolboxPanel.show(byLang[lang || ''] || 'timestamp');
    })
  );

  // 编辑器右键：把选区内容带入对应工具
  const editorToTool: Record<string, string> = {
    'devToolbox.editor.json': 'json',
    'devToolbox.editor.javaToJson': 'javaToJson',
    'devToolbox.editor.sqlFormat': 'sqlFormat',
    'devToolbox.editor.curl': 'curl',
    'devToolbox.editor.timestamp': 'timestamp',
    'devToolbox.editor.diff': 'diff',
  };
  for (const [cmd, toolId] of Object.entries(editorToTool)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const text = editor.document.getText(editor.selection);
        ToolboxPanel.show(toolId, { text });
      })
    );
  }

  // 顶部标签页右键：把整个文件内容带入对应工具（命令参数为被右键 tab 的 Uri）
  const tabToTool: Record<string, string> = {
    'devToolbox.tab.json': 'json',
    'devToolbox.tab.javaToJson': 'javaToJson',
    'devToolbox.tab.sqlFormat': 'sqlFormat',
    'devToolbox.tab.curl': 'curl',
    'devToolbox.tab.timestamp': 'timestamp',
    'devToolbox.tab.diff': 'diff',
  };
  for (const [cmd, toolId] of Object.entries(tabToTool)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, async (arg?: vscode.Uri) => {
        const uri = arg ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri) return;
        const doc = await vscode.workspace.openTextDocument(uri);
        ToolboxPanel.show(toolId, { text: doc.getText() });
      })
    );
  }
}

export function deactivate() {}
