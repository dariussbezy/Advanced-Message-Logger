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
  const MAX_PINGS = 100;
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
  const seenMenus = new Map();
  const unpatches = [];
  let pings = [];
  let ActionSheet;
  let MessageStore;
  let UserStore;
  let ChannelStore;
  let GuildStore;
  let SelectedChannelStore;
  let ThemeStore;
  let renderUnpatch = null;
  let renderErrors = 0;
  let dirty = false;
  let pingDirty = false;
  let saveTimer = null;
  let appStateSub = null;

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

  function flipIgnore(kind, id, name) {
    const ig = JSON.parse(JSON.stringify(ignored()));
    let now;
    if (ig[kind][id]) { delete ig[kind][id]; now = false; }
    else { ig[kind][id] = name || id; now = true; }
    cfg().ignored = ig;
    toast((now ? "Logger now ignores " : "Logger no longer ignores ") + (name || id));
    return now;
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
    const kept = pings.filter((p) => p.at >= cutoff);
    if (kept.length !== pings.length) { pings = kept; changed = true; pingDirty = true; }
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
  function markPingDirty() {
    pingDirty = true;
    schedule();
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!dirty && !pingDirty) return;
    const wasDirty = dirty;
    const wasPing = pingDirty;
    dirty = false;
    pingDirty = false;
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
      if (wasPing || changed) cfg().pings = pings.slice();
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

  function isReplyToMe(msg, channelId, me) {
    const ref = msg.messageReference;
    if (!ref) return false;
    const refId = ref.message_id || ref.messageId;
    const refChannel = ref.channel_id || ref.channelId || channelId;
    const target = refId ? getMessage(refChannel, refId) : null;
    if (target && target.author && target.author.id === me) return true;
    const embedded = msg.referencedMessage && msg.referencedMessage.message;
    const alt = embedded || msg.referenced_message;
    return !!(alt && alt.author && alt.author.id === me);
  }

  function mentionsMe(msg, me) {
    if (msg.mentioned === true) return true;
    try {
      for (const m of msg.mentions || []) {
        if ((typeof m === "string" ? m : m && m.id) === me) return true;
      }
    } catch (_) {}
    return false;
  }

  function checkGhostPing(msg, channelId, guildId) {
    const s = cfg();
    if (!s.ghostPing) return;
    const me = myId();
    if (!me || !msg.author || msg.author.id === me) return;
    let kind = null;
    if (s.pingDMs && isDM(getChannel(channelId))) kind = "dm";
    if (!kind && s.pingReplies && isReplyToMe(msg, channelId, me)) kind = "reply";
    if (!kind && s.pingMentions && mentionsMe(msg, me)) kind = "mention";
    if (!kind || pings.some((p) => p.id === msg.id)) return;
    const entry = {
      id: msg.id, c: channelId, g: guildId || null, ai: msg.author.id, an: nameOf(msg.author),
      t: clip(msg.content, 300), k: kind, at: Date.now(),
    };
    pings.unshift(entry);
    if (pings.length > MAX_PINGS) pings.length = MAX_PINGS;
    markPingDirty();
    const what = kind === "dm" ? "deleted a message in your DM" : kind === "reply" ? "deleted a reply to you" : "deleted a message that mentioned you";
    toast("Ghost ping: " + entry.an + " " + what);
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

  const blocked = () => ({ type: "GHOST_LOGGER_BLOCKED" });

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
    checkGhostPing(msg, e.channelId, guildId);
    if (!cfg().logDeleted) return null;
    markDeleted(msg, e.channelId, e.id, guildId);
    return blocked();
  }

  function onBulkDelete(e) {
    if (!Array.isArray(e.ids)) return null;
    if (e.ids.length && e.ids.every(isAllowed)) return null;
    const guildId = e.guildId || guildOf(e.channelId);
    const pass = [];
    let kept = 0;
    for (const id of e.ids) {
      const msg = getMessage(e.channelId, id);
      if (!msg || shouldSkip(msg, e.channelId, guildId)) { pass.push(id); continue; }
      checkGhostPing(msg, e.channelId, guildId);
      if (!cfg().logDeleted) { pass.push(id); continue; }
      markDeleted(msg, e.channelId, id, guildId);
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
    if (en.v.length > MAX_VERSIONS) en.v.shift();
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
        try { FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", id, channelId, guildId }); } catch (_) {}
        setTimeout(() => {
          try {
            if (getMessage(channelId, id)) {
              FluxDispatcher.dispatch({ type: "MESSAGE_DELETE_BULK", ids: [id], channelId, guildId });
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

  function removePing(id) {
    pings = pings.filter((p) => p.id !== id);
    markPingDirty();
  }

  function jumpTo(channelId, guildId, messageId) {
    const link = "https://discord.com/channels/" + (guildId || "@me") + "/" + channelId + (messageId ? "/" + messageId : "");
    try {
      const u = metro.common.url || findByProps("openDeeplink");
      if (u && typeof u.openDeeplink === "function") { u.openDeeplink(link); return; }
      if (u && typeof u.openURL === "function") { u.openURL(link); return; }
    } catch (_) {}
    try { RN.Linking.openURL(link); } catch (_) {}
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

  function askIgnore(message) {
    const channelId = message.channel_id || message.channelId || currentChannelId();
    const guildId = message.guild_id || guildOf(channelId);
    const author = message.author;
    const ig = ignored();
    const buttons = [];
    if (author && author.id) {
      const n = nameOf(author);
      buttons.push({ text: (ig.users[author.id] ? "Stop ignoring " : "Ignore ") + n, onPress: () => flipIgnore("users", author.id, n) });
    }
    if (channelId) {
      const dm = isDM(getChannel(channelId));
      const label = channelLabel(channelId, guildId);
      buttons.push({ text: (ig.channels[channelId] ? "Stop ignoring " : "Ignore ") + (dm ? "this DM" : "this channel"), onPress: () => flipIgnore("channels", channelId, label) });
    }
    if (guildId) {
      const gn = guildName(guildId) || guildId;
      buttons.push({ text: (ig.guilds[guildId] ? "Stop ignoring " : "Ignore ") + "this server", onPress: () => flipIgnore("guilds", guildId, gn) });
    }
    if (buttons.length) ask("Basic Message Logger", "Choose what the logger should ignore.", buttons);
  }

  function messagePlan(message) {
    if (!message || !message.id) return null;
    const plan = [];
    const en = edits.get(message.id);
    if (en && en.v.length) plan.push({ key: "bml-view-edits", label: "View edit history", icon: "history", press: () => showEdits(message) });
    if (deleted.has(message.id)) plan.push({ key: "bml-remove-log", label: "Remove logged message", icon: "trash", press: () => removeLog(message) });
    else if (en) plan.push({ key: "bml-remove-log", label: "Remove edit history", icon: "trash", press: () => removeLog(message) });
    plan.push({ key: "bml-ignore", label: "Ignore in logger...", icon: "eye", press: () => askIgnore(message) });
    return plan;
  }

  function scopePlan(key, ctx) {
    if (typeof key !== "string" || !ctx || typeof ctx !== "object" || SKIP_MENU.test(key)) return null;
    const make = (kind, id, name, word) => {
      const on = !!ignored()[kind][id];
      return [{
        key: "bml-ignore-" + kind,
        label: (on ? "Stop ignoring this " : "Ignore this ") + word + " in logger",
        icon: "eye",
        press: () => flipIgnore(kind, id, name),
      }];
    };
    try {
      if (/guild|server/i.test(key)) {
        const g = ctx.guild || (ctx.guildId && GuildStore.getGuild(ctx.guildId));
        if (g && g.id) return make("guilds", g.id, g.name || g.id, "server");
      }
      if (/channel|dm|thread/i.test(key)) {
        const c = ctx.channel || getChannel(ctx.channelId);
        if (c && c.id) return make("channels", c.id, channelLabel(c.id, c.guild_id), isDM(c) ? "DM" : "channel");
      }
      if (/user|profile|member/i.test(key)) {
        const u = ctx.user || (ctx.userId && UserStore.getUser(ctx.userId));
        if (u && u.id) return make("users", u.id, nameOf(u), "user");
      }
    } catch (_) {}
    return null;
  }

  function findGroups(node, seen, depth, out) {
    if (!node || typeof node !== "object" || depth > 40 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      const rows = node.filter((e) => e && e.props && typeof e.props.onPress === "function" &&
        (typeof e.props.message === "string" || typeof e.props.label === "string"));
      if (rows.length) { out.push({ list: node, rows }); return; }
      for (const c of node) findGroups(c, seen, depth + 1, out);
      return;
    }
    if (node.props) findGroups(node.props.children, seen, depth + 1, out);
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
    const cur = tpl.props.icon;
    if (!id || cur === undefined) return undefined;
    if (typeof cur === "number") return id;
    if (cur && typeof cur === "object" && cur.props && cur.props.source !== undefined) {
      return React.cloneElement(cur, { source: id });
    }
    return undefined;
  }

  function addButtons(tree, plan) {
    const groups = [];
    findGroups(tree, new Set(), 0, groups);
    if (!groups.length) return;
    if (groups.some((g) => g.list.some((e) => e && typeof e.key === "string" && e.key.startsWith("bml-")))) return;
    const last = groups[groups.length - 1];
    const neutral = groups.length > 1 ? groups[groups.length - 2] : last;
    const tpl = neutral.rows[0];
    const elements = plan.map((item) => {
      const props = {
        key: item.key,
        onPress: () => {
          try { ActionSheet && ActionSheet.hideActionSheet && ActionSheet.hideActionSheet(); } catch (_) {}
          item.press();
        },
      };
      if (typeof tpl.props.message === "string") props.message = item.label;
      if (typeof tpl.props.label === "string") props.label = item.label;
      const icon = withIcon(tpl, pickIcon(item.icon));
      if (icon !== undefined) props.icon = icon;
      return React.cloneElement(tpl, props);
    });
    last.list.splice(0, 0, ...elements);
  }

  function hookSheet(args) {
    try {
      const [component, key, ctx] = args;
      if (!component || typeof component.then !== "function") return;
      if (typeof key === "string" && cfg().devMenus && !seenMenus.has(key)) {
        seenMenus.set(key, Object.keys(ctx || {}).slice(0, 8).join(","));
        trimMap(seenMenus, 30);
      }
      const plan = key === "MessageLongPressActionSheet" ? messagePlan(ctx && ctx.message) : scopePlan(key, ctx);
      if (!plan || !plan.length) return;
      component.then((instance) => {
        const un = patcher.after("default", instance, (_, tree) => {
          React.useEffect(() => () => { un(); }, []);
          try { addButtons(tree, plan); } catch (_) {}
        });
      });
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
        for (const v of versions.slice(-MAX_SHOWN)) head = head.concat(paint([{ type: "text", content: v.t + "\n" }], grey));
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
    const refreshUI = () => bump((x) => x + 1);
    const F = ui.components && ui.components.Forms;
    const C = palette();
    const h = React.createElement;

    const go = (name) => { setLimit(PAGE); setScreen(name); };

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
      if (purge()) { markDirty(); markPingDirty(); }
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
          if (en.c) buttons.push({ text: "Jump to message", onPress: () => jumpTo(en.c, en.g, en.id) });
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

    const pingsScreen = () => {
      const label = { dm: "DM", reply: "Reply", mention: "Mention" };
      const rows = [back(), h(RN.View, { key: "title", style: { paddingHorizontal: 16, paddingVertical: 8 } },
        Text({ style: { color: C.text, fontSize: 20, fontWeight: "700" } }, "Ghost pings (" + pings.length + ")"))];
      if (pings.length) {
        rows.push(Btn("clear-pings", "Clear ghost ping history", () => {
          ask("Clear ghost ping history?", "This removes every saved ghost ping.", [
            { text: "Clear", style: "destructive", onPress: () => { pings = []; markPingDirty(); refreshUI(); } },
          ]);
        }, RED));
      } else {
        rows.push(Text({ key: "empty", style: { color: C.sub, padding: 16 } }, "No ghost pings yet."));
      }
      for (const p of pings.slice(0, limit)) {
        rows.push(PressRow(p.id, snippet(p.t), label[p.k] + " · " + p.an + " · " + channelLabel(p.c, p.g) + " · " + fmtTime(p.at), () => {
          ask(label[p.k] + " from " + p.an, clip(p.t, 600), [
            { text: "Jump to message", onPress: () => jumpTo(p.c, p.g, p.id) },
            { text: "Remove", style: "destructive", onPress: () => { removePing(p.id); refreshUI(); } },
          ]);
        }));
      }
      const m = more(pings.length);
      if (m) rows.push(m);
      return rows;
    };

    const ignoredScreen = () => {
      const ig = ignored();
      const groups = [["guilds", "Servers"], ["channels", "Channels and DMs"], ["users", "Users"]];
      const total = groups.reduce((n, g) => n + Object.keys(ig[g[0]]).length, 0);
      const rows = [back(), h(RN.View, { key: "title", style: { paddingHorizontal: 16, paddingVertical: 8 } },
        Text({ style: { color: C.text, fontSize: 20, fontWeight: "700" } }, "Ignored (" + total + ")"))];
      if (!total) rows.push(Text({ key: "empty", style: { color: C.sub, padding: 16 } }, "Nothing is ignored. Long-press a server, channel, DM or message and choose the ignore option."));
      for (const [kind, title] of groups) {
        const ids = Object.keys(ig[kind]);
        if (!ids.length) continue;
        rows.push(Section(title));
        for (const id of ids) {
          rows.push(PressRow(kind + id, ig[kind][id], "Tap to stop ignoring", () => {
            ask("Stop ignoring?", ig[kind][id], [{ text: "Stop ignoring", onPress: () => { flipIgnore(kind, id, ig[kind][id]); refreshUI(); } }]);
          }));
        }
      }
      return rows;
    };

    let content;
    if (screen === "deleted" || screen === "edited") content = loggedScreen(screen);
    else if (screen === "pings") content = pingsScreen();
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
        Section("Ghost pings"),
        Switch("ghostPing", "Ghost ping detector", "Notify when a message that pinged you gets deleted"),
        Switch("pingMentions", "Mentions", "Messages that mentioned you"),
        Switch("pingReplies", "Replies", "Replies to your messages"),
        Switch("pingDMs", "Direct messages", "Every deleted message in your DMs"),
        Section("Filters"),
        Switch("skipOwn", "Ignore my messages", "Your own deletes and edits behave normally"),
        Switch("skipBots", "Ignore bots", "Less noise in busy bot channels"),
        Section("Storage"),
        PressRow("retention", "Keep saved messages for", "Older logs are removed automatically", cycleRetention, retentionLabel()),
        Section("Logs"),
        PressRow("nav-deleted", "Deleted messages", deleted.size + " logged", () => go("deleted"), ">"),
        PressRow("nav-edited", "Edited messages", edits.size + " logged", () => go("edited"), ">"),
        PressRow("nav-pings", "Ghost ping history", pings.length + " saved", () => go("pings"), ">"),
        PressRow("nav-ignored", "Ignored servers, channels and users", ignoredCount + " ignored", () => go("ignored"), ">"),
        Btn("clear", "Clear all logged messages", () => {
          ask("Clear all logged messages?", "This removes every stored deleted and edited message, including the ones saved on this device.", [
            { text: "Clear", style: "destructive", onPress: () => { clearAll(); refreshUI(); } },
          ]);
        }, RED),
        Section("Advanced"),
        Switch("devMenus", "Detect menus", "Lists the menus you open, useful for bug reports"),
      ];
      if (cfg().devMenus) {
        const list = [...seenMenus.entries()].map(([k, v]) => k + ": " + v).join("\n") || "Open a menu, then come back.";
        content.push(h(RN.View, { key: "menus", style: { paddingHorizontal: 16, paddingVertical: 8 } },
          Text({ style: { color: C.sub, fontSize: 11 }, selectable: true }, list)));
      }
    }

    return h(RN.ScrollView, null, ...content);
  }

  function onLoad() {
    const s = cfg();
    const defaults = {
      logDeleted: true, logEdited: true, persist: false, redName: true, skipOwn: false, skipBots: false,
      showDeletedTime: false, showEditTime: false, ghostPing: true, pingMentions: true, pingReplies: true,
      pingDMs: true, retentionDays: 0, devMenus: false,
    };
    for (const k of Object.keys(defaults)) if (s[k] === undefined) s[k] = defaults[k];
    if (!s.ignored) s.ignored = { channels: {}, guilds: {}, users: {} };
    renderErrors = 0;

    if (!loadStores()) { toast("Basic Message Logger: required Discord modules not found"); return; }
    try { pings = Array.isArray(s.pings) ? JSON.parse(JSON.stringify(s.pings)) : []; } catch (_) { pings = []; }
    if (s.persist) loadSaved();
    if (purge()) { markDirty(); markPingDirty(); }

    try { unpatches.push(patcher.before("dispatch", FluxDispatcher, hookDispatch)); }
    catch (_) { return; }
    try { renderUnpatch = patchRender(); } catch (_) {}
    try {
      ActionSheet = findByProps("openLazy", "hideActionSheet");
      if (ActionSheet) unpatches.push(patcher.before("openLazy", ActionSheet, hookSheet));
    } catch (_) {}
    try {
      appStateSub = RN.AppState.addEventListener("change", (state) => {
        if (state === "active") { if (purge()) { markDirty(); markPingDirty(); } }
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
    seenMenus.clear();
    pings = [];
  }

  return { onLoad, onUnload, settings: Settings };
})()
