import { processWatcherIconPng } from './generated/processWatcherIcon.js';

interface Env {
	DB: D1Database;
	RESEND_API_KEY: string;
	TOKEN_SIGNING_SECRET: string;
	FROM_EMAIL: string;
}

interface EmailMessage {
	processName: string;
	pid: number;
	location: 'Local Windows' | 'Remote Linux';
	processStartedAt: string;
	watchStartedAt: string;
	endedAt: string;
	commandLine: string;
}

interface TokenPayload {
	email: string;
	expiresAt: number;
	version: 1;
	purpose?: 'unsubscribe';
}

interface EmailAttachment {
	content: string;
	filename: string;
	content_id: string;
}

interface ResendMessage {
	to: string;
	subject: string;
	text: string;
	html: string;
	attachments?: EmailAttachment[];
}

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const htmlHeaders = {
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
	'referrer-policy': 'no-referrer',
	'x-content-type-options': 'nosniff',
};
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const maxBodyBytes = 16_384;
const maxOutboundEmailsPerDay = 90;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			const url = new URL(request.url);
			if (request.method === 'GET' && url.pathname === '/health') {
				return json({ ok: true });
			}
			if (request.method === 'GET' && url.pathname === '/v1/email/unsubscribe') {
				return unsubscribePage(url, env);
			}
			if (request.method !== 'POST') {
				return json({ error: 'Not found.' }, 404);
			}
			switch (url.pathname) {
				case '/v1/email/request-code':
					return await requestCode(request, env);
				case '/v1/email/verify':
					return await verifyCode(request, env);
				case '/v1/email/notify':
					return await sendNotification(request, env);
				case '/v1/email/unsubscribe':
					return await unsubscribe(request, env);
				default:
					return json({ error: 'Not found.' }, 404);
			}
		} catch (error) {
			if (error instanceof HttpError) {
				return json({ error: error.message }, error.status);
			}
			console.error('Unhandled email relay error', error instanceof Error ? error.name : typeof error);
			return json({ error: 'Email service unavailable.' }, 500);
		}
	},
} satisfies ExportedHandler<Env>;

async function requestCode(request: Request, env: Env): Promise<Response> {
	const body = await readJson(request);
	const email = normalizeEmail(body.email);
	if (!email) {
		return json({ error: 'Enter a valid email address.' }, 400);
	}
	const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
	await cleanupExpired(env.DB);
	if (!await limitAvailable(env.DB, 'outbound-email-global', maxOutboundEmailsPerDay)
		|| !await consumeLimit(env.DB, await rateLimitKey('verify-ip', ip, env.TOKEN_SIGNING_SECRET), 20, 60 * 60)
		|| !await consumeLimit(env.DB, await rateLimitKey('verify-email', email, env.TOKEN_SIGNING_SECRET), 5, 60 * 60)
		|| !await consumeLimit(env.DB, 'outbound-email-global', maxOutboundEmailsPerDay, 24 * 60 * 60)) {
		return json({ error: 'Too many verification requests. Try again later.' }, 429);
	}

	const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
	const codeHash = await sign(`${email}:${code}`, env.TOKEN_SIGNING_SECRET);
	const recipientHash = await emailHash(email, env.TOKEN_SIGNING_SECRET);
	const expiresAt = unixSeconds() + 10 * 60;
	await env.DB.prepare(`
		INSERT INTO email_verifications (email_hash, code_hash, expires_at, attempts)
		VALUES (?, ?, ?, 0)
		ON CONFLICT(email_hash) DO UPDATE SET code_hash = excluded.code_hash,
			expires_at = excluded.expires_at, attempts = 0
	`).bind(recipientHash, codeHash, expiresAt).run();

	await sendResendEmail(env, {
		to: email,
		subject: 'Verify Process Watcher email notifications',
		text: `Your Process Watcher verification code is ${code}. It expires in 10 minutes.`,
		html: `<p>Your Process Watcher verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 10 minutes.</p>`,
	});
	return json({ ok: true });
}

