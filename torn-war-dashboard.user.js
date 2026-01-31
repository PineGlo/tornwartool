// ==UserScript==
// @name         Torn War Dashboard v3 (Enemy-only) + Robust Attack Links + Shared Cache + Travel Tracker + Alarms + FF Scouter Overlay
// @namespace    edj.torn.war.dashboard.v3
// @version      3.1.0
// @description  Enemy-only war dashboard with single-leader polling + lease, shared+persistent cache, robust war-page Attack link upgrades, next pops, filters/search, hospital/jail exit alarms + sound, Traveling trip tracker (observed duration + best-effort ETA), landing-soon + landed alarms (per-trip gated), attack-page timer box from shared cache, settings panel, draggable + collapsible UI. Also decorates rows using FF Scouter IndexedDB cache (bs_estimate + value) when available.
// @author       You
// @match        https://www.torn.com/factions.php*
// @match        https://torn.com/factions.php*
// @match        https://www.torn.com/loader.php*
// @match        https://torn.com/loader.php*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @connect      api.torn.com
// @run-at       document-end
// ==/UserScript==

(() => {
  "use strict";

  /********************************************************************
   * CONFIG
   ********************************************************************/
  const CFG = {
    // Polling
    FAST_POLL_MS: 666,           // ~90/min if visible
    SLOW_POLL_MS: 2500,          // backoff
    HIDDEN_POLL_MS: 1000,        // background polling when tab hidden
    LOOP_JITTER_MS: 140,         // small per-loop jitter
    API_WINDOW_MS: 60_000,
    API_REQ_LIMIT: 95,

    // Leader lease
    HEARTBEAT_MS: 1000,
    LEASE_MS: 4500,
    WATCHDOG_MS: 900,
    CLAIM_JITTER_MS: [250, 900],
    STARTUP_GRACE_MS: [1200, 2200],      // prevents "everyone claims leader at boot"
    LEADER_START_BACKOFF_MS: 2000,       // when becoming leader, wait before first request

    // UI
    UI_TICK_MS: 1000,
    MAX_ROWS: 70,
    NEXT_POPS_N: 6,
    HOT_UNDER_SEC: 300,          // highlight <5m
    CACHE_STALE_WARN_MS: 5000,
    UI_WIDTH: 460,
    UI_POS_DEFAULT: { top: 80, right: 12 },

    // Persistence
    PERSIST_CACHE_EVERY_MS: 5000,
    PERSIST_CACHE_MAX_AGE_MS: 60 * 60 * 1000,

    // Alarms
    ALARMS_DEFAULT_ON: true,
    TRAVEL_ALARMS_DEFAULT_ON: true,
    SOUND_DEFAULT_ON: true,
    HOSP_COOLDOWN_SEC: 30,
    TRAVEL_SOON_COOLDOWN_SEC: 120,
    TRAVEL_LANDED_COOLDOWN_SEC: 60,

    // Travel tracker
    LANDING_SOON_SEC: 30,
    MAX_REASONABLE_ETA_SEC: 6 * 60 * 60,
    FLIGHT_PURGE_INACTIVE_SEC: 15 * 60,
    ETA_USE_PRIVATE_ISLAND_DEFAULT: false,
    ETA_USE_BUSINESS_CLASS_DEFAULT: false,

    // Attack link behavior
    OPEN_ATTACK_NEW_TAB_DEFAULT: true,

    // FF Scouter overlay
    FFSCOUTER_OVERLAY_DEFAULT_ON: true,

    DEBUG: false,
  };

  const log = (...a) => CFG.DEBUG && console.log("[WarDashV3]", ...a);

  /********************************************************************
   * STORAGE KEYS
   ********************************************************************/
  const K = {
    API_KEY: "edj_wd_v3_public_api_key",
    ENEMY_FACTION_ID: "edj_wd_v3_enemy_faction_id",

    ALARMS_ON: "edj_wd_v3_alarms_on",
    TRAVEL_ALARMS_ON: "edj_wd_v3_travel_alarms_on",
    SOUND_ON: "edj_wd_v3_sound_on",
    OPEN_NEW_TAB: "edj_wd_v3_open_attack_new_tab",
    ETA_USE_PI: "edj_wd_v3_eta_use_pi",
    ETA_USE_BUSINESS: "edj_wd_v3_eta_use_business",

    // FF Scouter
    FFSC_ON: "edj_wd_v3_ffsc_on",

    PERSISTED_CACHE: "edj_wd_v3_persisted_cache",
    TRIPS: "edj_wd_v3_trips",

    UI_POS: "edj_wd_v3_ui_pos",
    UI_SIZE: "edj_wd_v3_ui_size",
    UI_COLLAPSED: "edj_wd_v3_ui_collapsed",
  };

  /********************************************************************
   * PAGE FLAGS
   ********************************************************************/
  const isWarPage = location.pathname.includes("factions.php");
  const isAttackPage = location.pathname.includes("loader.php") && location.search.includes("sid=attack");

  /********************************************************************
   * HELPERS
   ********************************************************************/
  function randInt(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function nowUnix() {
    if (typeof window.getCurrentTimestamp === "function") return Math.floor(window.getCurrentTimestamp());
    return Math.floor(Date.now() / 1000);
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function fmtSeconds(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    const ss = s % 60;
    if (m < 60) return m + ":" + pad2(ss);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return h + "h" + pad2(mm);
  }

  function pageVisible() { return !document.hidden; }

  function apiGetJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        onload: (res) => {
          try { resolve(JSON.parse(res.responseText)); }
          catch (e) { reject(e); }
        },
        onerror: reject,
        ontimeout: reject,
      });
    });
  }

  function extractUserIdFromProfileHref(href) {
    if (!href) return null;
    const s = String(href);
    const m = s.match(/[?&](?:XID|ID)=(\d+)/i);
    return m ? m[1] : null;
  }

  function buildAttackUrl(userId) { return "/loader.php?sid=attack&user2ID=" + userId; }
  function buildProfileUrl(userId) { return "/profiles.php?XID=" + userId; }

  /********************************************************************
   * FF Scouter IndexedDB Reader (local-only enrichment)
   * - Reads FF Scouter's local IndexedDB cache (if present)
   * - Decorates rows with bs_estimate + value
   ********************************************************************/
  const FFSC = {
    enabled: GM_getValue(K.FFSC_ON, CFG.FFSCOUTER_OVERLAY_DEFAULT_ON),
    DB_NAME: "ffscouter-cache",
    DB_VER: 1,
    STORE: "cache",

    // local memo
    dbPromise: null,
    byId: new Map(),               // userId -> record
    lastBatchMs: 0,
    BATCH_COOLDOWN_MS: 4000,       // don’t hammer IDB every render
  };

  function ffOpenDb() {
    if (FFSC.dbPromise) return FFSC.dbPromise;

    FFSC.dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(FFSC.DB_NAME, FFSC.DB_VER);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
      } catch (e) {
        reject(e);
      }
    });

    return FFSC.dbPromise;
  }

  // Read many IDs in one transaction.
  // Returns: { [id]: record }
  async function ffReadMany(playerIds) {
    const out = {};
    if (!FFSC.enabled || !playerIds || !playerIds.length) return out;

    let db;
    try {
      db = await ffOpenDb();
    } catch (_) {
      // DB not present / blocked / FF Scouter not installed
      return out;
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(FFSC.STORE, "readonly");
        const store = tx.objectStore(FFSC.STORE);

        let remaining = playerIds.length;

        playerIds.forEach((id) => {
          const pid = Number(id);
          const req = store.get(pid);

          req.onsuccess = () => {
            const r = req.result;
            // only keep fresh entries
            if (r && typeof r.expiry === "number" && r.expiry > Date.now()) {
              out[String(id)] = r;
            }
            remaining--;
            if (remaining === 0) resolve(out);
          };

          req.onerror = () => {
            remaining--;
            if (remaining === 0) resolve(out);
          };
        });
      } catch (_) {
        resolve(out);
      }
    });
  }

  function fmtFF(val) {
    if (typeof val !== "number") return "";
    return val.toFixed(2);
  }

  function uiApplyFFToRows(ids) {
    if (!UI.root || UI.collapsed) return;
    if (!FFSC.enabled) return;

    ids.forEach((id) => {
      const nodes = UI.rowNodes.get(String(id));
      if (!nodes || !nodes.lastSpan) return;

      const rec = FFSC.byId.get(String(id));

      let ffText = "";
      let bsText = "";

      if (rec && !rec.no_data) {
        if (typeof rec.value === "number") ffText = "FF " + fmtFF(rec.value);

        // bs_estimate and/or bs_estimate_human show up depending on version
        if (typeof rec.bs_estimate_human === "string" && rec.bs_estimate_human.trim()) {
          bsText = "BS " + rec.bs_estimate_human.trim();
        } else if (typeof rec.bs_estimate === "number") {
          bsText = "BS " + rec.bs_estimate;
        } else if (typeof rec.bs_estimate === "string" && rec.bs_estimate.trim()) {
          bsText = "BS " + rec.bs_estimate.trim();
        }
      }

      // base "last action"
      const base = (nodes.lastSpan.getAttribute("data-base-last") || nodes.lastSpan.textContent || "").trim();

      const parts = [base];
      if (ffText) parts.push(ffText);
      if (bsText) parts.push(bsText);

      nodes.lastSpan.textContent = parts.filter(Boolean).join(" • ");
    });
  }

  async function ffRefreshForIds(ids) {
    const now = Date.now();
    if (!FFSC.enabled) return;
    if (!ids || !ids.length) return;
    if (now - FFSC.lastBatchMs < FFSC.BATCH_COOLDOWN_MS) {
      uiApplyFFToRows(ids);
      return;
    }

    // Only request IDs we don't already have in memory
    const want = [];
    for (const id of ids) {
      const k = String(id);
      if (!FFSC.byId.has(k)) want.push(k);
    }
    if (!want.length) {
      uiApplyFFToRows(ids);
      return;
    }

    FFSC.lastBatchMs = now;

    const res = await ffReadMany(want);
    for (const [id, rec] of Object.entries(res)) {
      FFSC.byId.set(String(id), rec);
    }

    uiApplyFFToRows(ids);
  }

  /********************************************************************
   * NOTIFY + SOUND
   ********************************************************************/
  let soundOn = GM_getValue(K.SOUND_ON, CFG.SOUND_DEFAULT_ON);

  function beepFallback() {
    if (!soundOn) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.value = 0.06;
      o.start();
      setTimeout(() => { o.stop(); ctx.close(); }, 160);
    } catch (_) {}
  }

  function notify(title, text) {
    try {
      if (typeof GM_notification === "function") {
        GM_notification({ title, text, timeout: 4500, silent: !soundOn });
      } else {
        beepFallback();
      }
    } catch (_) {
      beepFallback();
    }
    log("NOTIFY:", title, text);
  }

  /********************************************************************
   * USER SETTINGS (LOCAL VARS REFRESHED FROM STORAGE WHEN NEEDED)
   ********************************************************************/
  let apiKey = GM_getValue(K.API_KEY, "");
  let enemyFactionId = GM_getValue(K.ENEMY_FACTION_ID, "");
  let alarmsOn = GM_getValue(K.ALARMS_ON, CFG.ALARMS_DEFAULT_ON);
  let travelAlarmsOn = GM_getValue(K.TRAVEL_ALARMS_ON, CFG.TRAVEL_ALARMS_DEFAULT_ON);
  let openAttackNewTab = GM_getValue(K.OPEN_NEW_TAB, CFG.OPEN_ATTACK_NEW_TAB_DEFAULT);
  let etaUsePrivateIsland = GM_getValue(K.ETA_USE_PI, CFG.ETA_USE_PRIVATE_ISLAND_DEFAULT);
  let etaUseBusinessClass = GM_getValue(K.ETA_USE_BUSINESS, CFG.ETA_USE_BUSINESS_CLASS_DEFAULT);

  function refreshSettingsFromStorage() {
    apiKey = GM_getValue(K.API_KEY, apiKey);
    enemyFactionId = GM_getValue(K.ENEMY_FACTION_ID, enemyFactionId);
    alarmsOn = GM_getValue(K.ALARMS_ON, alarmsOn);
    travelAlarmsOn = GM_getValue(K.TRAVEL_ALARMS_ON, travelAlarmsOn);
    soundOn = GM_getValue(K.SOUND_ON, soundOn);
    openAttackNewTab = GM_getValue(K.OPEN_NEW_TAB, openAttackNewTab);
    etaUsePrivateIsland = GM_getValue(K.ETA_USE_PI, etaUsePrivateIsland);
    etaUseBusinessClass = GM_getValue(K.ETA_USE_BUSINESS, etaUseBusinessClass);

    FFSC.enabled = GM_getValue(K.FFSC_ON, FFSC.enabled);
  }

  function hasValidApiKey() {
    return (typeof apiKey === "string" && apiKey.trim().length === 16);
  }

  /********************************************************************
   * MENU COMMANDS
   ********************************************************************/
  function setEnemyFactionIdPrompt() {
    const input = prompt("Set enemy faction ID (numbers only):", enemyFactionId || "");
    if (input && /^\d+$/.test(input.trim())) {
      enemyFactionId = input.trim();
      GM_setValue(K.ENEMY_FACTION_ID, enemyFactionId);
      Shared.cache.enemyFactionId = enemyFactionId;
      broadcastCacheUpdate();
      alert("Enemy faction ID set to " + enemyFactionId);
    }
  }

  try {
    GM_registerMenuCommand("WarDash v3: Open Settings", () => UISettings.open());
    GM_registerMenuCommand("WarDash v3: Set enemy faction ID (override)", () => setEnemyFactionIdPrompt());
    GM_registerMenuCommand("WarDash v3: Toggle hospital/jail alarms", () => {
      alarmsOn = !alarmsOn; GM_setValue(K.ALARMS_ON, alarmsOn);
      alert("Hospital/Jail alarms: " + (alarmsOn ? "ON" : "OFF"));
      UI.updateAlarmButtons();
    });
    GM_registerMenuCommand("WarDash v3: Toggle travel alarms", () => {
      travelAlarmsOn = !travelAlarmsOn; GM_setValue(K.TRAVEL_ALARMS_ON, travelAlarmsOn);
      alert("Travel alarms: " + (travelAlarmsOn ? "ON" : "OFF"));
      UI.updateAlarmButtons();
    });
    GM_registerMenuCommand("WarDash v3: Toggle sound", () => {
      soundOn = !soundOn; GM_setValue(K.SOUND_ON, soundOn);
      alert("Sound: " + (soundOn ? "ON" : "OFF"));
      UI.updateAlarmButtons();
    });
    GM_registerMenuCommand("WarDash v3: Toggle open Attack in new tab", () => {
      openAttackNewTab = !openAttackNewTab; GM_setValue(K.OPEN_NEW_TAB, openAttackNewTab);
      alert("Attack links open in " + (openAttackNewTab ? "NEW TAB" : "SAME TAB"));
      // re-upgrade links
      if (isWarPage) installAttackUpgrader(true);
      UISettings.sync();
    });
    GM_registerMenuCommand("WarDash v3: Toggle FF Scouter overlay", () => {
      FFSC.enabled = !FFSC.enabled;
      GM_setValue(K.FFSC_ON, FFSC.enabled);
      alert("FF Scouter overlay: " + (FFSC.enabled ? "ON" : "OFF"));
      renderFromCache();
    });
  } catch (_) {}

  /********************************************************************
   * SHARED CACHE + LEADER LEASE
   ********************************************************************/
  const BC_NAME = "edj_war_cache_v3";
  const bc = ("BroadcastChannel" in window) ? new BroadcastChannel(BC_NAME) : null;

  function validPersistedCache(c) {
    if (!c || c.schema !== "edj.warcache.v3") return false;
    if (typeof c.ts !== "number") return false;
    if ((Date.now() - c.ts) > CFG.PERSIST_CACHE_MAX_AGE_MS) return false;
    if (!c.enemyFactionId || !/^\d+$/.test(String(c.enemyFactionId))) return false;
    if (!c.members || typeof c.members !== "object") return false;
    return true;
  }

  const persisted = GM_getValue(K.PERSISTED_CACHE, null);

  const Shared = {
    leaderId: Date.now() + "-" + Math.random().toString(16).slice(2),
    isLeader: false,

    leaderFrom: "",
    leaseUntilMs: 0,
    leaderTerm: 0,
    becameLeaderAtMs: 0,

    reqTimesMs: [],
    pollMs: CFG.FAST_POLL_MS,

    cache: validPersistedCache(persisted) ? persisted : {
      schema: "edj.warcache.v3",
      ts: 0,
      enemyFactionId: enemyFactionId || "",
      members: {},
      meta: { lastApiOkMs: 0, lastApiErr: "" },
    },
  };

  function pruneReqTimes() {
    const cutoff = Date.now() - CFG.API_WINDOW_MS;
    while (Shared.reqTimesMs.length && Shared.reqTimesMs[0] < cutoff) Shared.reqTimesMs.shift();
  }
  function canMakeRequest() { pruneReqTimes(); return Shared.reqTimesMs.length < CFG.API_REQ_LIMIT; }
  function noteRequest() { Shared.reqTimesMs.push(Date.now()); }

  function bcSend(type, payload) {
    if (!bc) return;
    bc.postMessage({
      type,
      from: Shared.leaderId,
      term: Shared.leaderTerm,
      leaseUntilMs: Shared.leaseUntilMs,
      payload,
    });
  }

  let lastPersistMs = 0;
  function persistCacheThrottled() {
    const now = Date.now();
    if (now - lastPersistMs < CFG.PERSIST_CACHE_EVERY_MS) return;
    lastPersistMs = now;
    try { GM_setValue(K.PERSISTED_CACHE, Shared.cache); } catch (_) {}
  }

  function broadcastCacheUpdate() {
    bcSend("CACHE_UPDATE", { cache: Shared.cache });
    window.dispatchEvent(new CustomEvent("EDJ_CACHE_UPDATE"));
    persistCacheThrottled();
  }

  function assumeLeader(from, term, leaseUntilMs) {
    Shared.isLeader = (from === Shared.leaderId);
    Shared.leaderFrom = from || "";
    Shared.leaderTerm = term || Shared.leaderTerm;
    Shared.leaseUntilMs = leaseUntilMs || Shared.leaseUntilMs;
  }

  function startLeaderElection() {
    if (!bc) {
      // No BroadcastChannel: act as leader but poll slower (safer).
      Shared.isLeader = true;
      Shared.becameLeaderAtMs = Date.now();
      Shared.leaderFrom = Shared.leaderId;
      Shared.leaderTerm = 1;
      Shared.leaseUntilMs = Date.now() + CFG.LEASE_MS;
      Shared.pollMs = CFG.SLOW_POLL_MS;
      return;
    }

    // Startup grace so tabs don't all claim immediately on first load.
    if (!Shared.leaseUntilMs) {
      Shared.leaseUntilMs = Date.now() + randInt(CFG.STARTUP_GRACE_MS[0], CFG.STARTUP_GRACE_MS[1]);
    }

    bc.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg || !msg.type) return;

      if (msg.type === "LEADER_HEARTBEAT" || msg.type === "LEADER_CLAIM") {
        const theirTerm = msg.term || 0;
        const theirLease = msg.leaseUntilMs || 0;
        const theirFrom = msg.from || "";

        if (theirTerm > Shared.leaderTerm) {
          assumeLeader(theirFrom, theirTerm, theirLease);
          return;
        }
        if (theirTerm === Shared.leaderTerm && theirLease > Shared.leaseUntilMs) {
          assumeLeader(theirFrom, theirTerm, theirLease);
          return;
        }
      }

      if (msg.type === "CACHE_UPDATE") {
        const c = msg.payload && msg.payload.cache;
        if (c && c.schema === "edj.warcache.v3") {
          Shared.cache = c;
          if (c.enemyFactionId && c.enemyFactionId !== enemyFactionId) {
            enemyFactionId = c.enemyFactionId;
            GM_setValue(K.ENEMY_FACTION_ID, enemyFactionId);
          }
          window.dispatchEvent(new CustomEvent("EDJ_CACHE_UPDATE"));
          persistCacheThrottled();
        }
      }
    };

    // Leader heartbeat renews lease
    setInterval(() => {
      if (!Shared.isLeader) return;
      Shared.leaseUntilMs = Date.now() + CFG.LEASE_MS;
      bcSend("LEADER_HEARTBEAT", { ts: Date.now() });
    }, CFG.HEARTBEAT_MS);

    // Watchdog: claim leadership if lease expired (with jitter)
    setInterval(() => {
      const expired = Date.now() > (Shared.leaseUntilMs || 0);
      if (!expired) return;

      const delay = randInt(CFG.CLAIM_JITTER_MS[0], CFG.CLAIM_JITTER_MS[1]);
      setTimeout(() => {
        const stillExpired = Date.now() > (Shared.leaseUntilMs || 0);
        if (!stillExpired) return;

        Shared.isLeader = true;
        Shared.becameLeaderAtMs = Date.now();
        Shared.leaderFrom = Shared.leaderId;
        Shared.leaderTerm = (Shared.leaderTerm || 0) + 1;
        Shared.leaseUntilMs = Date.now() + CFG.LEASE_MS;

        bcSend("LEADER_CLAIM", { ts: Date.now() });
      }, delay);
    }, CFG.WATCHDOG_MS);
  }

  /********************************************************************
   * LEADER API POLL (ENEMY FACTION ONLY)
   ********************************************************************/
  let forcedSlowUntilMs = 0;

  async function leaderPollEnemyFaction() {
    if (!Shared.isLeader) return;

    // reduce double-leader spikes after a flip
    if (Shared.becameLeaderAtMs && (Date.now() - Shared.becameLeaderAtMs) < CFG.LEADER_START_BACKOFF_MS) {
      Shared.pollMs = CFG.SLOW_POLL_MS;
      return;
    }

    if (!pageVisible()) {
      Shared.pollMs = CFG.HIDDEN_POLL_MS;
      return;
    }

    // IMPORTANT: refresh settings on the leader tab
    refreshSettingsFromStorage();

    const fid = Shared.cache.enemyFactionId || enemyFactionId;
    if (!fid) return;

    if (!hasValidApiKey()) {
      Shared.cache.meta = Shared.cache.meta || {};
      Shared.cache.meta.lastApiErr = "missing_key";
      Shared.pollMs = CFG.SLOW_POLL_MS;
      broadcastCacheUpdate();
      return;
    }

    if (Date.now() < forcedSlowUntilMs) {
      Shared.pollMs = CFG.SLOW_POLL_MS;
      return;
    }

    if (!canMakeRequest()) {
      Shared.pollMs = CFG.SLOW_POLL_MS;
      return;
    }

    Shared.pollMs = CFG.FAST_POLL_MS;

    const url = "https://api.torn.com/faction/" + fid + "?selections=basic&key=" + apiKey + "&comment=edj_wd_v3";
    noteRequest();

    let json;
    try {
      json = await apiGetJson(url);
    } catch (e) {
      Shared.cache.meta = Shared.cache.meta || {};
      Shared.cache.meta.lastApiErr = "network/json";
      Shared.pollMs = CFG.SLOW_POLL_MS;
      broadcastCacheUpdate();
      return;
    }

    if (!json) return;

    if (json.error) {
      const code = (json.error && json.error.code) ? json.error.code : json.error;
      Shared.cache.meta = Shared.cache.meta || {};
      Shared.cache.meta.lastApiErr = "error_" + code;

      forcedSlowUntilMs = Date.now() + (code === 5 ? 60_000 : 12_000);
      Shared.pollMs = CFG.SLOW_POLL_MS;
      broadcastCacheUpdate();
      return;
    }

    if (!json.members || typeof json.members !== "object") return;

    Shared.cache = {
      schema: "edj.warcache.v3",
      ts: Date.now(),
      enemyFactionId: String(fid),
      members: json.members,
      meta: { lastApiOkMs: Date.now(), lastApiErr: "" },
    };

    broadcastCacheUpdate();
  }

  function startLeaderPollLoop() {
    const loop = async () => {
      await leaderPollEnemyFaction();
      const jitter = randInt(0, CFG.LOOP_JITTER_MS);
      setTimeout(loop, Shared.pollMs + jitter);
    };
    loop();
  }

  /********************************************************************
   * WAR PAGE: ENEMY FACTION ID EXTRACTION
   ********************************************************************/
  function extractEnemyFactionIdFromWarDom() {
    const warList = document.querySelector("#faction_war_list_id");
    if (!warList) return "";
    const enemyLi = warList.querySelector("li.enemy");
    if (!enemyLi) return "";

    const panel = enemyLi.closest(".faction-war") || enemyLi.closest(".descriptions") || warList;
    const link = panel.querySelector('a[href*="factions.php"][href*="ID="]');
    const href = link ? (link.getAttribute("href") || link.href || "") : "";
    const m = href.match(/ID=(\d+)/);
    return m ? m[1] : "";
  }

  function ensureEnemyFactionId() {
    refreshSettingsFromStorage();
    if (enemyFactionId && /^\d+$/.test(enemyFactionId)) {
      Shared.cache.enemyFactionId = enemyFactionId;
      return true;
    }
    const found = extractEnemyFactionIdFromWarDom();
    if (found) {
      enemyFactionId = found;
      GM_setValue(K.ENEMY_FACTION_ID, enemyFactionId);
      Shared.cache.enemyFactionId = enemyFactionId;
      broadcastCacheUpdate();
      return true;
    }
    return false;
  }

  /********************************************************************
   * WAR PAGE: ROBUST ATTACK LINK UPGRADER
   ********************************************************************/
  let attackObs = null;
  let attackBodyObs = null;

  function findWarListRoot() {
    return document.querySelector("#faction_war_list_id");
  }

  function getUserIdFromEnemyRow(li) {
    // Most reliable: the profile link contains XID=#### (your sample confirms this)
    const a =
      li.querySelector('a[href^="/profiles.php"][href*="XID="]') ||
      li.querySelector('a[href*="profiles.php"][href*="XID="]') ||
      li.querySelector('a[href*="profiles.php"][href*="ID="]');
    const href = a ? (a.getAttribute("href") || a.href || "") : "";
    return extractUserIdFromProfileHref(href);
  }

  function upgradeAttackLinks(root) {
    if (!root) return;
    const rows = root.querySelectorAll("li.enemy");
    rows.forEach((li) => {
      const userId = getUserIdFromEnemyRow(li);
      if (!userId) return;

      // If already upgraded, do nothing
      if (li.querySelector('.edj-attack-link[data-user2id="' + userId + '"]')) return;

      // Find the "Attack" target in the row
      let target =
        li.querySelector(".attack span.t-gray-9") ||
        Array.from(li.querySelectorAll("span.t-gray-9")).find((s) => (s.textContent || "").trim() === "Attack") ||
        null;

      if (!target) return;
      if (((target.textContent || "").trim()) !== "Attack") return;

      target.classList.add("edj-attack-link");
      target.dataset.user2id = userId;
      target.setAttribute("role", "link");
      target.setAttribute("tabindex", "0");
    });
  }

  function installAttackUpgrader(forceReinstall = false) {
    if (!isWarPage) return;

    if (forceReinstall) {
      if (attackObs) try { attackObs.disconnect(); } catch (_) {}
      if (attackBodyObs) try { attackBodyObs.disconnect(); } catch (_) {}
      attackObs = null;
      attackBodyObs = null;
    }

    GM_addStyle(`
      li.enemy .edj-attack-link {
        cursor: pointer !important;
        text-decoration: underline !important;
        color: inherit !important;
        font-weight: 950;
      }
      li.enemy .edj-attack-link:hover { filter: brightness(1.15); }
    `);

    const tryAttach = () => {
      const root = findWarListRoot();
      if (!root) return false;

      upgradeAttackLinks(root);

      // scoped observer
      let pending = false;
      attackObs = new MutationObserver(() => {
        if (pending) return;
        pending = true;
        setTimeout(() => {
          pending = false;
          upgradeAttackLinks(findWarListRoot());
        }, 250);
      });
      attackObs.observe(root, { childList: true, subtree: true });

      return true;
    };

    if (tryAttach()) return;

    // root not present yet: observe body until it appears
    attackBodyObs = new MutationObserver(() => {
      if (tryAttach()) {
        try { attackBodyObs.disconnect(); } catch (_) {}
      }
    });
    attackBodyObs.observe(document.body, { childList: true, subtree: true });
  }

  // Safety net: event delegation for the non-destructive link behavior
  function installAttackClickDelegation() {
    if (!isWarPage) return;

    document.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;

      // only act on upgraded "Attack" spans in enemy rows
      if (!t.matches("li.enemy .edj-attack-link")) return;
      if (((t.textContent || "").trim()) !== "Attack") return;

      const li = t.closest("li.enemy");
      if (!li) return;
      const userId = t.dataset.user2id || getUserIdFromEnemyRow(li);
      if (!userId) return;

      refreshSettingsFromStorage();
      const url = buildAttackUrl(userId);

      ev.preventDefault();
      ev.stopPropagation();

      if (openAttackNewTab) window.open(url, "_blank", "noopener");
      else location.href = url;
    }, true);

    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      if (!t.matches("li.enemy .edj-attack-link")) return;
      if (((t.textContent || "").trim()) !== "Attack") return;
      const li = t.closest("li.enemy");
      if (!li) return;
      const userId = t.dataset.user2id || getUserIdFromEnemyRow(li);
      if (!userId) return;
      refreshSettingsFromStorage();
      const url = buildAttackUrl(userId);
      ev.preventDefault();
      if (openAttackNewTab) window.open(url, "_blank", "noopener");
      else location.href = url;
    }, true);
  }

  /********************************************************************
   * TRAVEL TRIP TRACKER (Traveling-only)
   ********************************************************************/
  let tripStore = GM_getValue(K.TRIPS, {
    schema: "edj.trip.v2",
    updatedAt: 0,
    byUser: {},
  });

  function saveTripStore() {
    try { GM_setValue(K.TRIPS, tripStore); } catch (_) {}
  }

  function purgeInactiveTrips() {
    const now = nowUnix();
    const byUser = tripStore.byUser || {};
    for (const [uid, rec] of Object.entries(byUser)) {
      if (!rec) continue;
      if (rec.active) continue;
      const endedAt = rec.endedAt || rec.lastSeenTraveling || 0;
      if (endedAt && (now - endedAt) > CFG.FLIGHT_PURGE_INACTIVE_SEC) delete byUser[uid];
    }
  }

  function updateTripTrackerFromCache() {
    const now = nowUnix();
    const members = Shared.cache.members || {};
    const byUser = tripStore.byUser || (tripStore.byUser = {});

    for (const [userId, m] of Object.entries(members)) {
      const st = (m && m.status && m.status.state) ? m.status.state : "";
      const until = (m && m.status) ? m.status.until : null;
      const isTraveling = (st === "Traveling");

      const rec = byUser[userId];

      if (isTraveling) {
        if (!rec || !rec.active) {
          byUser[userId] = {
            active: true,
            tripId: now + "-" + Math.random().toString(16).slice(2),
            observedStart: now,
            lastSeenTraveling: now,
            lastUntil: (typeof until === "number") ? until : null,
            endedAt: null,

            firedLandingSoonTripId: null,
            firedLandedTripId: null,
          };
        } else {
          rec.active = true;
          rec.lastSeenTraveling = now;
          if (typeof until === "number") rec.lastUntil = until;
        }
      } else {
        if (rec && rec.active) {
          rec.active = false;
          rec.endedAt = now;
        }
      }
    }

    tripStore.schema = "edj.trip.v2";
    tripStore.updatedAt = now;
    purgeInactiveTrips();
    saveTripStore();
  }

  function getObservedTravelSeconds(userId) {
    const rec = tripStore.byUser && tripStore.byUser[userId];
    if (!rec || !rec.active || typeof rec.observedStart !== "number") return null;
    return Math.max(0, nowUnix() - rec.observedStart);
  }

  function travelTimeTable() {
    return {
      mexico: { standard: 26 * 60, airstrip: 18 * 60, business: 8 * 60 },
      cayman: { standard: 35 * 60, airstrip: 25 * 60, business: 11 * 60 },
      canada: { standard: 41 * 60, airstrip: 29 * 60, business: 12 * 60 },
      hawaii: { standard: 2 * 3600 + 14 * 60, airstrip: 1 * 3600 + 34 * 60, business: 40 * 60 },
      uk: { standard: 2 * 3600 + 39 * 60, airstrip: 1 * 3600 + 51 * 60, business: 48 * 60 },
      argentina: { standard: 2 * 3600 + 47 * 60, airstrip: 1 * 3600 + 57 * 60, business: 50 * 60 },
      switzerland: { standard: 2 * 3600 + 55 * 60, airstrip: 2 * 3600 + 3 * 60, business: 53 * 60 },
      japan: { standard: 3 * 3600 + 45 * 60, airstrip: 2 * 3600 + 38 * 60, business: 1 * 3600 + 8 * 60 },
      china: { standard: 4 * 3600 + 2 * 60, airstrip: 2 * 3600 + 49 * 60, business: 1 * 3600 + 12 * 60 },
      uae: { standard: 4 * 3600 + 31 * 60, airstrip: 3 * 3600 + 10 * 60, business: 1 * 3600 + 21 * 60 },
      south_africa: { standard: 4 * 3600 + 57 * 60, airstrip: 3 * 3600 + 28 * 60, business: 1 * 3600 + 29 * 60 },
    };
  }

  function normalizeDestination(desc) {
    const d = String(desc || "").toLowerCase();
    if (d.includes("mexico")) return "mexico";
    if (d.includes("cayman")) return "cayman";
    if (d.includes("canada")) return "canada";
    if (d.includes("hawaii")) return "hawaii";
    if (d.includes("united kingdom") || d.includes("uk") || d.includes("london")) return "uk";
    if (d.includes("argentina") || d.includes("buenos")) return "argentina";
    if (d.includes("switzerland") || d.includes("zurich")) return "switzerland";
    if (d.includes("japan") || d.includes("tokyo")) return "japan";
    if (d.includes("china") || d.includes("beijing")) return "china";
    if (d.includes("united arab emirates") || d.includes("dubai") || d.includes("uae")) return "uae";
    if (d.includes("south africa") || d.includes("johannesburg")) return "south_africa";
    return null;
  }

  function selectTravelTime(totalByTier) {
    if (etaUsePrivateIsland && totalByTier.airstrip) return totalByTier.airstrip;
    if (etaUseBusinessClass && totalByTier.business) return totalByTier.business;
    return totalByTier.standard || null;
  }

  function getTravelEtaSecondsBestEffort(userId, member) {
    const rec = tripStore.byUser && tripStore.byUser[userId];
    if (!rec || !rec.active) return null;

    const desc = member && member.status ? member.status.description : "";
    const destKey = normalizeDestination(desc);
    if (destKey) {
      const table = travelTimeTable();
      const totals = table[destKey];
      const totalSec = totals ? selectTravelTime(totals) : null;
      if (totalSec) {
        const observed = getObservedTravelSeconds(userId) || 0;
        const eta = Math.max(0, totalSec - observed);
        if (eta <= CFG.MAX_REASONABLE_ETA_SEC) return eta;
      }
    }

    if (typeof rec.lastUntil === "number") {
      const eta = Math.max(0, rec.lastUntil - nowUnix());
      if (eta > CFG.MAX_REASONABLE_ETA_SEC) return null;
      return eta;
    }

    return null;
  }

  /********************************************************************
   * ALARMS (Hospital/Jail exit + Travel landing soon + landed)
   ********************************************************************/
  const prevStateSnapshot = new Map();
  const hospCooldown = new Map();
  const travelSoonCooldown = new Map();
  const travelLandedCooldown = new Map();

  function cooldownOk(map, userId, cooldownSec) {
    const now = nowUnix();
    const last = map.get(userId) || 0;
    if ((now - last) >= cooldownSec) {
      map.set(userId, now);
      return true;
    }
    return false;
  }

  function evalAlarmsOnCacheUpdate() {
    refreshSettingsFromStorage();

    const members = Shared.cache.members || {};
    const now = nowUnix();

    for (const [userId, m] of Object.entries(members)) {
      const name = (m && m.name) ? m.name : userId;
      const newState = (m && m.status && m.status.state) ? m.status.state : "Unknown";
      const prev = prevStateSnapshot.get(userId);

      // Hospital/Jail exit -> Okay
      if (alarmsOn) {
        if ((prev === "Hospital" || prev === "Jail") && newState === "Okay") {
          if (cooldownOk(hospCooldown, userId, CFG.HOSP_COOLDOWN_SEC)) {
            notify("Enemy out", name + " is now Okay");
          }
        }
      }

      // Travel alarms (Traveling only)
      if (travelAlarmsOn) {
        const rec = tripStore.byUser && tripStore.byUser[userId];
        const until = (m && m.status) ? m.status.until : null;

        // Landing soon while still Traveling (per-trip gated)
        if (newState === "Traveling" && rec && rec.active && typeof until === "number") {
          const eta = Math.max(0, until - now);
          if (eta <= CFG.LANDING_SOON_SEC) {
            const alreadyFired = (rec.firedLandingSoonTripId === rec.tripId);
            if (!alreadyFired && cooldownOk(travelSoonCooldown, userId, CFG.TRAVEL_SOON_COOLDOWN_SEC)) {
              rec.firedLandingSoonTripId = rec.tripId;
              saveTripStore();
              notify("Enemy landing soon", name + " lands in " + fmtSeconds(eta));
            }
          }
        }

        // Landed when leaving Traveling (per-trip gated)
        if (prev === "Traveling" && newState !== "Traveling") {
          if (rec) {
            const alreadyFired = (rec.firedLandedTripId === rec.tripId);
            if (!alreadyFired && cooldownOk(travelLandedCooldown, userId, CFG.TRAVEL_LANDED_COOLDOWN_SEC)) {
              rec.firedLandedTripId = rec.tripId;
              saveTripStore();
              notify("Enemy landed", name + " is no longer Traveling (" + newState + ")");
            }
          } else {
            // edge-case: no record, still notify once (cooldown-gated)
            if (cooldownOk(travelLandedCooldown, userId, CFG.TRAVEL_LANDED_COOLDOWN_SEC)) {
              notify("Enemy landed", name + " is no longer Traveling (" + newState + ")");
            }
          }
        }
      }

      prevStateSnapshot.set(userId, newState);
    }
  }

  /********************************************************************
   * SETTINGS MODAL
   ********************************************************************/
  const UISettings = {
    modal: null,
    open() {
      if (!this.modal) this.build();
      this.modal.style.display = "flex";
      this.sync();
    },
    close() {
      if (this.modal) this.modal.style.display = "none";
    },
    build() {
      GM_addStyle(`
        #edj-wd3-settings-backdrop {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.55);
          z-index: 1000001;
          display: none;
          align-items: center;
          justify-content: center;
        }
        #edj-wd3-settings {
          width: 540px;
          max-width: calc(100vw - 24px);
          background: rgba(18,18,20,0.98);
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 14px;
          box-shadow: 0 16px 40px rgba(0,0,0,0.45);
          color: #eaeaf0;
          font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
          overflow: hidden;
        }
        #edj-wd3-settings .top {
          padding: 12px 14px;
          display: flex;
          align-items: center;
          gap: 10px;
          border-bottom: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.04);
        }
        #edj-wd3-settings .top .t { font-weight: 950; letter-spacing: 0.2px; }
        #edj-wd3-settings .top .x {
          margin-left: auto;
          cursor: pointer;
          padding: 6px 10px;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.06);
          font-weight: 950;
        }
        #edj-wd3-settings .body { padding: 14px; display: grid; gap: 12px; }
        #edj-wd3-settings .card {
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.04);
          border-radius: 12px;
          padding: 12px;
        }
        #edj-wd3-settings .row {
          display: grid;
          grid-template-columns: 190px 1fr;
          gap: 10px;
          align-items: center;
          margin-top: 10px;
        }
        #edj-wd3-settings label { font-weight: 950; font-size: 12px; opacity: 0.95; }
        #edj-wd3-settings input, #edj-wd3-settings select {
          width: 100%;
          padding: 8px 10px;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(0,0,0,0.25);
          color: #eaeaf0;
          outline: none;
          font-size: 12px;
        }
        #edj-wd3-settings .hint { font-size: 12px; opacity: 0.85; line-height: 1.4; }
        #edj-wd3-settings .actions {
          display: flex;
          gap: 10px;
          justify-content: flex-end;
          margin-top: 10px;
        }
        #edj-wd3-settings button {
          padding: 8px 12px;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.06);
          color: #eaeaf0;
          font-weight: 950;
          cursor: pointer;
          font-size: 12px;
        }
        #edj-wd3-settings button.primary {
          background: rgba(155,229,155,0.12);
          border-color: rgba(155,229,155,0.35);
        }
        #edj-wd3-settings .pill {
          display: inline-flex;
          gap: 8px;
          align-items: center;
          padding: 4px 10px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.05);
          font-weight: 950;
          font-size: 11px;
        }
        #edj-wd3-settings .ok { color: #9be59b; }
        #edj-wd3-settings .bad { color: #ff8f8f; }
      `);

      const backdrop = document.createElement("div");
      backdrop.id = "edj-wd3-settings-backdrop";
      backdrop.innerHTML = `
        <div id="edj-wd3-settings" role="dialog" aria-modal="true">
          <div class="top">
            <div class="t">WarDash Settings</div>
            <div class="x" id="edj-wd3-settings-close">Close</div>
          </div>
          <div class="body">
            <div class="card">
              <div class="pill"><span>API Key</span> <span id="edj-wd3-key-state" class="bad">Missing</span></div>
              <div class="hint" style="margin-top:8px">
                Use a <b>PUBLIC</b> Torn API key (16 characters). This script calls faction <code>basic</code> only.
                <br/>Tip: use a dedicated key for this script.
              </div>
              <div class="row">
                <label for="edj-wd3-api-key">Public API key</label>
                <input id="edj-wd3-api-key" placeholder="16-char PUBLIC key" maxlength="32" />
              </div>
            </div>

            <div class="card">
              <div class="pill"><span>Target</span></div>
              <div class="hint" style="margin-top:8px">
                Enemy faction ID is usually auto-detected on the war page. Override if detection fails.
              </div>
              <div class="row">
                <label for="edj-wd3-enemy-id">Enemy faction ID</label>
                <input id="edj-wd3-enemy-id" placeholder="numbers only" />
              </div>
            </div>

            <div class="card">
              <div class="pill"><span>Options</span></div>
              <div class="row">
                <label for="edj-wd3-open-tab">Attack links</label>
                <select id="edj-wd3-open-tab">
                  <option value="new">Open in new tab</option>
                  <option value="same">Open in same tab</option>
                </select>
              </div>
              <div class="row">
                <label for="edj-wd3-alarm-hosp">Hospital/Jail alarms</label>
                <select id="edj-wd3-alarm-hosp">
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </div>
              <div class="row">
                <label for="edj-wd3-alarm-travel">Travel alarms</label>
                <select id="edj-wd3-alarm-travel">
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </div>
              <div class="row">
                <label for="edj-wd3-sound">Alarm sound</label>
                <select id="edj-wd3-sound">
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </div>
              <div class="row">
                <label for="edj-wd3-eta-pi">ETA: Private Island (Airstrip)</label>
                <select id="edj-wd3-eta-pi">
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </div>
              <div class="row">
                <label for="edj-wd3-eta-business">ETA: 10* Lingerie (Business)</label>
                <select id="edj-wd3-eta-business">
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </div>
            </div>

            <div class="actions">
              <button id="edj-wd3-cancel">Cancel</button>
              <button class="primary" id="edj-wd3-save">Save</button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(backdrop);
      this.modal = backdrop;

      const close = () => this.close();
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
      backdrop.querySelector("#edj-wd3-settings-close").addEventListener("click", close);
      backdrop.querySelector("#edj-wd3-cancel").addEventListener("click", close);

      backdrop.querySelector("#edj-wd3-save").addEventListener("click", () => {
        const keyInput = (backdrop.querySelector("#edj-wd3-api-key").value || "").trim();
        const enemyInput = (backdrop.querySelector("#edj-wd3-enemy-id").value || "").trim();
        const openTab = backdrop.querySelector("#edj-wd3-open-tab").value;
        const hospAlarm = backdrop.querySelector("#edj-wd3-alarm-hosp").value;
        const travelAlarm = backdrop.querySelector("#edj-wd3-alarm-travel").value;
        const sound = backdrop.querySelector("#edj-wd3-sound").value;
        const etaPi = backdrop.querySelector("#edj-wd3-eta-pi").value;
        const etaBusiness = backdrop.querySelector("#edj-wd3-eta-business").value;

        if (keyInput) {
          if (keyInput.length === 16) {
            apiKey = keyInput;
            GM_setValue(K.API_KEY, apiKey);
          } else {
            alert("API key must be exactly 16 characters (PUBLIC key).");
            return;
          }
        }

        if (enemyInput) {
          if (/^\d+$/.test(enemyInput)) {
            enemyFactionId = enemyInput;
            GM_setValue(K.ENEMY_FACTION_ID, enemyFactionId);
            Shared.cache.enemyFactionId = enemyFactionId;
          } else {
            alert("Enemy faction ID must be numbers only.");
            return;
          }
        }

        openAttackNewTab = (openTab === "new");
        GM_setValue(K.OPEN_NEW_TAB, openAttackNewTab);

        alarmsOn = (hospAlarm === "on");
        GM_setValue(K.ALARMS_ON, alarmsOn);

        travelAlarmsOn = (travelAlarm === "on");
        GM_setValue(K.TRAVEL_ALARMS_ON, travelAlarmsOn);

        soundOn = (sound === "on");
        GM_setValue(K.SOUND_ON, soundOn);

        etaUsePrivateIsland = (etaPi === "on");
        GM_setValue(K.ETA_USE_PI, etaUsePrivateIsland);

        etaUseBusinessClass = (etaBusiness === "on");
        GM_setValue(K.ETA_USE_BUSINESS, etaUseBusinessClass);

        UI.updateAlarmButtons();
        broadcastCacheUpdate();
        if (isWarPage) installAttackUpgrader(true);

        this.close();
      });
    },
    sync() {
      if (!this.modal) return;
      refreshSettingsFromStorage();

      const keyState = this.modal.querySelector("#edj-wd3-key-state");
      const keyInput = this.modal.querySelector("#edj-wd3-api-key");
      const enemyInput = this.modal.querySelector("#edj-wd3-enemy-id");

      const openTab = this.modal.querySelector("#edj-wd3-open-tab");
      const hospAlarm = this.modal.querySelector("#edj-wd3-alarm-hosp");
      const travelAlarm = this.modal.querySelector("#edj-wd3-alarm-travel");
      const sound = this.modal.querySelector("#edj-wd3-sound");
      const etaPi = this.modal.querySelector("#edj-wd3-eta-pi");
      const etaBusiness = this.modal.querySelector("#edj-wd3-eta-business");

      keyInput.value = apiKey || "";
      enemyInput.value = enemyFactionId || Shared.cache.enemyFactionId || "";

      const ok = hasValidApiKey();
      keyState.textContent = ok ? "Set" : "Missing";
      keyState.className = ok ? "ok" : "bad";

      openTab.value = openAttackNewTab ? "new" : "same";
      hospAlarm.value = alarmsOn ? "on" : "off";
      travelAlarm.value = travelAlarmsOn ? "on" : "off";
      sound.value = soundOn ? "on" : "off";
      etaPi.value = etaUsePrivateIsland ? "on" : "off";
      etaBusiness.value = etaUseBusinessClass ? "on" : "off";
    },
  };

  /********************************************************************
   * DASHBOARD UI
   ********************************************************************/
  const UI = {
    root: null,
    headerLive: null,
    headerMeta: null,
    filterState: null,
    filterOnline: null,
    search: null,
    btnAlarms: null,
    btnTravel: null,
    btnSound: null,
    nextPops: null,
    tbody: null,
    rowNodes: new Map(),
    collapsed: GM_getValue(K.UI_COLLAPSED, false),

    updateAlarmButtons() {
      if (this.btnAlarms) this.btnAlarms.textContent = alarmsOn ? "🔔" : "🔕";
      if (this.btnTravel) this.btnTravel.textContent = travelAlarmsOn ? "✈️" : "🚫";
      if (this.btnSound) this.btnSound.textContent = soundOn ? "🔊" : "🔇";
    }
  };

  const FILTER = { state: "all", online: "any", query: "" };

  function getUiPos() {
    const saved = GM_getValue(K.UI_POS, null);
    if (saved && typeof saved.top === "number" && typeof saved.right === "number") return saved;
    return { top: CFG.UI_POS_DEFAULT.top, right: CFG.UI_POS_DEFAULT.right };
  }
  function saveUiPos(pos) { GM_setValue(K.UI_POS, pos); }
  function getUiSize() {
    const saved = GM_getValue(K.UI_SIZE, null);
    if (saved && typeof saved.width === "number" && typeof saved.height === "number") return saved;
    return null;
  }
  function saveUiSize(size) { GM_setValue(K.UI_SIZE, size); }

  function stateClass(state) {
    if (state === "Okay") return "s-ok";
    if (state === "Hospital" || state === "Jail") return "s-hosp";
    if (state === "Traveling" || state === "Abroad") return "s-travel";
    return "s-warn";
  }

  function stateLabel(state, desc) {
    if (state === "Traveling" || state === "Abroad") {
      const d = String(desc || "");
      if (d.includes("Traveling to ")) return "► " + d.split("Traveling to ")[1];
      if (d.includes("Returning to Torn from ")) return "◄ " + d.split("Returning to Torn from ")[1];
      if (d.includes("In ")) return d.split("In ")[1];
      return state;
    }
    return state || "—";
  }

  function filterMember(m) {
    const name = ((m && m.name) ? m.name : "").toLowerCase();
    const st = (m && m.status && m.status.state) ? m.status.state : "";
    const until = (m && m.status) ? m.status.until : null;
    const la = (m && m.last_action) ? m.last_action.status : "";

    if (FILTER.query && !name.includes(FILTER.query)) return false;

    if (FILTER.online === "online") {
      if (!(la === "Online" || la === "Idle")) return false;
    }

    if (FILTER.state === "all") return true;
    if (FILTER.state === "hosp") return (st === "Hospital" || st === "Jail");
    if (FILTER.state === "out5") {
      if (!(st === "Hospital" || st === "Jail")) return false;
      if (typeof until !== "number") return false;
      const left = until - nowUnix();
      return left > 0 && left <= CFG.HOT_UNDER_SEC;
    }
    if (FILTER.state === "okay") return st === "Okay";
    if (FILTER.state === "travel") return (st === "Traveling" || st === "Abroad");
    return true;
  }

  function sortMembers(a, b) {
    const sa = (a && a.status) ? a.status.state : "Unknown";
    const sb = (b && b.status) ? b.status.state : "Unknown";

    const rank = (st) => {
      if (st === "Okay") return 0;
      if (st === "Hospital" || st === "Jail") return 1;
      if (st === "Traveling" || st === "Abroad") return 2;
      return 3;
    };

    const ra = rank(sa), rb = rank(sb);
    if (ra !== rb) return ra - rb;

    const isHosp = (st) => (st === "Hospital" || st === "Jail");
    if (isHosp(sa) && isHosp(sb)) {
      const ua = (a && a.status && typeof a.status.until === "number") ? a.status.until : 9e12;
      const ub = (b && b.status && typeof b.status.until === "number") ? b.status.until : 9e12;
      if (ua !== ub) return ua - ub;
    }

    return String((a && a.name) ? a.name : "").localeCompare(String((b && b.name) ? b.name : ""));
  }

  function mountDashboard() {
    if (UI.root) return;

    refreshSettingsFromStorage();
    const pos = getUiPos();

    GM_addStyle(`
      #edj-wd3 {
        position: fixed;
        top: ${pos.top}px;
        right: ${pos.right}px;
        width: ${CFG.UI_WIDTH}px;
        z-index: 999999;
        background: rgba(18,18,20,0.94);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 14px;
        box-shadow: 0 12px 30px rgba(0,0,0,0.40);
        color: #e8e8ea;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        overflow: hidden;
        resize: both;
        min-width: 320px;
        min-height: 240px;
        max-width: 90vw;
        max-height: 85vh;
        user-select: none;
      }
      #edj-wd3 * { user-select: text; }
      #edj-wd3 .hdr {
        display: flex;
        gap: 10px;
        align-items: center;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.10);
        background: rgba(255,255,255,0.04);
        cursor: move;
      }
      #edj-wd3 .title { font-weight: 950; font-size: 13px; letter-spacing: 0.2px; }
      #edj-wd3 .meta {
        margin-left: auto;
        font-size: 11px;
        opacity: 0.88;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      #edj-wd3 .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.05);
        font-weight: 950;
        font-size: 11px;
      }
      #edj-wd3 .live { color: #9be59b; }
      #edj-wd3 .stale { color: #ffd27a; }

      #edj-wd3 .hdrBtns { display:flex; gap: 8px; align-items:center; }
      #edj-wd3 .hdrBtn {
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.06);
        font-weight: 950;
        font-size: 11px;
      }

      #edj-wd3 .controls {
        padding: 10px 12px;
        display: grid;
        grid-template-columns: 1fr 1fr 1.2fr auto auto auto;
        gap: 8px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      #edj-wd3 select, #edj-wd3 input {
        width: 100%;
        padding: 7px 8px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(0,0,0,0.25);
        color: #eaeaf0;
        font-size: 12px;
        outline: none;
      }
      #edj-wd3 button {
        padding: 7px 10px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.06);
        color: #eaeaf0;
        font-weight: 950;
        cursor: pointer;
        font-size: 12px;
      }
      #edj-wd3 button:hover { filter: brightness(1.08); }

      #edj-wd3 .pops { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
      #edj-wd3 .pops-title { font-weight: 950; font-size: 12px; margin-bottom: 8px; opacity: 0.95; }
      #edj-wd3 .pops-list { display: grid; gap: 6px; }
      #edj-wd3 .pop-item {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.10);
        background: rgba(255,255,255,0.04);
      }
      #edj-wd3 .pop-name { font-weight: 950; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #edj-wd3 .pop-timer { margin-left: auto; font-weight: 950; }
      #edj-wd3 .pop-link { text-decoration: none; color: #cfd6ff; font-weight: 950; }

      #edj-wd3 .body { max-height: 62vh; overflow: auto; }
      #edj-wd3 table { width: 100%; border-collapse: collapse; font-size: 12px; }
      #edj-wd3 th, #edj-wd3 td {
        padding: 8px 10px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        text-align: left;
        vertical-align: middle;
      }
      #edj-wd3 th {
        position: sticky; top: 0; z-index: 1;
        background: rgba(18,18,20,0.98);
        font-size: 11px; text-transform: uppercase;
        letter-spacing: 0.08em; opacity: 0.9;
      }
      #edj-wd3 .statusPill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.05);
        font-weight: 950;
        font-size: 11px;
      }
      #edj-wd3 .subline { margin-top: 4px; font-size: 11px; opacity: 0.8; white-space: nowrap; }
      #edj-wd3 .s-ok { color: #9be59b; }
      #edj-wd3 .s-hosp { color: #ff8f8f; }
      #edj-wd3 .s-travel { color: #8fb7ff; }
      #edj-wd3 .s-warn { color: #ffd27a; }
      #edj-wd3 tr.hot { background: rgba(255, 225, 125, 0.08); }
      #edj-wd3 .muted { opacity: 0.75; }
      #edj-wd3 .actions a { text-decoration: none; color: #cfd6ff; font-weight: 950; margin-right: 10px; }

      #edj-wd3.collapsed .controls,
      #edj-wd3.collapsed .pops,
      #edj-wd3.collapsed .body { display:none; }
    `);

    // --- FIX: force readable text colors inside the overlay (Torn CSS sometimes overrides) ---
    GM_addStyle(`
      /* Force a readable default text color everywhere inside the dashboard */
      #edj-wd3, #edj-wd3 * {
        color: #eaeaf0 !important;
      }

      /* Inputs / placeholders */
      #edj-wd3 input, #edj-wd3 select, #edj-wd3 button {
        color: #eaeaf0 !important;
      }
      #edj-wd3 input::placeholder {
        color: rgba(234,234,240,0.65) !important;
      }

      /* Restore your intentional accent colors */
      #edj-wd3 .live { color: #9be59b !important; }
      #edj-wd3 .stale { color: #ffd27a !important; }

      #edj-wd3 .s-ok { color: #9be59b !important; }
      #edj-wd3 .s-hosp { color: #ff8f8f !important; }
      #edj-wd3 .s-travel { color: #8fb7ff !important; }
      #edj-wd3 .s-warn { color: #ffd27a !important; }

      #edj-wd3 .pop-link,
      #edj-wd3 .actions a {
        color: #cfd6ff !important;
      }

      /* Make sure your injected Attack links on the war list stay readable too */
      li.enemy .edj-attack-link {
        color: #cfd6ff !important;
      }
    `);

    UI.root = document.createElement("div");
    UI.root.id = "edj-wd3";
    if (UI.collapsed) UI.root.classList.add("collapsed");

    UI.root.innerHTML = `
      <div class="hdr" id="edj-wd3-drag">
        <div class="title">War Dashboard</div>
        <div class="meta">
          <span id="edj-wd3-live" class="pill stale">STALE</span>
          <span id="edj-wd3-meta" class="muted">—</span>
          <div class="hdrBtns">
            <div class="hdrBtn" id="edj-wd3-btn-settings" title="Settings">⚙️</div>
            <div class="hdrBtn" id="edj-wd3-btn-collapse" title="Collapse/Expand">${UI.collapsed ? "▸" : "▾"}</div>
          </div>
        </div>
      </div>

      <div class="controls">
        <select id="edj-wd3-filter-state" title="State filter">
          <option value="all">All</option>
          <option value="hosp">Hospital/Jail</option>
          <option value="out5">Out &lt; 5m</option>
          <option value="okay">Okay</option>
          <option value="travel">Travel/Abroad</option>
        </select>

        <select id="edj-wd3-filter-online" title="Online filter">
          <option value="any">Any</option>
          <option value="online">Online/Idle only</option>
        </select>

        <input id="edj-wd3-search" placeholder="Search name…" />

        <button id="edj-wd3-alarms" title="Toggle hospital/jail alarms"></button>
        <button id="edj-wd3-travel" title="Toggle travel alarms"></button>
        <button id="edj-wd3-sound" title="Toggle sound"></button>
      </div>

      <div class="pops">
        <div class="pops-title">Next pops</div>
        <div id="edj-wd3-pops" class="pops-list"></div>
      </div>

      <div class="body">
        <table>
          <thead>
            <tr>
              <th>Enemy</th>
              <th>Status</th>
              <th>Timer</th>
              <th>Last</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="edj-wd3-tbody"></tbody>
        </table>
      </div>
    `;

    document.body.appendChild(UI.root);

    const savedSize = getUiSize();
    if (savedSize) {
      UI.root.style.width = savedSize.width + "px";
      UI.root.style.height = savedSize.height + "px";
    }

    UI.headerLive = UI.root.querySelector("#edj-wd3-live");
    UI.headerMeta = UI.root.querySelector("#edj-wd3-meta");
    UI.filterState = UI.root.querySelector("#edj-wd3-filter-state");
    UI.filterOnline = UI.root.querySelector("#edj-wd3-filter-online");
    UI.search = UI.root.querySelector("#edj-wd3-search");
    UI.btnAlarms = UI.root.querySelector("#edj-wd3-alarms");
    UI.btnTravel = UI.root.querySelector("#edj-wd3-travel");
    UI.btnSound = UI.root.querySelector("#edj-wd3-sound");
    UI.nextPops = UI.root.querySelector("#edj-wd3-pops");
    UI.tbody = UI.root.querySelector("#edj-wd3-tbody");

    UI.updateAlarmButtons();

    UI.filterState.value = FILTER.state;
    UI.filterOnline.value = FILTER.online;
    UI.search.value = FILTER.query;

    UI.filterState.addEventListener("change", () => { FILTER.state = UI.filterState.value; renderFromCache(); });
    UI.filterOnline.addEventListener("change", () => { FILTER.online = UI.filterOnline.value; renderFromCache(); });
    UI.search.addEventListener("input", () => { FILTER.query = (UI.search.value || "").trim().toLowerCase(); renderFromCache(); });

    UI.btnAlarms.addEventListener("click", () => { alarmsOn = !alarmsOn; GM_setValue(K.ALARMS_ON, alarmsOn); UI.updateAlarmButtons(); });
    UI.btnTravel.addEventListener("click", () => { travelAlarmsOn = !travelAlarmsOn; GM_setValue(K.TRAVEL_ALARMS_ON, travelAlarmsOn); UI.updateAlarmButtons(); });
    UI.btnSound.addEventListener("click", () => { soundOn = !soundOn; GM_setValue(K.SOUND_ON, soundOn); UI.updateAlarmButtons(); });

    UI.root.querySelector("#edj-wd3-btn-settings").addEventListener("click", () => UISettings.open());
    UI.root.querySelector("#edj-wd3-btn-collapse").addEventListener("click", () => {
      UI.collapsed = !UI.collapsed;
      GM_setValue(K.UI_COLLAPSED, UI.collapsed);
      UI.root.classList.toggle("collapsed", UI.collapsed);
      UI.root.querySelector("#edj-wd3-btn-collapse").textContent = UI.collapsed ? "▸" : "▾";
    });

    // Draggable
    const dragHandle = UI.root.querySelector("#edj-wd3-drag");
    let dragging = false;
    let startX = 0, startY = 0;
    let startTop = 0, startRight = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const newTop = Math.max(10, startTop + dy);
      const newRight = Math.max(10, startRight - dx);

      UI.root.style.top = newTop + "px";
      UI.root.style.right = newRight + "px";
      saveUiPos({ top: newTop, right: newRight });
    };

    const onUp = () => {
      dragging = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    dragHandle.addEventListener("mousedown", (e) => {
      const target = e.target;
      if (target && target.closest && target.closest(".hdrBtn")) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = UI.root.getBoundingClientRect();
      startTop = rect.top;
      startRight = window.innerWidth - rect.right;

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!UI.root) return;
      const rect = UI.root.getBoundingClientRect();
      if (rect.width && rect.height) {
        saveUiSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
      }
    });
    resizeObserver.observe(UI.root);

    // If API key missing, open settings once on war page
    if (!hasValidApiKey()) setTimeout(() => UISettings.open(), 800);
  }

  function renderFromCache() {
    if (!UI.root || UI.collapsed) return;

    const cache = Shared.cache;
    const age = Date.now() - (cache.ts || 0);

    if (age <= CFG.CACHE_STALE_WARN_MS) {
      UI.headerLive.classList.remove("stale");
      UI.headerLive.classList.add("live");
      UI.headerLive.textContent = "LIVE";
    } else {
      UI.headerLive.classList.remove("live");
      UI.headerLive.classList.add("stale");
      UI.headerLive.textContent = "STALE " + Math.floor(age / 1000) + "s";
    }

    const metaErr = (cache.meta && cache.meta.lastApiErr) ? (" • " + cache.meta.lastApiErr) : "";
    const leaderTag = Shared.isLeader ? "Leader" : "Client";
    UI.headerMeta.textContent = "EnemyID " + (cache.enemyFactionId || "—") + " • " + leaderTag + " • Poll " + Math.round(Shared.pollMs) + "ms" + metaErr;

    const membersObj = cache.members || {};

    const entries = Object.entries(membersObj)
      .map(([id, m]) => ({ id, m }))
      .filter(({ m }) => filterMember(m))
      .sort((x, y) => sortMembers(x.m, y.m))
      .slice(0, CFG.MAX_ROWS);

    // Next pops
    const pops = Object.entries(membersObj)
      .map(([id, m]) => ({ id, m }))
      .filter(({ m }) => {
        const st = (m && m.status) ? m.status.state : "";
        const until = (m && m.status) ? m.status.until : null;
        if (!(st === "Hospital" || st === "Jail")) return false;
        if (typeof until !== "number") return false;
        return (until - nowUnix()) > 0;
      })
      .sort((a, b) => (a.m.status.until - b.m.status.until))
      .slice(0, CFG.NEXT_POPS_N);

    refreshSettingsFromStorage();

    UI.nextPops.innerHTML = pops.length ? pops.map(({ id, m }) => {
      const left = m.status.until - nowUnix();
      const url = buildAttackUrl(id);
      const open = openAttackNewTab ? 'target="_blank" rel="noopener noreferrer"' : "";
      return `
        <div class="pop-item">
          <div class="pop-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
          <div class="pop-timer" data-pop-id="${id}">${escapeHtml(fmtSeconds(left))}</div>
          <a class="pop-link" href="${url}" ${open}>Attack</a>
        </div>
      `;
    }).join("") : `<div class="muted">No upcoming hospital/jail pops.</div>`;

    UI.rowNodes.clear();

    UI.tbody.innerHTML = entries.length ? entries.map(({ id, m }) => {
      const st = (m && m.status) ? m.status.state : "—";
      const desc = (m && m.status) ? m.status.description : "";
      const until = (m && m.status) ? m.status.until : null;
      const la = (m && m.last_action) ? m.last_action.status : "—";
      const left = (typeof until === "number") ? (until - nowUnix()) : null;

      const timerText = ((st === "Hospital" || st === "Jail") && left != null && left > 0) ? fmtSeconds(left) : "";
      const hot = ((st === "Hospital" || st === "Jail") && left != null && left > 0 && left <= CFG.HOT_UNDER_SEC);

      const open = openAttackNewTab ? 'target="_blank" rel="noopener noreferrer"' : "";

      // Travel subline (Traveling ONLY)
      let travelSub = "";
      if (st === "Traveling") {
        const obs = getObservedTravelSeconds(id);
        const eta = getTravelEtaSecondsBestEffort(id, m);
        if (obs != null) {
          travelSub = "Observed travel " + fmtSeconds(obs) + (eta != null ? (" • ETA " + fmtSeconds(eta) + "*") : "");
        }
      }

      return `
        <tr data-user-id="${id}" class="${hot ? "hot" : ""}">
          <td title="${id}">${escapeHtml(m.name || id)}</td>
          <td>
            <div>
              <span class="statusPill ${stateClass(st)}" data-status-id="${id}">
                ${escapeHtml(stateLabel(st, desc))}
              </span>
              <div class="subline muted" data-travel-id="${id}">${escapeHtml(travelSub)}</div>
            </div>
          </td>
          <td>
            <span data-timer-id="${id}" class="${(st === "Hospital" || st === "Jail") ? "s-hosp" : "muted"}">
              ${escapeHtml(timerText)}
            </span>
          </td>
          <td>
            <span data-last-id="${id}" class="muted" data-base-last="${escapeHtml(la)}">${escapeHtml(la)}</span>
          </td>
          <td class="actions">
            <a href="${buildAttackUrl(id)}" ${open}>Attack</a>
            <a href="${buildProfileUrl(id)}" ${open}>Profile</a>
          </td>
        </tr>
      `;
    }).join("") : `<tr><td colspan="5" class="muted">No matches.</td></tr>`;

    UI.tbody.querySelectorAll("tr[data-user-id]").forEach((tr) => {
      const userId = tr.getAttribute("data-user-id");
      UI.rowNodes.set(userId, {
        tr,
        timerSpan: tr.querySelector('[data-timer-id="' + userId + '"]'),
        statusMain: tr.querySelector('[data-status-id="' + userId + '"]'),
        travelSub: tr.querySelector('[data-travel-id="' + userId + '"]'),
        lastSpan: tr.querySelector('[data-last-id="' + userId + '"]'),
      });
    });

    // Local-only enrichment from FF Scouter cache (if present)
    ffRefreshForIds(Array.from(UI.rowNodes.keys()));
  }

  function uiTickTimersOnly() {
    if (!UI.root) return;

    const age = Date.now() - (Shared.cache.ts || 0);
    if (age <= CFG.CACHE_STALE_WARN_MS) {
      if (UI.headerLive) {
        UI.headerLive.classList.remove("stale");
        UI.headerLive.classList.add("live");
        UI.headerLive.textContent = "LIVE";
      }
    } else {
      if (UI.headerLive) {
        UI.headerLive.classList.remove("live");
        UI.headerLive.classList.add("stale");
        UI.headerLive.textContent = "STALE " + Math.floor(age / 1000) + "s";
      }
    }

    if (UI.collapsed) return;

    const now = nowUnix();

    // Pops
    if (UI.nextPops) {
      UI.nextPops.querySelectorAll("[data-pop-id]").forEach((el) => {
        const userId = el.getAttribute("data-pop-id");
        const m = Shared.cache.members && Shared.cache.members[userId];
        const until = (m && m.status) ? m.status.until : null;
        if (typeof until !== "number") return;
        el.textContent = fmtSeconds(until - now);
      });
    }

    // Rows
    for (const [userId, nodes] of UI.rowNodes.entries()) {
      const m = Shared.cache.members && Shared.cache.members[userId];
      if (!m) continue;

      const st = (m && m.status) ? m.status.state : "";
      const until = (m && m.status) ? m.status.until : null;
      const la = (m && m.last_action) ? m.last_action.status : "—";
      const desc = (m && m.status) ? m.status.description : "";

      if (nodes.lastSpan) {
        nodes.lastSpan.setAttribute("data-base-last", la);
        nodes.lastSpan.textContent = la; // will be re-decorated below
      }

      if (nodes.statusMain) nodes.statusMain.textContent = stateLabel(st, desc);

      if ((st === "Hospital" || st === "Jail") && typeof until === "number") {
        const left = until - now;
        if (left > 0) {
          if (nodes.timerSpan) nodes.timerSpan.textContent = fmtSeconds(left);
          nodes.tr.classList.toggle("hot", left <= CFG.HOT_UNDER_SEC);
        } else {
          if (nodes.timerSpan) nodes.timerSpan.textContent = "";
          nodes.tr.classList.remove("hot");
        }
      } else {
        if (nodes.timerSpan) nodes.timerSpan.textContent = "";
        nodes.tr.classList.remove("hot");
      }

      if (nodes.travelSub) {
        if (st === "Traveling") {
          const obs = getObservedTravelSeconds(userId);
          const eta = getTravelEtaSecondsBestEffort(userId, m);
          nodes.travelSub.textContent = (obs != null)
            ? ("Observed travel " + fmtSeconds(obs) + (eta != null ? (" • ETA " + fmtSeconds(eta) + "*") : ""))
            : "";
        } else {
          nodes.travelSub.textContent = "";
        }
      }
    }

    // Re-apply FF decoration after tick updates base "Last"
    if (FFSC.enabled && UI.rowNodes.size) {
      uiApplyFFToRows(Array.from(UI.rowNodes.keys()));
    }
  }

  /********************************************************************
   * ATTACK PAGE: TIMER BOX
   ********************************************************************/
  const AttackUI = { box: null, lastUserId: null };

  function getAttackUser2Id() {
    const m = location.href.match(/user2ID=(\d+)/i);
    return m ? m[1] : null;
  }

  function findAttackBoxMount() {
    // more robust than hashed classes: find a "user info" style box first
    const userInfo = document.querySelector('div[class*="userInfoBox"]') ||
      document.querySelector("#mainContainer") ||
      document.body;
    return userInfo;
  }

  function mountAttackBox() {
    if (AttackUI.box && AttackUI.box.isConnected) return AttackUI.box;

    GM_addStyle(`
      #edj-wd3-attack-box {
        margin-top: 10px;
        padding: 10px 12px;
        background: rgba(0,0,0,0.75);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 10px;
        color: #eaeaf0;
        font-weight: 950;
        font-size: 1.05rem;
        text-align: center;
      }
      #edj-wd3-attack-box .small {
        display:block;
        font-weight: 950;
        font-size: 0.85rem;
        opacity: 0.85;
        margin-bottom: 6px;
      }
      #edj-wd3-attack-box.ok { color: #9be59b; }
      #edj-wd3-attack-box.bad { color: #ff8f8f; }
      #edj-wd3-attack-box.warn { color: #ffd27a; }
    `);

    const box = document.createElement("div");
    box.id = "edj-wd3-attack-box";
    box.innerHTML = '<span class="small">WarDash Timer</span><span>—</span>';

    const mount = findAttackBoxMount();
    mount.appendChild(box);

    AttackUI.box = box;
    return box;
  }

  function renderAttackTimer() {
    const userId = getAttackUser2Id();
    if (!userId) return;

    const box = mountAttackBox();
    if (!box) return;

    const m = Shared.cache.members && Shared.cache.members[userId];
    const name = (m && m.name) ? m.name : userId;
    const st = (m && m.status) ? m.status.state : "";
    const until = (m && m.status) ? m.status.until : null;

    if (!m) {
      box.className = "warn";
      box.querySelector(".small").textContent = "WarDash Timer";
      box.querySelector("span:last-child").textContent = "Not tracked (not in enemy cache)";
      return;
    }

    if (st !== "Hospital" && st !== "Jail") {
      box.className = "ok";
      box.querySelector(".small").textContent = name;
      box.querySelector("span:last-child").textContent = (st || "Okay");
      return;
    }

    if (typeof until !== "number") {
      box.className = "bad";
      box.querySelector(".small").textContent = name;
      box.querySelector("span:last-child").textContent = st + " (time unknown)";
      return;
    }

    const left = until - nowUnix();
    const txt = left > 0 ? fmtSeconds(left) : "0s";

    box.className = "bad";
    box.querySelector(".small").textContent = name + " out in";
    box.querySelector("span:last-child").textContent = txt;

    document.title = txt + " | " + name;
  }

  function startAttackPageLoops() {
    refreshSettingsFromStorage();
    if (!hasValidApiKey()) setTimeout(() => UISettings.open(), 800);

    setInterval(() => {
      const uid = getAttackUser2Id();
      if (uid !== AttackUI.lastUserId) AttackUI.lastUserId = uid;
      renderAttackTimer();
    }, 1000);

    window.addEventListener("EDJ_CACHE_UPDATE", () => {
      updateTripTrackerFromCache();
      evalAlarmsOnCacheUpdate();
      renderAttackTimer();
    });

    const tryMount = () => { mountAttackBox(); renderAttackTimer(); };
    tryMount();
    setTimeout(tryMount, 500);
    setTimeout(tryMount, 1500);
  }

  /********************************************************************
   * WAR PAGE BOOT
   ********************************************************************/
  function startWarPage() {
    mountDashboard();
    installAttackUpgrader(false);
    installAttackClickDelegation();

    // Try discover enemy ID
    const attempt = () => ensureEnemyFactionId();
    attempt();

    const idObs = new MutationObserver(() => attempt());
    idObs.observe(document.body, { childList: true, subtree: true });

    // On cache update: trips + alarms + render
    window.addEventListener("EDJ_CACHE_UPDATE", () => {
      updateTripTrackerFromCache();
      evalAlarmsOnCacheUpdate();
      renderFromCache();
    });

    // UI tick
    setInterval(() => uiTickTimersOnly(), CFG.UI_TICK_MS);

    // initial render
    renderFromCache();
  }

  /********************************************************************
   * GLOBAL BOOT
   ********************************************************************/
  startLeaderElection();
  startLeaderPollLoop();

  if (isWarPage) startWarPage();
  if (isAttackPage) startAttackPageLoops();

})();
