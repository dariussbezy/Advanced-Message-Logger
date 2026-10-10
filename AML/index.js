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
  const DEFAULT_RAW_BUFFER = 1000;
  const MIN_RAW_BUFFER = 100;
  const MAX_RAW_BUFFER = 20000;
  const MAX_RAW_SIZE = 20000;
  const BUILD = "v3.1.0";
  const SAVE_DELAY = 4000;
  const PAGE = 40;
  const DAY = 86400000;
  const DISCORD_EPOCH = 1420070400000;
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
  const dmAlertQueue = [];
  let dmAlertShowing = false;
  const wrappedSheetModules = new WeakSet();
  const profileTypeWrappers = new WeakMap();
  const profileWrappedTypes = new WeakSet();

  const cfg = () => plugin.storage;
  const GPL_BRIDGE_KEY = "__advanced_message_logger_gpl_bridge_v1__";
  const GPL_ALERT_BRIDGE_KEY = "__ghost_ping_logger_aml_bridge_v1__";
  let gplBridge = null;
  const toast = (t) => { try { ui.toasts.showToast(t); } catch (_) {} };
  const trimMap = (m, max) => { while (m.size > max) m.delete(m.keys().next().value); };
  const cmp = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
  const snowTime = (id) => Math.floor(Number(id) / 4194304) + DISCORD_EPOCH;
  const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
  function colorValue(key, fallback) {
    const value = String(cfg()[key] || "");
    return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : fallback;
  }
  const withAlpha = (color, alpha) => color + alpha;

  function fmtTime(ms) {
    const d = new Date(ms);
    const p = (n) => (n < 10 ? "0" : "") + n;
    const use12HourClock = !!cfg().use12HourClock;
    const hour = use12HourClock ? ((d.getHours() % 12) || 12) : d.getHours();
    const t = p(hour) + ":" + p(d.getMinutes()) + (use12HourClock ? (d.getHours() < 12 ? " AM" : " PM") : "");
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
  function getKnownMessage(channelId, id) {
    const inStore = getMessage(channelId, id);
    if (inStore) return inStore;
    if (cfg().captureMode !== "expanded") return null;
    const cached = rawBuffer.get(id);
    return cached && (!cached.channel_id || String(cached.channel_id) === String(channelId)) ? cached : null;
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

  function directDMForUser(userId) {
    try {
      loadStores();
      const id = String(userId);
      const resolve = (value) => {
        if (!value) return null;
        const channel = typeof value === "string" || typeof value === "number" ? getChannel(String(value)) : value;
        if (!channel || String(channel.type) !== "1" || !channel.id) return null;
        const recipients = Array.isArray(channel.recipients) ? channel.recipients : [];
        if (recipients.length && !recipients.some((r) => String(r && typeof r === "object" ? r.id : r) === id)) return null;
        return channel;
      };

      // ChannelStore's DM lookup is the authoritative mapping; validate its result
      // so group DMs and unrelated private channels are never added.
      if (ChannelStore && typeof ChannelStore.getDMFromUserId === "function") {
        const channel = resolve(ChannelStore.getDMFromUserId(id));
        if (channel) return channel;
      }

      // On builds that lack the lookup method, use the currently selected channel
      // only when it is a one-to-one DM with this exact recipient.
      const selected = getChannel(currentChannelId());
      if (selected && String(selected.type) === "1") {
        const recipients = Array.isArray(selected.recipients) ? selected.recipients : [];
        if (recipients.some((r) => String(r && typeof r === "object" ? r.id : r) === id)) return selected;
      }
    } catch (_) {}
    return null;
  }

  function setUserIgnoreWithDM(userId, name, shouldIgnore) {
    try {
      const id = String(userId);
      const storage = cfg();
      const current = storage.ignored && typeof storage.ignored === "object" ? storage.ignored : {};
      const ig = JSON.parse(JSON.stringify({
        channels: current.channels || {},
        guilds: current.guilds || {},
        users: current.users || {},
      }));
      const links = JSON.parse(JSON.stringify(storage.autoIgnoredDMsByUser || {}));
      let dmAdded = false;

      if (shouldIgnore) {
        ig.users[id] = name || id;
        const dm = directDMForUser(id);
        if (dm && dm.id) {
          const dmId = String(dm.id);
          if (!ig.channels[dmId]) {
            ig.channels[dmId] = "DM · " + (name || dmName(dm));
            links[id] = dmId;
            dmAdded = true;
          }
        }
      } else {
        delete ig.users[id];
        const linkedDMId = links[id];
        // Remove only entries this user-ignore action created. An independently
        // ignored DM remains ignored when the user is unignored.
        if (linkedDMId && Object.keys(links).every((otherId) => otherId === id || String(links[otherId]) !== String(linkedDMId))) {
          delete ig.channels[String(linkedDMId)];
        }
        delete links[id];
      }

      storage.ignored = ig;
      storage.autoIgnoredDMsByUser = links;
      if (!!(storage.ignored && storage.ignored.users && storage.ignored.users[id]) !== !!shouldIgnore) {
        throw new Error("User ignore update did not persist");
      }
      toast(shouldIgnore
        ? "Logger now ignores " + (name || id) + (dmAdded ? " and their DM" : "")
        : "Logger no longer ignores " + (name || id));
      return true;
    } catch (_) {
      toast("Could not update the logger ignore list");
      return false;
    }
  }

  function setIgnore(kind, id, name, shouldIgnore) {
    try {
      if (!["channels", "guilds", "users"].includes(kind) || id == null) return false;
      id = String(id);
      if (kind === "users") return setUserIgnoreWithDM(id, name, shouldIgnore);
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
    if (cfg().captureMode !== "expanded" || !raw || !raw.id) return;
    rawBuffer.delete(raw.id);
    rawBuffer.set(raw.id, raw);
    trimMap(rawBuffer, rawBufferLimit());
  }

  const looksLikeMessage = (m) => !!m && typeof m === "object" && typeof m.id === "string" &&
    typeof m.content === "string" && !!m.author && typeof m.author === "object";

  // Collects every full message object from an event payload (single message, lists, nested
  // lists such as search results, or pin entries) into the all-channels cache.
  function harvest(value, depth) {
    if (!value || typeof value !== "object" || depth > 3) return;
    if (Array.isArray(value)) { for (const v of value) harvest(v, depth + 1); return; }
    if (looksLikeMessage(value)) { remember(value); return; }
    harvest(value.message, depth + 1);
    harvest(value.messages, depth + 1);
    harvest(value.pins, depth + 1);
  }

  function rawBufferLimit() {
    const value = Number(cfg().maxCachedMessages);
    if (!Number.isFinite(value)) return DEFAULT_RAW_BUFFER;
    return Math.max(MIN_RAW_BUFFER, Math.min(MAX_RAW_BUFFER, Math.round(value)));
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

  function refreshStyledMessages() {
    const ids = new Set([...deleted.keys(), ...edits.keys()]);
    for (const id of ids) {
      const info = deleted.get(id) || edits.get(id);
      const msg = getMessage(info && info.c, id);
      if (msg) refreshToggle(msg, info.c, id, info.g || guildOf(info.c));
    }
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
    refreshToggle(msg, channelId, id, guildId);
    if (cfg().notifyDeleted && isDM(getChannel(channelId)) && !gplWillAlert(msg, channelId, guildId, id)) {
      showDmMessageAlert({ kind: "deleted", id, c: channelId, g: guildId || null, an: info.an, t: info.t });
    }
  }

  // True when Ghost Ping Logger will already alert about this deleted message, so we skip our own DM toast.
  function gplWillAlert(msg, channelId, guildId, id) {
    try {
      const bridge = globalThis[GPL_ALERT_BRIDGE_KEY];
      return !!(bridge && bridge.active && typeof bridge.willShowDeleteAlert === "function" && bridge.willShowDeleteAlert(msg, channelId, guildId, id));
    } catch (_) { return false; }
  }

  function gplRemoveEditHistory(id) {
    try {
      const bridge = globalThis[GPL_ALERT_BRIDGE_KEY];
      if (bridge && bridge.active && typeof bridge.removeEditHistory === "function") bridge.removeEditHistory(String(id));
    } catch (_) {}
  }

  const blocked = (original) => ({ type: "MESSAGE_LOGGER_BLOCKED", original });

  function isAllowed(id) {
    const until = allowDelete.get(id);
    return !!until && Date.now() < until;
  }

  function onDelete(e) {
    if (!e.id || isAllowed(e.id)) return null;
    const msg = getKnownMessage(e.channelId, e.id);
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
      const msg = getKnownMessage(e.channelId, id);
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
    const old = getKnownMessage(m.channel_id, m.id);
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
    if (cfg().notifyEdited && isDM(getChannel(m.channel_id))) {
      showDmMessageAlert({ kind: "edited", id: String(m.id), c: String(m.channel_id), g: guildId || null, an: en.an, t: en.cur });
    }
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
          if (e.message && e.message.id) {
            const old = rawBuffer.get(e.message.id);
            if (old) remember({ ...old, ...e.message });
            else if (looksLikeMessage(e.message)) remember(e.message);
          }
          break;
        }
        case "MESSAGE_CREATE": {
          // Keep a bounded in-memory snapshot of messages Kettu receives even
          // when their channel is not currently open in MessageStore.
          remember(e.message);
          break;
        }
        case "LOAD_MESSAGES_SUCCESS": {
          if (cfg().persist) {
            const r = inject(e);
            if (r) args[0] = r;
          }
          harvest(args[0].messages, 0);
          break;
        }
        case "LOCAL_MESSAGE_CREATE":
        case "LOAD_MESSAGES_SUCCESS_CACHED":
        case "LOAD_RECENT_MENTIONS_SUCCESS":
        case "LOAD_PINNED_MESSAGES_SUCCESS":
        case "SEARCH_FINISH":
          harvest(e, 0);
          break;
      }
    } catch (_) {}
  }

  function removeLog(message) {
    const id = message.id;
    const channelId = message.channel_id || message.channelId || currentChannelId();
    const guildId = guildOf(channelId);
    const wasDeleted = deleted.has(id);
    const removedEditHistory = edits.delete(id);
    if (removedEditHistory) gplRemoveEditHistory(id);
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

  function removeEditedMessageFromAML(id) {
    const key = String(id);
    const entry = edits.get(key);
    if (!entry) return false;
    edits.delete(key);
    markDirty();
    const msg = getMessage(entry.c, key);
    if (msg) refreshToggle(msg, entry.c, key, entry.g || guildOf(entry.c));
    return true;
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
              const performMessageJump = () => {
                try {
                  actions.jumpToMessage({ channelId, messageId: real, flash: true, jumpType: "INSTANT" });
                  return true;
                } catch (_) {
                  try { actions.jumpToMessage(channelId, real, true); return true; }
                  catch (_) { toast("Kettu could not jump to that message"); return false; }
                }
              };
              const jumpWhenMessageIsReady = (attemptsLeft) => {
                if (getMessage(channelId, real)) {
                  // The first jump requests older history; repeat after the
                  // target enters MessageStore so the list can scroll to it.
                  return setTimeout(performMessageJump, 180);
                }
                if (attemptsLeft > 0) return setTimeout(() => jumpWhenMessageIsReady(attemptsLeft - 1), 150);
                toast("The message did not load yet. Open the channel and try Jump to message again.");
              };
              const jumpWhenChannelIsReady = (attemptsLeft) => {
                if (String(currentChannelId() || "") !== String(channelId)) {
                  if (attemptsLeft > 0) return setTimeout(() => jumpWhenChannelIsReady(attemptsLeft - 1), 160);
                  toast("The channel did not open in time. Try Jump to message again.");
                  return;
                }
                if (performMessageJump()) jumpWhenMessageIsReady(80);
              };
              jumpWhenChannelIsReady(75);
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

  function ask(title, message, buttons, appendCancel) {
    const ios = RN.Platform && RN.Platform.OS === "ios";
    const list = buttons.slice(0, ios ? 6 : 3);
    if (ios && appendCancel !== false) list.push({ text: "Cancel", style: "cancel" });
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
    ask("Edit history", clip(parts.join("\n\n"), 3500), [{ text: "Close" }], false);
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

  const isOurs = (n) => !!n && typeof n === "object" && n.__gl === 1;
  const ours = (nodes) => { for (const n of nodes) { try { if (n && typeof n === "object") n.__gl = 1; } catch (_) {} } return nodes; };

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
      else if (Array.isArray(m.content) && m.content.some(isOurs)) m.content = m.content.filter((n) => !isOurs(n));
      if (m.__glNameBase) {
        m.colorString = m.__glNameBase.colorString;
        m.usernameColor = m.__glNameBase.usernameColor;
        delete m.__glNameBase;
      }
      return;
    }

    const pc = RN && RN.processColor;
    const deletedColor = colorValue("deletedMessageColor", RED);
    const editedColor = colorValue("editedMessageColor", GREY);
    const nameColor = colorValue("deletedNameColor", RED);
    const deletedTextColor = pc ? pc(deletedColor) : null;
    const edited = pc ? pc(editedColor) : null;

    if (info && cfg().redName && pc) {
      if (!m.__glNameBase) m.__glNameBase = { colorString: m.colorString, usernameColor: m.usernameColor };
      m.colorString = pc(nameColor); m.usernameColor = pc(nameColor);
    } else if (m.__glNameBase) {
      m.colorString = m.__glNameBase.colorString;
      m.usernameColor = m.__glNameBase.usernameColor;
      delete m.__glNameBase;
    }
    if (info && pc) row.backgroundHighlight = { backgroundColor: pc(withAlpha(deletedColor, "26")), gutterColor: deletedTextColor };

    let base = (m.__glOut && m.content === m.__glOut) ? m.__glBase : m.content;
    if (Array.isArray(base) && base.some(isOurs)) base = base.filter((n) => !isOurs(n));
    if (Array.isArray(base)) {
      let out = info ? paint(base, deletedTextColor) : base;
      if (versions) {
        let head = [];
        const start = Math.max(0, versions.length - MAX_SHOWN);
        for (let i = start; i < versions.length; i++) {
          let text = versions[i].t;
          if (cfg().showEditTime && i > 0) text += "  · edited " + fmtTime(versions[i - 1].at);
          head = head.concat(ours(paint([{ type: "text", content: text + "\n" }], edited)));
        }
        out = head.concat(out);
      }
      const labels = [];
      if (info && cfg().showDeletedTime) labels.push("deleted " + fmtTime(info.at));
      if (versions && cfg().showEditTime) labels.push("edited " + fmtTime(versions[versions.length - 1].at));
      if (labels.length) out = out.concat(ours(paint([{ type: "text", content: "  " + labels.join(" · ") }], edited)));
      m.__glBase = base;
      m.__glOut = out;
      m.content = out;
    }

    if (!info && versions && pc && !row.backgroundHighlight) {
      row.backgroundHighlight = { backgroundColor: pc(withAlpha(editedColor, "14")), gutterColor: pc(withAlpha(editedColor, "80")) };
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
    return light
      ? { text: "#060607", sub: "#5C5E66", acc: "#4752C4", blurple: "#5865F2", card2: "rgba(0,0,0,0.045)", chip: "rgba(0,0,0,0.07)", press: "rgba(0,0,0,0.06)", divider: "rgba(0,0,0,0.09)", off: "#B5BAC1" }
      : { text: "#FFFFFF", sub: "#B5BAC1", acc: "#8EA1FF", blurple: "#5865F2", card2: "rgba(255,255,255,0.06)", chip: "rgba(255,255,255,0.10)", press: "rgba(255,255,255,0.07)", divider: "rgba(255,255,255,0.09)", off: "#4E5058" };
  }

  function closeSettingsAlert() {
    try {
      const alerts = findByProps("openLazy", "close");
      if (alerts && typeof alerts.close === "function") alerts.close();
    } catch (_) {}
  }

  function dismissDmMessageAlert(entry, jump) {
    closeSettingsAlert();
    dmAlertShowing = false;
    if (jump && entry && entry.c && entry.id) {
      setTimeout(() => jumpTo(entry.c, entry.g, entry.id, null), 180);
    }
    const nextDelay = jump ? 2400 : 180;
    setTimeout(showNextDmMessageAlert, nextDelay);
  }

  function DmMessageAlert(props) {
    const entry = props.entry || {};
    const colors = palette();
    const dark = colors.text === "#FFFFFF";
    const h = React.createElement;
    const close = () => dismissDmMessageAlert(entry, false);
    const jump = () => dismissDmMessageAlert(entry, true);
    const deletedMessage = entry.kind === "deleted";
    const title = deletedMessage ? "MESSAGE DELETED" : "MESSAGE EDITED";
    const verb = deletedMessage ? "deleted a message in your DM" : "edited a message in your DM";
    const btn = (label, onPress, primary) => h(RN.Pressable, {
      key: label, onPress, accessibilityRole: "button",
      style: ({ pressed }) => ({ flex: 1, minHeight: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", marginLeft: primary ? 10 : 0, backgroundColor: primary ? (pressed ? "#4752C4" : "#5865F2") : (pressed ? "rgba(128,128,128,0.32)" : "rgba(128,128,128,0.22)") }),
    }, h(RN.Text, { style: { color: primary ? "#FFFFFF" : colors.text, fontSize: 15, fontWeight: "700" } }, label));
    return h(RN.View, { style: { width: "92%", maxWidth: 440, alignSelf: "center", padding: 22, borderRadius: 22, backgroundColor: dark ? "#2B2D31" : "#FFFFFF" } },
      h(RN.View, { style: { flexDirection: "row", alignItems: "center" } },
        h(RN.View, { style: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(237,66,69,0.16)" } },
          h(RN.Text, { style: { fontSize: 24 } }, deletedMessage ? "\uD83D\uDDD1\uFE0F" : "\u270F\uFE0F")),
        h(RN.View, { style: { flex: 1, marginLeft: 14 } },
          h(RN.Text, { style: { color: RED, fontSize: 12, fontWeight: "700", letterSpacing: 0.8 } }, title),
          h(RN.Text, { style: { color: colors.text, fontSize: 18, fontWeight: "700", marginTop: 2 }, numberOfLines: 1 }, String(entry.an || "Unknown")))),
      h(RN.Text, { style: { color: colors.sub, fontSize: 14, marginTop: 14 } }, verb),
      h(RN.View, { style: { marginTop: 10, padding: 14, borderRadius: 14, borderLeftWidth: 4, borderLeftColor: RED, backgroundColor: "rgba(237,66,69,0.10)" } },
        h(RN.Text, { style: { color: colors.text, fontSize: 15, lineHeight: 21 } }, entry.t || "(no message text)")),
      h(RN.View, { style: { flexDirection: "row", marginTop: 20 } },
        btn("Dismiss", close, false), btn("Jump to message", jump, true)));
  }

  function showDmMessageAlert(entry) {
    dmAlertQueue.push(entry);
    if (dmAlertQueue.length > 20) dmAlertQueue.shift();
    showNextDmMessageAlert();
  }

  function showNextDmMessageAlert() {
    if (dmAlertShowing || !dmAlertQueue.length) return;
    const entry = dmAlertQueue.shift();
    try {
      if (ui.alerts && typeof ui.alerts.showCustomAlert === "function") {
        dmAlertShowing = true;
        ui.alerts.showCustomAlert(DmMessageAlert, { entry });
        return;
      }
    } catch (_) { dmAlertShowing = false; }
    toast((entry.kind === "deleted" ? "Deleted" : "Edited") + " DM message from " + entry.an + ": " + clip(entry.t, 80));
    setTimeout(showNextDmMessageAlert, 180);
  }

  function MessageCacheLimitModal(props) {
    const [value, setValue] = React.useState(String(props.initialValue || DEFAULT_RAW_BUFFER));
    const [error, setError] = React.useState("");
    const colors = palette();
    const action = (label, onPress, primary) => React.createElement(RN.Pressable, {
      key: label,
      onPress,
      accessibilityRole: "button",
      style: { minHeight: 46, paddingHorizontal: 18, borderRadius: 14, marginLeft: primary ? 10 : 0, alignItems: "center", justifyContent: "center", backgroundColor: primary ? "#5865F2" : "rgba(128,128,128,0.22)" },
    }, React.createElement(RN.Text, { style: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" } }, label));
    const save = () => {
      const count = Number(String(value).trim());
      if (!Number.isInteger(count) || count < MIN_RAW_BUFFER || count > MAX_RAW_BUFFER) {
        setError("Enter a whole number from " + MIN_RAW_BUFFER + " to " + MAX_RAW_BUFFER + ".");
        return;
      }
      closeSettingsAlert();
      if (typeof props.onSave === "function") props.onSave(count);
    };
    return React.createElement(RN.View, { style: { width: "92%", maxWidth: 440, alignSelf: "center", padding: 18, borderRadius: 22, backgroundColor: colors.text === "#FFFFFF" ? "#2B2D31" : "#FFFFFF" } },
      React.createElement(RN.Text, { style: { color: colors.text, fontSize: 20, fontWeight: "700", marginBottom: 8 } }, "Maximum cached messages"),
      React.createElement(RN.Text, { style: { color: colors.sub, fontSize: 14, marginBottom: 16 } }, "All Channels mode only. Higher values use more memory. Keeps messages Discord sends or loads while Kettu runs; no history is fetched."),
      React.createElement(RN.TextInput, { value, onChangeText: (next) => { setValue(next); setError(""); }, keyboardType: "number-pad", accessibilityLabel: "Maximum cached messages", style: { minHeight: 48, paddingHorizontal: 14, borderRadius: 14, color: colors.text, fontSize: 17, backgroundColor: "rgba(128,128,128,0.16)" } }),
      error ? React.createElement(RN.Text, { style: { color: RED, fontSize: 13, marginTop: 8 } }, error) : null,
      React.createElement(RN.View, { style: { flexDirection: "row", justifyContent: "flex-end", marginTop: 18 } },
        action("Cancel", closeSettingsAlert, false), action("Save", save, true)));
  }

  function ColorSettingModal(props) {
    const [value, setValue] = React.useState(String(props.initialValue || RED));
    const [error, setError] = React.useState("");
    const colors = palette();
    const action = (label, onPress, primary) => React.createElement(RN.Pressable, {
      key: label,
      onPress,
      accessibilityRole: "button",
      style: { minHeight: 46, paddingHorizontal: 18, borderRadius: 14, marginLeft: primary ? 10 : 0, alignItems: "center", justifyContent: "center", backgroundColor: primary ? "#5865F2" : "rgba(128,128,128,0.22)" },
    }, React.createElement(RN.Text, { style: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" } }, label));
    const save = () => {
      const hex = String(value).trim().toUpperCase();
      if (!/^#[0-9A-F]{6}$/.test(hex)) { setError("Enter a HEX color such as #3366FF."); return; }
      closeSettingsAlert();
      if (typeof props.onSave === "function") props.onSave(hex);
    };
    const presets = [
      ["Red", "#ED4245"], ["Orange", "#F07B3E"], ["Gold", "#F1C40F"], ["Green", "#43B581"], ["Teal", "#1ABC9C"],
      ["Blue", "#3498DB"], ["Indigo", "#5865F2"], ["Purple", "#9B59B6"], ["Pink", "#EB459E"], ["Gray", "#80848E"],
    ];
    return React.createElement(RN.ScrollView, { style: { width: "92%", maxWidth: 440, maxHeight: "90%", alignSelf: "center", padding: 18, borderRadius: 22, backgroundColor: colors.text === "#FFFFFF" ? "#2B2D31" : "#FFFFFF" } },
      React.createElement(RN.Text, { style: { color: colors.text, fontSize: 20, fontWeight: "700", marginBottom: 8 } }, props.title || "Message color"),
      React.createElement(RN.Text, { style: { color: colors.sub, fontSize: 14, marginBottom: 12 } }, "Choose a preset or enter a HEX color."),
      React.createElement(RN.View, { style: { flexDirection: "row", flexWrap: "wrap", marginBottom: 12 } }, presets.map(([label, hex]) => React.createElement(RN.Pressable, {
        key: hex, onPress: () => { setValue(hex); setError(""); }, accessibilityRole: "button", accessibilityLabel: label,
        style: { width: 62, alignItems: "center", marginRight: 6, marginBottom: 8 },
      }, React.createElement(RN.View, { style: { width: 34, height: 34, borderRadius: 17, backgroundColor: hex, borderWidth: value.toUpperCase() === hex ? 3 : 1, borderColor: colors.text } }),
      React.createElement(RN.Text, { style: { color: colors.text, fontSize: 11, marginTop: 3 } }, label)))),
      React.createElement(RN.View, { style: { width: 44, height: 24, marginBottom: 12, borderRadius: 6, backgroundColor: /^#[0-9A-Fa-f]{6}$/.test(value) ? value : "transparent", borderWidth: 1, borderColor: colors.sub } }),
      React.createElement(RN.TextInput, { value, onChangeText: (next) => { setValue(next); setError(""); }, autoCapitalize: "characters", autoCorrect: false, accessibilityLabel: "HEX color", placeholder: "#3366FF", style: { minHeight: 48, paddingHorizontal: 14, borderRadius: 14, color: colors.text, fontSize: 17, backgroundColor: "rgba(128,128,128,0.16)" } }),
      error ? React.createElement(RN.Text, { style: { color: RED, fontSize: 13, marginTop: 8 } }, error) : null,
      React.createElement(RN.View, { style: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", marginTop: 18 } },
        action("Default", () => { closeSettingsAlert(); if (typeof props.onSave === "function") props.onSave(props.defaultValue); }, false),
        action("Cancel", closeSettingsAlert, false), action("Save", save, true)));
  }

  function LogFilterModal(props) {
    const initial = props.initialValue || {};
    const [query, setQuery] = React.useState(initial.query || "");
    const [from, setFrom] = React.useState(initial.from || "");
    const [to, setTo] = React.useState(initial.to || "");
    const [name, setName] = React.useState("");
    const [error, setError] = React.useState("");
    const colors = palette();
    const current = () => ({ query: query.trim(), from: from.trim(), to: to.trim() });
    const validate = () => {
      const f = from.trim(), t = to.trim();
      if ((f && !/^\d{4}-\d{2}-\d{2}$/.test(f)) || (t && !/^\d{4}-\d{2}-\d{2}$/.test(t)) || (f && Number.isNaN(Date.parse(f))) || (t && Number.isNaN(Date.parse(t)))) {
        setError("Use dates in YYYY-MM-DD format."); return false;
      }
      if (f && t && f > t) { setError("The start date must be before the end date."); return false; }
      return true;
    };
    const action = (label, onPress, primary) => React.createElement(RN.Pressable, {
      key: label, onPress, accessibilityRole: "button",
      style: { minHeight: 44, paddingHorizontal: 14, borderRadius: 14, marginLeft: primary ? 8 : 0, alignItems: "center", justifyContent: "center", backgroundColor: primary ? "#5865F2" : "rgba(128,128,128,0.22)" },
    }, React.createElement(RN.Text, { style: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" } }, label));
    const field = (label, value, onChangeText, keyboardType) => React.createElement(RN.TextInput, {
      value, onChangeText, placeholder: label, keyboardType: keyboardType || "default", autoCapitalize: "none", autoCorrect: false,
      accessibilityLabel: label,
      style: { minHeight: 46, paddingHorizontal: 14, marginTop: 8, borderRadius: 14, color: colors.text, backgroundColor: "rgba(128,128,128,0.16)" },
    });
    const apply = (filter) => {
      if (!filter && !validate()) return;
      closeSettingsAlert();
      if (typeof props.onApply === "function") props.onApply(filter || current());
    };
    const save = () => {
      if (!validate()) return;
      if (!name.trim()) { setError("Enter a name for this saved filter."); return; }
      closeSettingsAlert();
      if (typeof props.onSave === "function") props.onSave({ ...current(), name: name.trim() });
    };
    const saved = Array.isArray(props.savedFilters) ? props.savedFilters : [];
    return React.createElement(RN.ScrollView, { style: { width: "92%", maxWidth: 440, maxHeight: "90%", alignSelf: "center", padding: 18, borderRadius: 22, backgroundColor: colors.text === "#FFFFFF" ? "#2B2D31" : "#FFFFFF" } },
      React.createElement(RN.Text, { style: { color: colors.text, fontSize: 20, fontWeight: "700", marginBottom: 8 } }, "Search logs"),
      React.createElement(RN.Text, { style: { color: colors.sub, fontSize: 13 } }, "Search matches user, channel, and message text."),
      field("User, channel, or message", query, setQuery),
      field("From (YYYY-MM-DD)", from, setFrom),
      field("To (YYYY-MM-DD)", to, setTo),
      error ? React.createElement(RN.Text, { style: { color: RED, fontSize: 13, marginTop: 8 } }, error) : null,
      React.createElement(RN.Text, { style: { color: colors.text, fontSize: 16, fontWeight: "600", marginTop: 16 } }, "Saved filters"),
      saved.length ? saved.map((item, index) => React.createElement(RN.View, {
        key: "saved-filter-" + index,
        style: { flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: "rgba(128,128,128,0.2)" },
      }, React.createElement(RN.Pressable, {
        onPress: () => apply(item), accessibilityRole: "button",
        style: { flex: 1, paddingVertical: 10 },
      }, React.createElement(RN.Text, { style: { color: colors.text, fontSize: 14 } }, item.name || "Saved filter")),
      React.createElement(RN.Pressable, {
        onPress: () => { closeSettingsAlert(); if (typeof props.onDeleteFilter === "function") props.onDeleteFilter(index); },
        accessibilityRole: "button", accessibilityLabel: "Delete saved filter " + (item.name || "Saved filter"),
        style: { paddingHorizontal: 12, paddingVertical: 10 },
      }, React.createElement(RN.Text, { style: { color: RED, fontSize: 14, fontWeight: "600" } }, "Delete"))))
        : React.createElement(RN.Text, { style: { color: colors.sub, fontSize: 13, marginTop: 8 } }, "No saved filters yet."),
      field("Name to save this filter", name, setName),
      React.createElement(RN.View, { style: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", marginTop: 16 } },
        action("Cancel", closeSettingsAlert, false), action("Clear", () => apply({ query: "", from: "", to: "" }), false), action("Apply", () => apply(), true), action("Save filter", save, true)));
  }

  function Settings() {
    vstorage.useProxy(plugin.storage);
    const [screen, setScreen] = React.useState("main");
    const AnimatedScrollView = RN.Animated && RN.Animated.ScrollView;
    const screenFade = React.useRef(AnimatedScrollView ? new RN.Animated.Value(1) : null).current;
    React.useEffect(() => {
      if (!screenFade || !RN.Animated || typeof RN.Animated.timing !== "function") return;
      screenFade.setValue(0);
      const animation = RN.Animated.timing(screenFade, { toValue: 1, duration: 110, useNativeDriver: true });
      animation.start();
      return () => animation.stop();
    }, [screen]);
    const screenStyle = screenFade ? { opacity: screenFade, transform: [{ translateY: screenFade.interpolate({ inputRange: [0, 1], outputRange: [3, 0] }) }] } : undefined;
    const [limit, setLimit] = React.useState(PAGE);
    const [logFilter, setLogFilter] = React.useState({ query: "", from: "", to: "" });
    const [, bump] = React.useState(0);
    let settingsNavigation = null;
    try {
      const navigationModule = findByProps("useNavigation");
      const useNavigation = navigationModule && navigationModule.useNavigation;
      if (typeof useNavigation === "function") settingsNavigation = useNavigation();
    } catch (_) {}
    const refreshUI = () => bump((x) => x + 1);
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

    const rowSet = new WeakSet();
    const mark = (el) => { rowSet.add(el); return el; };
    const HEXCOLOR = /^#[0-9A-Fa-f]{6}$/;
    const Text = (props, ...kids) => h(RN.Text, props, ...kids);
    const rowStyle = ({ pressed }) => ({ paddingHorizontal: 16, paddingVertical: 13, minHeight: 56, flexDirection: "row", alignItems: "center", backgroundColor: pressed ? C.press : "transparent" });
    const rowText = (label, sub) => h(RN.View, { style: { flex: 1 } },
      Text({ style: { color: C.text, fontSize: 16, fontWeight: "500" }, numberOfLines: 4 }, label),
      sub ? Text({ style: { color: C.sub, fontSize: 13, lineHeight: 18, marginTop: 2 }, numberOfLines: 4 }, sub) : null);

    const Section = (title) =>
      h(RN.View, { key: "sec-" + title, style: { paddingHorizontal: 30, paddingTop: 24, paddingBottom: 6 } },
        Text({ style: { color: C.acc, fontSize: 12, fontWeight: "700", letterSpacing: 0.8 } }, title.toUpperCase()));

    const valueChip = (right, rightColor) => {
      if (!right) return null;
      if (right === ">" || right === "\u203A") return Text({ style: { color: C.sub, fontSize: 24, marginLeft: 8 } }, "\u203A");
      if (right === "Selected") return Text({ style: { color: C.acc, fontSize: 20, fontWeight: "700", marginLeft: 8 } }, "\u2713");
      if (HEXCOLOR.test(right)) {
        return h(RN.View, { style: { flexDirection: "row", alignItems: "center", marginLeft: 8 } },
          h(RN.View, { style: { width: 22, height: 22, borderRadius: 11, backgroundColor: right, borderWidth: 2, borderColor: C.divider } }),
          Text({ style: { color: C.sub, fontSize: 13, marginLeft: 8 } }, right));
      }
      return h(RN.View, { style: { marginLeft: 8, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: C.chip, maxWidth: "50%" } },
        Text({ style: { color: rightColor || C.text, fontSize: 14, fontWeight: "600" }, numberOfLines: 2 }, right));
    };

    const PressRow = (key, label, sub, onPress, right, rightColor) => mark(
      h(RN.Pressable, { key, onPress, accessibilityRole: "button", style: rowStyle },
        rowText(label, sub), valueChip(right, rightColor)));

    const switchRow = (key, label, sub, value, change) => mark(
      h(RN.Pressable, { key, onPress: () => change(!value), style: rowStyle },
        h(RN.View, { style: { flex: 1, paddingRight: 12 } },
          Text({ style: { color: C.text, fontSize: 16, fontWeight: "500" } }, label),
          sub ? Text({ style: { color: C.sub, fontSize: 13, lineHeight: 18, marginTop: 2 } }, sub) : null),
        h(RN.Switch, { value, onValueChange: change, trackColor: { false: C.off, true: C.blurple }, thumbColor: "#FFFFFF", ios_backgroundColor: C.off })));

    const Btn = (key, title, onPress, color) => {
      if (key === "back") {
        return h(RN.View, { key, style: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 2, flexDirection: "row" } },
          h(RN.Pressable, { onPress, accessibilityRole: "button", style: ({ pressed }) => ({ paddingVertical: 9, paddingHorizontal: 16, borderRadius: 20, backgroundColor: pressed ? C.press : C.chip }) },
            Text({ style: { color: C.text, fontSize: 15, fontWeight: "600" } }, "\u2039  Back")));
      }
      const danger = color === RED;
      return h(RN.View, { key, style: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 } },
        h(RN.Pressable, {
          onPress, accessibilityRole: "button",
          style: ({ pressed }) => ({ minHeight: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: danger ? (pressed ? "rgba(237,66,69,0.30)" : "rgba(237,66,69,0.16)") : (pressed ? C.press : C.chip) }),
        }, Text({ style: { color: danger ? RED : C.text, fontSize: 15, fontWeight: "700" } }, title)));
    };

    const Empty = (key, text) =>
      h(RN.View, { key, style: { marginHorizontal: 16, marginTop: 12, padding: 24, borderRadius: 16, backgroundColor: C.card2, alignItems: "center" } },
        Text({ style: { color: C.sub, fontSize: 14, lineHeight: 20, textAlign: "center" } }, text));

    const Title = (key, text) =>
      h(RN.View, { key, style: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 4 } },
        Text({ style: { color: C.text, fontSize: 24, fontWeight: "700" } }, text));

    const Header = (title, subtitle) =>
      h(RN.View, { key: "build", style: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 2 } },
        Text({ style: { color: C.text, fontSize: 28, fontWeight: "800" } }, title),
        h(RN.View, { style: { flexDirection: "row", alignItems: "center", marginTop: 8, flexWrap: "wrap" } },
          h(RN.View, { style: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, backgroundColor: C.chip, marginRight: 10 } },
            Text({ style: { color: C.sub, fontSize: 11, fontWeight: "700" } }, "Build " + BUILD)),
          Text({ style: { color: C.sub, fontSize: 13, flexShrink: 1 } }, subtitle)));

    const buildTag = () =>
      h(RN.View, { key: "build", style: { paddingHorizontal: 20, paddingTop: 8 } },
        Text({ style: { color: C.sub, fontSize: 11 } }, "Build " + BUILD));

    // Rows that sit next to each other are grouped into one rounded card with dividers.
    const compose = (list) => {
      const out = [];
      let run = [];
      const flush = () => {
        if (!run.length) return;
        const kids = [];
        run.forEach((r, i) => {
          if (i) kids.push(h(RN.View, { key: "div-" + r.key, style: { height: 1, backgroundColor: C.divider, marginLeft: 16 } }));
          kids.push(r);
        });
        out.push(h(RN.View, { key: "card-" + out.length, style: { marginHorizontal: 16, marginTop: 4, borderRadius: 16, backgroundColor: C.card2, overflow: "hidden" } }, ...kids));
        run = [];
      };
      for (const el of list) {
        if (el && rowSet.has(el)) run.push(el);
        else { flush(); if (el) out.push(el); }
      }
      flush();
      return out;
    };

    const Switch = (key, label, sub, onChange) => {
      const value = !!cfg()[key];
      const change = onChange || ((v) => { cfg()[key] = v; refreshUI(); });
      return switchRow(key, label, sub, value, change);
    };

    const back = () => Btn("back", "< Back", () => { setScreen("main"); refreshUI(); });

    const more = (total) => total > limit ? Btn("more", "Show more", () => setLimit(limit + PAGE)) : null;

    const openLogFilters = () => {
      const saved = Array.isArray(cfg().savedLogFilters) ? cfg().savedLogFilters : [];
      try {
        ui.alerts.showCustomAlert(LogFilterModal, {
          initialValue: logFilter,
          savedFilters: saved,
          onApply: (filter) => { setLogFilter(filter); setLimit(PAGE); refreshUI(); },
          onSave: (filter) => {
            const next = saved.filter((item) => item.name !== filter.name);
            next.unshift(filter);
            cfg().savedLogFilters = next.slice(0, 20);
            setLogFilter(filter);
            setLimit(PAGE);
            refreshUI();
          },
          onDeleteFilter: (index) => {
            const current = Array.isArray(cfg().savedLogFilters) ? cfg().savedLogFilters : [];
            cfg().savedLogFilters = current.filter((_, i) => i !== index);
            refreshUI();
          },
        });
      } catch (_) { toast("Could not open log filters"); }
    };

    const retentionLabel = () => (cfg().retentionDays === 7 ? "7 days" : cfg().retentionDays === 30 ? "30 days" : "Forever");
    const captureModeLabel = () => cfg().captureMode === "expanded" ? "All Channels" : "Loaded Only";
    const captureModeDescription = () => cfg().captureMode === "expanded"
      ? "Higher memory use; captures messages Discord delivers from channels you have not opened. Does not fetch channel history."
      : "Lowest resource use; check only messages already loaded by Discord";
    const cycleCaptureMode = () => {
      cfg().captureMode = cfg().captureMode === "expanded" ? "loaded" : "expanded";
      if (cfg().captureMode === "loaded") rawBuffer.clear();
      refreshUI();
    };
    const editRawBufferLimit = () => {
      try {
        ui.alerts.showCustomAlert(MessageCacheLimitModal, {
          initialValue: rawBufferLimit(),
          onSave: (count) => {
            cfg().maxCachedMessages = count;
            trimMap(rawBuffer, count);
            refreshUI();
          },
        });
      } catch (_) { toast("Could not open cache limit settings"); }
    };
    const editColor = (key, title, defaultValue) => {
      try {
        ui.alerts.showCustomAlert(ColorSettingModal, {
          title,
          initialValue: colorValue(key, key === "editedMessageColor" ? GREY : RED),
          defaultValue,
          onSave: (value) => { cfg()[key] = value; refreshStyledMessages(); refreshUI(); },
        });
      } catch (_) { toast("Could not open color settings"); }
    };
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
      const q = String(logFilter.query || "").toLowerCase();
      const from = logFilter.from ? Date.parse(logFilter.from + "T00:00:00") : null;
      const to = logFilter.to ? Date.parse(logFilter.to + "T23:59:59.999") : null;
      const filtered = entries.filter((entry) => {
        const searchable = [entry.an, entry.t, channelLabel(entry.c, entry.g)].join(" ").toLowerCase();
        return (!q || searchable.includes(q)) && (from === null || entry.at >= from) && (to === null || entry.at <= to);
      });
      const rows = [back(), Title("title", (isDel ? "Deleted messages" : "Edited messages") + " (" + filtered.length + ")"),
        Btn("log-filters", "Search and filters", openLogFilters)];
      if (!filtered.length) rows.push(Empty("empty", entries.length ? "No messages match this filter." : "Nothing logged yet."));
      // Build each row in its own function scope, matching the ignored-list
      // renderer. This keeps the row identity and native press callback paired
      // even on the mobile React renderer when the list is reordered.
      filtered.slice(0, limit).forEach(function (entry) {
        const rowKind = String(kind);
        const messageId = String(entry.id);
        const channelId = entry.c == null ? null : String(entry.c);
        const guildId = entry.g == null ? null : String(entry.g);
        const rowKey = "logged-" + rowKind + "-" + messageId;
        const rowLabel = snippet(entry.t);
        const rowSub = entry.an + " · " + (channelId ? channelLabel(channelId, guildId) : "Unknown channel") + " · " + fmtTime(entry.at);
        rows.push(PressRow(rowKey, rowLabel, rowSub, function () {
          const record = isDel ? deleted.get(messageId) : edits.get(messageId);
          if (!record) return;
          const currentText = isDel
            ? record.t
            : record.cur || (record.v[record.v.length - 1] && record.v[record.v.length - 1].t) || "";
          const authorName = record.an || entry.an;
          const timestamp = isDel
            ? record.at
            : (record.v[record.v.length - 1] || { at: entry.at }).at;
          const buttons = [];
          if (channelId) buttons.push({ text: "Jump to message", onPress: () => jumpTo(channelId, guildId, messageId, settingsNavigation) });
          if (!isDel) {
            buttons.push({ text: "Edit history", onPress: () => showEdits({ id: messageId, content: currentText }) });
          }
          buttons.push({ text: "Remove from log", style: "destructive", onPress: () => { removeLog({ id: messageId, channel_id: channelId }); refreshUI(); } });
          ask(authorName + " · " + fmtTime(timestamp), clip(currentText, 600), buttons);
        }));
      });
      const m = more(filtered.length);
      if (m) rows.push(m);
      return rows;
    };

    const ignoredScreen = () => {
      const ig = ignored();
      const groups = [["guilds", "Servers"], ["channels", "Channels and DMs"], ["users", "Users"]];
      const total = groups.reduce((n, g) => n + Object.keys(ig[g[0]]).length, 0);
      const rows = [back(), Title("title", "Ignored (" + total + ")")];
        if (!total) rows.push(Empty("empty", "Nothing is ignored. Long-press a DM, open a profile's three-dot menu, or long-press a server or channel."));
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
        Switch("logDeleted", "Keep deleted messages", "Deleted messages stay visible in the selected color"),
        Switch("redName", "Color deleted usernames", "Apply a separate color to the sender's name", (v) => { cfg().redName = v; refreshStyledMessages(); refreshUI(); }),
        Switch("logEdited", "Keep edited messages", "Previous versions appear above the new text in the selected color"),
        Switch("persist", "Save across restarts", "Store logged messages on this device", (v) => { setPersist(v); refreshUI(); }),
        Switch("notifyDeleted", "Notify about deleted messages", "Show a Jump to message alert for deleted DMs only"),
        Switch("notifyEdited", "Notify about edited messages", "Show a Jump to message alert for edited DMs only"),
        Section("Message capture"),
        PressRow("capture-mode", "Capture mode", captureModeDescription(), cycleCaptureMode, captureModeLabel()),
        PressRow("cache-limit", "Maximum cached messages", "All Channels mode only · held in memory", editRawBufferLimit, String(rawBufferLimit())),
        Section("Display"),
        PressRow("deleted-color", "Deleted message color", "Text and highlight color", () => editColor("deletedMessageColor", "Deleted message color", RED), colorValue("deletedMessageColor", RED)),
        PressRow("edited-color", "Edited message color", "Previous versions and edit highlights", () => editColor("editedMessageColor", "Edited message color", GREY), colorValue("editedMessageColor", GREY)),
        PressRow("name-color", "Deleted username color", "Works when Color deleted usernames is on", () => editColor("deletedNameColor", "Deleted username color", RED), colorValue("deletedNameColor", RED)),
        Switch("showDeletedTime", "Show deletion time", "Adds \"deleted 00:45\" after deleted messages"),
        Switch("showEditTime", "Show edit time", "Adds \"edited 00:45\" after edited messages"),
        Switch("use12HourClock", "12-hour clock", "Show times like 4:45 PM instead of 16:45"),
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

    content.unshift(screen === "main" ? Header("Advanced Message Logger", "Deleted and edited messages stay visible") : buildTag());
    return h(AnimatedScrollView || RN.ScrollView, { key: screen, style: screenStyle, contentContainerStyle: { paddingBottom: 40 } }, ...compose(content));
  }

  function onLoad() {
    dmAlertQueue.length = 0;
    dmAlertShowing = false;
    const s = cfg();
    const defaults = {
      logDeleted: true, logEdited: true, persist: false, redName: true, skipOwn: true, skipBots: true,
      showDeletedTime: false, showEditTime: false, retentionDays: 0, captureMode: "expanded", maxCachedMessages: DEFAULT_RAW_BUFFER,
      deletedMessageColor: RED, editedMessageColor: GREY, deletedNameColor: RED, use12HourClock: false,
      notifyDeleted: false, notifyEdited: false,
    };
    for (const k of Object.keys(defaults)) if (s[k] === undefined) s[k] = defaults[k];
    if (s.maxCachedMessagesDefaultMigration !== 1) {
      if (Number(s.maxCachedMessages) === 500) s.maxCachedMessages = DEFAULT_RAW_BUFFER;
      s.maxCachedMessagesDefaultMigration = 1;
    }
    if (s.captureMode !== "loaded" && s.captureMode !== "expanded") s.captureMode = "expanded";
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
    try {
      gplBridge = {
        active: true,
        shouldRetainDelete: (message, channelId, guildId) => !!cfg().logDeleted && !shouldSkip(message, channelId, guildId),
        ownsDeletedMessage: (id) => deleted.has(String(id)),
        ownsEditedMessage: (id) => edits.has(String(id)),
        removeEditedMessage: removeEditedMessageFromAML,
        notifiesDMDelete: (channelId) => !!cfg().logDeleted && !!cfg().notifyDeleted && isDM(getChannel(channelId)),
        notifiesDMEdit: (channelId) => !!cfg().logEdited && !!cfg().notifyEdited && isDM(getChannel(channelId)),
      };
      globalThis[GPL_BRIDGE_KEY] = gplBridge;
    } catch (_) { gplBridge = null; }
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
    dmAlertQueue.length = 0;
    dmAlertShowing = false;
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
    try { if (globalThis[GPL_BRIDGE_KEY] === gplBridge) delete globalThis[GPL_BRIDGE_KEY]; } catch (_) {}
    gplBridge = null;
  }

  return { onLoad, onUnload, settings: Settings };
})()