async function verifyCode(request: Request, env: Env): Promise<Response> {
	const body = await readJson(request);
	const email = normalizeEmail(body.email);
	const code = typeof body.code === 'string' ? body.code.trim() : '';
	if (!email || !/^\d{6}$/.test(code)) {
		return json({ error: 'Enter the six-digit verification code.' }, 400);
	}

	const recipientHash = await emailHash(email, env.TOKEN_SIGNING_SECRET);
	const record = await env.DB.prepare(`
		UPDATE email_verifications SET attempts = attempts + 1
		WHERE email_hash = ? AND expires_at >= ? AND attempts < 5
		RETURNING code_hash
	`).bind(recipientHash, unixSeconds()).first<{ code_hash: string }>();
	if (!record) {
		return json({ error: 'The verification code is invalid or expired.' }, 400);
	}
	if (!await verifySignature(`${email}:${code}`, record.code_hash, env.TOKEN_SIGNING_SECRET)) {
		return json({ error: 'The verification code is invalid or expired.' }, 400);
	}

	await env.DB.prepare('DELETE FROM email_verifications WHERE email_hash = ?').bind(recipientHash).run();
	await env.DB.prepare('DELETE FROM email_suppressions WHERE email_hash = ?')
		.bind(recipientHash).run();
	const token = await createToken({
		email,
		expiresAt: unixSeconds() + 365 * 24 * 60 * 60,
		version: 1,
	}, env.TOKEN_SIGNING_SECRET);
	return json({ token, email });
}

