# Process Watcher - get a notification when any process completes

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![open source](https://img.shields.io/badge/open%20source-yes-brightgreen.svg)](https://github.com/dor-yeheskel/process-watcher)

A tiny tool whose purpose is simple: let you know when any process has finished, in 2 clicks.

<div align="center"  style="margin-bottom: 2rem">
  <img src="media/demo.gif" width="80%" />
  <br/>
  <sub><i>▶ Example: get a notification for a finished process</i></sub>
</div>

---

> **TL;DR**  
> ✅ `Ctrl + Shift + P` → `Process Watcher: Add Process`  
> ✅ A notification will appear immediately when it completes, with an optional email notification as well.  
> ✅ That's it!  

---

## Sometimes, a notification is all you need

When a long process completes, instead of manually checking its progress constantly, 
a small Windows notification - and optionally an email - will keep you informed immediately.

Imagine running a process that you know takes 30 minutes. You do something else meanwhile,  
then come back and find out that the process completed after just 1 minute...  because of a stupid failure.  

If you were informed immediately, you could take action right away instead of discovering  
the failure much later. Well, as long as the notification is not annoying or spammy, and you
choose which process to follow.

Doing this for **any process** you choose on your machine - this is the pain that **Process Watcher** solves.

## Usage

You choose a process, any process - yours, someone else's, a Python script, a Copilot process, anything.  
You can do it by either pressing `Ctrl + Shift + P` → `Process Watcher: Add Process`,  
or via the extension's GUI.

The process will be monitored by a simple tracker in the background that will do the "manual checking" for you.  
You will be notified immediately once it completes by a small window notification that will remain there until you close it.

<div align="center"  style="margin-bottom: 2rem">
  <img src="media/choose_process.gif" width="660"/>
  <br/>
  <sub><i>▶ Example: choosing a process to watch</i></sub>
</div>

If you provide an **email** address, you will also receive an email notification once the process completes.

<div align="center" style="margin-bottom: 2rem">
  <img src="media/email_example.png" width="660"/>
  <br/>
  <sub><i>▶ Example: email notification for a finished process</i></sub>
</div>

## Register your email

To receive email notifications, you need to register your email address.  
**No password or login is required** - simply provide your email, verify it, and you will be notified when a process you are watching completes.

### Stages:
1. Press `Ctrl + Shift + P` → `Process Watcher: Email Notifications`.
2. Paste your email address.
3. Paste the verification code you received via email.

You will see a small notification confirming in VS-Code that your email has been registered successfully.

<div align="center"  style="margin-bottom: 2rem">
  <img src="media/register_email.gif" width="660"/>
  <br/>
  <sub><i>▶ Example: registering your email for notifications</i></sub>
</div>

### Unregister your email
1. Press `Ctrl + Shift + P` → `Process Watcher: Email Notifications`.
2. `Remove Email Address`.

Or, in every email you get, you can click the  `Stop receiving Process Watcher emails` link to unregister your email.

### Privacy

Completion emails include the process name, full command line, PID, location, and timestamps. Command lines may contain sensitive arguments, so enable email notifications only when sending that information through the email service is appropriate.

See the [privacy notice](PRIVACY.md) for details about data handling, storage, and security.

## Manifest

* Simplicity.
* No annoying login.  
* No tracking.  
* No ads.  
* Completely free.  
* An open-source project.  

## Platform Support

- ✅ **Local Windows**.
- ✅ **Remote SSH to Linux from Windows**.

Other local or remote platform combinations are not currently supported or tested.

## Contributing / Issues 🤝

Found a bug? Need another feature? Issues and PRs are welcome.  

Please include:  

-   VS-Code version  
-   OS (and remote/WSL if relevant)  
-   Steps to reproduce the issue  
-   Screenshots / GIFs if possible  

## License 📄

This project is licensed under the MIT License.  
See [LICENSE](LICENSE) for details.  
