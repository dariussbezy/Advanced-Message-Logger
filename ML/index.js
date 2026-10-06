(() => {
  "use strict";
  const { metro, patcher, plugin, ui } = vendetta;
  const vstorage = vendetta.storage;
  const { findByName, findByStoreName } = metro;
  const { FluxDispatcher, React, ReactNative: RN } = metro.common;

  const MAX_EDITS = 5;
  const MAX_SHOWN = 3;
  const MAX_LEN = 2000;
  const MAX_DELETED = 1000;
  const MAX_SESSION_HISTORY = 300;
  const MAX_SAVED_HISTORY = 1000;
  const MAX_SAVED_DELETED = 500;
  const MAX_RAW_BUFFER = 500;
  const MAX_RAW_SIZE = 20000;
  const SAVE_DELAY = 4000;
  const FLAG = 0x20000000;
  const RED = "#ED4245";
  const GREY = "#80848E";
  const INLINE = new Set(["text", "strong", "em", "u", "s", "inlineCode"]);

  const history = new Map();
  const deleted = new Set();
  const savedDeleted = new Map();
  const rawBuffer = new Map();
  const unpatches = [];
  let renderUnpatch = null;
  let renderErrors = 0;
  let dirty = false;
  let saveTimer = null;
  let appStateSub = null;
  let MessageStore;
  let UserStore;

  const cfg = () => plugin.storage;
  const toast = (t) => { try { ui.toasts.showToast(t); } catch (_) {} };
  const trimMap = (m, max) => { while (m.size > max) m.delete(m.keys().next().value); };
  const trimSet = (s, max) => { while (s.size > max) s.delete(s.values().next().value); };
  const cmp = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);

  function loadStores() {
    MessageStore = MessageStore || findByStoreName("MessageStore");
    UserStore = UserStore || findByStoreName("UserStore");
    return !!(MessageStore && UserStore && FluxDispatcher);
  }

  function getMessage(channelId, id) {
    try { return MessageStore.getMessage(channelId, id) || null; } catch (_) { return null; }
  }

  function shouldSkip(msg) {
    try {
      const a = msg.author;
      if (!a) return false;
      if (cfg().skipOwn && a.id === UserStore.getCurrentUser()?.id) return true;
      if (cfg().skipBots && a.bot) return true;
    } catch (_) {}
    return false;
  }

  function loadSaved() {
    try {
      const raw = cfg().saved;
      if (!raw) return;
      const data = JSON.parse(JSON.stringify(raw));
      for (const [id, v] of Object.entries(data.deleted || {})) {
        if (v && v.raw) { savedDeleted.set(id, v); deleted.add(id); }
      }
      for (const [id, v] of Object.entries(data.edits || {})) {
        if (Array.isArray(v)) history.set(id, v);
      }
    } catch (_) {}
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!dirty) return;
    dirty = false;
    try {
      const del = {};
      for (const [id, v] of savedDeleted) del[id] = v;
      const edits = {};
      for (const [id, h] of history) edits[id] = h;
      cfg().saved = { deleted: del, edits };
    } catch (_) {}
  }

  function markDirty() {
    if (!cfg().persist) return;
    dirty = true;
    if (!saveTimer) saveTimer = setTimeout(flush, SAVE_DELAY);
  }

  function setPersist(on) {
    cfg().persist = on;
    if (on) {
      loadSaved();
      markDirty();
    } else {
      rawBuffer.clear();
    }
  }

  function clearAll() {
    history.clear();
    deleted.clear();
    savedDeleted.clear();
    dirty = false;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { cfg().saved = { deleted: {}, edits: {} }; } catch (_) {}
  }

  function remember(raw) {
    if (!raw || !raw.id) return;
    rawBuffer.delete(raw.id);
    rawBuffer.set(raw.id, raw);
    trimMap(rawBuffer, MAX_RAW_BUFFER);
  }

  function refresh(msg, channelId, id, guildId) {
    setTimeout(() => {
      try {
        FluxDispatcher.dispatch({
          type: "MESSAGE_UPDATE",
          guildId,
          message: { id, channel_id: channelId, guild_id: guildId, flags: (msg.flags | 0) | FLAG },
        });
      } catch (_) {}
    }, 0);
  }

  function markDeleted(msg, channelId, id, guildId) {
    deleted.add(id);
    trimSet(deleted, MAX_DELETED);
    if (cfg().persist) {
      const raw = rawBuffer.get(id);
      if (raw) {
        let size = 0;
        try { size = JSON.stringify(raw).length; } catch (_) { size = MAX_RAW_SIZE + 1; }
        if (size <= MAX_RAW_SIZE) {
          savedDeleted.set(id, { c: channelId, g: guildId || null, raw });
          trimMap(savedDeleted, MAX_SAVED_DELETED);
          markDirty();
        }
      }
    }
    refresh(msg, channelId, id, guildId);
  }

  const blocked = () => ({ type: "GHOST_LOGGER_BLOCKED" });

  function onDelete(e) {
    if (!cfg().logDeleted || !e.id) return null;
    const msg = getMessage(e.channelId, e.id);
    if (!msg || shouldSkip(msg)) return null;
    markDeleted(msg, e.channelId, e.id, e.guildId);
    return blocked();
  }

  function onBulkDelete(e) {
    if (!cfg().logDeleted || !Array.isArray(e.ids)) return null;
    const pass = [];
    let kept = 0;
    for (const id of e.ids) {
      const msg = getMessage(e.channelId, id);
      if (!msg || shouldSkip(msg)) { pass.push(id); continue; }
      markDeleted(msg, e.channelId, id, e.guildId);
      kept++;
    }
    if (!kept) return null;
    return pass.length ? { ...e, ids: pass } : blocked();
  }

  function onEdit(e) {
    const m = e.message;
    if (!cfg().logEdited || !m || typeof m.content !== "string" || !m.edited_timestamp) return;
    const old = getMessage(m.channel_id, m.id);
    if (!old || typeof old.content !== "string" || !old.content || old.content === m.content) return;
    if (shouldSkip(old)) return;
    let h = history.get(m.id);
    if (!h) {
      h = [];
      history.set(m.id, h);
      trimMap(history, cfg().persist ? MAX_SAVED_HISTORY : MAX_SESSION_HISTORY);
    }
    if (h[h.length - 1] === old.content) return;
    h.push(old.content.slice(0, MAX_LEN));
    if (h.length > MAX_EDITS) h.shift();
    markDirty();
  }

  function inject(e) {
    if (!cfg().logDeleted || !savedDeleted.size || !Array.isArray(e.messages)) return null;
    const present = new Set();
    let lo = null;
    let hi = null;
    for (const m of e.messages) {
      present.add(m.id);
      if (lo === null || cmp(m.id, lo) < 0) lo = m.id;
      if (hi === null || cmp(m.id, hi) > 0) hi = m.id;
    }
    const extra = [];
    for (const [id, v] of savedDeleted) {
      if (v.c !== e.channelId || present.has(id)) continue;
      if (lo === null) {
        if (!e.hasMoreBefore && !e.hasMoreAfter) extra.push(v.raw);
        continue;
      }
      const inside = cmp(id, lo) >= 0 && cmp(id, hi) <= 0;
      const newer = cmp(id, hi) > 0 && !e.hasMoreAfter;
      const older = cmp(id, lo) < 0 && !e.hasMoreBefore;
      if (inside || newer || older) extra.push(v.raw);
    }
    if (!extra.length) return null;
    const all = e.messages.concat(extra);
    all.sort((a, b) => cmp(b.id, a.id));
    return { ...e, messages: all };
  }

  function hookDispatch(args) {
    const e = args[0];
    if (!e) return;
    try {
      switch (e.type) {
        case "MESSAGE_DELETE": {
          const r = onDelete(e);
          if (r) args[0] = r;
          break;
        }
        case "MESSAGE_DELETE_BULK": {
          const r = onBulkDelete(e);
          if (r) args[0] = r;
          break;
        }
        case "MESSAGE_UPDATE": {
          onEdit(e);
          if (cfg().persist && e.message && e.message.id) {
            const old = rawBuffer.get(e.message.id);
            if (old) rawBuffer.set(e.message.id, { ...old, ...e.message });
          }
          break;
        }
        case "MESSAGE_CREATE": {
          if (cfg().persist) remember(e.message);
          break;
        }
        case "LOAD_MESSAGES_SUCCESS": {
          if (!cfg().persist) break;
          const r = inject(e);
          if (r) args[0] = r;
          const list = args[0].messages;
          if (Array.isArray(list)) for (const m of list) remember(m);
          break;
        }
      }
    } catch (_) {}
  }

  function paint(nodes, color) {
    if (!color) return nodes;
    const out = [];
    let run = [];
    const flushRun = () => {
      if (!run.length) return;
      out.push({
        type: "link",
        target: "usernameOnClick",
        context: { username: "", usernameOnClick: { action: "0", userId: "0", linkColor: color, messageChannelId: "0" } },
        content: run,
      });
      run = [];
    };
    for (const n of nodes) {
      if (n && INLINE.has(n.type)) run.push(n);
      else { flushRun(); out.push(n); }
    }
    flushRun();
    return out;
  }

  function decorate(row, input) {
    if (!row || !row.message) return;
    const rowType = input && input.rowType !== undefined ? input.rowType : row.rowType;
    if (rowType !== 1) return;
    const m = row.message;
    const isDeleted = deleted.has(m.id);
    const h = cfg().logEdited ? history.get(m.id) : null;
    if (!isDeleted && !h) return;

    const pc = RN && RN.processColor;
    const red = pc ? pc(RED) : null;
    const grey = pc ? pc(GREY) : null;

    if (isDeleted && pc) {
      row.backgroundHighlight = { backgroundColor: pc(RED + "26"), gutterColor: red };
    }

    const base = (m.__glOut && m.content === m.__glOut) ? m.__glBase : m.content;
    if (Array.isArray(base)) {
      let out = isDeleted ? paint(base, red) : base;
      if (h && h.length) {
        let head = [];
        for (const old of h.slice(-MAX_SHOWN)) {
          head = head.concat(paint([{ type: "text", content: old + "\n" }], grey));
        }
        out = head.concat(out);
      }
      m.__glBase = base;
      m.__glOut = out;
      m.content = out;
    }

    if (!isDeleted && h && pc && !row.backgroundHighlight) {
      row.backgroundHighlight = { backgroundColor: pc(GREY + "14"), gutterColor: pc(GREY + "80") };
    }
  }

  function onRenderError() {
    renderErrors++;
    if (renderErrors >= 3 && renderUnpatch) {
      try { renderUnpatch(); } catch (_) {}
      renderUnpatch = null;
      toast("Basic Message Logger: message styling disabled after repeated errors");
    }
  }

  function patchRender() {
    let RM = findByName("RowManager");
    if (!RM || !RM.prototype) {
      try { RM = findByName("RowManager", false)?.default; } catch (_) {}
    }
    if (!RM || !RM.prototype || typeof RM.prototype.generate !== "function") {
      toast("Basic Message Logger: could not find the message renderer");
      return null;
    }
    return patcher.after("generate", RM.prototype, (args, ret) => {
      try { decorate(ret, args[0]); } catch (_) { onRenderError(); }
    });
  }

  function Settings() {
    vstorage.useProxy(plugin.storage);
    const [, bump] = React.useState(0);
    const F = ui.components && ui.components.Forms;

    const options = [
      ["logDeleted", "Keep deleted messages", "Deleted messages stay visible in red"],
      ["logEdited", "Keep edited messages", "Previous versions appear in gray above the new text"],
      ["persist", "Save across restarts", "Store logged messages on this device"],
      ["skipOwn", "Ignore my messages", "Your own deletes and edits behave normally"],
      ["skipBots", "Ignore bots", "Less noise in busy bot channels"],
    ];

    const setValue = (key, value) => {
      if (key === "persist") setPersist(value);
      else cfg()[key] = value;
      bump((x) => x + 1);
    };

    const rows = options.map(([key, label, sub]) =>
      F && F.FormSwitchRow
        ? React.createElement(F.FormSwitchRow, { key, label, subLabel: sub, value: !!cfg()[key], onValueChange: (v) => setValue(key, v) })
        : React.createElement(
            RN.View,
            { key, style: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16 } },
            React.createElement(RN.Text, { style: { color: "#fff", flex: 1 } }, label),
            React.createElement(RN.Switch, { value: !!cfg()[key], onValueChange: (v) => setValue(key, v) })
          )
    );

    const summary = `Logged: ${deleted.size} deleted, ${history.size} edited` +
      (cfg().persist ? `\nSaved on device: ${savedDeleted.size} deleted` : "");

    rows.push(
      React.createElement(RN.View, { key: "info", style: { paddingHorizontal: 16, paddingVertical: 12 } },
        React.createElement(RN.Text, { style: { color: "#aaa", fontSize: 13 } }, summary))
    );

    rows.push(
      React.createElement(RN.View, { key: "clear", style: { padding: 16 } },
        React.createElement(RN.Button, {
          title: "Clear all logged messages",
          color: "#ED4245",
          onPress: () => {
            RN.Alert.alert("Clear all logged messages?", "This removes every stored deleted and edited message, including the ones saved on this device.", [
              { text: "Cancel", style: "cancel" },
              { text: "Clear", style: "destructive", onPress: () => { clearAll(); bump((x) => x + 1); } },
            ]);
          },
        }))
    );

    return React.createElement(RN.ScrollView, null, ...rows);
  }

  function onLoad() {
    const s = cfg();
    if (s.logDeleted === undefined) s.logDeleted = true;
    if (s.logEdited === undefined) s.logEdited = true;
    if (s.persist === undefined) s.persist = false;
    if (s.skipOwn === undefined) s.skipOwn = false;
    if (s.skipBots === undefined) s.skipBots = false;
    renderErrors = 0;

    if (!loadStores()) { toast("Basic Message Logger: required Discord modules not found"); return; }
    if (s.persist) loadSaved();

    try { unpatches.push(patcher.before("dispatch", FluxDispatcher, hookDispatch)); }
    catch (_) { return; }
    try { renderUnpatch = patchRender(); } catch (_) {}
    try {
      appStateSub = RN.AppState.addEventListener("change", (state) => { if (state !== "active") flush(); });
    } catch (_) {}
  }

  function onUnload() {
    flush();
    for (const u of unpatches.splice(0)) { try { u(); } catch (_) {} }
    if (renderUnpatch) { try { renderUnpatch(); } catch (_) {} renderUnpatch = null; }
    if (appStateSub && appStateSub.remove) { try { appStateSub.remove(); } catch (_) {} }
    appStateSub = null;
    history.clear();
    deleted.clear();
    savedDeleted.clear();
    rawBuffer.clear();
  }

  return { onLoad, onUnload, settings: Settings };
})()
