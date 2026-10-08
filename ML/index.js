(() => {
  "use strict";
  const { metro, patcher, plugin, ui } = vendetta;
  const vstorage = vendetta.storage;
  const { findByName, findByProps, findByStoreName } = metro;
  const { FluxDispatcher, React, ReactNative: RN } = metro.common;

  const MAX_VERSIONS = 20;
  const MAX_SHOWN = 3;
  const MAX_LEN = 2000;
  const MAX_SNIPPET = 500;
  const MAX_LOGGED = 2000;
  const MAX_EDITED = 1000;
  const MAX_SAVED_RAW = 1000;
  const MAX_RAW_BUFFER = 500;
  const MAX_RAW_SIZE = 20000;
  const BUILD = 8;
  const SAVE_DELAY = 4000;
  const PAGE = 40;
  const DAY = 86400000;
  const DISCORD_EPOCH = 1420070400000;
  const FLAG = 0x20000000;
  const FLAG_TOGGLE = 0x10000000;
  const RED = "#ED4245";
  const GREY = "#80848E";
  const INLINE = new Set(["text", "strong", "em", "u", "s", "inlineCode"]);
  const SKIP_MENU = /message|reaction|emoji|sticker|mute|notif|setting|permission|invite|share|report|forward/i;

  const deleted = new Map();
  const edits = new Map();
  const rawSaved = new Map();
  const rawBuffer = new Map();
  const allowDelete = new Map();
  const unpatches = [];
  let ActionSheet;
  let ActionSheetRowIconComponent;
  let MessageStore;
  let UserStore;
  let ChannelStore;
  let GuildStore;
  let SelectedChannelStore;
  let ThemeStore;
  let renderUnpatch = null;
  let renderErrors = 0;
  let dirty = false;
  let saveTimer = null;
  let appStateSub = null;
  let profileRenderUser = null;
  let pendingSheetPlan = null;
  let activeSheetPlan = null;
  let activeSheetInserted = false;
  const wrappedSheetModules = new WeakSet();
  const profileTypeWrappers = new WeakMap();
  const profileWrappedTypes = new WeakSet();

  const cfg = () => plugin.storage;
  const toast = (t) => { try { ui.toasts.showToast(t); } catch (_) {} };
  const trimMap = (m, max) => { while (m.size > max) m.delete(m.keys().next().value); };
  const cmp = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
  const snowTime = (id) => Math.floor(Number(id) / 4194304) + DISCORD_EPOCH;
  const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

  function fmtTime(ms) {
    const d = new Date(ms);
    const p = (n) => (n < 10 ? "0" : "") + n;
    const t = p(d.getHours()) + ":" + p(d.getMinutes());
    if (d.toDateString() === new Date().toDateString()) return t;
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + " " + t;
  }

  function nameOf(u) {
    if (!u) return "Unknown";
    return u.globalName || u.global_name || u.username || "Unknown";
  }

  function loadStores() {
    MessageStore = MessageStore || findByStoreName("MessageStore");
    UserStore = UserStore || findByStoreName("UserStore");
    ChannelStore = ChannelStore || findByStoreName("ChannelStore");
    GuildStore = GuildStore || findByStoreName("GuildStore");
    return !!(MessageStore && UserStore && FluxDispatcher);
  }

  function getMessage(channelId, id) {
    try { return MessageStore.getMessage(channelId, id) || null; } catch (_) { return null; }
  }
  function getChannel(id) {
    try { return id ? ChannelStore.getChannel(id) : null; } catch (_) { return null; }
  }
  function guildOf(channelId) {
    const ch = getChannel(channelId);
    return ch && ch.guild_id ? ch.guild_id : null;
  }
  function guildName(id) {
    try { return id ? GuildStore.getGuild(id)?.name || null : null; } catch (_) { return null; }
  }
  function isDM(ch) {
    return !!ch && (ch.type === 1 || ch.type === 3);
  }
  function currentChannelId() {
    try {
      SelectedChannelStore = SelectedChannelStore || findByStoreName("SelectedChannelStore");
      return SelectedChannelStore.getChannelId();
    } catch (_) { return null; }
  }
  function myId() {
    try { return UserStore.getCurrentUser()?.id || null; } catch (_) { return null; }
  }

  function dmName(ch) {
    if (ch.name) return ch.name;
    try {
      const names = (ch.recipients || []).map((id) => UserStore.getUser(id)?.username).filter(Boolean);
      if (names.length) return names.join(", ");
    } catch (_) {}
    return "Unknown";
  }

  function channelLabel(channelId, guildId) {
    const ch = getChannel(channelId);
    if (!ch) return "Unknown channel";
    if (isDM(ch)) return "DM · " + dmName(ch);
    const gn = guildName(guildId || ch.guild_id);
    return "#" + (ch.name || "channel") + (gn ? " · " + gn : "");
  }

  function ignored() {
    const ig = cfg().ignored;
    return { channels: (ig && ig.channels) || {}, guilds: (ig && ig.guilds) || {}, users: (ig && ig.users) || {} };
  }

  function setIgnore(kind, id, name, shouldIgnore) {
    try {
      if (!["channels", "guilds", "users"].includes(kind) || id == null) return false;
      id = String(id);
      const storage = cfg();
      const current = storage.ignored && typeof storage.ignored === "object" ? storage.ignored : {};
      const ig = JSON.parse(JSON.stringify({
        channels: current.channels || {},
        guilds: current.guilds || {},
        users: current.users || {},
      }));
      if (shouldIgnore) ig[kind][id] = name || id;
      else delete ig[kind][id];
      storage.ignored = ig;
      if (!!(storage.ignored && storage.ignored[kind] && storage.ignored[kind][id]) !== !!shouldIgnore) {
        throw new Error("Ignore list update did not persist");
      }
      toast((shouldIgnore ? "Logger now ignores " : "Logger no longer ignores ") + (name || id));
      return true;
    } catch (_) {
      toast("Could not update the logger ignore list");
      return false;
    }
  }

  function flipIgnore(kind, id, name) {
    return setIgnore(kind, id, name, !ignored()[kind]?.[id]);
  }

  function shouldSkip(msg, channelId, guildId) {
    try {
      const a = msg.author;
      const ig = ignored();
      if (a) {
        if (cfg().skipOwn && a.id === myId()) return true;
        if (cfg().skipBots && a.bot) return true;
        if (ig.users[a.id]) return true;
      }
      if (channelId && ig.channels[channelId]) return true;
      if (guildId && ig.guilds[guildId]) return true;
    } catch (_) {}
    return false;
  }

  function purge() {
    const days = cfg().retentionDays;
    if (!days) return false;
    const cutoff = Date.now() - days * DAY;
    let changed = false;
    for (const [id, info] of deleted) {
      if (info.at && info.at < cutoff) { deleted.delete(id); rawSaved.delete(id); changed = true; }
    }
    for (const [id, en] of edits) {
      const last = en.v && en.v[en.v.length - 1];
      if (!last || last.at < cutoff) { edits.delete(id); changed = true; }
    }
    return changed;
  }

  function schedule() {
    if (!saveTimer) saveTimer = setTimeout(flush, SAVE_DELAY);
  }
  function markDirty() {
    if (!cfg().persist) return;
    dirty = true;
    schedule();
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!dirty) return;
    const wasDirty = dirty;
    dirty = false;
    try {
      const changed = purge();
      if ((wasDirty || changed) && cfg().persist) {
        for (const id of rawSaved.keys()) if (!deleted.has(id)) rawSaved.delete(id);
        const del = {};
        for (const [id, info] of deleted) {
          const entry = { i: info };
          const raw = rawSaved.get(id);
          if (raw) entry.raw = raw;
          del[id] = entry;
        }
        const ed = {};
        for (const [id, en] of edits) ed[id] = en;
        cfg().saved = { v: 2, deleted: del, edits: ed };
      }
    } catch (_) {}
  }

  function loadSaved() {
    try {
      const raw = cfg().saved;
      if (!raw) return;
      const data = JSON.parse(JSON.stringify(raw));
      const now = Date.now();
      for (const [id, v] of Object.entries(data.deleted || {})) {
        if (!v) continue;
        let info = v.i;
        if (!info) {
          const r = v.raw || {};
          info = { c: v.c, g: v.g || null, ai: r.author && r.author.id, an: nameOf(r.author), t: clip(r.content, MAX_SNIPPET), at: now };
        }
        if (!info.c) continue;
        deleted.set(id, info);
        if (v.raw) rawSaved.set(id, v.raw);
      }
      for (const [id, v] of Object.entries(data.edits || {})) {
        if (Array.isArray(v)) {
          edits.set(id, { c: null, g: null, ai: null, an: "Unknown", cur: "", v: v.map((t) => ({ t: String(t), at: now })) });
        } else if (v && Array.isArray(v.v)) {
          edits.set(id, v);
        }
      }
    } catch (_) {}
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
    deleted.clear();
    edits.clear();
    rawSaved.clear();
    dirty = false;
    try { cfg().saved = { v: 2, deleted: {}, edits: {} }; } catch (_) {}
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

  function refreshToggle(msg, channelId, id, guildId) {
    setTimeout(() => {
      try {
        FluxDispatcher.dispatch({
          type: "MESSAGE_UPDATE",
          guildId,
          message: { id, channel_id: channelId, guild_id: guildId, flags: (msg.flags | 0) ^ FLAG_TOGGLE },
        });
      } catch (_) {}
    }, 0);
  }

  function markDeleted(msg, channelId, id, guildId) {
    const info = {
      c: channelId, g: guildId || null, ai: msg.author && msg.author.id, an: nameOf(msg.author),
      t: clip(msg.content, MAX_SNIPPET), at: Date.now(),
    };
    deleted.set(id, info);
    trimMap(deleted, MAX_LOGGED);
    if (cfg().persist) {
      const raw = rawBuffer.get(id);
      if (raw) {
        let size = 0;
        try { size = JSON.stringify(raw).length; } catch (_) { size = MAX_RAW_SIZE + 1; }
        if (size <= MAX_RAW_SIZE) {
          rawSaved.set(id, raw);
          trimMap(rawSaved, MAX_SAVED_RAW);
        }
      }
      markDirty();
    }
    refresh(msg, channelId, id, guildId);
  }

  const blocked = (original) => ({ type: "MESSAGE_LOGGER_BLOCKED", original });

  function isAllowed(id) {
    const until = allowDelete.get(id);
    return !!until && Date.now() < until;
  }

  function onDelete(e) {
    if (!e.id || isAllowed(e.id)) return null;
    const msg = getMessage(e.channelId, e.id);
    if (!msg) return null;
    const guildId = e.guildId || guildOf(e.channelId);
    if (shouldSkip(msg, e.channelId, guildId)) return null;
    if (!cfg().logDeleted) return null;
    markDeleted(msg, e.channelId, e.id, guildId);
    return blocked(e);
  }

  function onBulkDelete(e) {
    if (!Array.isArray(e.ids)) return null;
    if (e.ids.length && e.ids.every(isAllowed)) return null;
    const guildId = e.guildId || guildOf(e.channelId);
    const pass = [];
    const keptIds = [];
    for (const id of e.ids) {
      const msg = getMessage(e.channelId, id);
      if (!msg || shouldSkip(msg, e.channelId, guildId)) { pass.push(id); continue; }
      if (!cfg().logDeleted) { pass.push(id); continue; }
      markDeleted(msg, e.channelId, id, guildId);
      keptIds.push(id);
    }
    if (!keptIds.length) return null;
    return pass.length ? { ...e, ids: pass, loggerKept: keptIds } : blocked(e);
  }

  function onEdit(e) {
    const m = e.message;
    if (!cfg().logEdited || !m || typeof m.content !== "string" || !m.edited_timestamp) return;
    const old = getMessage(m.channel_id, m.id);
    if (!old || typeof old.content !== "string" || !old.content || old.content === m.content) return;
    const guildId = m.guild_id || guildOf(m.channel_id);
    if (shouldSkip(old, m.channel_id, guildId)) return;
    let en = edits.get(m.id);
    if (!en) {
      en = { c: m.channel_id, g: guildId || null, ai: old.author && old.author.id, an: nameOf(old.author), cur: "", v: [] };
      edits.set(m.id, en);
      trimMap(edits, MAX_EDITED);
    }
    const text = clip(old.content, MAX_LEN);
    const last = en.v[en.v.length - 1];
    if (last && last.t === text) return;
    en.c = en.c || m.channel_id;
    en.cur = clip(m.content, MAX_SNIPPET);
    en.v.push({ t: text, at: Date.parse(m.edited_timestamp) || Date.now() });
    if (en.v.length > MAX_VERSIONS) { en.v.shift(); en.trimmed = true; }
    markDirty();
  }

  function inject(e) {
    if (!cfg().logDeleted || !rawSaved.size || !Array.isArray(e.messages)) return null;
    const present = new Set();
    let lo = null;
    let hi = null;
    for (const m of e.messages) {
      present.add(m.id);
      if (lo === null || cmp(m.id, lo) < 0) lo = m.id;
      if (hi === null || cmp(m.id, hi) > 0) hi = m.id;
    }
    const extra = [];
    for (const [id, raw] of rawSaved) {
      const info = deleted.get(id);
      if (!info || info.c !== e.channelId || present.has(id)) continue;
      if (lo === null) {
        if (!e.hasMoreBefore && !e.hasMoreAfter) extra.push(raw);
        continue;
      }
      const inside = cmp(id, lo) >= 0 && cmp(id, hi) <= 0;
      const newer = cmp(id, hi) > 0 && !e.hasMoreAfter;
      const older = cmp(id, lo) < 0 && !e.hasMoreBefore;
      if (inside || newer || older) extra.push(raw);
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

  function removeLog(message) {
    const id = message.id;
    const channelId = message.channel_id || message.channelId || currentChannelId();
    const guildId = guildOf(channelId);
    const wasDeleted = deleted.has(id);
    edits.delete(id);
    if (wasDeleted) {
      deleted.delete(id);
      rawSaved.delete(id);
      allowDelete.set(id, Date.now() + 5000);
      setTimeout(() => {
        try { FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", id, channelId, guildId, loggerRemoval: true }); } catch (_) {}
        setTimeout(() => {
          try {
            if (getMessage(channelId, id)) {
              FluxDispatcher.dispatch({ type: "MESSAGE_DELETE_BULK", ids: [id], channelId, guildId, loggerRemoval: true });
            }
          } catch (_) {}
          setTimeout(() => allowDelete.delete(id), 5000);
        }, 300);
      }, 100);
    } else {
      const msg = getMessage(channelId, id);
      if (msg) refreshToggle(msg, channelId, id, guildId);
    }
    markDirty();
  }

  function jumpTo(channelId, guildId, messageId, navigation) {
    const real = messageId && !String(messageId).startsWith("test-") ? messageId : null;
    const openMessagesTab = () => {
      let current = navigation;
      for (let depth = 0; current && depth < 8; depth++) {
        let state = null;
        try { state = typeof current.getState === "function" ? current.getState() : null; } catch (_) {}
        const routes = state && Array.isArray(state.routes) ? state.routes : [];
        const target = routes.find((route) => /^(home|messages|messagestab|hometab|directmessages)$/i.test(String(route.name || ""))) ||
          routes.find((route) => /home|messages|direct.?messages/i.test(String(route.name || "")) && !/setting|profile|you/i.test(String(route.name || "")));
        if (target) {
          try {
            if (typeof current.jumpTo === "function") current.jumpTo(target.name);
            else if (typeof current.navigate === "function") current.navigate(target.name);
            else return false;
            return true;
          } catch (_) {}
        }
        try { current = typeof current.getParent === "function" ? current.getParent() : null; }
        catch (_) { current = null; }
      }
      return false;
    };
    const dismissProfileRoute = () => {
      let current = navigation;
      for (let depth = 0; current && depth < 8; depth++) {
        let state = null;
        try { state = typeof current.getState === "function" ? current.getState() : null; } catch (_) {}
        const routes = state && Array.isArray(state.routes) ? state.routes : [];
        const active = routes[state && Number.isInteger(state.index) ? state.index : routes.length - 1];
        const routeName = String(active && active.name || "");
        if (/user.?profile|profile.?modal/i.test(routeName) && !/you|settings/i.test(routeName)) {
          try {
            if (typeof current.goBack === "function" && current.canGoBack()) current.goBack();
            else if (typeof current.dismiss === "function") current.dismiss();
            return true;
          } catch (_) {}
        }
        try { current = typeof current.getParent === "function" ? current.getParent() : null; }
        catch (_) { current = null; }
      }
      return false;
    };
    const selectAfterClose = () => {
      setTimeout(() => {
        // UserProfile is often presented as a modal above the tab navigator.
        // Closing only the plugin settings route leaves that profile modal
        // visible, so close the app modal stack before selecting Messages.
        try {
          const modalActions = findByProps("closeAllModals");
          if (modalActions && typeof modalActions.closeAllModals === "function") modalActions.closeAllModals();
        } catch (_) {}
        try { FluxDispatcher.dispatch({ type: "USER_PROFILE_MODAL_CLOSE" }); } catch (_) {}
        try { FluxDispatcher.dispatch({ type: "USER_SETTINGS_MODAL_CLOSE" }); } catch (_) {}
        setTimeout(() => {
          dismissProfileRoute();
          setTimeout(() => {
            openMessagesTab();
            setTimeout(() => {
              // Use the client's channel router so navigation leaves the
              // profile tab and enters the actual Kettu conversation route.
              try {
                const channelRouter = findByProps("transitionToChannel");
                if (channelRouter && typeof channelRouter.transitionToChannel === "function") {
                  channelRouter.transitionToChannel(String(channelId));
                }
              } catch (_) {}
              try {
                const navigationRouter = findByProps("transitionTo");
                const path = guildId
                  ? "/channels/" + String(guildId) + "/" + String(channelId)
                  : "/channels/@me/" + String(channelId);
                if (navigationRouter && typeof navigationRouter.transitionTo === "function") navigationRouter.transitionTo(path);
              } catch (_) {}
              try { FluxDispatcher.dispatch({ type: "CHANNEL_SELECT", guildId: guildId || null, channelId }); } catch (_) {}
              if (!real) return;
              const actions = findByProps("jumpToMessage");
              if (!actions || typeof actions.jumpToMessage !== "function") {
                toast("Could not find Kettu's message navigation action");
                return;
              }
              const jumpWhenChannelIsReady = (attemptsLeft) => {
                if (String(currentChannelId() || "") !== String(channelId) && attemptsLeft > 0) {
                  return setTimeout(() => jumpWhenChannelIsReady(attemptsLeft - 1), 120);
                }
                try {
                  actions.jumpToMessage({ channelId, messageId: real, flash: true, jumpType: "INSTANT" });
                } catch (_) {
                  try { actions.jumpToMessage(channelId, real, true); }
                  catch (_) { toast("Kettu could not jump to that message"); }
                }
              };
              jumpWhenChannelIsReady(25);
          }, 220);
          }, 160);
        }, 250);
      }, 250);
    };
    // The plugin settings are nested above the profile view. Unwind their
    // routes first; the modal and profile route are closed afterward.
    const nav = navigation;
    let depth = 0;
    const closeOne = () => {
      if (!nav || depth++ >= 8) return selectAfterClose();
      let canGoBack = false;
      try { canGoBack = typeof nav.canGoBack === "function" && nav.canGoBack(); } catch (_) {}
      if (canGoBack && typeof nav.goBack === "function") {
        try { nav.goBack(); } catch (_) {}
        return setTimeout(closeOne, 120);
      }
      try {
        if (typeof nav.dismiss === "function") nav.dismiss();
      } catch (_) {}
      selectAfterClose();
    };
    closeOne();
  }

  function ask(title, message, buttons) {
    const ios = RN.Platform && RN.Platform.OS === "ios";
    const list = buttons.slice(0, ios ? 6 : 3);
    if (ios) list.push({ text: "Cancel", style: "cancel" });
    try { RN.Alert.alert(title, message, list, { cancelable: true }); } catch (_) {}
  }

  function showEdits(message) {
    const en = edits.get(message.id);
    if (!en || !en.v.length) return;
    const sent = snowTime(message.id);
    const parts = en.v.map((v, i) =>
      (i === 0 ? "Original" : "Version " + (i + 1)) + " (" + fmtTime(i === 0 ? sent : en.v[i - 1].at) + ")\n" + v.t);
    const current = typeof message.content === "string" ? message.content : en.cur;
    parts.push("Current (" + fmtTime(en.v[en.v.length - 1].at) + ")\n" + current);
    ask("Edit history", clip(parts.join("\n\n"), 3500), [{ text: "Close" }]);
  }

  function messagePlan(message) {
    if (!message || !message.id) return null;
    const plan = [];
    const en = edits.get(message.id);
    if (en && en.v.length) plan.push({ key: "bml-view-edits", label: "View edit history", icon: "history", press: () => showEdits(message) });
    if (deleted.has(message.id)) plan.push({ key: "bml-remove-log", label: "Remove logged message", icon: "trash", press: () => removeLog(message) });
    else if (en) plan.push({ key: "bml-remove-log", label: "Remove edit history", icon: "trash", press: () => removeLog(message) });
    return plan.length ? plan : null;
  }

  function inspectCtx(ctx) {
    let channel = null;
    let guild = null;
    let user = null;
    const asChannel = (v) => {
      if (channel || !v) return;
      const id = typeof v === "string" ? v : typeof v === "object" ? v.id : null;
      const c = id ? getChannel(id) : null;
      if (c) channel = c;
    };
    asChannel(ctx.channel);
    asChannel(ctx.channelId);
    asChannel(ctx.channel_id);
    if (!channel) {
      for (const k of Object.keys(ctx)) {
        const v = ctx[k];
        if (v && typeof v === "object" && v.id && v.type !== undefined) asChannel(v);
        if (channel) break;
      }
    }
    try {
      const gid = (ctx.guild && ctx.guild.id) || ctx.guildId || ctx.guild_id;
      if (gid) guild = GuildStore.getGuild(gid) || null;
      user = ctx.user || ctx.recipient || (ctx.member && ctx.member.user) || (ctx.userId && UserStore.getUser(ctx.userId)) || null;
    } catch (_) {}
    return { channel, guild, user };
  }

  function ignoreItem(kind, id, name, word) {
    const on = !!ignored()[kind][id];
    return {
      key: "bml-ignore-" + kind,
      label: (on ? "Stop ignoring this " : "Ignore this ") + word + " in logger",
      icon: kind === "users" ? "user" : kind === "guilds" ? "server" : "dm",
      press: () => flipIgnore(kind, id, name),
    };
  }

  function scopePlan(key, ctx) {
    if (typeof key !== "string" || !ctx || typeof ctx !== "object" || SKIP_MENU.test(key)) return null;
    const item = (kind, id, name, word) => ({
      key: "bml-ignore-" + kind + "-" + id,
      label: (ignored()[kind][id] ? "Stop ignoring this " : "Ignore this ") + word + " in logger",
      icon: "eye",
      press: () => flipIgnore(kind, id, name),
    });
    try {
      const channelArg = ctx.channel;
      const channelId = (channelArg && typeof channelArg === "object" && channelArg.id) ||
        (typeof channelArg === "string" && channelArg) || ctx.channelId || ctx.channel_id;
      const channel = channelArg && typeof channelArg === "object" ? channelArg : getChannel(channelId);
      const guild = ctx.guild || (ctx.guildId && GuildStore.getGuild(ctx.guildId));
      if (channel && channel.id) {
        const dm = isDM(channel);
        const plan = [item("channels", channel.id, channelLabel(channel.id, channel.guild_id), dm ? "DM" : "channel")];
        return plan;
      }
      if (guild && guild.id) return [item("guilds", guild.id, guild.name || guild.id, "server")];
    } catch (_) {}
    return null;
  }

  function menuText(value, depth) {
    if (depth > 6 || value == null) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((v) => menuText(v, depth + 1)).join(" ");
    if (typeof value !== "object") return "";
    const p = value.props || value;
    for (const key of ["label", "message", "text", "title", "defaultMessage", "children", "content"]) {
      if (p[key] != null) {
        const text = menuText(p[key], depth + 1);
        if (text) return text;
      }
    }
    return "";
  }

  function componentName(type) {
    if (!type) return "";
    return type.displayName || type.name || (type.type && (type.type.displayName || type.type.name)) ||
      (type.render && (type.render.displayName || type.render.name)) || "";
  }

  function isMenuRow(node) {
    const type = componentName(node && node.type);
    const props = node && node.props;
    return !!(props && /^(ActionSheetRow|ContextMenuItem)$/.test(type) &&
      typeof props.label === "string" && typeof props.onPress === "function");
  }

  function addButtons(tree, plan, requireCloseDM) {
    if (!tree || !plan || !plan.length) return null;
    const markers = new Set(plan.map((item) => item.key));
    let alreadyAdded = false;
    const inspect = (node, depth, seen) => {
      if (!node || typeof node !== "object" || depth > 40 || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const child of node) {
          const key = child && (child.key || (child.props && child.props.key));
          if (typeof key === "string" && Array.from(markers).some((marker) => key.indexOf(marker) === 0)) alreadyAdded = true;
          inspect(child, depth + 1, seen);
        }
      } else if (node.props) {
        inspect(node.props.items, depth + 1, seen);
        inspect(node.props.children, depth + 1, seen);
      }
    };
    inspect(tree, 0, new Set());
    if (alreadyAdded) return tree;

    const makeRows = (template) => plan.map((item) => {
      const press = () => {
        try {
          try { ActionSheet && ActionSheet.hideActionSheet && ActionSheet.hideActionSheet(); } catch (_) {}
          item.press();
        } catch (_) { toast("Could not apply this logger action"); }
      };
      const props = { key: item.key, label: item.label, onPress: press };
      if (/^ActionSheetRow$/.test(componentName(template.type))) {
        return React.cloneElement(template, props, rowGlyph(item));
      } else {
        props.iconSource = null;
        props.IconComponent = item.icon === "user" ? LoggerPersonGlyph : LoggerDmGlyph;
      }
      return React.cloneElement(template, props);
    });

    let inserted = false;
    const rewrite = (node, depth, seen) => {
      if (!node || typeof node !== "object" || depth > 40 || seen.has(node)) return node;
      seen.add(node);
      if (Array.isArray(node)) {
        const directRows = node.filter(isMenuRow);
        const closeIndex = directRows.length
          ? node.findIndex((row) => isMenuRow(row) && /^close (dm|group)/i.test(row.props.label))
          : -1;
        if (directRows.length && (!requireCloseDM || closeIndex >= 0)) {
          const position = closeIndex >= 0 ? closeIndex + 1 : node.length;
          const next = node.slice();
          next.splice(position, 0, ...makeRows(directRows[0]));
          inserted = true;
          return next;
        }
        let changed = false;
        const next = node.map((child) => {
          const result = rewrite(child, depth + 1, seen);
          if (result !== child) changed = true;
          return result;
        });
        return changed ? next : node;
      }
      if (!node.props) return node;
      const props = node.props;
      const nextProps = {};
      let changed = false;
      for (const key of Object.keys(props)) {
        const value = (key === "children" || key === "items") ? rewrite(props[key], depth + 1, seen) : props[key];
        nextProps[key] = value;
        if (value !== props[key]) changed = true;
      }
      return changed ? React.cloneElement(node, nextProps) : node;
    };
    const result = rewrite(tree, 0, new Set());
    return inserted ? result : null;
  }

  function pickIcon(kind) {
    try {
      const names = Object.keys(ui.assets.all || {});
      const tests = kind === "trash"
        ? [/^(ic_)?trash.*(filled|variant|circle|check|x|sweep)/i, /delete.*(forever|sweep|outline|history)/i, /^(ic_)?(clear_all|eraser|broom|sweep)/i, /trash|delete/i]
        : kind === "history"
          ? [/history/i, /clock/i, /^(ic_)?(time|recent)/i]
          : [/eye.*(off|slash|closed)/i, /(hide|invisible)/i, /^(ic_)?eye/i];
      for (const t of tests) {
        const hit = names.find((n) => t.test(n) && n !== "ic_trash_24px" && n !== "trash");
        if (hit) return ui.assets.getAssetIDByName(hit);
      }
    } catch (_) {}
    return null;
  }

  function withIcon(tpl, id) {
    const p = tpl && (tpl.props || tpl);
    const cur = p && (p.icon !== undefined ? p.icon : p.iconSource);
    if (!id || cur === undefined) return undefined;
    if (typeof cur === "number") return id;
    if (cur && typeof cur === "object" && cur.props && cur.props.source !== undefined) {
      return React.cloneElement(cur, { source: id });
    }
    return undefined;
  }

  function LoggerPersonGlyph(props) {
    const color = props && props.color || "#B5BAC1";
    return React.createElement(RN.View, {
      style: [props && props.style, { width: 20, height: 20, alignItems: "center", justifyContent: "center" }],
    },
    React.createElement(RN.View, { style: { width: 7, height: 7, borderRadius: 4, backgroundColor: color, marginBottom: 2 } }),
    React.createElement(RN.View, { style: { width: 14, height: 8, borderTopLeftRadius: 7, borderTopRightRadius: 7, backgroundColor: color } }));
  }

  function LoggerDmGlyph(props) {
    const color = props && props.color || "#B5BAC1";
    return React.createElement(RN.View, {
      style: [props && props.style, { width: 20, height: 20, alignItems: "center", justifyContent: "center" }],
    },
    React.createElement(RN.View, { style: { width: 16, height: 12, borderRadius: 4, backgroundColor: color } }),
    React.createElement(RN.View, { style: { position: "absolute", left: 4, bottom: 2, width: 0, height: 0, borderTopWidth: 5, borderTopColor: color, borderRightWidth: 5, borderRightColor: "transparent" } }));
  }

  function rowGlyph(item) {
    const IconComponent = item.icon === "user" ? LoggerPersonGlyph : LoggerDmGlyph;
    if (ActionSheetRowIconComponent === undefined) {
      try {
        const mod = findByName("ActionSheetRowIcon", false);
        ActionSheetRowIconComponent = mod && (mod.default || mod) || null;
      } catch (_) { ActionSheetRowIconComponent = null; }
    }
    return ActionSheetRowIconComponent
      ? React.createElement(ActionSheetRowIconComponent, { IconComponent })
      : React.createElement(IconComponent, null);
  }

  function hookSheet(args) {
    try {
      pendingSheetPlan = null;
      activeSheetPlan = null;
      activeSheetInserted = false;
      const [component, key, ctx] = args;
      if (!component || typeof component.then !== "function") return;
      const plan = key === "MessageLongPressActionSheet" ? messagePlan(ctx && ctx.message) : scopePlan(key, ctx);
      if (!plan || !plan.length) return;
      pendingSheetPlan = plan;
      activeSheetPlan = plan;
      setTimeout(() => {
        if (pendingSheetPlan === plan) {
          pendingSheetPlan = null;
          activeSheetPlan = null;
          activeSheetInserted = false;
        }
      }, 15000);
      component.then((instance) => {
        wrapSheetComponent(instance);
        const un = patcher.after("default", instance, (_, tree) => {
          React.useEffect(() => () => { un(); }, []);
          try {
            const updatedTree = addButtons(tree, plan, plan.some((item) => /this DM/i.test(item.label)));
            if (updatedTree) return updatedTree;
          } catch (_) {}
        });
      });
    } catch (_) {}
  }

  function wrapSheetComponent(module) {
    try {
      if (!module || typeof module !== "object" || wrappedSheetModules.has(module)) return;
      const key = Object.keys(module).find((name) => /ChannelLongPressActionSheetConnected/.test(componentName(module[name]))) || "default";
      const exported = module[key];
      let holder = module;
      let field = key;
      let original = exported;
      if (typeof exported !== "function") {
        if (exported && typeof exported.type === "function") { holder = exported; field = "type"; original = exported.type; }
        else if (exported && typeof exported.render === "function") { holder = exported; field = "render"; original = exported.render; }
        else return;
      }
      const wrapped = function (...args) {
        const previous = activeSheetPlan;
        const previousInserted = activeSheetInserted;
        activeSheetPlan = pendingSheetPlan || previous;
        activeSheetInserted = false;
        try { return original.apply(this, args); }
        finally { activeSheetPlan = previous; activeSheetInserted = previousInserted; }
      };
      wrapped.displayName = componentName(exported) || "ChannelLongPressActionSheetConnected";
      try { Object.assign(wrapped, original); } catch (_) {}
      holder[field] = wrapped;
      wrappedSheetModules.add(module);
      unpatches.push(() => { if (holder[field] === wrapped) holder[field] = original; });
    } catch (_) {}
  }

  function addProfileIgnore(tree, user) {
    if (!tree || !user || !user.id) return false;
    const marker = "bml-profile-ignore-" + user.id;
    const label = (ignored().users[user.id] ? "Stop ignoring " : "Ignore ") + nameOf(user) + " in logger";
    const handler = () => {
      try { flipIgnore("users", user.id, nameOf(user)); }
      catch (_) { toast("Could not update the logger ignore list"); }
    };
    let added = false;
    const seen = new Set();
    const visit = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 40 || seen.has(node) || added) return;
      seen.add(node);
      if (node.props) {
        const type = componentName(node.type);
        const props = node.props;
        if (/ContextMenu/i.test(String(type || "")) && props.items && typeof props.items === "object") {
          const cloneMenuItem = (sample, index) => {
            if (!sample || typeof sample !== "object") return null;
            const source = sample.props || sample;
            const callback = ["onPress", "onSelect", "action", "onClick", "callback"].find((k) => typeof source[k] === "function");
            if (!callback) return null;
            const next = { key: marker, id: marker, label, [callback]: handler, iconSource: null, IconComponent: null };
            if (source.index !== undefined) next.index = index;
            if (source.lastInSection !== undefined) next.lastInSection = true;
            return sample.props ? React.cloneElement(sample, next) : { ...sample, ...next };
          };
          const insertInRows = (rows) => {
            if (!Array.isArray(rows)) return null;
            if (rows.some((e) => e && (e.key === marker || e.id === marker || (e.props && e.props.key === marker)))) return rows;
            const labels = rows.map((e) => menuText(e && (e.props || e), 0).trim());
            const ignoreIndex = labels.findIndex((s) => /^ignore$/i.test(s));
            const blockIndex = labels.findIndex((s) => /^block$/i.test(s));
            const pivot = ignoreIndex >= 0 ? ignoreIndex : blockIndex;
            const templateIndex = pivot >= 0 ? pivot : rows.findIndex((e) => cloneMenuItem(e, rows.length));
            if (templateIndex < 0) return null;
            const item = cloneMenuItem(rows[templateIndex], rows.length);
            if (!item) return null;
            const position = ignoreIndex >= 0 ? ignoreIndex + 1 : blockIndex >= 0 ? blockIndex : rows.length;
            const nextRows = rows.slice();
            nextRows.splice(position, 0, item);
            return nextRows;
          };
          const patchItems = (items, depth, seen) => {
            if (!items || typeof items !== "object" || depth > 12 || seen.has(items)) return null;
            seen.add(items);
            if (Array.isArray(items)) {
              const inserted = insertInRows(items);
              if (inserted) return inserted;
              for (let i = 0; i < items.length; i++) {
                const child = patchItems(items[i], depth + 1, seen);
                if (child) { const next = items.slice(); next[i] = child; return next; }
              }
              return null;
            }
            if (items.props) return null;
            const entries = Object.entries(items);
            const labels = entries.map(([, e]) => menuText(e && (e.props || e), 0).trim());
            const ignoreIndex = labels.findIndex((s) => /^ignore$/i.test(s));
            const blockIndex = labels.findIndex((s) => /^block$/i.test(s));
            if (ignoreIndex >= 0 || blockIndex >= 0) {
              const pivot = ignoreIndex >= 0 ? ignoreIndex : blockIndex;
              const item = cloneMenuItem(entries[pivot][1], entries.length);
              if (item) {
                const position = ignoreIndex >= 0 ? ignoreIndex + 1 : blockIndex;
                const next = {};
                entries.forEach(([key, value], index) => {
                  if (index === position) next[marker] = item;
                  next[key] = value;
                });
                if (position >= entries.length) next[marker] = item;
                return next;
              }
            }
            for (const [key, value] of entries) {
              const child = patchItems(value, depth + 1, seen);
              if (child) return { ...items, [key]: child };
            }
            return null;
          };
          const nextItems = patchItems(props.items, 0, new Set());
          if (nextItems) { props.items = nextItems; added = true; return; }
        }
        if (/ContextMenu/i.test(String(type || "")) && props.children != null) {
          const hadArrayChildren = Array.isArray(props.children);
          const rows = hadArrayChildren ? props.children : [props.children];
          const template = rows.find((row) => isMenuRow(row) && /ContextMenuItem/.test(componentName(row.type)));
          if (template) {
            const childProps = {
              key: marker,
              label,
              onPress: handler,
              index: rows.length,
              lastInSection: true,
              iconSource: null,
              IconComponent: null,
            };
            const ignoreIndex = rows.findIndex((row) => isMenuRow(row) && /^ignore$/i.test(row.props.label));
            const blockIndex = rows.findIndex((row) => isMenuRow(row) && /^block$/i.test(row.props.label));
            const position = ignoreIndex >= 0 ? ignoreIndex + 1 : blockIndex >= 0 ? blockIndex : rows.length;
            const nextChildren = rows.slice();
            nextChildren.splice(position, 0, React.cloneElement(template, childProps));
            props.children = hadArrayChildren ? nextChildren : React.createElement(React.Fragment, null, ...nextChildren);
            added = true;
            return;
          }
        }
        visit(props.items, depth + 1);
        visit(props.children, depth + 1);
      }
      if (Array.isArray(node)) for (const child of node) visit(child, depth + 1);
    };
    try { visit(tree, 0); } catch (_) {}
    return added;
  }

  function hookProfileOverflow() {
    try {
      const module = findByName("UserProfileOverflowMenu", false);
      if (!module || !module.default) return;
      const exported = module.default;
      let original = null;
      let replace = null;
      let restore = null;
      if (typeof exported === "function") {
        original = exported;
        replace = (fn) => { module.default = fn; };
        restore = () => { if (module.default === wrapped) module.default = exported; };
      } else if (exported && typeof exported.type === "function") {
        original = exported.type;
        replace = (fn) => { exported.type = fn; };
        restore = () => { if (exported.type === wrapped) exported.type = original; };
      } else if (exported && typeof exported.render === "function") {
        original = exported.render;
        replace = (fn) => { exported.render = fn; };
        restore = () => { if (exported.render === wrapped) exported.render = original; };
      }
      if (!original) return;
      const wrapped = function (...args) {
        const props = args[0] || {};
        const previous = profileRenderUser;
        profileRenderUser = props.user || props.profileUser || (props.userId && UserStore.getUser(props.userId)) || null;
        try { return original.apply(this, args); }
        finally { profileRenderUser = previous; }
      };
      wrapped.displayName = "UserProfileOverflowMenu";
      try { Object.assign(wrapped, original); } catch (_) {}
      replace(wrapped);
      unpatches.push(restore);
    } catch (_) {}
  }

  function hookProfileContextMenu(args) {
    try {
      const type = args[0];
      const name = componentName(type);
      if (activeSheetPlan && /ActionSheetRowGroup/.test(name)) {
        if (activeSheetInserted) return;
        const currentProps = args[1] || {};
        const updated = addButtons(currentProps.children, activeSheetPlan, activeSheetPlan.some((item) => /this DM/i.test(item.label)));
        if (updated && updated !== currentProps.children) {
          args[1] = { ...currentProps, children: updated };
          activeSheetInserted = true;
        }
        return;
      }
      if (name === "UserProfileOverflowMenu") {
        if (profileWrappedTypes.has(type)) return;
        if ((typeof type === "function" || (type && typeof type === "object")) && !profileTypeWrappers.has(type)) {
          let original = type;
          let field = null;
          if (typeof type !== "function") {
            if (typeof type.type === "function") { original = type.type; field = "type"; }
            else if (typeof type.render === "function") { original = type.render; field = "render"; }
            else return;
          }
          const wrapped = function (...componentArgs) {
            const props = componentArgs[0] || {};
            const previous = profileRenderUser;
            profileRenderUser = props.user || props.profileUser || (props.userId && UserStore.getUser(props.userId)) || null;
            try { return original.apply(this, componentArgs); }
            finally { profileRenderUser = previous; }
          };
          wrapped.displayName = "UserProfileOverflowMenu";
          let wrappedType = wrapped;
          if (field) {
            wrappedType = { ...type, [field]: wrapped };
            profileTypeWrappers.set(type, wrappedType);
          } else profileTypeWrappers.set(type, wrapped);
          profileWrappedTypes.add(wrappedType);
          args[0] = wrappedType;
        } else if (profileTypeWrappers.has(type)) args[0] = profileTypeWrappers.get(type);
        return;
      }
      if (!profileRenderUser || name !== "ContextMenu") return;
      const originalProps = args[1];
      if (!originalProps) return;
      // Replace the JSX props object too; Discord may freeze the original.
      const props = { ...originalProps };
      const added = addProfileIgnore({ type: args[0], props }, profileRenderUser);
      if (added) args[1] = props;
    } catch (_) {}
  }

  function hookReactCreateElement(args) {
    try {
      if (activeSheetPlan && /ActionSheetRowGroup/.test(componentName(args[0])) && args.length > 2) {
        const props = { ...(args[1] || {}) };
        if (props.children === undefined) {
          props.children = args.length === 3 ? args[2] : args.slice(2);
          args[1] = props;
          args.splice(2);
        }
      }
    } catch (_) {}
    hookProfileContextMenu(args);
  }

  function hookProfileMenuFactories() {
    try {
      const jsxRuntime = findByProps("jsx", "jsxs");
      if (jsxRuntime) {
        unpatches.push(patcher.before("jsx", jsxRuntime, hookProfileContextMenu));
        unpatches.push(patcher.before("jsxs", jsxRuntime, hookProfileContextMenu));
      }
    } catch (_) {}
    try { unpatches.push(patcher.before("createElement", React, hookReactCreateElement)); } catch (_) {}
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
    const info = deleted.get(m.id);
    const en = cfg().logEdited ? edits.get(m.id) : null;
    const versions = en && en.v && en.v.length ? en.v : null;
    if (!info && !versions) {
      if (m.__glOut && m.content === m.__glOut) m.content = m.__glBase;
      return;
    }

    const pc = RN && RN.processColor;
    const red = pc ? pc(RED) : null;
    const grey = pc ? pc(GREY) : null;

    if (info && cfg().redName && red) { m.colorString = red; m.usernameColor = red; }
    if (info && pc) row.backgroundHighlight = { backgroundColor: pc(RED + "26"), gutterColor: red };

    const base = (m.__glOut && m.content === m.__glOut) ? m.__glBase : m.content;
    if (Array.isArray(base)) {
      let out = info ? paint(base, red) : base;
      if (versions) {
        let head = [];
        const start = Math.max(0, versions.length - MAX_SHOWN);
        for (let i = start; i < versions.length; i++) {
          let text = versions[i].t;
          if (cfg().showEditTime && i > 0) text += "  · edited " + fmtTime(versions[i - 1].at);
          head = head.concat(paint([{ type: "text", content: text + "\n" }], grey));
        }
        out = head.concat(out);
      }
      const labels = [];
      if (info && cfg().showDeletedTime) labels.push("deleted " + fmtTime(info.at));
      if (versions && cfg().showEditTime) labels.push("edited " + fmtTime(versions[versions.length - 1].at));
      if (labels.length) out = out.concat(paint([{ type: "text", content: "  " + labels.join(" · ") }], grey));
      m.__glBase = base;
      m.__glOut = out;
      m.content = out;
    }

    if (!info && versions && pc && !row.backgroundHighlight) {
      row.backgroundHighlight = { backgroundColor: pc(GREY + "14"), gutterColor: pc(GREY + "80") };
    }
  }

  function onRenderError() {
    renderErrors++;
    if (renderErrors >= 3 && renderUnpatch) {
      try { renderUnpatch(); } catch (_) {}
      renderUnpatch = null;
      toast("Advanced Message Logger: message styling disabled after repeated errors");
    }
  }

  function patchRender() {
    let RM = findByName("RowManager");
    if (!RM || !RM.prototype) {
      try { RM = findByName("RowManager", false)?.default; } catch (_) {}
    }
    if (!RM || !RM.prototype || typeof RM.prototype.generate !== "function") {
      toast("Advanced Message Logger: could not find the message renderer");
      return null;
    }
    return patcher.after("generate", RM.prototype, (args, ret) => {
      try { decorate(ret, args[0]); } catch (_) { onRenderError(); }
    });
  }

  function palette() {
    let light = false;
    try {
      ThemeStore = ThemeStore || findByStoreName("ThemeStore");
      light = !!ThemeStore && ThemeStore.theme === "light";
    } catch (_) {}
    return light ? { text: "#060607", sub: "#5C5E66" } : { text: "#FFFFFF", sub: "#B5BAC1" };
  }

  function Settings() {
    vstorage.useProxy(plugin.storage);
    const [screen, setScreen] = React.useState("main");
    const [limit, setLimit] = React.useState(PAGE);
    const [, bump] = React.useState(0);
    let settingsNavigation = null;
    try {
      const navigationModule = findByProps("useNavigation");
      const useNavigation = navigationModule && navigationModule.useNavigation;
      if (typeof useNavigation === "function") settingsNavigation = useNavigation();
    } catch (_) {}
    const refreshUI = () => bump((x) => x + 1);
    const F = ui.components && ui.components.Forms;
    const C = palette();
    const h = React.createElement;

    const go = (name) => { setLimit(PAGE); setScreen(name); };

    const confirmStopIgnoring = (kind, id, entryName) => {
      // Capture the identity from this exact row. The native alert keeps the
      // list stationary until the user confirms, then returns to the list.
      const exactKind = String(kind);
      const exactId = String(id);
      const exactName = String(entryName || id);
      const category = exactKind === "guilds" ? "server" : exactKind === "channels" ? "channel or DM" : "user";
      ask("Stop ignoring?", "Remove “" + exactName + "” from the ignored " + category + " list?", [
        { text: "Stop ignoring", style: "destructive", onPress: () => {
          if (setIgnore(exactKind, exactId, exactName, false)) refreshUI();
        } },
      ]);
    };

    const Text = (props, ...kids) => h(RN.Text, props, ...kids);
    const Section = (title) =>
      h(RN.View, { key: "sec-" + title, style: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 4 } },
        Text({ style: { color: C.sub, fontSize: 12, fontWeight: "600" } }, title.toUpperCase()));

    const PressRow = (key, label, sub, onPress, right) =>
      h(RN.Pressable, { key, onPress, style: { paddingHorizontal: 16, paddingVertical: 12, flexDirection: "row", alignItems: "center" } },
        h(RN.View, { style: { flex: 1 } },
          Text({ style: { color: C.text, fontSize: 16 } }, label),
          sub ? Text({ style: { color: C.sub, fontSize: 13, marginTop: 2 } }, sub) : null),
        right ? Text({ style: { color: C.sub, fontSize: 15 } }, right) : null);

    const Switch = (key, label, sub, onChange) => {
      const value = !!cfg()[key];
      const change = onChange || ((v) => { cfg()[key] = v; refreshUI(); });
      return F && F.FormSwitchRow
        ? h(F.FormSwitchRow, { key, label, subLabel: sub, value, onValueChange: change })
        : h(RN.View, { key, style: { flexDirection: "row", alignItems: "center", padding: 16 } },
            h(RN.View, { style: { flex: 1 } },
              Text({ style: { color: C.text, fontSize: 16 } }, label),
              Text({ style: { color: C.sub, fontSize: 13 } }, sub)),
            h(RN.Switch, { value, onValueChange: change }));
    };

    const Btn = (key, title, onPress, color) =>
      h(RN.View, { key, style: { paddingHorizontal: 16, paddingVertical: 6 } }, h(RN.Button, { title, onPress, color }));

    const back = () => Btn("back", "< Back", () => { setScreen("main"); refreshUI(); });

    const more = (total) => total > limit ? Btn("more", "Show more", () => setLimit(limit + PAGE)) : null;

    const retentionLabel = () => (cfg().retentionDays === 7 ? "7 days" : cfg().retentionDays === 30 ? "30 days" : "Forever");
    const cycleRetention = () => {
      const cur = cfg().retentionDays || 0;
      cfg().retentionDays = cur === 0 ? 7 : cur === 7 ? 30 : 0;
      if (purge()) markDirty();
      refreshUI();
    };

    const snippet = (t) => clip(t, 200) || "(no text)";

    const loggedScreen = (kind) => {
      const isDel = kind === "deleted";
      const entries = isDel
        ? [...deleted.entries()].map(([id, i]) => ({ id, c: i.c, g: i.g, an: i.an, t: i.t, at: i.at })).sort((a, b) => b.at - a.at)
        : [...edits.entries()].map(([id, e]) => ({ id, c: e.c, g: e.g, an: e.an, t: e.cur || (e.v[e.v.length - 1] && e.v[e.v.length - 1].t) || "", at: (e.v[e.v.length - 1] || { at: 0 }).at })).sort((a, b) => b.at - a.at);
      const rows = [back(), h(RN.View, { key: "title", style: { paddingHorizontal: 16, paddingVertical: 8 } },
        Text({ style: { color: C.text, fontSize: 20, fontWeight: "700" } }, (isDel ? "Deleted messages" : "Edited messages") + " (" + entries.length + ")"))];
      if (!entries.length) rows.push(Text({ key: "empty", style: { color: C.sub, padding: 16 } }, "Nothing logged yet."));
      for (const en of entries.slice(0, limit)) {
        rows.push(PressRow(en.id, snippet(en.t), en.an + " · " + (en.c ? channelLabel(en.c, en.g) : "Unknown channel") + " · " + fmtTime(en.at), () => {
          const buttons = [];
          if (en.c) buttons.push({ text: "Jump to message", onPress: () => jumpTo(en.c, en.g, en.id, settingsNavigation) });
          if (!isDel) {
            buttons.push({ text: "Edit history", onPress: () => showEdits({ id: en.id, content: en.t }) });
          }
          buttons.push({ text: "Remove from log", style: "destructive", onPress: () => { removeLog({ id: en.id, channel_id: en.c }); refreshUI(); } });
          ask(en.an + " · " + fmtTime(en.at), clip(en.t, 600), buttons);
        }));
      }
      const m = more(entries.length);
      if (m) rows.push(m);
      return rows;
    };

    const ignoredScreen = () => {
      const ig = ignored();
      const groups = [["guilds", "Servers"], ["channels", "Channels and DMs"], ["users", "Users"]];
      const total = groups.reduce((n, g) => n + Object.keys(ig[g[0]]).length, 0);
      const rows = [back(), h(RN.View, { key: "title", style: { paddingHorizontal: 16, paddingVertical: 8 } },
        Text({ style: { color: C.text, fontSize: 20, fontWeight: "700" } }, "Ignored (" + total + ")"))];
        if (!total) rows.push(Text({ key: "empty", style: { color: C.sub, padding: 16 } }, "Nothing is ignored. Long-press a DM, open a profile's three-dot menu, or long-press a server or channel."));
      groups.forEach(function (group) {
        const kind = group[0];
        const title = group[1];
        const ids = Object.keys(ig[kind]);
        if (!ids.length) return;
        rows.push(Section(title));
        ids.forEach(function (id) {
          const entryName = ig[kind][id];
          const rowKind = String(kind);
          const rowId = String(id);
          const rowName = String(entryName || id);
          rows.push(PressRow("ignored-" + rowKind + "-" + rowId, entryName, "Tap to remove · " + title, function () {
            confirmStopIgnoring(rowKind, rowId, rowName);
          }, "›"));
        });
      });
      return rows;
    };

    let content;
    if (screen === "deleted" || screen === "edited") content = loggedScreen(screen);
    else if (screen === "ignored") content = ignoredScreen();
    else {
      const ig = ignored();
      const ignoredCount = Object.keys(ig.guilds).length + Object.keys(ig.channels).length + Object.keys(ig.users).length;
      content = [
        Section("Logging"),
        Switch("logDeleted", "Keep deleted messages", "Deleted messages stay visible in red"),
        Switch("redName", "Red usernames", "Also color the sender's name red on deleted messages"),
        Switch("logEdited", "Keep edited messages", "Previous versions appear in gray above the new text"),
        Switch("persist", "Save across restarts", "Store logged messages on this device", (v) => { setPersist(v); refreshUI(); }),
        Section("Display"),
        Switch("showDeletedTime", "Show deletion time", "Adds \"deleted 00:45\" after deleted messages"),
        Switch("showEditTime", "Show edit time", "Adds \"edited 00:45\" after edited messages"),
        Section("Filters"),
        Switch("skipOwn", "Ignore my messages", "Your own deletes and edits behave normally"),
        Switch("skipBots", "Ignore bots", "Less noise in busy bot channels"),
        Section("Storage"),
        PressRow("retention", "Keep saved messages for", "Older logs are removed automatically", cycleRetention, retentionLabel()),
        Section("Logs"),
        PressRow("nav-deleted", "Deleted messages", deleted.size + " logged", () => go("deleted"), ">"),
        PressRow("nav-edited", "Edited messages", edits.size + " logged", () => go("edited"), ">"),
        PressRow("nav-ignored", "Ignored servers, channels and users", ignoredCount + " ignored", () => go("ignored"), ">"),
        Btn("clear", "Clear all logged messages", () => {
          ask("Clear all logged messages?", "This removes every stored deleted and edited message, including the ones saved on this device.", [
            { text: "Clear", style: "destructive", onPress: () => { clearAll(); refreshUI(); } },
          ]);
        }, RED),
      ];
    }

    content.unshift(h(RN.View, { key: "build", style: { paddingHorizontal: 16, paddingTop: 8 } },
      Text({ style: { color: C.sub, fontSize: 11 } }, "Build " + BUILD)));
    return h(RN.ScrollView, null, ...content);
  }

  function onLoad() {
    const s = cfg();
    const defaults = {
      logDeleted: true, logEdited: true, persist: false, redName: true, skipOwn: true, skipBots: false,
      showDeletedTime: false, showEditTime: false, retentionDays: 0,
    };
    for (const k of Object.keys(defaults)) if (s[k] === undefined) s[k] = defaults[k];
    if (s.ignoreOwnDefaultMigration !== 1) {
      s.skipOwn = true;
      s.ignoreOwnDefaultMigration = 1;
    }
    if (!s.ignored) s.ignored = { channels: {}, guilds: {}, users: {} };
    renderErrors = 0;

    if (!loadStores()) { toast("Advanced Message Logger: required Discord modules not found"); return; }
    if (s.pings) s.pings = undefined;
    if (s.persist) loadSaved();
    if (purge()) markDirty();

    try { unpatches.push(patcher.before("dispatch", FluxDispatcher, hookDispatch)); }
    catch (_) { return; }
    try { renderUnpatch = patchRender(); } catch (_) {}
    try {
      ActionSheet = findByProps("openLazy", "hideActionSheet");
      if (ActionSheet) {
        unpatches.push(patcher.before("openLazy", ActionSheet, hookSheet));
        unpatches.push(patcher.before("hideActionSheet", ActionSheet, () => {
          pendingSheetPlan = null;
          activeSheetPlan = null;
          activeSheetInserted = false;
        }));
      }
    } catch (_) {}
    hookProfileOverflow();
    hookProfileMenuFactories();
    try {
      appStateSub = RN.AppState.addEventListener("change", (state) => {
        if (state === "active") { if (purge()) markDirty(); }
        else flush();
      });
    } catch (_) {}
  }

  function onUnload() {
    flush();
    for (const u of unpatches.splice(0)) { try { u(); } catch (_) {} }
    if (renderUnpatch) { try { renderUnpatch(); } catch (_) {} renderUnpatch = null; }
    if (appStateSub && appStateSub.remove) { try { appStateSub.remove(); } catch (_) {} }
    appStateSub = null;
    deleted.clear();
    edits.clear();
    rawSaved.clear();
    rawBuffer.clear();
    allowDelete.clear();
  }

  return { onLoad, onUnload, settings: Settings };
})()
