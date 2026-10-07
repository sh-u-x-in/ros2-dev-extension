// 最小 vscode stub(仅 headless mocha 测试用,不打包进扩展)
module.exports = new Proxy({}, {
  get: (_, prop) => {
    if (prop === 'EventEmitter') {
      return class { constructor(){ this.listeners=[]; } fire(){ } event(){ return (l)=>{ this.listeners.push(l); return { dispose(){ this.listeners = this.listeners.filter(x=>x!==l); } }; }; } };
    }
    if (prop === 'window') {
      return { showQuickPick: async () => undefined, showInputBox: async () => undefined, showInformationMessage: async () => undefined, showErrorMessage: async () => undefined, setStatusBarMessage: () => ({ dispose(){ } }), createStatusBarItem: () => ({ show(){ }, dispose(){ }, text: '' }), createWebviewPanel: () => ({ webview: { html: '', postMessage(){ }, onDidReceiveMessage(){ return { dispose(){ } }; } }, onDidDispose(){ return { dispose(){ } }; }, reveal(){ } }), createTerminal: () => ({ show(){ } }) };
    }
    if (prop === 'workspace') {
      return { getConfiguration: () => ({ get: () => undefined, update: async () => undefined, onDidChange: () => ({ dispose(){ } }) }), workspaceFolders: [], rootPath: undefined, createFileSystemWatcher: () => ({ onDidChange(){ return { dispose(){ } }; }, onDidCreate(){ return { dispose(){ } }; }, onDidDelete(){ return { dispose(){ } }; } }), onDidChangeWorkspaceFolders: () => ({ dispose(){ } }), fs: { stat: async () => ({}) } };
    }
    if (prop === 'commands') {
      return { registerCommand: () => ({ dispose(){ } }), executeCommand: async () => undefined, getCommands: async () => [] };
    }
    if (prop === 'tasks') {
      return { executeTask: async () => ({}), onDidEndTask: () => ({ dispose(){ } }) };
    }
    if (prop === 'Uri') {
      return { file: (p) => ({ fsPath: p, toString: () => p }), joinPath: (a, ...b) => ({ fsPath: [a.fsPath, ...b].join('/') }) };
    }
    if (prop === 'ViewColumn') return { Two: 2, One: 1 };
    if (prop === 'StatusBarAlignment') return { Left: 1, Right: 2 };
    if (prop === 'TaskScope') return { Workspace: 2, Global: 1 };
    if (prop === 'ShellExecution') return class { constructor(cmd, args, opts){ this.cmd=cmd; this.args=args; this.opts=opts; } };
    if (prop === 'Task') return class { constructor(def, scope, name, source){ this.definition=def; this.scope=scope; this.name=name; this.source=source; } };
    if (prop === 'RelativePattern') return class { constructor(dir, base){ this.dir=dir; this.base=base; } };
    if (prop === 'QuickPickItem' || prop === 'ThemeIcon' || prop === 'MarkdownString') return class {};
    if (prop === 'workspaceContains') return undefined;
    return () => undefined;
  }
});