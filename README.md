# Process Watcher

Process Watcher is a VS Code extension that watches an existing local Windows process or a current-user Linux process in a Remote SSH window. When that exact process ends, it opens a persistent native Windows popup and can optionally send a verified email notification.

Process identity includes both the PID and creation time, so PID reuse does not complete the wrong watch. Detached monitors continue independently from the terminal that launched the process, and ended watches remain visible until removed or cleared.

## Requirements

- Windows as the local VS Code UI host
- VS Code 1.137 or newer
- Optional: a Remote SSH connection to a Linux host for remote process monitoring

Process discovery is limited to the current Windows session or current remote Linux user. Native popups are Windows-only.

## Install

Install a packaged VSIX from VS Code with **Extensions: Install from VSIX**, then reload the window.

To build a VSIX from source:

```powershell
npm install
npm run vsix
```

## Watch A Process

1. Open **Process Watcher** from the Activity Bar.
2. Select **+**, search by process name, PID, or command line, and choose a process.
3. Running watches appear in green. Ended watches remain in gray.
4. Hover over a watch to see its command line, PID, location, and timestamps.
5. Remove one watch from its context menu, or use the view's clear action to remove all ended watches.

Processes are ordered newest-first, with PID as a deterministic tie-breaker. A persistent popup appears when a watched process ends. Clicking it attempts to reactivate the originating VS Code window.

## Email Notifications

1. Run `Process Watcher: Email Notifications` from the Command Palette.
2. Review the command-line privacy warning and continue.
3. Enter your email address.
4. Enter the six-digit verification code sent to that address.

Run the command again to change or remove the address. Every completion email also contains a confirmed unsubscribe link. Removing or unsubscribing suppresses the recipient across existing installation tokens until the address is explicitly verified again.

Email delivery is independent from popup delivery and watch persistence. A relay outage does not prevent the watch from completing locally.

## Privacy And Security

The verified address and signed installation token are stored in VS Code SecretStorage. Resend and signing credentials exist only as Cloudflare Worker secrets and are never included in the extension or repository.

Completion emails contain the process name, full command line, PID, location, and timestamps. Command lines can contain passwords, API keys, tokens, file paths, or other sensitive arguments. Enable email only when sending that data through Cloudflare, Resend, and your email provider is appropriate.

The relay uses expiring verification codes, atomic attempt limits, HMAC-derived database identifiers, signed recipient-bound tokens, suppression records, streamed body limits, and per-caller/global quotas. Process details and provider response bodies are not intentionally logged server-side.

See the [privacy notice](https://github.com/dor-yeheskel/process-watcher/blob/master/PRIVACY.md) and [relay documentation](https://github.com/dor-yeheskel/process-watcher/blob/master/email-relay/README.md) for details.

## Remote SSH

The extension is UI-hosted, so popup and email orchestration run on local Windows. In a Remote SSH window, a hidden terminal uses the existing connection to enumerate current-user Linux processes and launch an owner-only detached monitor.

Remote completion files are written under `/tmp` with owner-only permissions and discovered when the VS Code window reconnects.

## Development

```powershell
npm install
npm run compile
npm run compile-tests
npm test
```

The email relay is a separate Cloudflare Worker project:

```powershell
npm install --prefix email-relay
npm run --prefix email-relay check
npm run --prefix email-relay test
```

Production Wrangler configuration, Worker secrets, local D1 state, dependencies, build output, and VSIX packages are ignored by Git. The committed `email-relay/wrangler.example.jsonc` contains placeholders only.

## Current Limitations

- No macOS or Linux-native popup implementation
- No VS Code completion notification
- No separate running and finished sections
- Remote Linux monitoring requires the existing Remote SSH session for setup and completion discovery
