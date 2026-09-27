import * as vscode from 'vscode';
import { WatchedProcess } from './models';

const EMAIL_TOKEN_KEY = 'processWatcher.email.token';
const EMAIL_ADDRESS_KEY = 'processWatcher.email.address';
const EMAIL_RELAY_URL = 'https://relay.processwatcher.dev';

interface RelayError {
	error?: string;
}

interface VerifyResponse extends RelayError {
	token?: string;
	email?: string;
}

export class EmailNotifications {
	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly log: (message: string) => void,
	) {}

	async configure(): Promise<void> {
		if (!this.isRelayConfigured()) {
			void vscode.window.showErrorMessage('Process Watcher email service has not been deployed yet.');
			return;
		}
		const currentEmail = await this.secrets.get(EMAIL_ADDRESS_KEY);
		if (currentEmail) {
			const action = await vscode.window.showQuickPick([
				{ label: 'Change Email Address', description: currentEmail, action: 'change' as const },
				{ label: 'Remove Email Address', description: currentEmail, action: 'remove' as const },
			], {
				title: 'Process Watcher Email Notifications',
				placeHolder: `Enabled for ${currentEmail}`,
			});
			if (!action) {
				return;
			}
			if (action.action === 'remove') {
				const token = await this.secrets.get(EMAIL_TOKEN_KEY);
				if (token) {
					try {
						await this.request('/v1/email/unsubscribe', {}, token);
					} catch (error) {
						void vscode.window.showErrorMessage(`Could not remove email address: ${errorMessage(error)}`);
						return;
					}
				}
				await Promise.all([
					this.secrets.delete(EMAIL_TOKEN_KEY),
					this.secrets.delete(EMAIL_ADDRESS_KEY),
				]);
				void vscode.window.showInformationMessage('Process Watcher email address removed.');
				return;
			}
		}
		const consent = await vscode.window.showWarningMessage(
			'Completion emails include the process name, full command line, PID, location, and timestamps. Command lines may contain sensitive arguments.',
			{ modal: true },
			'Continue',
		);
		if (consent !== 'Continue') {
			return;
		}
		await this.verifyAddress(currentEmail);
	}

	async sendCompletion(watch: WatchedProcess): Promise<void> {
		const token = await this.secrets.get(EMAIL_TOKEN_KEY);
		if (!token || !watch.endedAt || !this.isRelayConfigured()) {
			return;
		}
		try {
			await this.request('/v1/email/notify', completionEmailPayload(watch), token);
			this.log(`Email notification sent for PID ${watch.pid}.`);
		} catch (error) {
			if (error instanceof RelayRequestError && (error.status === 401 || error.status === 410)) {
				await Promise.all([
					this.secrets.delete(EMAIL_TOKEN_KEY),
					this.secrets.delete(EMAIL_ADDRESS_KEY),
				]);
				void vscode.window.showWarningMessage(error.status === 410
					? 'Process Watcher email notifications were unsubscribed for this address.'
					: 'Process Watcher email verification expired. Run Email Notifications to verify again.');
			}
			this.log(`Email notification failed for PID ${watch.pid}: ${errorMessage(error)}`);
		}
	}

	private async verifyAddress(previousEmail?: string): Promise<void> {
		const email = await vscode.window.showInputBox({
			title: 'Process Watcher Email Notifications',
			prompt: 'Enter the address that should receive process completion emails.',
			placeHolder: 'you@example.com',
			value: previousEmail,
			ignoreFocusOut: true,
			validateInput: value => isValidEmail(value) ? undefined : 'Enter a valid email address.',
		});
		if (!email) {
			return;
		}
		try {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: 'Sending Process Watcher verification code...',
			}, () => this.request('/v1/email/request-code', { email: email.trim() }));
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not send verification code: ${errorMessage(error)}`);
			return;
		}

		const code = await vscode.window.showInputBox({
			title: 'Verify Process Watcher Email',
			prompt: `Enter the six-digit code sent to ${email.trim()}.`,
			placeHolder: '123456',
			ignoreFocusOut: true,
			validateInput: value => /^\d{6}$/.test(value.trim()) ? undefined : 'Enter the six-digit code.',
		});
		if (!code) {
			return;
		}
		try {
			const response = await this.request<VerifyResponse>('/v1/email/verify', {
				email: email.trim(),
				code: code.trim(),
			});
			if (!response.token || !response.email) {
				throw new Error('The email service returned an invalid response.');
			}
			await Promise.all([
				this.secrets.store(EMAIL_TOKEN_KEY, response.token),
				this.secrets.store(EMAIL_ADDRESS_KEY, response.email),
			]);
			void vscode.window.showInformationMessage(`Process Watcher emails enabled for ${response.email}.`);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not verify email: ${errorMessage(error)}`);
		}
	}

	private async request<T extends RelayError = RelayError>(
		path: string,
		body: unknown,
		token?: string,
	): Promise<T> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		try {
			const response = await fetch(`${EMAIL_RELAY_URL}${path}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(token ? { authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			return await parseRelayResponse<T>(response);
		} finally {
			clearTimeout(timeout);
		}
	}

	private isRelayConfigured(): boolean {
		return !EMAIL_RELAY_URL.includes('REPLACE_WITH_SUBDOMAIN');
	}
}

export function completionEmailPayload(watch: WatchedProcess) {
	if (!watch.endedAt) {
		throw new Error('Cannot email a process that has not ended.');
	}
	return {
		processName: watch.name,
		pid: watch.pid,
		location: watch.location === 'windows' ? 'Local Windows' as const : 'Remote Linux' as const,
		processStartedAt: watch.startedAt,
		watchStartedAt: watch.watchStartedAt,
		endedAt: watch.endedAt,
		commandLine: watch.commandLine,
	};
}

function isValidEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) && value.trim().length <= 254;
}

export async function parseRelayResponse<T extends RelayError = RelayError>(response: Response): Promise<T> {
	const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
	const body = await response.text();
	if (contentType.includes('text/html') || /^\s*(?:<!doctype html|<html\b)/i.test(body)) {
		throw new RelayRequestError(
			response.status,
			`Email service returned an HTML page (HTTP ${response.status}). A network proxy or security filter may be blocking relay.processwatcher.dev.`,
		);
	}
	let result: unknown;
	try {
		result = JSON.parse(body);
	} catch {
		throw new RelayRequestError(response.status, `Email service returned an invalid response (HTTP ${response.status}).`);
	}
	if (typeof result !== 'object' || result === null || Array.isArray(result)) {
		throw new RelayRequestError(response.status, `Email service returned an invalid response (HTTP ${response.status}).`);
	}
	const relayResult = result as T;
	if (!response.ok) {
		throw new RelayRequestError(response.status, relayResult.error ?? 'Email service request failed.');
	}
	return relayResult;
}

class RelayRequestError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
