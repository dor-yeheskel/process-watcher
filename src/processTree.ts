import * as vscode from 'vscode';
import { WatchedProcess } from './models';

export class ProcessTreeProvider implements vscode.TreeDataProvider<ProcessItem>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<ProcessItem | undefined>();
	private readonly items = new Map<string, ProcessItem>();

	readonly onDidChangeTreeData = this.changeEmitter.event;

	constructor(private readonly getWatches: () => readonly WatchedProcess[]) {}

	dispose(): void {
		this.changeEmitter.dispose();
	}

	refreshAll(): void {
		this.changeEmitter.fire(undefined);
	}

	refreshTimers(): void {
		for (const watch of this.getWatches()) {
			if (watch.status !== 'running') {
				continue;
			}
			const item = this.items.get(watch.id);
			if (item) {
				item.updateRuntime();
				this.changeEmitter.fire(item);
			}
		}
	}

	getTreeItem(element: ProcessItem): vscode.TreeItem {
		return element;
	}

	getChildren(): ProcessItem[] {
		const watches = this.getWatches();
		const activeIds = new Set(watches.map(watch => watch.id));
		for (const id of this.items.keys()) {
			if (!activeIds.has(id)) {
				this.items.delete(id);
			}
		}
		return watches.map(watch => {
			let item = this.items.get(watch.id);
			if (!item) {
				item = new ProcessItem(watch);
				this.items.set(watch.id, item);
			} else {
				item.update(watch);
			}
			return item;
		});
	}
}

export class ProcessItem extends vscode.TreeItem {
	watch: WatchedProcess;

	constructor(watch: WatchedProcess) {
		super(watch.name, vscode.TreeItemCollapsibleState.None);
		this.watch = watch;
		this.id = `processWatcher.process.${watch.id}`;
		this.update(watch);
	}

	update(watch: WatchedProcess): void {
		this.watch = watch;
		this.label = watch.name;
		this.contextValue = watch.status === 'running'
			? 'processWatcher.running'
			: 'processWatcher.ended';
		this.iconPath = watch.status === 'running'
			? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'))
			: new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
		this.tooltip = tooltipFor(watch);
		this.updateRuntime();
	}

	updateRuntime(): void {
		if (this.watch.status === 'ended') {
			this.description = `PID ${this.watch.pid} | ended ${formatClock(this.watch.endedAt)}`;
			return;
		}
		this.description = `PID ${this.watch.pid} | ${formatDuration(Date.now() - Date.parse(this.watch.watchStartedAt))}`;
	}
}

function tooltipFor(watch: WatchedProcess): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString();
	tooltip.appendMarkdown(`**${escapeMarkdown(watch.name)}**\n\n`);
	tooltip.appendMarkdown('Command line:\n');
	tooltip.appendCodeblock(watch.commandLine || '(unavailable)', 'text');
	tooltip.appendMarkdown('\n');
	tooltip.appendMarkdown(`PID: ${watch.pid}  \n`);
	tooltip.appendMarkdown(`Status: ${watch.status}  \n`);
	tooltip.appendMarkdown(`Location: ${watch.location === 'windows' ? 'Local Windows' : 'Remote Linux'}  \n`);
	tooltip.appendMarkdown(`Process started: ${formatDate(watch.startedAt)}  \n`);
	tooltip.appendMarkdown(`Watch started: ${formatDate(watch.watchStartedAt)}  \n`);
	if (watch.endedAt) {
		tooltip.appendMarkdown(`Ended: ${formatDate(watch.endedAt)}  \n`);
	}
	return tooltip;
}

function formatDuration(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

function formatClock(value: string | undefined): string {
	return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

function formatDate(value: string): string {
	return new Date(value).toLocaleString();
}

function escapeMarkdown(value: string): string {
	return value.replace(/[\\`*_{}\[\]()#+\-.!]/g, '\\$&');
}