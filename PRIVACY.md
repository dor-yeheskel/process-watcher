# Privacy

Process Watcher has no analytics or advertising telemetry.

## Local data

Watched-process records are stored in VS Code extension global state. They include the process name, full command line, PID, start and end timestamps, execution location, and monitor file locations. The verified email address and signed installation token are stored separately in VS Code SecretStorage.

Removing a watch deletes it from extension state. Removing the email address deletes the local SecretStorage values and suppresses that recipient at the relay.

## Email notifications

Email notifications are disabled until the user enters an address and completes a six-digit verification challenge. When enabled, the extension sends the verified installation token and these completion details over HTTPS to the Process Watcher relay:

- Process name and full command line
- PID and local/remote location
- Process start, watch start, and end timestamps

Command lines can contain passwords, API keys, tokens, file paths, or other sensitive arguments. Users should enable email only when transmitting this information through Cloudflare, Resend, and their email provider is appropriate.

The relay uses Resend to deliver verification and completion emails. Resend receives the recipient address and message content. The relay does not intentionally log recipient addresses, process details, command lines, verification codes, or installation tokens.

## Relay storage

Cloudflare D1 stores HMAC-derived identifiers rather than plaintext addresses for verification, rate limiting, and suppression. Pending verification codes are HMAC-protected, expire after 10 minutes, and allow at most five attempts. Expired verification and rate-limit records are removed during subsequent requests. Suppression hashes remain until that address is explicitly verified again.

Signed installation tokens contain the normalized recipient address, expire after one year, and are bearer credentials. They are not encrypted and must not be shared. A token can send only to its signed recipient. Unsubscribe links contain a purpose-limited signed token and require POST confirmation.