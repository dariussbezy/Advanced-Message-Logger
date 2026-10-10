# Advanced Message Logger

An advanced message logger for Kettu, inspired by the Vencord version. It keeps deleted messages visible in chat, shows previous versions of edited messages and much more.

## Features

- **Deleted messages** remain visible in chat with configurable message and username colors.
- **Edited messages** show previous text above the current message in a configurable color; edit history can be opened, jumped to, or removed.
- **Deleted and edited logs** are searchable by user, channel, period, and message text. Save or delete search filters from settings.
- **DM alerts** can show a Jump to message prompt for deleted and edited messages in DMs.
- **Ignore filters** for servers, channels, DMs, and users. Ignoring a user also ignores their existing one-to-one DM; group DMs are unaffected.
- **Ignore my messages** and **Ignore bots** can be configured in settings.
- **Capture modes**: Loaded Only, or All Channels, which keeps a bounded cache of messages Discord delivers while Kettu is running. It does not fetch channel history.
- **Optional local persistence** saves logs across restarts. Choose 7 days, 30 days, or forever.
- **Deletion and edit timestamps** can be shown in 24-hour or 12-hour format.
- **Storage limits**: up to 2,000 deleted entries, 1,000 edited histories, 20 previous versions per edited message, and a configurable cache for All Channels mode.
- Batched storage writes; no polling.

## Installation

In Kettu, go to **Settings → Plugins**, tap **+**, and paste:

```text
https://raw.githubusercontent.com/dariussbezy/Advanced-Message-Logger/main/AML/
```

Enable the plugin, then open its settings to choose what to log and display.

## Compatibility

The existing project notes report testing on iOS 27 with Kettu 1.4.3 and Discord 305.1. Android and other client versions may behave differently. Please report any discrepancies or issues you encounter.
Please report bugs, crashes, and suggestions in the project's feedback channel.

## Recommended for use with the Ghost Ping Logger plugin.
https://github.com/dariussbezy/Ghost-Ping-Logger

## Screenshots

<img width="1179" height="1428" alt="1" src="https://github.com/user-attachments/assets/633ac1ad-9b09-4d4f-aac7-4d8a2170d239" />
<img width="1179" height="385" alt="image" src="https://github.com/user-attachments/assets/e9714f5e-e98c-46fb-af56-b85a2d0d7abf" />
<img width="1179" height="557" alt="image" src="https://github.com/user-attachments/assets/b11167df-9725-4782-be3f-242bef1e0bef" />
<img width="1179" height="2413" alt="image" src="https://github.com/user-attachments/assets/0728bbd3-224c-4214-8c2f-93ca86defbab" />
<img width="1179" height="2409" alt="image" src="https://github.com/user-attachments/assets/8489e526-1ce0-4f1f-a600-ba456dd34f9b" />
<img width="1179" height="2408" alt="image" src="https://github.com/user-attachments/assets/d35f91e7-0192-4568-8445-1559e4fc0832" />
