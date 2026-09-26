# Process Watcher

Watch a local Windows process or a process on the Linux host of the current Remote SSH window. When the exact PID and creation identity ends, Process Watcher opens a native Windows popup and can send a verified email notification.

## Use

1. Reload VS Code after installing the VSIX.
2. Press `Ctrl+Shift+P`.
3. Open Process Watcher in the Activity Bar.
4. Select `+`, search for a process, and select it.
5. The single list keeps running processes in green and ended processes in gray.
6. When a process ends, a persistent Windows popup shows its name and PID.

`Process Watcher: Hello World Windows Notification` remains available as a notification test.

## Email notifications

1. Run `Process Watcher: Email Notifications` from the Command Palette.
2. Enter your email address.
3. Enter the six-digit verification code sent to that address.

The verified address and signed installation token are stored in VS Code SecretStorage. Provider credentials are held only by the hosted relay and are never included in the extension. Run the command again to change or remove the address. Every completion email also includes an unsubscribe link; removal suppresses the address across existing installation tokens until it is explicitly verified again. Email delivery is additional and non-blocking: popup notifications and watch persistence continue if the email service is unavailable.

Email notifications send the process name, full command line, PID, location, and timestamps to the Process Watcher relay and Resend. Command lines can contain sensitive arguments, so enable email only when this data is appropriate to transmit. The included privacy notice describes storage, retention, and removal details.

The extension is UI-hosted so the toast always runs on local Windows. In a Remote SSH window it uses a hidden terminal in the existing remote session to enumerate and monitor current-user Linux processes. Remote completion is persisted in `/tmp` and discovered when the window is connected.

This build does not provide VS Code completion notifications, macOS popups, or separate running/finished sections.
