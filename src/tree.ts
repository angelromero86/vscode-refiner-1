import * as vscode from 'vscode';
import { RefinerStore } from './store';
import { isWebThread, StoredComment, WebThread } from './types';
import { sourceLocation } from './web/source';

/** A node of the "UI Threads" view: page → thread → comment. */
export type UiNode =
  | { kind: 'page'; page: string; threads: WebThread[] }
  | { kind: 'thread'; thread: WebThread; number: number }
  | { kind: 'comment'; thread: WebThread; comment: StoredComment };

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** A one-line preview of a Markdown body. */
function firstLine(body: string): string {
  const line = body
    .replace(/```[^\n]*\n?/g, ' ')
    .split('\n')
    .map((l) => l.replace(/^[\s>*-]+/, '').trim())
    .find((l) => l !== '');
  return line ? clip(line.replace(/[*_`]+/g, ''), 80) : '';
}

const lastRole = (t: WebThread) => t.comments[t.comments.length - 1]?.role ?? 'user';
const awaitingYou = (t: WebThread) => t.status === 'open' && lastRole(t) === 'assistant';

/**
 * Every thread in `.refiner/web-comments.json`, grouped by page — the same
 * list the browser overlay shows under shift+C, with the same numbering. This
 * is also where threads without a source location live in VSCode: the ones
 * with one are additionally rendered inline at that location by extension.ts.
 */
export class UiThreadsTree implements vscode.TreeDataProvider<UiNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly store: RefinerStore,
    private readonly folder: vscode.WorkspaceFolder,
  ) {
    store.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  get threads(): WebThread[] {
    return this.store.threads.filter(isWebThread);
  }

  getChildren(node?: UiNode): UiNode[] {
    if (!node) {
      const groups = new Map<string, WebThread[]>();
      for (const t of this.threads) {
        const list = groups.get(t.web.page);
        if (list) {
          list.push(t);
        } else {
          groups.set(t.web.page, [t]);
        }
      }
      return Array.from(groups, ([page, threads]) => ({ kind: 'page' as const, page, threads })).sort((a, b) =>
        a.page.localeCompare(b.page),
      );
    }
    if (node.kind === 'page') {
      // Numbered like the pins in the browser: by position among the page's threads.
      return node.threads.map((thread, i) => ({ kind: 'thread' as const, thread, number: i + 1 }));
    }
    if (node.kind === 'thread') {
      return node.thread.comments.map((comment) => ({ kind: 'comment' as const, thread: node.thread, comment }));
    }
    return [];
  }

  getTreeItem(node: UiNode): vscode.TreeItem {
    switch (node.kind) {
      case 'page':
        return this.pageItem(node);
      case 'thread':
        return this.threadItem(node);
      case 'comment':
        return this.commentItem(node);
    }
  }

  private pageItem(node: Extract<UiNode, { kind: 'page' }>): vscode.TreeItem {
    const item = new vscode.TreeItem(node.page, vscode.TreeItemCollapsibleState.Expanded);
    const open = node.threads.filter((t) => t.status === 'open').length;
    item.description = open ? `${open} open` : 'all resolved';
    item.iconPath = new vscode.ThemeIcon('browser');
    item.tooltip = node.threads[0]?.web.url;
    item.contextValue = 'page';
    return item;
  }

  private threadItem(node: Extract<UiNode, { kind: 'thread' }>): vscode.TreeItem {
    const t = node.thread;
    const first = t.comments[0];
    const item = new vscode.TreeItem(
      `#${node.number}  ${firstLine(first?.body ?? '') || '(empty)'}`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    const element = `<${t.web.anchor.tag}>${t.web.anchor.text ? ` “${clip(t.web.anchor.text, 32)}”` : ''}`;
    const meta = [element, first?.author ?? ''];
    if (t.status === 'resolved') {
      meta.push('resolved');
    } else if (awaitingYou(t)) {
      meta.push('agent replied');
    }
    item.description = meta.filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon(
      t.status === 'resolved' ? 'check' : awaitingYou(t) ? 'comment-discussion' : 'comment',
      t.status === 'resolved' ? new vscode.ThemeColor('disabledForeground') : undefined,
    );
    item.tooltip = this.threadTooltip(node);
    const loc = sourceLocation(t.web.source);
    item.contextValue = `thread-${t.status}${loc ? '-source' : ''}`;
    item.command = { command: 'refiner.ui.open', title: 'Open', arguments: [node] };
    return item;
  }

  private threadTooltip(node: Extract<UiNode, { kind: 'thread' }>): vscode.MarkdownString {
    const t = node.thread;
    const first = t.comments[0];
    const md = new vscode.MarkdownString(undefined, true);
    const a = t.web.anchor;
    md.appendMarkdown(`**#${node.number} on ${t.web.page}** — \`<${a.tag}>\`${a.text ? ` “${clip(a.text, 60)}”` : ''}  \n`);
    md.appendMarkdown(
      `${first?.author ?? ''} · ${t.comments.length} ${t.comments.length === 1 ? 'comment' : 'comments'}` +
        `${t.status === 'resolved' ? ' · resolved' : awaitingYou(t) ? ' · $(sparkle) agent replied' : ''}\n\n`,
    );
    if (first) {
      md.appendMarkdown(first.body.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n');
    }
    const src = t.web.source;
    const loc = sourceLocation(src);
    if (loc) {
      md.appendMarkdown(
        `$(go-to-file) \`${loc.file}${loc.line ? ':' + loc.line : ''}\`${src?.component ? ` (${src.component})` : ''}  \n`,
      );
    }
    md.appendMarkdown(`$(link) ${t.web.url}\n\n`);
    if (t.web.shot) {
      md.appendMarkdown(`![screenshot](${vscode.Uri.joinPath(this.folder.uri, ...t.web.shot.split('/')).toString()})`);
    }
    return md;
  }

  private commentItem(node: Extract<UiNode, { kind: 'comment' }>): vscode.TreeItem {
    const c = node.comment;
    const item = new vscode.TreeItem(c.author || (c.role === 'assistant' ? 'Claude Code' : 'anon'));
    item.description = firstLine(c.body);
    item.iconPath = new vscode.ThemeIcon(c.role === 'assistant' ? 'sparkle' : 'account');
    const md = new vscode.MarkdownString(c.body);
    item.tooltip = md;
    item.contextValue = 'comment';
    return item;
  }
}
