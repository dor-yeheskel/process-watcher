import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { completionEmailPayload, parseRelayResponse } from '../emailNotifications';
import { WatchedProcess } from '../models';
import { retainAfterClearingEnded, watchStartedMessage } from '../extension';
import { parseRemoteProcessOutput, sortProcessesNewestFirst } from '../processBridge';
import { ProcessTreeProvider } from '../processTree';

suite('Process Watcher MVP', () => {
	test('is UI-hosted and contributes the process commands', async () => {
		const manifestPath = path.resolve(__dirname, '..', '..', 'package.json');
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
			extensionKind: string[];
			contributes: {
				commands: Array<{ command: string }>;
				menus: { commandPalette: Array<{ command: string; when: string }> };
			};
		};
		assert.deepStrictEqual(manifest.extensionKind, ['ui']);
		assert.deepStrictEqual(
			manifest.contributes.commands.map(command => command.command),
			[
				'processWatcher.addProcess',
				'processWatcher.configureEmail',
				'processWatcher.removeProcess',
				'processWatcher.clearEndedProcesses',
			],
		);
		assert.deepStrictEqual(
			manifest.contributes.menus.commandPalette.map(item => item.command),
			[
				'processWatcher.removeProcess',
				'processWatcher.clearEndedProcesses',
			],
		);
		assert.ok(manifest.contributes.menus.commandPalette.every(item => item.when === 'false'));
	});

	test('uses a modern bottom-right Windows toast', async () => {
		const scriptPath = path.resolve(__dirname, '..', '..', 'resources', 'windows-hello.ps1');
		const script = await readFile(scriptPath, 'utf8');
		assert.match(script, /PresentationFramework/);
		assert.match(script, /\[string\]\$Headline/);
		assert.match(script, /\[string\]\$Detail/);
		assert.match(script, /Topmost="True"/);
		assert.match(script, /\$workArea\.Bottom/);
		assert.doesNotMatch(script, /DispatcherTimer/);
		assert.match(script, /ProcessWatcherToastSlots/);
		assert.match(script, /Start-Process.*CodePath/);
		assert.match(script, /ToastSurface/);
		assert.match(script, /closeButton\.IsMouseOver/);
		assert.match(script, /MouseLeftButtonUpEvent/);
		assert.match(script, /TargetWindowMarker/);
		assert.match(script, /EnumWindows/);
		assert.match(script, /GetWindowText/);
		assert.match(script, /FindWindow/);
		assert.match(script, /TitleMatches/);
		assert.match(script, /Regex\.Escape\(titleMarker\)/);
		assert.doesNotMatch(script, /Get-Process -Name \$codeProcessName/);
		assert.doesNotMatch(script, /--reuse-window/);
		assert.match(script, /ShowWindow/);
		assert.match(script, /IsIconic/);
		assert.match(script, /SetForegroundWindow/);
		assert.match(script, /AttachThreadInput/);
		assert.match(script, /GetCurrentThreadId/);
		assert.match(script, /keybd_event/);
		assert.match(script, /RestoreAndActivate/);
		assert.match(script, /Data="M12,2 A10,10/);
		assert.match(script, /IsMouseOver/);
		assert.match(script, /#D94B4B/);
		assert.match(script, /DoubleAnimation/);
	});

	test('contributes one flat process view', async () => {
		const manifestPath = path.resolve(__dirname, '..', '..', 'package.json');
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
			contributes: { views: Record<string, Array<{ id: string }>> };
		};
		assert.deepStrictEqual(manifest.contributes.views.processWatcher, [{
			id: 'processWatcher.view',
			name: 'Processes',
		}]);
	});

	test('Windows monitor validates creation identity and writes completion', async () => {
		const scriptPath = path.resolve(__dirname, '..', '..', 'resources', 'windows-monitor.ps1');
		const script = await readFile(scriptPath, 'utf8');
		assert.match(script, /StartTime\.ToUniversalTime\(\)\.Ticks/);
		assert.match(script, /ExpectedIdentity/);
		assert.match(script, /Move-Item/);
	});

	test('Windows launcher detaches the monitor', async () => {
		const scriptPath = path.resolve(__dirname, '..', '..', 'resources', 'windows-launch-monitor.ps1');
		const script = await readFile(scriptPath, 'utf8');
		assert.match(script, /Start-Process/);
		assert.match(script, /WindowStyle Hidden/);
		assert.match(script, /MonitorPath/);
	});

	test('parses current-user Linux process output with boot identity', () => {
		const name = Buffer.from('python3').toString('base64');
		const command = Buffer.from('python3 regression.py').toString('base64');
		const processes = parseRemoteProcessOutput(`4321\t1700000000:98765\t1700000987\t${name}\t${command}\n`);
		assert.deepStrictEqual(processes, [{
			pid: 4321,
			name: 'python3',
			commandLine: 'python3 regression.py',
			identity: 'linux:1700000000:98765',
			startedAt: new Date(1700000987 * 1000).toISOString(),
		}]);
	});

	test('protects Remote SSH temporary process data with owner-only permissions', async () => {
		const bridgePath = path.resolve(__dirname, '..', '..', 'src', 'processBridge.ts');
		const source = await readFile(bridgePath, 'utf8');
		assert.strictEqual(source.match(/'umask 077'/g)?.length, 2);
	});

	test('sorts process candidates newest-first with deterministic ties', () => {
		const older = candidate(100, '2026-09-24T00:29:48.000Z');
		const newerLowPid = candidate(200, '2026-09-24T00:51:42.000Z');
		const newerHighPid = candidate(300, '2026-09-24T00:51:42.000Z');

		assert.deepStrictEqual(
			sortProcessesNewestFirst([older, newerLowPid, newerHighPid]).map(process => process.pid),
			[300, 200, 100],
		);
	});

	test('renders running and ended watches in one flat list', () => {
		const running = watch('running-watch', 'running');
		const ended = { ...watch('ended-watch', 'ended'), endedAt: new Date().toISOString() };
		const provider = new ProcessTreeProvider(() => [running, ended]);
		try {
			const items = provider.getChildren();
			assert.strictEqual(items.length, 2);
			assert.strictEqual(items[0].contextValue, 'processWatcher.running');
			assert.strictEqual(items[1].contextValue, 'processWatcher.ended');
			assert.strictEqual((items[1].iconPath as vscode.ThemeIcon).color?.id, 'disabledForeground');
			const tooltip = (items[0].tooltip as vscode.MarkdownString).value;
			assert.ok(tooltip.indexOf('Command line:') < tooltip.indexOf('PID:'));
		} finally {
			provider.dispose();
		}
	});

	test('clears only ended watches from the active workspace', () => {
		const localRunning = watch('local-running', 'running');
		const localEnded = watch('local-ended', 'ended');
		const remoteEnded = { ...watch('remote-ended', 'ended'), workspaceKey: 'remote' };

		assert.deepStrictEqual(
			retainAfterClearingEnded([localRunning, localEnded, remoteEnded], 'local-windows')
				.map(item => item.id),
			['local-running', 'remote-ended'],
		);
	});

	test('confirms a newly watched process with a concise notification', async () => {
		assert.strictEqual(watchStartedMessage({ name: 'python3', pid: 9704 }), 'Watching python3 (PID 9704).');
		const extensionPath = path.resolve(__dirname, '..', '..', 'src', 'extension.ts');
		const source = await readFile(extensionPath, 'utf8');
		assert.match(source, /await persist\(\);[\s\S]*showInformationMessage\(watchStartedMessage\(watch\)\)/);
	});

	test('builds completion email details from an ended watch', () => {
		const endedAt = '2026-09-26T10:30:00.000Z';
		const ended = { ...watch('email-watch', 'ended'), endedAt };
		assert.deepStrictEqual(completionEmailPayload(ended), {
			processName: 'test-process',
			pid: 123,
			location: 'Local Windows',
			processStartedAt: ended.startedAt,
			watchStartedAt: ended.watchStartedAt,
			endedAt,
			commandLine: 'test process',
		});
	});

	test('explains when a network filter replaces the relay response with HTML', async () => {
		await assert.rejects(
			parseRelayResponse(new Response('<!DOCTYPE html><title>Access denied</title>', {
				status: 403,
				headers: { 'content-type': 'text/html; charset=utf-8' },
			})),
			/email service returned an HTML page \(HTTP 403\).*network proxy or security filter.*relay\.processwatcher\.dev/i,
		);
	});

	test('preserves JSON errors returned by the relay', async () => {
		await assert.rejects(
			parseRelayResponse(new Response('{"error":"Too many verification requests."}', {
				status: 429,
				headers: { 'content-type': 'application/json' },
			})),
			/Too many verification requests\./,
		);
	});
});

function watch(id: string, status: WatchedProcess['status']): WatchedProcess {
	const now = new Date().toISOString();
	return {
		id,
		pid: 123,
		name: 'test-process',
		commandLine: 'test process',
		identity: 'windows:123',
		startedAt: now,
		watchStartedAt: now,
		location: 'windows',
		workspaceKey: 'local-windows',
		status,
		eventUri: 'file:///event.json',
		cancelUri: 'file:///cancel',
	};
}

function candidate(pid: number, startedAt: string) {
	return {
		pid,
		name: `process-${pid}`,
		commandLine: `process-${pid}`,
		identity: `test:${pid}`,
		startedAt,
	};
}
