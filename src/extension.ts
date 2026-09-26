import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { EmailNotifications } from './emailNotifications';
import { ProcessCandidate, WatchedProcess } from './models';
import { ProcessBridge } from './processBridge';
import { ProcessItem, ProcessTreeProvider } from './processTree';

const execFileAsync = promisify(execFile);
const WATCHES_KEY = 'processWatcher.watches.v1';

interface ProcessPickItem extends vscode.QuickPickItem {
	process: ProcessCandidate;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel('Process Watcher');
	const log = (message: string) => output.appendLine(`${new Date().toISOString()} ${message}`);
	const bridge = new ProcessBridge(context, log);
	const emailNotifications = new EmailNotifications(context.secrets, log);
	let watches = loadWatches(context);
	const visibleWatches = () => watches
		.filter(watch => watch.workspaceKey === bridge.workspaceKey)
		.sort((left, right) => {
			if (left.status !== right.status) {
				return left.status === 'running' ? -1 : 1;
			}
			return Date.parse(right.watchStartedAt) - Date.parse(left.watchStartedAt);
		});
	const treeProvider = new ProcessTreeProvider(visibleWatches);
	const treeView = vscode.window.createTreeView('processWatcher.view', {
		treeDataProvider: treeProvider,
		showCollapseAll: false,
	});
	const setTreeMessage = (message?: string) => {
		treeView.message = message ?? (visibleWatches().length === 0
			? 'Select + to watch a running process.'
			: undefined);
	};
	const persist = async () => context.globalState.update(WATCHES_KEY, watches);
	const notifyCompletion = (watch: WatchedProcess) => {
		void launchWindowsPopup(
				context.asAbsolutePath(path.join('resources', 'windows-hello.ps1')),
				`${watch.name} finished`,
				`PID ${watch.pid} - ${watch.location === 'windows' ? 'Local Windows' : 'Remote Linux'}`,
			)
			.catch(error => log(`Popup failed: ${errorMessage(error)}`));
		void emailNotifications.sendCompletion(watch);
	};

	context.subscriptions.push(
		output,
		bridge,
		treeProvider,
		treeView,
		vscode.commands.registerCommand('processWatcher.configureEmail', () =>
			emailNotifications.configure()),
		vscode.commands.registerCommand('processWatcher.addProcess', async () => {
			setTreeMessage('Loading processes...');
			try {
				const candidates = await bridge.listProcesses();
				const activeIdentities = new Set(visibleWatches()
					.filter(watch => watch.status === 'running')
					.map(watch => `${watch.pid}:${watch.identity}`));
				const items: ProcessPickItem[] = candidates
					.filter(candidate => !activeIdentities.has(`${candidate.pid}:${candidate.identity}`))
					.map(process => ({
						label: process.name,
						description: `PID ${process.pid} | ${new Date(process.startedAt).toLocaleString()}`,
						detail: process.commandLine,
						process,
					}));
				const selected = await vscode.window.showQuickPick(items, {
					title: bridge.location === 'windows' ? 'Watch a Windows Process' : 'Watch a Remote Linux Process',
					placeHolder: 'Search by name, PID, or command line',
					matchOnDescription: true,
					matchOnDetail: true,
				});
				if (!selected) {
					setTreeMessage();
					return;
				}
				const watch = await bridge.createWatch(selected.process);
				watches.push(watch);
				await persist();
				treeProvider.refreshAll();
				setTreeMessage();
				log(`Watching ${watch.name} (PID ${watch.pid}) on ${watch.location}.`);
			} catch (error) {
				const message = errorMessage(error);
				setTreeMessage(message);
				log(`Add process failed: ${message}`);
			}
		}),
		vscode.commands.registerCommand('processWatcher.removeProcess', async (item?: ProcessItem) => {
			if (!item) {
				return;
			}
			try {
				await bridge.cancel(item.watch);
			} catch (error) {
				log(`Could not cancel monitor for PID ${item.watch.pid}: ${errorMessage(error)}`);
			}
			watches = watches.filter(watch => watch.id !== item.watch.id);
			await persist();
			treeProvider.refreshAll();
			setTreeMessage();
		}),
		vscode.commands.registerCommand('processWatcher.clearEndedProcesses', async () => {
			const ended = visibleWatches().filter(watch => watch.status === 'ended');
			for (const watch of ended) {
				try {
					await bridge.cancel(watch);
				} catch (error) {
					log(`Could not clean up ended PID ${watch.pid}: ${errorMessage(error)}`);
				}
			}
			watches = retainAfterClearingEnded(watches, bridge.workspaceKey);
			await persist();
			treeProvider.refreshAll();
			setTreeMessage();
		}),
	);

