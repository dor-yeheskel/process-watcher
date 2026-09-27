# Change Log

## 0.0.10

- Explain when a corporate proxy or security filter replaces an email-service response with HTML.
- Shorten the Marketplace summary while retaining local Windows, Remote SSH Linux, popup, and email support.

## 0.0.9

- Add a compact, responsive completion-email design using the Process Watcher clock mark, with a matching plain-text fallback.
- Focus the originating VS Code workspace when a completion popup is clicked, including when local and Remote SSH windows share one Electron process.
- Add Marketplace artwork, workflow demonstrations, platform support notes, and public installation documentation.
- Remove obsolete debug and duplicate focus commands from the Command Palette.
- Remove the redundant always-ended status row from completion emails.
- Move the production relay to `relay.processwatcher.dev` and keep production Cloudflare identifiers out of source control.
- Store only HMAC-derived recipient and IP identifiers in D1, atomically limit verification attempts, and clean expired records.
- Add per-caller and global outbound limits, validate requests before consuming notification quotas, and enforce streamed body limits.
- Avoid logging provider response bodies and require explicit consent before sending command lines by email.
- Restrict Remote SSH temporary process data to owner-only permissions.
- Add privacy documentation and the MIT license.

## 0.0.8

- Add recipient unsubscribe links and a `Remove Email Address` action in VS Code.
- Suppress unsubscribed addresses across existing installation tokens until the address is explicitly verified again.
- Show the command line immediately after the process name in email and hover details.

## 0.0.7

- Add optional verified email notifications for completed processes.
- Store the verified address and signed installation token in VS Code SecretStorage.
- Deliver email independently from existing persistent Windows popups and watch persistence.
- Add a Cloudflare Worker relay backed by D1 and Resend, with expiring codes and rate limits.

## 0.0.6

- Use the Process Watcher clock mark in completion popups and add a red close-button hover state.
- Keep the Command Palette focused on adding processes while retaining internal utility commands.
- Add a view-title action that clears ended watches without removing running watches.

## 0.0.5

- Enforce newest-first process picker ordering across Windows and Remote Linux.
- Use descending PID order when processes have identical start timestamps.

## 0.0.4

- Add local Windows and Remote SSH Linux process selection.
- Track exact PID creation identities and show the native Windows toast on completion.
- Present running and ended watches together in one list; ended rows are gray.

## 0.0.3

- Replace the legacy message box with a modern Steam-style bottom-right toast.
- Add slide/fade animation, hover pause, close control, and automatic dismissal.

## 0.0.2

- Reset to a Windows-only notification proof of concept.
- Add an initial native Windows notification prototype.
- Force local UI-host execution so the command also runs locally from Remote SSH windows.