async function sendNotification(request: Request, env: Env): Promise<Response> {
	const authorization = request.headers.get('authorization') ?? '';
	const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
	const payload = await verifyToken(token, env.TOKEN_SIGNING_SECRET);
	if (!payload || payload.purpose) {
		return json({ error: 'Email verification expired. Verify your address again.' }, 401);
	}
	const body = await readJson(request);
	const message = validateMessage(body);
	if (!message) {
		return json({ error: 'Invalid process details.' }, 400);
	}
	await cleanupExpired(env.DB);
	const suppressed = await env.DB.prepare(
		'SELECT 1 AS suppressed FROM email_suppressions WHERE email_hash = ?',
	).bind(await emailHash(payload.email, env.TOKEN_SIGNING_SECRET)).first<{ suppressed: number }>();
	if (suppressed) {
		return json({ error: 'This email address has unsubscribed.' }, 410);
	}
	if (!await limitAvailable(env.DB, 'outbound-email-global', maxOutboundEmailsPerDay)
		|| !await consumeLimit(env.DB, await rateLimitKey('notify', payload.email, env.TOKEN_SIGNING_SECRET), 50, 24 * 60 * 60)
		|| !await consumeLimit(env.DB, 'outbound-email-global', maxOutboundEmailsPerDay, 24 * 60 * 60)) {
		return json({ error: 'Daily email notification limit reached.' }, 429);
	}
	const runtime = formatDuration(Date.parse(message.endedAt) - Date.parse(message.watchStartedAt));
	const unsubscribeToken = await createToken({
		email: payload.email,
		expiresAt: payload.expiresAt,
		version: 1,
		purpose: 'unsubscribe',
	}, env.TOKEN_SIGNING_SECRET);
	const unsubscribeUrl = `${new URL(request.url).origin}/v1/email/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
	const presentation = completionEmailPresentation(message, runtime, unsubscribeUrl);
	await sendResendEmail(env, {
		to: payload.email,
		subject: `Process Watcher: ${message.processName} finished`,
		...presentation,
	});
	return json({ ok: true });
}

export function completionEmailPresentation(message: EmailMessage, runtime: string, unsubscribeUrl: string) {
	const details = [
		['Status', 'Ended'],
		['Process started', formatDate(message.processStartedAt)],
		['Watch started', formatDate(message.watchStartedAt)],
		['Ended', formatDate(message.endedAt)],
		['Runtime while watched', runtime],
	] as const;
	const text = [
		'PROCESS WATCHER',
		'',
		`${message.processName} finished`,
		`PID: ${message.pid}`,
		`Location: ${message.location}`,
		'',
		'Command line:',
		message.commandLine,
		'',
		...details.map(([label, value]) => `${label}: ${value}`),
		'',
		`Stop receiving Process Watcher emails: ${unsubscribeUrl}`,
	].join('\n');
	const detailRows = details.map(([label, value]) => `
		<tr>
			<td width="42%" style="padding:9px 12px 9px 0;border-top:1px solid #E4E9ED;color:#66717C;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;line-height:18px;vertical-align:top">${escapeHtml(label)}</td>
			<td style="padding:9px 0;border-top:1px solid #E4E9ED;color:#20252B;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;line-height:18px;vertical-align:top">${escapeHtml(value)}</td>
		</tr>`).join('');
	const html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<meta name="color-scheme" content="light">
	<meta name="supported-color-schemes" content="light">
	<title>${escapeHtml(message.processName)} finished</title>
	<style>
		@media only screen and (max-width:600px) {
			.email-shell { padding:16px 10px !important; }
			.notification { padding:22px 18px !important; }
			.process-title { font-size:22px !important; line-height:28px !important; }
		}
	</style>
</head>
<body style="margin:0;padding:0;background:#F2F5F7;color:#20252B">
	<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(message.processName)} finished - PID ${message.pid} - ${escapeHtml(message.location)}</div>
	<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#F2F5F7">
		<tr>
			<td class="email-shell" align="center" style="padding:28px 14px">
				<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px">
					<tr>
						<td class="notification" style="padding:26px 28px;background:#FFFFFF;border:1px solid #D9E0E5;border-left:5px solid #66C0F4;border-radius:8px;box-shadow:0 5px 18px rgba(32,37,43,0.10)">
							<table role="presentation" cellspacing="0" cellpadding="0" border="0">
								<tr>
									<td width="40" style="width:40px;padding:0 10px 0 0;vertical-align:middle">
										<img src="cid:process-watcher-clock" width="32" height="32" alt="" style="display:block;width:32px;height:32px;border:0">
									</td>
									<td style="color:#2B8FBE;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:700;line-height:16px;letter-spacing:0.8px;vertical-align:middle">PROCESS WATCHER</td>
								</tr>
							</table>
							<h1 class="process-title" style="margin:18px 0 5px;color:#20252B;font-family:'Segoe UI',Arial,sans-serif;font-size:25px;font-weight:600;line-height:32px;letter-spacing:0">${escapeHtml(message.processName)} finished</h1>
							<p style="margin:0;color:#66717C;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;line-height:20px">PID ${message.pid}&nbsp;&nbsp;&bull;&nbsp;&nbsp;${escapeHtml(message.location)}</p>
							<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:22px">
								<tr>
									<td style="padding:0 0 7px;color:#66717C;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:700;line-height:16px;text-transform:uppercase">Command line</td>
								</tr>
								<tr>
									<td style="padding:11px 12px;background:#F4F7F9;border:1px solid #E0E6EA;border-radius:4px;color:#303840;font-family:Consolas,'Courier New',monospace;font-size:12px;line-height:18px;word-break:break-all;overflow-wrap:anywhere">${escapeHtml(message.commandLine)}</td>
								</tr>
							</table>
							<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:18px">${detailRows}
							</table>
						</td>
					</tr>
					<tr>
						<td align="center" style="padding:14px 12px 0;color:#7B8791;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;line-height:16px">
							<a href="${escapeHtml(unsubscribeUrl)}" style="color:#66717C;text-decoration:underline">Stop receiving Process Watcher emails</a>
						</td>
					</tr>
				</table>
			</td>
		</tr>
	</table>
</body>
</html>`;
	return {
		text,
		html,
		attachments: [{
			content: processWatcherIconPng,
			filename: 'process-watcher-clock.png',
			content_id: 'process-watcher-clock',
		}],
	};
}

