const rainRuntime = globalThis.rain;
if (!rainRuntime || !rainRuntime.api || !rainRuntime.api.storage) throw new Error("Discord plugin API unavailable");
const rainStore = rainRuntime.api.storage.createPluginStore("aml", {});
const updatePluginSettings = (patch) => rainStore.useStore.getState().updateSettings(patch);
const pluginSettings = new Proxy(Object.create(null), {
  get(_target, prop) { return Reflect.get(rainStore.useStore.getState(), prop); },
  set(_target, prop, value) { updatePluginSettings({ [prop]: value }); return true; },
});
const implementation = (() => {
  "use strict";
  const { metro } = rainRuntime;
  const patcher = rainRuntime.api.patcher;
  const ui = rainRuntime.api.ui;
  const { findByName, findByProps, findByStoreName } = metro;
  const { FluxDispatcher, React, ReactNative: RN } = metro.common;

  const MAX_VERSIONS = 20;
  const MAX_SHOWN = 3;
  const MAX_LEN = 2000;
  const MAX_SNIPPET = 500;
  const MAX_LOGGED = 2000;
  const MAX_EDITED = 1000;
  const MAX_SAVED_RAW = 1000;
  const DEFAULT_RAW_BUFFER = 10000;
  const MIN_RAW_BUFFER = 100;
  const MAX_RAW_BUFFER = 20000;
  const MAX_RAW_SIZE = 20000;
  const MAX_RAW_CACHE_BYTES = 8 * 1024 * 1024;
  const RAW_ARCHIVE_SAVE_DELAY = 30000;
  const BUILD = "v1.0.0";
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
  const rawBufferSizes = new Map();
  const rawArchiveIds = new Set();
  let rawBufferBytes = 0;
  let receivedThisSession = 0;
  let receivedDMsThisSession = 0;
  const receivedChannelsThisSession = new Set();
  let rawArchiveDirty = false;
  let rawArchiveTimer = null;
  const allowDelete = new Map();
  const unpatches = [];
  const pendingTimers = new Set();
  function later(fn, ms) {
    const id = setTimeout(() => { pendingTimers.delete(id); fn(); }, ms);
    pendingTimers.add(id);
    return id;
  }
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

  const cfg = () => pluginSettings;
  let hydrationUnsubscribe = null;
  let loadRequested = false;
  let initialized = false;
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

  let flushFailures = 0;
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
        flushFailures = 0;
      }
    } catch (_) {
      dirty = true;
      if (++flushFailures <= 3) schedule();
    }
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

  function estimateRawBytes(root) {
    const stack = [root];
    const seen = new WeakSet();
    let bytes = 128;
    let nodes = 0;
    while (stack.length && bytes <= MAX_RAW_SIZE && nodes++ < 1024) {
      const value = stack.pop();
      if (typeof value === "string") { bytes += value.length * 2 + 8; continue; }
      if (typeof value === "number" || typeof value === "boolean") { bytes += 8; continue; }
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) {
        bytes += value.length * 8;
        for (const child of value) stack.push(child);
      } else {
        const keys = Object.keys(value);
        bytes += keys.length * 16;
        for (const key of keys) { bytes += key.length * 2; stack.push(value[key]); }
      }
    }
    return bytes > MAX_RAW_SIZE || (nodes >= 1024 && stack.length) ? MAX_RAW_SIZE + 1 : bytes;
  }

  function trimRawBuffer() {
    while (rawBuffer.size > rawBufferLimit() || rawBufferBytes > MAX_RAW_CACHE_BYTES) {
      const oldest = rawBuffer.keys().next().value;
      if (oldest === undefined) break;
      rawBuffer.delete(oldest);
      rawArchiveIds.delete(oldest);
      rawBufferBytes = Math.max(0, rawBufferBytes - (rawBufferSizes.get(oldest) || 0));
      rawBufferSizes.delete(oldest);
    }
  }

  function clearRawBuffer() {
    rawBuffer.clear();
    rawBufferSizes.clear();
    rawArchiveIds.clear();
    rawBufferBytes = 0;
  }

  function flushRawArchive() {
    if (rawArchiveTimer) { clearTimeout(rawArchiveTimer); rawArchiveTimer = null; }
    if (!rawArchiveDirty) return;
    rawArchiveDirty = false;
    try {
      cfg().receivedMessages = cfg().rememberReceivedMessages === false ? [] : Array.from(rawArchiveIds).map((id) => rawBuffer.get(id)).filter(Boolean);
    } catch (_) {
      rawArchiveDirty = true;
      if (cfg().rememberReceivedMessages !== false && !rawArchiveTimer) rawArchiveTimer = setTimeout(flushRawArchive, 60000);
    }
  }

  function scheduleRawArchiveSave() {
    if (cfg().rememberReceivedMessages === false) return;
    rawArchiveDirty = true;
    if (!rawArchiveTimer) rawArchiveTimer = setTimeout(flushRawArchive, RAW_ARCHIVE_SAVE_DELAY);
  }

  function restoreRawArchive() {
    if (cfg().rememberReceivedMessages === false) return;
    const saved = Array.isArray(cfg().receivedMessages) ? cfg().receivedMessages : [];
    for (const message of saved) {
      if (message && message.id && message.author && typeof message.content === "string") remember(message);
    }
    rawArchiveDirty = false;
    if (rawArchiveTimer) { clearTimeout(rawArchiveTimer); rawArchiveTimer = null; }
  }

  function remember(raw, persistArchive) {
    if (cfg().captureMode !== "expanded" || !raw || !raw.id) return;
    const id = String(raw.id);
    const size = estimateRawBytes(raw) + 128;
    if (size > MAX_RAW_SIZE) return;
    if (rawBuffer.has(id)) {
      rawBufferBytes = Math.max(0, rawBufferBytes - (rawBufferSizes.get(id) || 0));
      rawBuffer.delete(id);
    }
    rawBufferSizes.set(id, size);
    rawBufferBytes += size;
    rawBuffer.set(id, raw);
    trimRawBuffer();
    if (persistArchive !== false && cfg().rememberReceivedMessages !== false) {
      rawArchiveIds.add(id);
      scheduleRawArchiveSave();
    }
  }

  const looksLikeMessage = (m) => !!m && typeof m === "object" && typeof m.id === "string" &&
    typeof m.content === "string" && !!m.author && typeof m.author === "object";

  function rawBufferLimit() {
    const value = Number(cfg().maxCachedMessages);
    if (!Number.isFinite(value)) return DEFAULT_RAW_BUFFER;
    return Math.max(MIN_RAW_BUFFER, Math.min(MAX_RAW_BUFFER, Math.round(value)));
  }

  function refreshToggle(msg, channelId, id, guildId) {
    later(() => {
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
            else if (looksLikeMessage(e.message)) remember(e.message, false);
          }
          break;
        }
        case "MESSAGE_CREATE": {
          // Keep a bounded in-memory snapshot of messages Discord receives even
          // when their channel is not currently open in MessageStore.
          remember(e.message);
          if (e.message && e.message.id) {
            receivedThisSession++;
            const channelId = e.message.channel_id || e.message.channelId;
            if (channelId) {
              receivedChannelsThisSession.add(String(channelId));
              if (isDM(getChannel(channelId))) receivedDMsThisSession++;
            }
          }
          break;
        }
        case "LOAD_MESSAGES_SUCCESS": {
          if (cfg().persist) {
            const r = inject(e);
            if (r) args[0] = r;
          }
          break;
        }
        case "LOCAL_MESSAGE_CREATE":
          if (e.message && e.message.id) remember(e.message);
          break;
        case "LOAD_MESSAGES_SUCCESS_CACHED":
        case "LOAD_RECENT_MENTIONS_SUCCESS":
        case "LOAD_PINNED_MESSAGES_SUCCESS":
        case "SEARCH_FINISH":
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

  function dismissHistoryNavigation(navigation) { let current=navigation,depth=0; while(current&&depth++<8){try{if(current.canGoBack?.()){if(typeof current.popToTop==="function")current.popToTop();else current.goBack?.();}current=current.getParent?.();}catch(_){break;}} }
  function jumpTo(channelId,guildId,messageId,navigation){
    if(!channelId||!messageId||String(messageId).startsWith("test-"))return;
    const jump=(()=>{try{return findByProps("jumpToMessage");}catch(_){return null;}})();
    const navigate=(()=>{try{return findByProps("transitionToChannel");}catch(_){return null;}})();
    const perform=()=>{try{if(typeof jump?.jumpToMessage!=="function")throw Error();jump.jumpToMessage({channelId:String(channelId),messageId:String(messageId),flash:true,jumpType:"ANIMATED"});}catch(_){toast("Could not jump to this message");}};
    try{if(typeof navigate?.transitionToChannel!=="function")throw Error();dismissHistoryNavigation(navigation);navigate.transitionToChannel(String(channelId),{});setTimeout(perform,650);}catch(_){toast("Could not open this channel");}
  }
  function ask(title, message, buttons, appendCancel) {
    const ios = RN.Platform && RN.Platform.OS === "ios";
    const list = buttons.slice(0, ios ? 6 : 3);
    if (ios && appendCancel !== false) list.push({ text: "Cancel", style: "cancel" });
    try { showDiscordAlert("aml-confirm", title, message, list); } catch (_) {}
  }

  function showCaptureTest() {
    ask("Message capture test", "Since AML started:\n" + receivedThisSession + " new message events\n" +
      receivedChannelsThisSession.size + " conversations/channels\n" + receivedDMsThisSession + " DM messages\n\n" +
      "Counts messages delivered by Discord while this plugin is running. Messages the app does not receive cannot be recorded.", [{ text: "OK" }]);
  }

  function showDiscordAlert(id, title, content, buttons) {
    const h = React.createElement;
    const alerts = findByProps("openAlert", "dismissAlert");
    const components = findByProps("AlertModal", "AlertActions", "AlertActionButton");
    if (!alerts || !components) throw new Error("Discord alert components unavailable");
    const actions = h(components.AlertActions, null, ...buttons.slice(0, 4).map((button, index) => h(components.AlertActionButton, {
      key: id + "-action-" + index, text: button.text,
      variant: button.style === "destructive" ? "destructive" : button.style === "cancel" ? "secondary" : "primary",
      onPress: button.onPress,
    })));
    alerts.openAlert(id, h(components.AlertModal, { title, content, actions }));
  }

  function openNativeInputAlert(props) {
    const api = findByProps("openAlert", "dismissAlert");
    if (!api || typeof api.openAlert !== "function") throw new Error("Discord alert API unavailable");
    api.openAlert(props.id, React.createElement(NativeInputAlert, props));
  }

  function NativeInputAlert(props) {
    const [value, setValue] = React.useState(String(props.initialValue || ""));
    const h = React.createElement;
    const parts = findByProps("AlertModal", "AlertActions", "AlertActionButton");
    const inputModule = findByProps("TextInput");
    const Input = inputModule && inputModule.TextInput;
    const dismiss = () => { try { findByProps("openAlert", "dismissAlert").dismissAlert(props.id); } catch (_) {} };
    const save = () => { dismiss(); if (typeof props.onSave === "function") props.onSave(value); };
    const field = Input
      ? h(Input, { value, onChange: setValue, keyboardType: props.keyboardType, placeholder: props.placeholder || "", autoCapitalize: "none", autoCorrect: false })
      : h(RN.TextInput, { value, onChangeText: setValue, keyboardType: props.keyboardType, placeholder: props.placeholder || "", autoCapitalize: "none", autoCorrect: false });
    const actions = h(parts.AlertActions, null,
      h(parts.AlertActionButton, { text: "Cancel", variant: "secondary", onPress: dismiss }),
      h(parts.AlertActionButton, { text: props.saveLabel || "Save", variant: "primary", onPress: save }));
    return h(parts.AlertModal, { title: props.title, content: props.content, extraContent: field, actions });
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
    try { ThemeStore = ThemeStore || findByStoreName("ThemeStore"); light = !!ThemeStore && ThemeStore.theme === "light"; } catch (_) {}
    return light
      ? { text: "#060607", sub: "#5C5E66", bg: "#FFFFFF", card: "#F2F3F5", acc: "#5865F2", accPressed: "#4752C4", blurple: "#5865F2", card2: "rgba(0,0,0,0.045)", chip: "rgba(0,0,0,0.07)", press: "rgba(0,0,0,0.06)", divider: "rgba(0,0,0,0.09)", off: "#B5BAC1" }
      : { text: "#FFFFFF", sub: "#B5BAC1", bg: "#1E1F22", card: "#2B2D31", acc: "#5865F2", accPressed: "#4752C4", blurple: "#5865F2", card2: "rgba(255,255,255,0.06)", chip: "rgba(255,255,255,0.10)", press: "rgba(255,255,255,0.07)", divider: "rgba(255,255,255,0.09)", off: "#4E5058" };
}

  function dismissDmMessageAlert(entry, jump) {
    dmAlertShowing = false;
    if (jump && entry && entry.c && entry.id) {
      later(() => jumpTo(entry.c, entry.g, entry.id, null), 180);
    }
    const nextDelay = jump ? 2400 : 180;
    later(showNextDmMessageAlert, nextDelay);
  }

  function showDmMessageAlert(entry) {
    dmAlertQueue.push(entry);
    if (dmAlertQueue.length > 20) dmAlertQueue.shift();
    showNextDmMessageAlert();
  }

  function showNextDmMessageAlert() {
    if (dmAlertShowing || !dmAlertQueue.length) return;
    const entry = dmAlertQueue.shift();
    dmAlertShowing = true;
    const deletedMessage = entry.kind === "deleted";
    const title = deletedMessage ? "Deleted DM message" : "Edited DM message";
    const buttons = [
      { text: "Dismiss", style: "cancel", onPress: () => dismissDmMessageAlert(entry, false) },
      { text: "Jump to message", onPress: () => dismissDmMessageAlert(entry, true) },
    ];
    try {
      showDiscordAlert("aml-dm-message", title, "From " + String(entry.an || "Unknown") + ":\n\n" + (entry.t || "(no message text)"), buttons);
    } catch (_) {
      dmAlertShowing = false;
      toast(title + " from " + entry.an + ": " + clip(entry.t, 80));
      later(showNextDmMessageAlert, 180);
    }
  }

  /* ---- shared settings design kit (identical in AML / GPL / QT) ---- */
  const KIT_TILES = {
    lang: ["LanguageIcon", "\u6587", "#5865F2"], paint: ["PaintPaletteIcon", "\u25C9", "#EB459E"], time: ["ClockIcon", "\u25F7", "#E58A00"],
    store: ["ClipboardListIcon", "\u25A3", "#3BA55D"], trash: ["TrashIcon", "\u232B", "#ED4245"], edit: ["PencilIcon", "\u270E", "#F07B3E"],
    shield: ["ShieldIcon", "\u2298", "#80848E"], bell: ["BellIcon", "!", "#E58A00"], at: ["BellIcon", "@", "#ED4245"],
    reply: ["ChatMarkUnreadIcon", "\u21A9", "#5865F2"], search: ["CompassIcon", "\u2315", "#1ABC9C"], chat: ["ChatMarkUnreadIcon", "\u25A4", "#5865F2"],
    plus: ["PlusSmallIcon", "+", "#5865F2"], link: ["LinkIcon", "\u2197", "#3498DB"], test: ["WrenchIcon", "\u25B7", "#9B59B6"],
    star: ["StarIcon", "\u2605", "#D99700"], server: ["PinIcon", "\u25C7", "#3498DB"], power: ["SettingsIcon", "\u25CF", "#43B581"],
    text: ["PencilIcon", "Aa", "#F07B3E"], guide: ["ClipboardCheckIcon", "?", "#5865F2"], gear: ["SettingsIcon", "\u2022", "#80848E"]
  };
  const KIT_RULES = [
    [/^(default|red|orange|gold|green|teal|blue|indigo|purple|pink|gray)$/i, null],
    [/^ghost ping logger$/i, "power"], [/color|appearance/, "paint"], [/notify|alert|toast/, "bell"], [/test/, "test"],
    [/button|position|composer/, "plus"], [/clear|remove/, "trash"],
    [/clock|time|history|retention|keep .* for/, "time"], [/quick|favorite|saved/, "star"],
    [/cache|storage|persist|remember|restart|across/, "store"],
    [/deleted|delete/, "trash"], [/edit/, "edit"], [/ignore/, "shield"], [/mention|everyone|ping/, "at"],
    [/reply|replies/, "reply"], [/filter|search/, "search"], [/jump/, "link"],
    [/translate|translation|google|deepl|language/, "lang"], [/word|term/, "text"], [/server|guild/, "server"],
    [/capture|message|channel|dm/, "chat"], [/enabled|logger/, "power"]
  ];
  const kitAssetCache = new Map();
  function kitAsset(name) {
    const hit = kitAssetCache.get(name);
    if (hit && (hit.id || Date.now() - hit.at < 5000)) return hit.id;
    let id = null;
    try { const r = globalThis.rain; id = (r && r.api && r.api.assets && r.api.assets.findAssetId && r.api.assets.findAssetId(name)) || null; } catch (_) { id = null; }
    kitAssetCache.set(name, { id, at: Date.now() });
    return id;
  }
  function hexA(hex, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return hex;
    const n = Math.round(a * 255).toString(16);
    return "#" + m[1] + (n.length < 2 ? "0" + n : n);
  }
  function settingIconForTitle(title) {
    const text = String(title || "").toLowerCase();
    const match = KIT_RULES.find(([pattern]) => pattern.test(text));
    return match ? match[1] : null;
  }
  function kitIconKey(p) {
    if (!p || p.noIcon) return null;
    if (p.icon && KIT_TILES[p.icon]) return p.icon;
    return settingIconForTitle(p.title);
  }
  function KitChevron(p) {
    const h = React.createElement, s = p.size || 8, deg = p.dir === "up" ? "225deg" : p.dir === "right" ? "-45deg" : "45deg";
    return h(RN.View, { style: { width: s, height: s, borderRightWidth: 2, borderBottomWidth: 2, borderColor: p.color, borderRadius: 1, transform: [{ rotate: deg }], marginTop: p.dir === "up" ? 3 : p.dir === "down" ? -3 : 0, marginHorizontal: 3 } });
  }
  function KitTile(p) {
    const h = React.createElement, t = KIT_TILES[p.k] || KIT_TILES.gear, size = p.size || 32, asset = kitAsset(t[0]);
    const inner = Math.round(size * 0.56);
    return h(RN.View, { style: { width: size, height: size, borderRadius: Math.round(size * 0.3), backgroundColor: t[2], alignItems: "center", justifyContent: "center", marginRight: p.noMargin ? 0 : 13 } },
      asset ? h(RN.Image, { source: asset, resizeMode: "contain", style: { width: inner, height: inner, tintColor: "#FFFFFF" } })
        : h(RN.Text, { style: { color: "#FFFFFF", fontSize: Math.round(size * 0.5), fontWeight: "700" } }, t[1]));
  }
  function CustomSection(p) {
    const C = palette(), h = React.createElement;
    const kids = React.Children.toArray(p.children);
    const any = kids.some((k) => k && k.type === CustomRow && kitIconKey(k.props));
    const isAction = (k) => !!k && k.type === CustomAction;
    if (kids.length && kids.every(isAction)) {
      return h(RN.View, { style: { marginBottom: p.title ? 24 : 12 } },
        p.title ? h(RN.View, { style: { flexDirection: "row", alignItems: "center", marginHorizontal: 6, marginBottom: 10 } },
          h(RN.View, { style: { width: 3, height: 14, borderRadius: 2, backgroundColor: C.blurple, marginRight: 8 } }),
          h(RN.Text, { numberOfLines: 1, style: { color: C.text, fontSize: 15, fontWeight: "700", flexShrink: 1 } }, p.title)) : null,
        ...kids.map((k, i) => React.cloneElement(k, { top: i === 0 ? 0 : 10 })));
    }
    const out = kids.map((k, i) => isAction(k)
      ? h(RN.View, { key: "act-" + i, style: { paddingHorizontal: 12, paddingTop: i === 0 ? 12 : 0, paddingBottom: 12 } }, React.cloneElement(k, { top: 0 }))
      : (k && k.type === CustomRow && any && !k.props.noIcon && !kitIconKey(k.props)) ? React.cloneElement(k, { __fallbackIcon: true }) : k);
    return h(RN.View, { style: { marginBottom: p.compact ? 14 : 24 } },
      p.title ? h(RN.View, { style: { flexDirection: "row", alignItems: "center", marginHorizontal: 6, marginBottom: 10 } },
        h(RN.View, { style: { width: 3, height: 14, borderRadius: 2, backgroundColor: C.blurple, marginRight: 8 } }),
        h(RN.Text, { numberOfLines: 1, style: { color: C.text, fontSize: 15, fontWeight: "700", letterSpacing: 0.1, flexShrink: 1 } }, p.title)) : null,
      h(RN.View, { style: { backgroundColor: C.card, borderRadius: 20, overflow: "hidden", borderWidth: 1, borderColor: C.card2 } }, ...out),
      p.footer ? h(RN.Text, { style: { color: C.sub, fontSize: 12, lineHeight: 17, marginHorizontal: 8, marginTop: 8 } }, p.footer) : null);
  }
  function CustomRow(p) {
    const C = palette(), h = React.createElement;
    const key = p.__fallbackIcon ? (kitIconKey(p) || "gear") : kitIconKey(p);
    const tile = key ? KitTile({ k: key, size: 34 }) : null;
    return h(RN.Pressable, {
      accessibilityRole: p.onPress ? "button" : undefined, onPress: p.onPress, disabled: !p.onPress,
      style: ({ pressed }) => ({ minHeight: 66, paddingHorizontal: 16, paddingVertical: 13, flexDirection: "row", alignItems: "center", backgroundColor: pressed ? C.press : "transparent" })
    },
      tile,
      h(RN.View, { style: { flex: 1, minWidth: 0, paddingRight: 10 } },
        h(RN.Text, { numberOfLines: 2, style: { color: C.text, fontSize: 16, fontWeight: "600", lineHeight: 21 } }, p.title),
        p.subtitle ? h(RN.Text, { numberOfLines: 3, style: { color: C.sub, fontSize: 13, marginTop: 3, lineHeight: 18 } }, p.subtitle) : null),
      p.trailing || null,
      !p.last ? h(RN.View, { style: { position: "absolute", bottom: 0, left: key ? 63 : 16, right: 0, height: 1, backgroundColor: C.card2 } }) : null);
  }
  function CustomSwitch(p) {
    const C = palette(), h = React.createElement, on = !!p.value;
    const pos = React.useRef(new RN.Animated.Value(on ? 1 : 0)).current;
    React.useEffect(() => {
      RN.Animated.spring(pos, { toValue: on ? 1 : 0, speed: 24, bounciness: 5, useNativeDriver: true }).start();
    }, [on]);
    return h(RN.Pressable, { accessibilityRole: "switch", accessibilityState: { checked: on }, onPress: () => p.onChange(!on), hitSlop: 10,
      style: { width: 52, height: 32, borderRadius: 16, padding: 3, justifyContent: "center", backgroundColor: on ? (p.color || C.blurple) : C.off } },
      h(RN.Animated.View, { style: { width: 26, height: 26, borderRadius: 13, backgroundColor: "#FFFFFF", shadowColor: "#000000", shadowOpacity: 0.25, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2, transform: [{ translateX: pos.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) }] } }));
  }
  function CustomAction(p) {
    const C = palette(), h = React.createElement, RED_ = "#ED4245";
    const sc = React.useRef(new RN.Animated.Value(1)).current;
    const to = (v) => RN.Animated.spring(sc, { toValue: v, speed: 40, bounciness: 0, useNativeDriver: true }).start();
    const bg = p.danger ? (p.secondary ? hexA(RED_, 0.14) : RED_) : (p.secondary ? C.chip : C.blurple);
    const fg = p.danger && p.secondary ? RED_ : (p.secondary ? C.text : "#FFFFFF");
    return h(RN.Pressable, { onPress: p.onPress, disabled: p.disabled, onPressIn: () => to(0.97), onPressOut: () => to(1), accessibilityRole: "button" },
      h(RN.Animated.View, { style: { minHeight: p.compact ? 42 : 50, borderRadius: 15, alignItems: "center", justifyContent: "center", paddingHorizontal: p.compact ? 12 : 18, marginTop: p.top != null ? p.top : 10, backgroundColor: bg, opacity: p.disabled ? 0.45 : 1, transform: [{ scale: sc }] } },
        h(RN.Text, { numberOfLines: 1, style: { color: fg, fontWeight: "700", fontSize: p.compact ? 15 : 16 } }, p.title)));
  }
  function CustomInput(p) {
    const C = palette(), h = React.createElement;
    const [focused, setFocused] = React.useState(false);
    return h(RN.TextInput, {
      ...p, placeholderTextColor: C.sub, underlineColorAndroid: "transparent", textAlignVertical: p.multiline ? "top" : "center",
      onFocus: (e) => { setFocused(true); if (p.onFocus) p.onFocus(e); },
      onBlur: (e) => { setFocused(false); if (p.onBlur) p.onBlur(e); },
      style: [{ minHeight: 50, borderRadius: 14, borderWidth: 1.5, borderColor: focused ? C.blurple : C.card2, backgroundColor: C.bg, color: C.text, paddingHorizontal: 15, fontSize: 16 }, p.style]
    });
  }
  let kitHeroPlayed = false;
  function KitHero(p) {
    const C = palette(), h = React.createElement, accent = p.accent || C.blurple;
    const stats = (p.stats || []).filter(Boolean);
    const enter = React.useRef(new RN.Animated.Value(kitHeroPlayed ? 1 : 0)).current;
    React.useEffect(() => { if (kitHeroPlayed) return; kitHeroPlayed = true; RN.Animated.spring(enter, { toValue: 1, speed: 14, bounciness: 6, useNativeDriver: true }).start(); }, []);
    return h(RN.Animated.View, { style: { borderRadius: 26, backgroundColor: C.card, borderWidth: 1, borderColor: hexA(accent, 0.4), padding: 18, marginBottom: 24, overflow: "hidden", opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }] } },
      h(RN.View, { pointerEvents: "none", style: { position: "absolute", top: -60, right: -50, width: 190, height: 190, borderRadius: 95, backgroundColor: hexA(accent, 0.16) } }),
      h(RN.View, { pointerEvents: "none", style: { position: "absolute", bottom: -70, left: -40, width: 140, height: 140, borderRadius: 70, backgroundColor: hexA(accent, 0.08) } }),
      h(RN.View, { style: { flexDirection: "row", alignItems: "center" } },
        KitTile({ k: p.icon, size: 54, noMargin: true }),
        h(RN.View, { style: { flex: 1, marginLeft: 14 } },
          h(RN.Text, { numberOfLines: 2, style: { color: C.text, fontSize: 21, fontWeight: "800", letterSpacing: -0.2 } }, p.title),
          p.subtitle ? h(RN.Text, { numberOfLines: 2, style: { color: C.sub, fontSize: 14, marginTop: 3, lineHeight: 19 } }, p.subtitle) : null)),
      stats.length ? h(RN.View, { style: { flexDirection: "row", marginTop: 16 } }, ...stats.map((s, i) =>
        h(RN.View, { key: "stat-" + i, style: { flex: 1, borderRadius: 15, backgroundColor: C.chip, paddingVertical: 11, paddingHorizontal: 12, marginRight: i === stats.length - 1 ? 0 : 8 } },
          h(RN.Text, { numberOfLines: 1, adjustsFontSizeToFit: true, style: { color: C.text, fontSize: 19, fontWeight: "800" } }, String(s[1])),
          h(RN.Text, { numberOfLines: 1, style: { color: C.sub, fontSize: 12, marginTop: 2, fontWeight: "600" } }, s[0])))) : null);
  }
  function KitGuide(p) {
    const C = palette(), h = React.createElement;
    const [open, setOpen] = React.useState(true);
    const steps = p.steps || [];
    return h(RN.View, { style: { marginTop: 4, marginBottom: 16, borderRadius: 20, backgroundColor: C.card, borderWidth: 1, borderColor: C.card2, overflow: "hidden" } },
      h(RN.Pressable, { onPress: () => setOpen(!open), accessibilityRole: "button", accessibilityState: { expanded: open }, style: ({ pressed }) => ({ flexDirection: "row", alignItems: "center", padding: 16, backgroundColor: pressed ? C.press : "transparent" }) },
        KitTile({ k: "guide", size: 34 }),
        h(RN.View, { style: { flex: 1 } },
          h(RN.Text, { style: { color: C.text, fontSize: 17, fontWeight: "800" } }, p.title || "Quick guide"),
          h(RN.Text, { style: { color: C.sub, fontSize: 13, marginTop: 2 } }, steps.length + " short steps")),
        h(RN.View, { style: { width: 24, alignItems: "center", justifyContent: "center" } }, KitChevron({ dir: open ? "up" : "down", color: C.sub, size: 9 }))),
      open ? h(RN.View, { style: { paddingHorizontal: 16, paddingBottom: 6 } }, ...steps.map((s, i) =>
        h(RN.View, { key: "guide-" + i, style: { flexDirection: "row", paddingTop: 12, paddingBottom: 14, borderTopWidth: 1, borderTopColor: C.card2 } },
          h(RN.View, { style: { width: 26, height: 26, borderRadius: 13, backgroundColor: hexA(C.blurple, 0.2), alignItems: "center", justifyContent: "center", marginRight: 13, marginTop: 1 } },
            h(RN.Text, { style: { color: C.blurple, fontSize: 13, fontWeight: "800" } }, String(i + 1))),
          h(RN.View, { style: { flex: 1 } },
            h(RN.Text, { style: { color: C.text, fontSize: 15, fontWeight: "700", marginBottom: 3 } }, s[0]),
            h(RN.Text, { style: { color: C.sub, fontSize: 14, lineHeight: 20 } }, s[1]))))) : null);
  }
  function kitIso(d) { const z = (n) => (n < 10 ? "0" : "") + n; return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()); }
  function kitRange(key) {
    const now = new Date(), to = kitIso(now);
    if (key === "today") return { from: to, to };
    if (key === "7d") return { from: kitIso(new Date(now.getTime() - 6 * 86400000)), to };
    if (key === "30d") return { from: kitIso(new Date(now.getTime() - 29 * 86400000)), to };
    return { from: "", to: "" };
  }
  function kitRangeKey(from, to) {
    if (!from && !to) return "all";
    for (const k of ["today", "7d", "30d"]) { const r = kitRange(k); if (r.from === from && r.to === to) return k; }
    return "custom";
  }
  function kitValidDate(v) {
    const s = String(v || "").trim();
    return !s || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00")));
  }
  function KitSearchIcon(p) {
    const h = React.createElement;
    return h(RN.View, { style: { width: 18, height: 18 } },
      h(RN.View, { style: { position: "absolute", left: 1, top: 1, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: p.color } }),
      h(RN.View, { style: { position: "absolute", left: 11, top: 13, width: 7, height: 2, borderRadius: 1, backgroundColor: p.color, transform: [{ rotate: "45deg" }] } }));
  }
  function KitChip(p) {
    const C = palette(), h = React.createElement;
    return h(RN.Pressable, { onPress: p.onPress, accessibilityRole: "button", accessibilityState: { selected: !!p.active }, hitSlop: 4,
      style: ({ pressed }) => ({ height: 34, borderRadius: 17, paddingHorizontal: 14, marginRight: p.flush ? 0 : 8, marginBottom: p.flush ? 0 : 8, flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: p.active ? C.blurple : C.chip, opacity: pressed ? 0.8 : 1 }) },
      h(RN.Text, { numberOfLines: 1, style: { color: p.active ? "#FFFFFF" : C.text, fontSize: 14, fontWeight: "600" } }, p.label),
      p.badge ? h(RN.View, { style: { marginLeft: 7, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: p.active ? "rgba(255,255,255,0.28)" : hexA(C.blurple, 0.22), alignItems: "center", justifyContent: "center" } },
        h(RN.Text, { style: { color: p.active ? "#FFFFFF" : C.blurple, fontSize: 12, fontWeight: "800" } }, String(p.badge))) : null);
  }
  function KitFilter(p) {
    const C = palette(), h = React.createElement;
    const query = String(p.query || ""), from = String(p.from || ""), to = String(p.to || "");
    const rangeKey = kitRangeKey(from, to);
    const hasQuery = !!query.trim(), hasDates = !!(from || to), active = hasQuery || hasDates;
    const [open, setOpen] = React.useState(!p.collapsible || active);
    const [custom, setCustom] = React.useState(rangeKey === "custom");
    const saved = Array.isArray(p.saved) ? p.saved : [];
    const set = (patch) => p.onChange({ query, from, to, ...patch });
    const label = (t) => h(RN.Text, { style: { color: C.sub, fontSize: 12, fontWeight: "700", letterSpacing: 0.3, marginTop: 14, marginBottom: 8 } }, t);
    const dateBox = (name, key, value) => h(RN.View, { key, style: { flex: 1, marginRight: key === "from" ? 8 : 0 } },
      h(RN.Text, { style: { color: C.sub, fontSize: 12, fontWeight: "600", marginBottom: 6 } }, name),
      h(CustomInput, { value, placeholder: "YYYY-MM-DD", onChangeText: (v) => set({ [key]: v }), autoCorrect: false, autoCapitalize: "none", keyboardType: "numbers-and-punctuation", style: kitValidDate(value) ? { minHeight: 44 } : { minHeight: 44, borderColor: "#ED4245" } }));
    const showBody = open || !p.collapsible;
    const chips = [["all", "All time"], ["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]];
    return h(RN.View, { style: { marginBottom: 18 } },
      h(RN.View, { style: { backgroundColor: C.card, borderRadius: 20, borderWidth: 1, borderColor: active ? hexA(C.blurple, 0.6) : C.card2, overflow: "hidden" } },
        h(RN.View, { style: { flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 8 } },
          KitSearchIcon({ color: C.sub }),
          h(RN.TextInput, { value: query, placeholder: p.placeholder || "Search author, channel, server or text", placeholderTextColor: C.sub, onChangeText: (v) => set({ query: v }), autoCorrect: false, autoCapitalize: "none", returnKeyType: "search", underlineColorAndroid: "transparent", style: { flex: 1, color: C.text, fontSize: 16, paddingVertical: 14, paddingHorizontal: 11 } }),
          query ? h(RN.Pressable, { onPress: () => set({ query: "" }), hitSlop: 8, accessibilityLabel: "Clear search", style: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.chip, alignItems: "center", justifyContent: "center", marginRight: 6 } },
            h(RN.Text, { style: { color: C.text, fontSize: 16, fontWeight: "700", marginTop: -1 } }, "\u00D7")) : null,
          p.collapsible ? KitChip({ label: "Filters", flush: true, active: open, badge: hasDates ? 1 : 0, onPress: () => setOpen(!open) }) : null),
        showBody ? h(RN.View, { style: { paddingHorizontal: 16, paddingBottom: 14, borderTopWidth: 1, borderTopColor: C.card2 } },
          label("PERIOD"),
          h(RN.View, { style: { flexDirection: "row", flexWrap: "wrap" } },
            ...chips.map(([k, t]) => h(RN.View, { key: k }, KitChip({ label: t, active: !custom && rangeKey === k, onPress: () => { setCustom(false); set(kitRange(k)); } }))),
            h(RN.View, { key: "custom" }, KitChip({ label: "Custom", active: custom || rangeKey === "custom", onPress: () => setCustom(true) }))),
          (custom || rangeKey === "custom") ? h(RN.View, { style: { flexDirection: "row", marginBottom: 4 } }, dateBox("From", "from", from), dateBox("To", "to", to)) : null,
          h(RN.View, { style: { flexDirection: "row", marginTop: 10 } },
            h(RN.View, { style: { flex: 1, marginRight: 6 } }, h(CustomAction, { title: "Clear", secondary: true, compact: true, top: 0, disabled: !active, onPress: () => { setCustom(false); p.onChange({ query: "", from: "", to: "" }); } })),
            h(RN.View, { style: { flex: 1, marginLeft: 6 } }, h(CustomAction, { title: "Save filter", compact: true, top: 0, disabled: !active || !p.onSave, onPress: () => p.onSave && p.onSave() }))),
          label("SAVED FILTERS"),
          saved.length ? h(RN.View, null, ...saved.map((item, i) => {
            const bits = [item.query, (item.from || item.to) ? ((item.from || "…") + " → " + (item.to || "…")) : ""].filter(Boolean).join("  ·  ");
            return h(RN.View, { key: "saved-" + i, style: { flexDirection: "row", alignItems: "center", backgroundColor: C.chip, borderRadius: 14, marginBottom: 8, overflow: "hidden" } },
              h(RN.Pressable, { onPress: () => p.onApplySaved && p.onApplySaved(item), style: ({ pressed }) => ({ flex: 1, paddingVertical: 11, paddingHorizontal: 14, backgroundColor: pressed ? C.press : "transparent" }) },
                h(RN.Text, { numberOfLines: 1, style: { color: C.text, fontSize: 15, fontWeight: "700" } }, item.name || "Saved filter"),
                bits ? h(RN.Text, { numberOfLines: 1, style: { color: C.sub, fontSize: 13, marginTop: 2 } }, bits) : null),
              h(RN.Pressable, { onPress: () => p.onDeleteSaved && p.onDeleteSaved(i, item), hitSlop: 6, accessibilityLabel: "Delete saved filter", style: { width: 44, alignSelf: "stretch", alignItems: "center", justifyContent: "center" } },
                h(RN.Text, { style: { color: C.sub, fontSize: 20, fontWeight: "600" } }, "\u00D7")));
          })) : h(RN.Text, { style: { color: C.sub, fontSize: 13, lineHeight: 18 } }, "Nothing saved yet. Set up a search and tap Save filter to reuse it later.")) : null),
      p.total != null ? h(RN.Text, { style: { color: active ? C.blurple : C.sub, fontSize: 13, fontWeight: "600", marginTop: 10, marginLeft: 8 } },
        active ? (p.matches + " of " + p.total + " match") : (p.total + " in total")) : null);
  }
  function kitMenuPill(label) {
    const C = palette(), h = React.createElement;
    return h(RN.View, { style: { flexDirection: "row", alignItems: "center", backgroundColor: hexA(C.blurple, 0.16), borderRadius: 12, paddingHorizontal: 11, paddingVertical: 7, marginLeft: 6 } },
      h(RN.Text, { numberOfLines: 1, style: { color: C.text, fontSize: 13, fontWeight: "700", maxWidth: 130 } }, String(label || "Select")),
      h(RN.View, { style: { marginLeft: 6 } }, KitChevron({ dir: "down", color: C.blurple, size: 7 })));
  }
  /* ---- end shared kit ---- */

  function Settings() {
    rainStore.useStore();
    const [screen, setScreen] = React.useState("main");
    const screenProgress = React.useRef(new RN.Animated.Value(1)).current;
    React.useEffect(() => { screenProgress.setValue(0); RN.Animated.timing(screenProgress, { toValue: 1, duration: 180, useNativeDriver: true }).start(); }, [screen]);
    const [limit, setLimit] = React.useState(PAGE);
    const [logFilter, setLogFilter] = React.useState({ query: "", from: "", to: "" });
    const [colorEditor, setColorEditor] = React.useState(null);
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

    const rowSet=new WeakSet(),sectionTitles=new WeakMap(),mark=(el)=>{rowSet.add(el);return el;},HEXCOLOR=/^#[0-9A-Fa-f]{6}$/;
    const Text=(props,...kids)=>h(RN.Text,props,...kids);
    const Section=(title)=>{const m=h(RN.View,{key:"sec-"+title});sectionTitles.set(m,title);return m;};
    const valueChip=(r)=>{if(!r)return null;if(r===">"||r==="\u203A")return Text({style:{color:C.sub,fontSize:24,marginLeft:7,fontWeight:"300"}},"\u203A");const v=String(r);if(HEXCOLOR.test(v))return h(RN.View,{style:{flexDirection:"row",alignItems:"center",marginLeft:8}},h(RN.View,{style:{width:20,height:20,borderRadius:10,backgroundColor:v,borderWidth:1,borderColor:C.divider}}));return Text({style:{color:C.sub,fontSize:14,marginLeft:8},numberOfLines:1},v);};
    const PressRow=(key,label,sub,onPress,right)=>mark(h(CustomRow,{key,title:label,subtitle:sub,onPress,noIcon:/^(logged-|ghost-history-|ignored-|saved-ping-filter-|filter-use-|filter-delete-)/.test(String(key)),trailing:(key==="capture-mode"||key==="retention")?kitMenuPill(right):valueChip(right)}));
    const switchRow=(key,label,sub,value,change)=>mark(h(CustomRow,{key,title:label,subtitle:sub,trailing:h(CustomSwitch,{value,onChange:change})}));
    const Btn=(key,title,onPress,color)=>mark(h(CustomAction,{key,title:key==="back"?"\u2039  Back":title,onPress,secondary:key!=="clear"&&key!=="test",danger:color===RED}));
    const Empty=(key,t)=>Text({key,style:{color:C.sub,fontSize:14,lineHeight:20,paddingHorizontal:14,paddingVertical:14,textAlign:"center"}},t),Title=(key,t)=>Text({key,style:{color:C.text,fontSize:22,fontWeight:"800",paddingTop:8,paddingBottom:8}},t);
    const compose=(list)=>{const out=[];let run=[],title=null,n=0;const flush=()=>{if(!run.length){if(title)out.push(h(CustomSection,{key:"section-"+n++,title}));title=null;return;}const rows=run.map((r,i)=>React.cloneElement(r,{last:i===run.length-1}));out.push(h(CustomSection,{key:"section-"+n++,title},...rows));run=[];title=null;};for(const el of list){if(el&&sectionTitles.has(el)){flush();title=sectionTitles.get(el);}else if(el&&rowSet.has(el))run.push(el);else{flush();if(el)out.push(el);}}flush();return out;};
    const Switch = (key, label, sub, onChange) => {
      const value = !!cfg()[key];
      const change = onChange || ((v) => { cfg()[key] = v; refreshUI(); });
      return switchRow(key, label, sub, value, change);
    };

    const back = () => Btn("back", "< Back", () => { setScreen("main"); refreshUI(); });

    const more = (total) => total > limit ? Btn("more", "Show more", () => setLimit(limit + PAGE)) : null;

    const saveCurrentLogFilter = () => {
      openNativeInputAlert({ id: "aml-filter-name", title: "Save filter", content: "Name this search", onSave: (name) => {
        const clean = String(name || "").trim();
        if (!clean) return;
        const saved = Array.isArray(cfg().savedLogFilters) ? cfg().savedLogFilters : [];
        cfg().savedLogFilters = [{ ...logFilter, name: clean }, ...saved.filter((item) => item.name !== clean)].slice(0, 20);
        refreshUI();
        toast("Filter saved");
      } });
    };

    const retentionLabel = () => (cfg().retentionDays === 7 ? "7 days" : cfg().retentionDays === 30 ? "30 days" : "Forever");
    const captureModeLabel = () => cfg().captureMode === "expanded" ? "All" : "Loaded";
    const captureModeDescription = () => cfg().captureMode === "expanded"
      ? "Captures messages delivered outside the open chat."
      : "Captures messages loaded in the open chat.";
    const chooseCaptureMode = (mode) => {
      cfg().captureMode = mode;
      if (mode === "loaded") clearRawBuffer();
      if (mode === "loaded") { cfg().receivedMessages = []; rawArchiveDirty = false; if (rawArchiveTimer) { clearTimeout(rawArchiveTimer); rawArchiveTimer = null; } }
      refreshUI();
    };
    const openCaptureModeMenu = () => {
      const select = (mode) => {
        chooseCaptureMode(mode);
        try { const hide = findByProps("openLazy", "hideActionSheet"); hide && hide.hideActionSheet && hide.hideActionSheet(); } catch (_) {}
      };
      try {
        const sheets = findByProps("showSimpleActionSheet");
        if (sheets && typeof sheets.showSimpleActionSheet === "function") {
          sheets.showSimpleActionSheet({ key: "capture-mode-selector", header: { title: "Capture mode" }, options: [
            { label: "All new messages", isMarked: cfg().captureMode === "expanded", onPress: () => select("expanded") },
            { label: "Loaded messages", isMarked: cfg().captureMode !== "expanded", onPress: () => select("loaded") }
          ] });
          return;
        }
      } catch (_) {}
      ask("Capture mode", "Choose which new messages to save.", [
        { text: "All new messages", onPress: () => select("expanded") },
        { text: "Loaded messages", onPress: () => select("loaded") }
      ]);
    };
    const editRawBufferLimit = () => {
      const saveLimit = (value) => {
        const count = Number(String(value || "").trim());
        if (!Number.isInteger(count) || count < MIN_RAW_BUFFER || count > MAX_RAW_BUFFER) {
          ask("Invalid message limit", "Enter a whole number from " + MIN_RAW_BUFFER + " to " + MAX_RAW_BUFFER + ".", [{ text: "OK" }]);
          return;
        }
        cfg().maxCachedMessages = count;
        trimRawBuffer();
        refreshUI();
      };
      try {
        openNativeInputAlert({ id: "aml-cache-limit", title: "Maximum cached messages", content: "Messages received by Discord · approx. 8 MiB cache budget", initialValue: rawBufferLimit(), keyboardType: "number-pad", onSave: saveLimit });
      } catch (_) { toast("Could not open cache limit settings"); }
    };
    const editColor=(key,title,defaultValue)=>{setColorEditor({key,title,defaultValue});setScreen("color");};
    const chooseRetention = (days) => {
      cfg().retentionDays = days;
      if (purge()) markDirty();
      refreshUI();
    };
    const openRetentionMenu = () => {
      const select = (days) => {
        chooseRetention(days);
        try { const hide = findByProps("openLazy", "hideActionSheet"); hide && hide.hideActionSheet && hide.hideActionSheet(); } catch (_) {}
      };
      try {
        const sheets = findByProps("showSimpleActionSheet");
        if (sheets && typeof sheets.showSimpleActionSheet === "function") {
          sheets.showSimpleActionSheet({ key: "aml-retention-selector", header: { title: "Keep saved messages for" }, options: [
            { label: "Forever", isMarked: !cfg().retentionDays, onPress: () => select(0) },
            { label: "7 days", isMarked: cfg().retentionDays === 7, onPress: () => select(7) },
            { label: "30 days", isMarked: cfg().retentionDays === 30, onPress: () => select(30) }
          ] });
          return;
        }
      } catch (_) {}
      ask("Keep saved messages for", "Choose how long saved logs are kept.", [
        { text: "Forever", onPress: () => select(0) },
        { text: "7 days", onPress: () => select(7) },
        { text: "30 days", onPress: () => select(30) }
      ]);
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
        h(KitFilter, { key: "kit-filter", collapsible: true, query: logFilter.query, from: logFilter.from, to: logFilter.to, matches: filtered.length, total: entries.length,
          saved: Array.isArray(cfg().savedLogFilters) ? cfg().savedLogFilters : [],
          onChange: (next) => { setLogFilter({ query: next.query, from: next.from, to: next.to }); setLimit(PAGE); },
          onSave: saveCurrentLogFilter,
          onApplySaved: (item) => { setLogFilter({ query: item.query || "", from: item.from || "", to: item.to || "" }); setLimit(PAGE); },
          onDeleteSaved: (index, item) => ask("Delete saved filter?", item.name || "Saved filter", [{ text: "Delete", style: "destructive", onPress: () => { const latest = Array.isArray(cfg().savedLogFilters) ? cfg().savedLogFilters : []; cfg().savedLogFilters = latest.filter((_, i) => i !== index); refreshUI(); } }]) })];
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
    if(screen==="color"&&colorEditor){
      const presets=[["Default",colorEditor.defaultValue],["Orange","#F07B3E"],["Gold","#F1C40F"],["Green","#43B581"],["Teal","#1ABC9C"],["Blue","#3498DB"],["Indigo","#5865F2"],["Purple","#9B59B6"],["Pink","#EB459E"],["Gray","#80848E"]];
      const current=colorValue(colorEditor.key,colorEditor.defaultValue);
      const applyColor=(v)=>{cfg()[colorEditor.key]=v;refreshStyledMessages();setColorEditor(null);setScreen("main");refreshUI();};
      content=[
        Text({key:"color-title",style:{color:C.text,fontSize:20,fontWeight:"700",marginBottom:6}},colorEditor.title),
        Text({key:"color-help",style:{color:C.sub,fontSize:14,marginBottom:8}},"Choose a color preset. Your choice saves automatically."),

        h(CustomSection,{key:"color-presets",title:"Color presets"},...presets.map(([label,hex],index)=>h(CustomRow,{key:"color-"+hex,title:label,last:index===presets.length-1,trailing:h(RN.View,{style:{flexDirection:"row",alignItems:"center",gap:10,marginRight:6}},h(RN.View,{style:{width:20,height:20,borderRadius:10,backgroundColor:hex}}),current===hex?h(RN.Text,{style:{color:C.blurple,fontWeight:"800",width:18,textAlign:"center"}},"✓"):h(RN.View,{style:{width:18}})),onPress:()=>applyColor(hex)}))),
        h(CustomAction,{key:"color-default",title:"Use default",secondary:true,onPress:()=>applyColor(colorEditor.defaultValue)})
      ];
    }
    else if (screen === "deleted" || screen === "edited") content = loggedScreen(screen);
    else if (screen === "ignored") content = ignoredScreen();
    else {
      const ig = ignored();
      const ignoredCount = Object.keys(ig.guilds).length + Object.keys(ig.channels).length + Object.keys(ig.users).length;
      content = [
        Section("Logging"),
        Switch("redName", "Color deleted usernames", "Apply a separate color to the sender's name", (v) => { cfg().redName = v; refreshStyledMessages(); refreshUI(); }),
        Switch("logEdited", "Keep edited messages", "Previous versions appear above the new text in the selected color"),
        Switch("persist", "Save across restarts", "Store logged messages on this device", (v) => { setPersist(v); refreshUI(); }),
        Switch("notifyDeleted", "Notify about deleted messages", "Show a Jump to message alert for deleted DMs only"),
        Switch("notifyEdited", "Notify about edited messages", "Show a Jump to message alert for edited DMs only"),
        Section("Message capture"),
        PressRow("capture-mode", "Capture mode", captureModeDescription(), openCaptureModeMenu, captureModeLabel()),
        Switch("rememberReceivedMessages", "Remember new messages", "Save new messages received by Discord on this device across restarts.", (v) => {
          cfg().rememberReceivedMessages = v;
          if (!v) { rawArchiveIds.clear(); cfg().receivedMessages = []; rawArchiveDirty = false; if (rawArchiveTimer) { clearTimeout(rawArchiveTimer); rawArchiveTimer = null; } }
          else scheduleRawArchiveSave();
          refreshUI();
        }),
        PressRow("test-capture", "Test message capture", "Count new messages since this plugin started", showCaptureTest, ">"),
        PressRow("cache-limit", "Maximum cached messages", "Delivered messages only · capped memory cache", editRawBufferLimit, String(rawBufferLimit())),
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
        PressRow("retention", "Keep saved messages for", "Older logs are removed automatically", openRetentionMenu, retentionLabel()),
        Section("Logs"),
        PressRow("nav-deleted", "Deleted messages", deleted.size + " logged", () => go("deleted"), ">"),
        PressRow("nav-edited", "Edited messages", edits.size + " logged", () => go("edited"), ">"),
        PressRow("nav-ignored", "Ignored items", ignoredCount + " ignored", () => go("ignored"), ">"),
        Btn("clear", "Clear all logged messages", () => {
          ask("Clear all logged messages?", "This removes every stored deleted and edited message, including the ones saved on this device.", [
            { text: "Clear", style: "destructive", onPress: () => { clearAll(); refreshUI(); } },
          ]);
        }, RED),
      ];
    }

    const helpFooter = screen === "main" ? h(KitGuide, { key: "settings-guide", title: "Quick guide", steps: [["How capture works","Messages Discord delivers to this device are kept in a small local cache while Remember new messages is on. That cache is how a deleted message can still be shown. Capture mode All records every event the app receives; Loaded only covers chats that are already loaded. Messages that never reached this device, or arrived while the app was closed, can't be recovered."],["Review what was logged","Open Deleted messages or Edited messages under Logs. Tap an entry to jump to it. Use the search bar and the Filters button to narrow by text, author, channel, server or date, and save the filters you reuse."],["Make changes stand out in chat","Deleted messages and the previous versions of edits are colored right in the chat. Choose the colors, username highlight and time labels under Display."],["Keep the noise out","Ignore servers, channels or users you don't care about, and skip bots or your own messages under Filters. Review or undo everything from Ignored items."],["Storage and privacy","Save across restarts is off by default, so logs are not kept after the app restarts unless you turn it on. Choose how long entries are kept; older ones are removed automatically, and you can clear everything at any time."]] }) : null;
    const buildLabel = Text({ key: "build", style: { color: C.sub, fontSize: 12, textAlign: "center", marginTop: 1, opacity: 0.7 } }, "Advanced Message Logger " + BUILD);
    const header = screen === "main" ? [h(KitHero, { key: "hero", icon: "chat", title: "Advanced Message Logger", subtitle: "Message history and capture preferences", stats: (() => { const ig = ignored(); return [["Deleted", deleted.size], ["Edited", edits.size], ["Ignored", Object.keys(ig.guilds).length + Object.keys(ig.channels).length + Object.keys(ig.users).length]]; })() })] : [];
    return h(RN.Animated.View, { style: { flex: 1, opacity: screenProgress, transform: [{ translateY: screenProgress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] } }, h(RN.ScrollView, { key: screen, style: { flex: 1 }, keyboardShouldPersistTaps: "handled", contentContainerStyle: { padding: 16, paddingBottom: 42 } }, ...header, ...compose(content), helpFooter, buildLabel));
  }

  function initializeAfterHydration() {
    if (!loadRequested || initialized) return;
    initialized = true;
    dmAlertQueue.length = 0;
    dmAlertShowing = false;
    receivedThisSession = 0;
    receivedDMsThisSession = 0;
    receivedChannelsThisSession.clear();
    const s = cfg();
    const defaults = {
      logDeleted: true, logEdited: true, persist: false, rememberReceivedMessages: true, redName: true, skipOwn: true, skipBots: true,
      showDeletedTime: false, showEditTime: false, retentionDays: 0, captureMode: "expanded", maxCachedMessages: DEFAULT_RAW_BUFFER,
      deletedMessageColor: RED, editedMessageColor: GREY, deletedNameColor: RED, use12HourClock: false,
      notifyDeleted: false, notifyEdited: false,
    };
    for (const k of Object.keys(defaults)) if (s[k] === undefined) s[k] = defaults[k];
    if (s.defaultsV2 !== 1) {
      s.logEdited = true; s.redName = true; s.rememberReceivedMessages = true; s.skipOwn = true; s.skipBots = true;
      s.captureMode = "expanded";
      if (!(Number(s.maxCachedMessages) > 5000)) s.maxCachedMessages = DEFAULT_RAW_BUFFER;
      s.defaultsV2 = 1;
    }
    if (s.captureModeDefaultMigration !== 1) { s.captureMode = "expanded"; s.captureModeDefaultMigration = 1; }
    if (s.maxCachedMessagesDefaultMigration !== 1) {
      if (Number(s.maxCachedMessages) === 500) s.maxCachedMessages = DEFAULT_RAW_BUFFER;
      s.maxCachedMessagesDefaultMigration = 1;
    }
    if (s.captureMode !== "loaded" && s.captureMode !== "expanded") s.captureMode = "expanded";
    if (s.rememberReceivedMessages === undefined) s.rememberReceivedMessages = true;
    if (s.ignoreOwnDefaultMigration !== 1) {
      s.skipOwn = true;
      s.ignoreOwnDefaultMigration = 1;
    }
    if (!s.ignored) s.ignored = { channels: {}, guilds: {}, users: {} };
    renderErrors = 0;

    if (!loadStores()) { toast("Advanced Message Logger: required Discord modules not found"); return; }
    clearRawBuffer();
    restoreRawArchive();
    if (s.pings) s.pings = undefined;
    if (s.persist) loadSaved();
    if (purge()) markDirty();

    try { unpatches.push(patcher.before("dispatch", FluxDispatcher, hookDispatch)); }
    catch (_) { return; }
    try {
      gplBridge = {
        active: true,
        getKnownMessage: (channelId, id) => getKnownMessage(channelId, id),
        ownsRecentCache: () => cfg().captureMode === "expanded",
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
        else { flush(); flushRawArchive(); }
      });
    } catch (_) {}
  }

  function onLoad() {
    loadRequested = true;
    const store = rainStore.useStore;
    if (store.getState()._hasHydrated) { initializeAfterHydration(); return; }
    const checkHydration = (state) => {
      if (!loadRequested || !state._hasHydrated) return;
      if (hydrationUnsubscribe) hydrationUnsubscribe();
      hydrationUnsubscribe = null;
      initializeAfterHydration();
    };
    hydrationUnsubscribe = store.subscribe(checkHydration);
    checkHydration(store.getState());
  }

  function onUnload() {
    loadRequested = false;
    if (hydrationUnsubscribe) { hydrationUnsubscribe(); hydrationUnsubscribe = null; }
    if (!initialized) return;
    initialized = false;
    for (const t of pendingTimers) clearTimeout(t);
    pendingTimers.clear();
    dmAlertQueue.length = 0;
    dmAlertShowing = false;
    flush();
    flushRawArchive();
    for (const u of unpatches.splice(0)) { try { u(); } catch (_) {} }
    if (renderUnpatch) { try { renderUnpatch(); } catch (_) {} renderUnpatch = null; }
    if (appStateSub && appStateSub.remove) { try { appStateSub.remove(); } catch (_) {} }
    appStateSub = null;
    deleted.clear();
    edits.clear();
    rawSaved.clear();
    clearRawBuffer();
    allowDelete.clear();
    try { if (globalThis[GPL_BRIDGE_KEY] === gplBridge) delete globalThis[GPL_BRIDGE_KEY]; } catch (_) {}
    gplBridge = null;
  }

  return { onLoad, onUnload, settings: Settings };
})();

// @ts-ignore Discord evaluates this file as a CommonJS plugin entry.
module.exports = {
  start() { implementation.onLoad(); },
  stop() { implementation.onUnload(); },
  settings: implementation.settings,
};
