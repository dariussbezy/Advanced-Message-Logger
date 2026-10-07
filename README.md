# Basic Message Logger

A simple message logger for Kettu, inspired by the Vencord version. Deleted and edited messages stay visible in the chat instead of disappearing.

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
