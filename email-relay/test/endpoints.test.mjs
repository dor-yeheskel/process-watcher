import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import worker, { createToken } from '../src/index.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function env(database = {}) {
	return {
		DB: database,
		RESEND_API_KEY: 'test-api-key',
		TOKEN_SIGNING_SECRET: 'test-signing-secret',
		FROM_EMAIL: 'Process Watcher <notifications@example.com>',
	};
}

function notificationDatabase() {
	let suppressed = false;
	return {
		prepare(sql) {
			return {
				bind() {
					return {
						async first() {
							if (sql.includes('email_suppressions')) {
								return suppressed ? { suppressed: 1 } : undefined;
							}
							return { count: 1 };
						},
						async run() {
							if (sql.includes('INSERT INTO email_suppressions')) {
								suppressed = true;
							}
							return {};
						},
					};
				},
			};
		},
	};
}

function verificationDatabase() {
	const calls = [];
	let codeHash;
	return {
		calls,
		prepare(sql) {
			return {
				bind(...values) {
					calls.push({ sql, values });
					return {
						async first() {
							if (sql.includes('UPDATE email_verifications')) {
								return codeHash ? { code_hash: codeHash } : undefined;
							}
							return { count: 1 };
						},
						async run() {
							if (sql.includes('INSERT INTO email_verifications')) {
								codeHash = values[1];
							}
							return {};
						},
					};
				},
			};
		},
	};
}

async function responseJson(response) {
	return JSON.parse(await response.text());
}

test('root identifies the public service and its owner', async () => {
	const response = await worker.fetch(new Request('https://relay.example/'), env());
	const body = await response.text();

	assert.equal(response.status, 200);
	assert.match(response.headers.get('content-type'), /^text\/html/);
	assert.match(body, /<h1>Process Watcher<\/h1>/);
	assert.match(body, /marketplace\.visualstudio\.com\/items\?itemName=dor-yeheskel\.process-watcher/);
	assert.match(body, /github\.com\/dor-yeheskel\/process-watcher\/blob\/master\/PRIVACY\.md/);
	assert.match(body, /href="\/health"/);
});

test('health endpoint is available without bindings', async () => {
	const response = await worker.fetch(new Request('https://relay.example/health'), env());

	assert.equal(response.status, 200);
	assert.deepEqual(await responseJson(response), { ok: true });
});

test('request-code rejects invalid addresses before touching D1 or Resend', async () => {
	const response = await worker.fetch(new Request('https://relay.example/v1/email/request-code', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email: 'not-an-email' }),
	}), env());

	assert.equal(response.status, 400);
	assert.deepEqual(await responseJson(response), { error: 'Enter a valid email address.' });
});

test('verification stores opaque identifiers and atomically consumes an attempt', async () => {
	const database = verificationDatabase();
	let verificationEmail;
	globalThis.fetch = async (_url, init) => {
		verificationEmail = JSON.parse(init.body);
		return new Response('{}', { status: 200 });
	};
	const email = 'private@example.net';
	const ip = '203.0.113.42';
	const requested = await worker.fetch(new Request('https://relay.example/v1/email/request-code', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
		body: JSON.stringify({ email }),
	}), env(database));
	assert.equal(requested.status, 200);
	for (const call of database.calls) {
		assert.ok(!call.values.includes(email));
		assert.ok(!call.values.includes(ip));
	}
	const code = verificationEmail.text.match(/\b(\d{6})\b/)?.[1];
	assert.ok(code);

	const verified = await worker.fetch(new Request('https://relay.example/v1/email/verify', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, code }),
	}), env(database));
	assert.equal(verified.status, 200);
	assert.ok(database.calls.some(call => call.sql.includes('UPDATE email_verifications')
		&& call.sql.includes('attempts = attempts + 1')
		&& call.sql.includes('RETURNING code_hash')));
});

test('global email cap blocks before allocating caller rate-limit rows', async () => {
	const statements = [];
	let resendCalled = false;
	globalThis.fetch = async () => {
		resendCalled = true;
		return new Response('{}', { status: 200 });
	};
	const database = {
		prepare(sql) {
			statements.push(sql);
			return {
				bind() {
					return {
						async first() {
							return { count: 90, expires_at: Math.floor(Date.now() / 1000) + 60 };
						},
						async run() {
							return {};
						},
					};
				},
			};
		},
	};
	const response = await worker.fetch(new Request('https://relay.example/v1/email/request-code', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.42' },
		body: JSON.stringify({ email: 'private@example.net' }),
	}), env(database));

	assert.equal(response.status, 429);
	assert.ok(!statements.some(sql => sql.includes('INSERT INTO rate_limits')));
	assert.equal(resendCalled, false);
});

test('notify rejects missing and forged tokens', async () => {
	for (const authorization of ['', 'Bearer forged.token']) {
		const response = await worker.fetch(new Request('https://relay.example/v1/email/notify', {
			method: 'POST',
			headers: { authorization },
			body: '{}',
		}), env());

		assert.equal(response.status, 401);
	}
});