	for (const watch of visibleWatches().filter(watch => watch.status === 'running')) {
		const completion = await bridge.readCompletion(watch);
		if (completion) {
			watch.status = 'ended';
			watch.endedAt = completion.endedAt;
			notifyCompletion(watch);
		} else {
			void bridge.restartMonitor(watch).catch(error =>
				log(`Could not restore monitor for PID ${watch.pid}: ${errorMessage(error)}`));
		}
	}
	await persist();
	treeProvider.refreshAll();
	setTreeMessage();

	let polling = false;
	const timer = setInterval(() => {
		treeProvider.refreshTimers();
		if (polling) {
			return;
		}
		polling = true;
		void pollCompletions(visibleWatches(), bridge)
			.then(async completed => {
				if (completed.length === 0) {
					return;
				}
				await persist();
				treeProvider.refreshAll();
				for (const watch of completed) {
					notifyCompletion(watch);
				}
			})
			.catch(error => log(`Completion poll failed: ${errorMessage(error)}`))
			.finally(() => { polling = false; });
	}, 1_000);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

async function pollCompletions(
	watches: readonly WatchedProcess[],
	bridge: ProcessBridge,
): Promise<WatchedProcess[]> {
	const completed: WatchedProcess[] = [];
	for (const watch of watches) {
		const completion = await bridge.readCompletion(watch);
		if (!completion) {
			continue;
		}
		watch.status = 'ended';
		watch.endedAt = completion.endedAt;
		completed.push(watch);
	}
	return completed;
}

function loadWatches(context: vscode.ExtensionContext): WatchedProcess[] {
	const value = context.globalState.get<unknown>(WATCHES_KEY, []);
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((watch): watch is WatchedProcess =>
		typeof watch === 'object'
		&& watch !== null
		&& 'id' in watch
		&& 'pid' in watch
		&& 'workspaceKey' in watch
		&& 'status' in watch);
}

export function retainAfterClearingEnded(
	watches: readonly WatchedProcess[],
	workspaceKey: string,
): WatchedProcess[] {
	return watches.filter(watch => watch.workspaceKey !== workspaceKey || watch.status !== 'ended');
}

async function launchWindowsPopup(scriptPath: string, headline: string, detail: string): Promise<void> {
	const powerShell = process.env.SystemRoot
		? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
		: 'powershell.exe';
	const target = vscode.workspace.workspaceFile
		? { switch: '--file-uri', uri: vscode.workspace.workspaceFile.toString() }
		: vscode.workspace.workspaceFolders?.[0]
			? { switch: '--folder-uri', uri: vscode.workspace.workspaceFolders[0].uri.toString() }
			: undefined;
	const args = [
		'-NoLogo',
		'-NoProfile',
		'-NonInteractive',
		'-STA',
		'-WindowStyle',
		'Hidden',
		'-ExecutionPolicy',
		'Bypass',
		'-File',
		scriptPath,
		'-Headline',
		headline,
		'-Detail',
		detail,
		'-CodePath',
		process.execPath,
		'-TargetWindowMarker',
		vscode.workspace.name ?? '',
	];
	if (target) {
		args.push('-TargetSwitch', target.switch, '-TargetUri', target.uri);
	}
	await execFileAsync(powerShell, args, {
		windowsHide: false,
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
