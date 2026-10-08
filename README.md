# Advanced Message Logger

An advanced message logger for Kettu, inspired by the Vencord version. It keeps deleted messages visible in chat, shows previous versions of edited messages and much more.

## Features

- **Deleted messages** remain visible in chat, with configurable red styling for the message and username.
- **Edited messages** show the previous text above the current message in gray.
- **Deleted and edited logs** are available in plugin settings. Open an entry to jump to the message, review its edit history, or remove it from the log.
- **Ignore filters** for servers, channels, DMs, and users. Ignore a user from their profile menu; their existing one-to-one DM is ignored automatically too.
- **Ignore my messages** is enabled by default. Bot logging can also be disabled.
- **Optional local persistence** saves logs across restarts. Choose a retention period of 7 days, 30 days, or forever.
- **Deletion and edit timestamps** can be shown in chat.
- **Storage limits** keep up to 2,000 deleted-message entries and 1,000 edited-message histories, with up to 20 previous versions per edited message.
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

## Screenshots

<img width="1179" height="1428" alt="1" src="https://github.com/user-attachments/assets/633ac1ad-9b09-4d4f-aac7-4d8a2170d239" />
<img width="1179" height="554" alt="2" src="https://github.com/user-attachments/assets/d4b320ac-f799-4516-81b3-323cb67b8883" />
<img width="1000" height="2048" alt="3" src="https://github.com/user-attachments/assets/621d9fd7-0981-4a06-80b6-052ebe023377" />
<img width="1179" height="787" alt="4" src="https://github.com/user-attachments/assets/9e2ed141-4748-442c-b46c-1c130e6e9d7c" />
<img width="1179" height="2379" alt="5" src="https://github.com/user-attachments/assets/b3053c9d-af87-4f5f-a76e-388b6bf54f15" />
<img width="1179" height="2379" alt="6" src="https://github.com/user-attachments/assets/98ea1ab7-5388-4616-a16e-f874fdb4d3a8" />
<img width="1179" height="1325" alt="7" src="https://github.com/user-attachments/assets/c1852ca2-85a6-4115-ab72-00e9ef00349a" />