async function unsubscribePage(url: URL, env: Env): Promise<Response> {
	const token = url.searchParams.get('token') ?? '';
	const payload = await verifyToken(token, env.TOKEN_SIGNING_SECRET);
	if (!payload || payload.purpose !== 'unsubscribe') {
		return htmlPage('Invalid link', 'This unsubscribe link is invalid or expired.', 400);
	}
	return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unsubscribe from Process Watcher</title><body style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:64px auto;padding:0 20px;color:#20252b"><h1 style="font-size:24px">Stop Process Watcher emails?</h1><p>This will unsubscribe <strong>${escapeHtml(payload.email)}</strong>. Existing installation tokens will no longer be able to send email to this address.</p><form method="post" action="/v1/email/unsubscribe"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit" style="padding:10px 16px;border:0;border-radius:4px;background:#b42318;color:white;font-weight:600;cursor:pointer">Unsubscribe</button></form></body></html>`, {
		headers: htmlHeaders,
	});
}

async function unsubscribe(request: Request, env: Env): Promise<Response> {
	const authorization = request.headers.get('authorization') ?? '';
	const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
	const isExtensionRequest = Boolean(bearerToken);
	const token = isExtensionRequest
		? bearerToken
		: new URLSearchParams(await readLimitedText(request)).get('token') ?? '';
	const payload = await verifyToken(token, env.TOKEN_SIGNING_SECRET);
	if (!payload || (isExtensionRequest ? Boolean(payload.purpose) : payload.purpose !== 'unsubscribe')) {
		return isExtensionRequest
			? json({ error: 'Email verification expired. Verify your address again.' }, 401)
			: htmlPage('Invalid link', 'This unsubscribe link is invalid or expired.', 400);
	}
	await env.DB.prepare(`
		INSERT INTO email_suppressions (email_hash, created_at) VALUES (?, ?)
		ON CONFLICT(email_hash) DO UPDATE SET created_at = excluded.created_at
	`).bind(await emailHash(payload.email, env.TOKEN_SIGNING_SECRET), unixSeconds()).run();
	return isExtensionRequest
		? json({ ok: true })
		: htmlPage('Unsubscribed', 'You will no longer receive Process Watcher emails.');
}

async function consumeLimit(database: D1Database, key: string, maximum: number, windowSeconds: number): Promise<boolean> {
	const now = unixSeconds();
	const result = await database.prepare(`
		INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
		ON CONFLICT(key) DO UPDATE SET
			count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
			expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
		RETURNING count
	`).bind(key, now + windowSeconds, now, now).first<{ count: number }>();
	return Boolean(result && result.count <= maximum);
}

async function limitAvailable(database: D1Database, key: string, maximum: number): Promise<boolean> {
	const result = await database.prepare(
		'SELECT count, expires_at FROM rate_limits WHERE key = ?',
	).bind(key).first<{ count: number; expires_at: number }>();
	return !result || result.expires_at <= unixSeconds() || result.count < maximum;
}

async function cleanupExpired(database: D1Database): Promise<void> {
	const now = unixSeconds();
	await database.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').bind(now).run();
	await database.prepare('DELETE FROM email_verifications WHERE expires_at < ?').bind(now).run();
}