test('notify validates details before consuming D1 quota', async () => {
	const token = await createToken({
		email: 'verified@example.com',
		expiresAt: Math.floor(Date.now() / 1000) + 60,
		version: 1,
	}, 'test-signing-secret');
	let databaseCalls = 0;
	const response = await worker.fetch(new Request('https://relay.example/v1/email/notify', {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: '{}',
	}), env({
		prepare() {
			databaseCalls += 1;
			throw new Error('D1 must not be called for invalid details.');
		},
	}));

	assert.equal(response.status, 400);
	assert.equal(databaseCalls, 0);
});

test('rejects streamed request bodies over 16 KiB', async () => {
	const response = await worker.fetch(new Request('https://relay.example/v1/email/request-code', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email: `${'a'.repeat(17_000)}@example.com` }),
	}), env());

	assert.equal(response.status, 413);
});

test('notify sends only to the address in the signed token', async () => {
	const token = await createToken({
		email: 'verified@example.com',
		expiresAt: Math.floor(Date.now() / 1000) + 60,
		version: 1,
	}, 'test-signing-secret');
	const resendRequests = [];
	globalThis.fetch = async (url, init) => {
		resendRequests.push({ url, init });
		return new Response('{}', { status: 200 });
	};
	const database = notificationDatabase();
	const notificationRequest = () => new Request('https://relay.example/v1/email/notify', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			email: 'attacker@example.com',
			processName: 'build.exe',
			pid: 4242,
			location: 'Local Windows',
			processStartedAt: '2026-03-01T10:00:00.000Z',
			watchStartedAt: '2026-03-01T10:01:00.000Z',
			endedAt: '2026-03-01T10:02:00.000Z',
			commandLine: 'build.exe --release',
		}),
	});
	const response = await worker.fetch(notificationRequest(), env(database));

	assert.equal(response.status, 200);
	const resendRequest = resendRequests[0];
	assert.equal(resendRequest.url, 'https://api.resend.com/emails');
	const resendBody = JSON.parse(resendRequest.init.body);
	assert.equal(resendBody.to, 'verified@example.com');
	assert.equal(resendBody.subject, 'Process Watcher: build.exe finished');
	assert.doesNotMatch(resendRequest.init.body, /attacker@example\.com/);
	assert.match(resendBody.text, /^PROCESS WATCHER\n\nbuild\.exe finished\nPID: 4242\nLocation: Local Windows/);
	assert.match(resendBody.text, /\nCommand line:\nbuild\.exe --release\n\nProcess started:/);
	assert.doesNotMatch(resendBody.text, /^Status:/m);
	for (const field of ['Process started:', 'Watch started:', 'Ended:', 'Runtime while watched:']) {
		assert.match(resendBody.text, new RegExp(field));
	}
	assert.match(resendBody.html, /src="cid:process-watcher-clock"/);
	assert.match(resendBody.html, /border-left:5px solid #66C0F4/);
	assert.match(resendBody.html, /background:#F2F5F7/);
	assert.match(resendBody.html, /background:#FFFFFF/);
	assert.ok(resendBody.html.indexOf('build.exe finished') < resendBody.html.indexOf('PID 4242'));
	assert.ok(resendBody.html.indexOf('PID 4242') < resendBody.html.indexOf('Command line'));
	assert.doesNotMatch(resendBody.html, />Status</);
	for (const value of ['Local Windows', 'build.exe --release', 'Process started', 'Watch started', 'Ended', 'Runtime while watched']) {
		assert.match(resendBody.html, new RegExp(value));
	}
	assert.deepEqual(resendBody.attachments.map(attachment => ({
		filename: attachment.filename,
		content_id: attachment.content_id,
	})), [{
		filename: 'process-watcher-clock.png',
		content_id: 'process-watcher-clock',
	}]);
	assert.equal(Buffer.from(resendBody.attachments[0].content, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

	const unsubscribeUrl = resendBody.text.match(/Stop receiving Process Watcher emails: (https:\/\/\S+)/)?.[1];
	assert.ok(unsubscribeUrl);
	const confirmation = await worker.fetch(new Request(unsubscribeUrl), env(database));
	assert.equal(confirmation.status, 200);
	assert.match(await confirmation.text(), /Stop Process Watcher emails\?/);

	const unsubscribeToken = new URL(unsubscribeUrl).searchParams.get('token');
	const removal = await worker.fetch(new Request('https://relay.example/v1/email/unsubscribe', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ token: unsubscribeToken }),
	}), env(database));
	assert.equal(removal.status, 200);
	assert.match(await removal.text(), /You will no longer receive/);

	const blocked = await worker.fetch(notificationRequest(), env(database));
	assert.equal(blocked.status, 410);
	assert.equal(resendRequests.length, 1);
});
