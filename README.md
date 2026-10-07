# Basic Message Logger

A simple and stable message logger for Kettu, inspired by the Vencord version. Deleted and edited messages stay visible in the chat instead of disappearing.

## Features

- **Deleted messages** stay in the chat in red (text, side bar and username).
- **Edited messages** show the previous version in gray above the new text.
- **Save across restarts** (optional) keeps logs on your device.
- **Remove a log entry** from the message long-press menu: *Remove logged message* on deleted messages, *Remove edit history* on edited ones.
- Options to ignore your own messages and bots, and a button to clear everything.
- Lightweight: no polling, batched disk writes, capped storage (500 deleted messages and 1000 edit histories).

## Installation

In Kettu, go to **Settings**, **Plugins**, tap **+** and paste:

```
https://raw.githubusercontent.com/dariussbezy/Basic-Message-Logger/main/ML/
```

Then enable the plugin and open its settings to choose what to keep.

⚠️ This plugin has currently only been tested on iOS 27 running Kettu 1.4.3 and Discord 305.1. There may be issues on Android; if the plugin does not work as described or look as shown in the screenshots, please let me know.

⚠️ Currently in Beta, I am constantly improving it for the best experience.

Please report any bugs/crashes so they can be fixed.

Please submit feedback/suggestions in the destinate channel

**Pictures:**

<img width="590" height="887" alt="IMG_0514" src="https://github.com/user-attachments/assets/1813c37f-5bf7-4ab2-93bb-bf1d01877a05" />
<img width="1179" height="486" alt="IMG_0512" src="https://github.com/user-attachments/assets/6811b98e-b8ff-4b33-9f6e-fb1883375794" />
<img width="1179" height="1587" alt="IMG_0513" src="https://github.com/user-attachments/assets/badb0cb0-0e23-4ae1-a407-c73ef3a07e3f" />
<img width="590" height="304" alt="IMG_0515" src="https://github.com/user-attachments/assets/0c33555d-a83e-4bfc-8562-5fcd055409b1" />
<img width="574" height="303" alt="IMG_0516" src="https://github.com/user-attachments/assets/2bee8a6a-baf6-42c1-b9d0-e44f62358d4c" />
