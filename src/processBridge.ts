import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { ProcessCandidate, WatchedProcess, WatchLocation } from './models';

const execFileAsync = promisify(execFile);

interface CompletionFile {
	endedAt: string;
	reason: string;
}

export class ProcessBridge implements vscode.Disposable {
	private remoteTerminal: vscode.Terminal | undefined;
	private remoteQueue: Promise<unknown> = Promise.resolve();
	private readonly closeSubscription: vscode.Disposable;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly log: (message: string) => void,
	) {
		this.closeSubscription = vscode.window.onDidCloseTerminal(terminal => {
			if (terminal === this.remoteTerminal) {
				this.remoteTerminal = undefined;
			}
		});
	}

	dispose(): void {
		this.closeSubscription.dispose();
		this.remoteTerminal?.dispose();
	}

	get location(): WatchLocation {
		return this.remoteFolder ? 'remote-linux' : 'windows';
	}

	get workspaceKey(): string {
		return this.remoteFolder?.uri.authority || 'local-windows';
	}

	async listProcesses(): Promise<ProcessCandidate[]> {
		const processes = await (this.location === 'remote-linux'
			? this.listRemoteLinuxProcesses()
			: this.listWindowsProcesses());
		return sortProcessesNewestFirst(processes);
	}

	async createWatch(candidate: ProcessCandidate): Promise<WatchedProcess> {
		const id = randomUUID();
		const eventUri = await this.eventUri(id);
		const cancelUri = await this.cancelUri(id);
		const watch: WatchedProcess = {
			id,
			pid: candidate.pid,
			name: candidate.name,
			commandLine: candidate.commandLine,
			identity: candidate.identity,
			startedAt: candidate.startedAt,
			watchStartedAt: new Date().toISOString(),
			location: this.location,
			workspaceKey: this.workspaceKey,
			status: 'running',
			eventUri: eventUri.toString(),
			cancelUri: cancelUri.toString(),
		};
		await this.startMonitor(watch);
		return watch;
	}

	async restartMonitor(watch: WatchedProcess): Promise<void> {
		if (watch.status === 'running' && watch.workspaceKey === this.workspaceKey) {
			await this.startMonitor(watch);
		}
	}

	async readCompletion(watch: WatchedProcess): Promise<CompletionFile | undefined> {
		if (watch.status !== 'running' || watch.workspaceKey !== this.workspaceKey) {
			return undefined;
		}
		try {
			const contents = await vscode.workspace.fs.readFile(vscode.Uri.parse(watch.eventUri));
			const value = JSON.parse(Buffer.from(contents).toString('utf8')) as CompletionFile;
			return typeof value.endedAt === 'string' ? value : undefined;
		} catch (error) {
			if (isMissingFile(error)) {
				return undefined;
			}
			this.log(`Could not read completion event for PID ${watch.pid}: ${errorMessage(error)}`);
			return undefined;
		}
	}

	async cancel(watch: WatchedProcess): Promise<void> {
		const cancelUri = vscode.Uri.parse(watch.cancelUri);
		if (watch.status === 'running' && watch.location === 'windows') {
			await vscode.workspace.fs.writeFile(cancelUri, Buffer.from('cancel\n'));
		} else if (watch.status === 'running' && watch.workspaceKey === this.workspaceKey) {
			await this.runRemoteShell(`: > ${shellQuote(cancelUri.path)}`);
		}
		await Promise.all([
			vscode.workspace.fs.delete(vscode.Uri.parse(watch.eventUri), { useTrash: false }).then(undefined, () => undefined),
			watch.status === 'ended'
				? vscode.workspace.fs.delete(cancelUri, { useTrash: false }).then(undefined, () => undefined)
				: Promise.resolve(),
		]);
	}

	private get remoteFolder(): vscode.WorkspaceFolder | undefined {
		if (vscode.env.remoteName !== 'ssh-remote') {
			return undefined;
		}
		return vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'vscode-remote');
	}

	private async listWindowsProcesses(): Promise<ProcessCandidate[]> {
		if (process.platform !== 'win32') {
			throw new Error('Local process discovery requires Windows.');
		}
		const script = [
			"$ErrorActionPreference = 'SilentlyContinue'",
			'$sessionId = (Get-Process -Id $PID).SessionId',
			'$items = Get-CimInstance Win32_Process | Where-Object { $_.SessionId -eq $sessionId } | ForEach-Object {',
			'  $cim = $_',
			'  $processInfo = Get-Process -Id $cim.ProcessId -ErrorAction SilentlyContinue',
			'  if ($processInfo -and $processInfo.StartTime) {',
			'    $started = $processInfo.StartTime.ToUniversalTime()',
			'    [ordered]@{ pid = [int]$cim.ProcessId; name = [string]$cim.Name; commandLine = [string]$cim.CommandLine; identity = ("windows:" + $started.Ticks); startedAt = $started.ToString("o") }',
			'  }',
			'}',
			'@($items | Sort-Object startedAt -Descending) | ConvertTo-Json -Compress -Depth 3',
		].join('; ');
		const { stdout } = await execFileAsync(windowsPowerShell(), [
			'-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
		], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
		const text = stripBom(stdout).trim();
		if (!text) {
			return [];
		}
		const value = JSON.parse(text) as ProcessCandidate | ProcessCandidate[];
		return (Array.isArray(value) ? value : [value])
			.filter(candidate => Number.isSafeInteger(candidate.pid) && candidate.pid > 0);
	}

	private async listRemoteLinuxProcesses(): Promise<ProcessCandidate[]> {
		const script = [
			'set -eu',
			'[ "$(uname -s)" = "Linux" ] || { echo "Process Watcher supports Linux Remote SSH hosts only" >&2; exit 2; }',
			'uid=$(id -u)',
			"boot=$(awk '$1 == \"btime\" { print $2 }' /proc/stat)",
			"hz=$(getconf CLK_TCK 2>/dev/null || printf '100')",
			'for directory in /proc/[0-9]*; do',
			'    pid=${directory##*/}',
			'    [ "$(stat -c %u "$directory" 2>/dev/null || printf x)" = "$uid" ] || continue',
			'    raw=$(cat "$directory/stat" 2>/dev/null) || continue',
			'    rest=${raw##*) }',
			'    set -- $rest',
			'    shift 19',
			'    start_ticks=$1',
			'    start_epoch=$((boot + start_ticks / hz))',
			"    name=$(cat \"$directory/comm\" 2>/dev/null || printf 'process')",
			"    command_line=$(tr '\\000' ' ' < \"$directory/cmdline\" 2>/dev/null || true)",
			'    [ -n "$command_line" ] || command_line=$name',
			"    name64=$(printf '%s' \"$name\" | base64 | tr -d '\\n')",
			"    command64=$(printf '%s' \"$command_line\" | base64 | tr -d '\\n')",
			"    printf '%s\\t%s:%s\\t%s\\t%s\\t%s\\n' \"$pid\" \"$boot\" \"$start_ticks\" \"$start_epoch\" \"$name64\" \"$command64\"",
			'done',
		].join('\n');
		const output = await this.runRemoteShell(script);
		return parseRemoteProcessOutput(output);
	}

	private async startMonitor(watch: WatchedProcess): Promise<void> {
		await Promise.all([
			vscode.workspace.fs.delete(vscode.Uri.parse(watch.eventUri), { useTrash: false }).then(undefined, () => undefined),
			vscode.workspace.fs.delete(vscode.Uri.parse(watch.cancelUri), { useTrash: false }).then(undefined, () => undefined),
		]);
		if (watch.location === 'windows') {
			await this.startWindowsMonitor(watch);
		} else {
			await this.startRemoteMonitor(watch);
		}
	}

	private async startWindowsMonitor(watch: WatchedProcess): Promise<void> {
		const monitorPath = this.context.asAbsolutePath(path.join('resources', 'windows-monitor.ps1'));
		const launcherPath = this.context.asAbsolutePath(path.join('resources', 'windows-launch-monitor.ps1'));
		const eventPath = vscode.Uri.parse(watch.eventUri).fsPath;
		const cancelPath = vscode.Uri.parse(watch.cancelUri).fsPath;
		await execFileAsync(windowsPowerShell(), [
			'-NoLogo',
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-File',
			launcherPath,
			'-MonitorPath',
			monitorPath,
			'-TargetProcessId',
			String(watch.pid),
			'-ExpectedIdentity',
			watch.identity,
			'-EventPath',
			eventPath,
			'-CancelPath',
			cancelPath,
		], {
			encoding: 'utf8',
			timeout: 5_000,
			windowsHide: true,
		});
	}

	private async startRemoteMonitor(watch: WatchedProcess): Promise<void> {
		const expected = watch.identity.replace(/^linux:/, '');
		const eventPath = vscode.Uri.parse(watch.eventUri).path;
		const cancelPath = vscode.Uri.parse(watch.cancelUri).path;
		const monitorPath = `/tmp/process-watcher-monitor-${watch.id}.sh`;
		const monitor = [
			'#!/bin/sh',
			'pid=$1',
			'expected=$2',
			'event=$3',
			'cancel=$4',
			"boot=$(awk '$1 == \"btime\" { print $2 }' /proc/stat)",
			'while :; do',
			'    [ -e "$cancel" ] && { rm -f "$cancel"; exit 0; }',
			'    raw=$(cat "/proc/$pid/stat" 2>/dev/null) || { reason=process_exited; break; }',
			'    rest=${raw##*) }',
			'    set -- $rest',
			'    shift 19',
			'    current=$1',
			'    [ "$boot:$current" = "$expected" ] || { reason=pid_reused; break; }',
			'    sleep 0.5',
			'done',
			'ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
			'temporary="$event.tmp.$$"',
			"printf '{\"endedAt\":\"%s\",\"reason\":\"%s\"}\\n' \"$ended\" \"$reason\" > \"$temporary\"",
			'mv "$temporary" "$event"',
			'rm -f "$0"',
		].join('\n');
		const encoded = Buffer.from(monitor, 'utf8').toString('base64');
		const launch = [
			'umask 077',
			`rm -f ${shellQuote(eventPath)} ${shellQuote(cancelPath)}`,
			`printf '%s' '${encoded}' | base64 -d > ${shellQuote(monitorPath)}`,
			`chmod 700 ${shellQuote(monitorPath)}`,
			`nohup /bin/sh ${shellQuote(monitorPath)} ${watch.pid} ${shellQuote(expected)} ${shellQuote(eventPath)} ${shellQuote(cancelPath)} </dev/null >/dev/null 2>&1 &`,
		].join('\n');
		await this.runRemoteShell(launch);
	}

	private async eventUri(id: string): Promise<vscode.Uri> {
		if (this.location === 'windows') {
			const directory = vscode.Uri.joinPath(this.context.globalStorageUri, 'events');
			await mkdir(directory.fsPath, { recursive: true });
			return vscode.Uri.joinPath(directory, `${id}.json`);
		}
		return this.remoteTemporaryUri(`process-watcher-${id}.json`);
	}

	private async cancelUri(id: string): Promise<vscode.Uri> {
		if (this.location === 'windows') {
			const directory = vscode.Uri.joinPath(this.context.globalStorageUri, 'cancellations');
			await mkdir(directory.fsPath, { recursive: true });
			return vscode.Uri.joinPath(directory, `${id}.cancel`);
		}
		return this.remoteTemporaryUri(`process-watcher-${id}.cancel`);
	}

	private remoteTemporaryUri(fileName: string): vscode.Uri {
		const folder = this.remoteFolder;
		if (!folder) {
			throw new Error('Open a Remote SSH Linux workspace first.');
		}
		return vscode.Uri.from({ scheme: folder.uri.scheme, authority: folder.uri.authority, path: `/tmp/${fileName}` });
	}

	private runRemoteShell(script: string): Promise<string> {
		const operation = this.remoteQueue.then(() => this.runRemoteShellNow(script));
		this.remoteQueue = operation.then(() => undefined, () => undefined);
		return operation;
	}

	private async runRemoteShellNow(script: string): Promise<string> {
		const folder = this.remoteFolder;
		if (!folder) {
			throw new Error('Process Watcher is not connected to a Remote SSH Linux workspace.');
		}
		const token = randomUUID();
		const outputUri = this.remoteTemporaryUri(`process-watcher-command-${token}.out`);
		const errorUri = this.remoteTemporaryUri(`process-watcher-command-${token}.err`);
		const doneUri = this.remoteTemporaryUri(`process-watcher-command-${token}.done`);
		const encoded = Buffer.from(script, 'utf8').toString('base64');
		const command = [
			'umask 077',
			`printf '%s' '${encoded}' | base64 -d | /bin/sh > ${shellQuote(`${outputUri.path}.tmp`)} 2> ${shellQuote(errorUri.path)}`,
			'process_watcher_exit=$?',
			`mv ${shellQuote(`${outputUri.path}.tmp`)} ${shellQuote(outputUri.path)}`,
			`printf '%s' "$process_watcher_exit" > ${shellQuote(doneUri.path)}`,
		].join('; ');
		const terminal = this.getRemoteTerminal(folder.uri);
		terminal.sendText(command, true);

		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			try {
				const exitCode = Buffer.from(await vscode.workspace.fs.readFile(doneUri)).toString('utf8').trim();
				const output = Buffer.from(await vscode.workspace.fs.readFile(outputUri)).toString('utf8');
				const error = await vscode.workspace.fs.readFile(errorUri)
					.then(data => Buffer.from(data).toString('utf8'), () => '');
				await Promise.all([outputUri, errorUri, doneUri].map(uri =>
					vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined)));
				if (exitCode !== '0') {
					throw new Error(error.trim() || `Remote command exited with code ${exitCode}.`);
				}
				return output;
			} catch (error) {
				if (!isMissingFile(error)) {
					throw error;
				}
			}
			await delay(100);
		}
		throw new Error('The Remote SSH command timed out. Ensure the remote terminal can start normally.');
	}

	private getRemoteTerminal(cwd: vscode.Uri): vscode.Terminal {
		this.remoteTerminal ??= vscode.window.createTerminal({
			name: 'Process Watcher Remote',
			cwd,
			shellPath: '/bin/sh',
			hideFromUser: true,
			isTransient: true,
		});
		return this.remoteTerminal;
	}
}

export function parseRemoteProcessOutput(output: string): ProcessCandidate[] {
	return sortProcessesNewestFirst(output.split(/\r?\n/).flatMap(line => {
		const [pidText, identity, epochText, name64, command64] = line.split('\t');
		const pid = Number(pidText);
		const epoch = Number(epochText);
		if (!Number.isSafeInteger(pid) || !identity || !Number.isFinite(epoch) || !name64 || !command64) {
			return [];
		}
		return [{
			pid,
			name: Buffer.from(name64, 'base64').toString('utf8').trim(),
			commandLine: Buffer.from(command64, 'base64').toString('utf8').trim(),
			identity: `linux:${identity}`,
			startedAt: new Date(epoch * 1000).toISOString(),
		}];
	}));
}

export function sortProcessesNewestFirst(processes: ProcessCandidate[]): ProcessCandidate[] {
	return processes.sort((left, right) => {
		const startDifference = Date.parse(right.startedAt) - Date.parse(left.startedAt);
		return startDifference || right.pid - left.pid;
	});
}

function windowsPowerShell(): string {
	return process.env.SystemRoot
		? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
		: 'powershell.exe';
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function stripBom(value: string): string {
	return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function isMissingFile(error: unknown): boolean {
	return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}