async function sendResendEmail(env: Env, message: ResendMessage): Promise<void> {
	const response = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			authorization: `Bearer ${env.RESEND_API_KEY}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify({ from: env.FROM_EMAIL, ...message }),
	});
	if (!response.ok) {
		console.error(`Resend request failed with status ${response.status}.`);
		throw new Error('Email provider rejected the request.');
	}
}

export async function createToken(payload: TokenPayload, secret: string): Promise<string> {
	const encoded = encodeBase64Url(JSON.stringify(payload));
	return `${encoded}.${await sign(encoded, secret)}`;
}

async function verifyToken(token: string, secret: string): Promise<TokenPayload | undefined> {
	if (token.length > 2_048) {
		return undefined;
	}
	const [encoded, signature, extra] = token.split('.');
	if (!encoded || !signature || extra || !await verifySignature(encoded, signature, secret)) {
		return undefined;
	}
	try {
		const payload = JSON.parse(decodeBase64Url(encoded)) as TokenPayload;
		return payload.version === 1 && Boolean(normalizeEmail(payload.email)) && payload.expiresAt > unixSeconds()
			? payload
			: undefined;
	} catch {
		return undefined;
	}
}

async function sign(value: string, secret: string): Promise<string> {
	const key = await hmacKey(secret, ['sign']);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
	return encodeBase64Url(String.fromCharCode(...new Uint8Array(signature)));
}

async function verifySignature(value: string, signature: string, secret: string): Promise<boolean> {
	try {
		const key = await hmacKey(secret, ['verify']);
		return crypto.subtle.verify('HMAC', key, decodeBase64UrlBytes(signature), new TextEncoder().encode(value));
	} catch {
		return false;
	}
}

function hmacKey(secret: string, usages: Array<'sign' | 'verify'>): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages,
	);
}

function emailHash(email: string, secret: string): Promise<string> {
	return sign(`email:${email}`, secret);
}

async function rateLimitKey(scope: string, value: string, secret: string): Promise<string> {
	return `${scope}:${await sign(`rate:${scope}:${value}`, secret)}`;
}

function validateMessage(value: Record<string, unknown>): EmailMessage | undefined {
	const location = value.location;
	if (typeof value.processName !== 'string' || value.processName.length > 200
		|| !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
		|| (location !== 'Local Windows' && location !== 'Remote Linux')
		|| !isDate(value.processStartedAt) || !isDate(value.watchStartedAt) || !isDate(value.endedAt)
		|| typeof value.commandLine !== 'string' || value.commandLine.length > 8_000) {
		return undefined;
	}
	return value as unknown as EmailMessage;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
	let value: unknown;
	try {
		value = JSON.parse(await readLimitedText(request));
	} catch (error) {
		if (error instanceof HttpError) {
			throw error;
		}
		throw new HttpError(400, 'Invalid JSON body.');
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new HttpError(400, 'Invalid JSON body.');
	}
	return value as Record<string, unknown>;
}

async function readLimitedText(request: Request): Promise<string> {
	if (Number(request.headers.get('content-length') ?? 0) > maxBodyBytes) {
		throw new HttpError(413, 'Request too large.');
	}
	const reader = request.body?.getReader();
	if (!reader) {
		return '';
	}
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		totalBytes += value.byteLength;
		if (totalBytes > maxBodyBytes) {
			await reader.cancel();
			throw new HttpError(413, 'Request too large.');
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function normalizeEmail(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const email = value.trim().toLowerCase();
	return email.length <= 254 && emailPattern.test(email) ? email : undefined;
}

function isDate(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function unixSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function formatDate(value: string): string {
	return new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function formatDuration(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return [hours && `${hours}h`, (hours || minutes) && `${minutes}m`, `${seconds}s`].filter(Boolean).join(' ');
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, character => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	})[character] ?? character);
}

function encodeBase64Url(value: string): string {
	return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
	return atob(base64);
}

function decodeBase64UrlBytes(value: string): Uint8Array {
	return Uint8Array.from(decodeBase64Url(value), character => character.charCodeAt(0));
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: jsonHeaders });
}

function htmlPage(title: string, message: string, status = 200): Response {
	return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:64px auto;padding:0 20px;color:#20252b"><h1 style="font-size:24px">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`, {
		status,
		headers: htmlHeaders,
	});
}

class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}
