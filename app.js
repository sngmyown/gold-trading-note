"use strict";

const STORAGE_KEY = "goldTradingReviewV1";
const DB_NAME = "goldTradingReviewImagesV1";
const DB_STORE = "images";
const DB_VERSION = 1;

const MARKET_TIME_ZONE = "Asia/Seoul";
const MARKET_SESSION_CYCLE_START_HOUR = 9;
const MARKET_SESSIONS = [
  { id: "asia", name: "아시아장", city: "TOKYO", timeZone: "Asia/Tokyo", openHour: 9, closeHour: 18, color: "#65a9ff", fill: "rgba(101,169,255,.72)" },
  { id: "europe", name: "유럽장", city: "LONDON", timeZone: "Europe/London", openHour: 8, closeHour: 17, color: "#44d48b", fill: "rgba(68,212,139,.72)" },
  { id: "newyork", name: "뉴욕장", city: "NEW YORK", timeZone: "America/New_York", openHour: 8, closeHour: 17, color: "#ff9d57", fill: "rgba(255,157,87,.72)" }
];

const CAPITAL_LEVEL_STREAK_TARGET = 20;
const CAPITAL_LEVELS = [
  { level: 1, amount: 100000, multiplier: 1, rule: "START" },
  { level: 2, amount: 200000, multiplier: 2, rule: "2×" },
  { level: 3, amount: 400000, multiplier: 4, rule: "2×" },
  { level: 4, amount: 800000, multiplier: 8, rule: "2×" },
  { level: 5, amount: 1600000, multiplier: 16, rule: "2×" },
  { level: 6, amount: 2400000, multiplier: 24, rule: "1.5×" },
  { level: 7, amount: 3600000, multiplier: 36, rule: "1.5×" },
  { level: 8, amount: 5400000, multiplier: 54, rule: "1.5×" },
  { level: 9, amount: 8100000, multiplier: 81, rule: "1.5×" },
  { level: 10, amount: 12150000, multiplier: 121.5, rule: "1.5× · 1000만원대" }
];

const TRADE_STRATEGIES = Object.freeze({
  range_program: { label: "횡보로직 프로그램", badgeClass: "strategy-range", mode: "auto" },
  trend_program: { label: "추세로직 프로그램", badgeClass: "strategy-trend", mode: "auto" },
  ds_trend: { label: "DS Trend", badgeClass: "strategy-ds", mode: "manual" },
  unspecified: { label: "전략 미지정", badgeClass: "strategy-unspecified" }
});

const DEFAULT_TRADING_PRINCIPLES = Object.freeze([
  "분석 시간대와 거래 보유 시간을 고정한다",
  "일관된 Swing 기준으로 주요 고점과 저점을 표시한다",
  "같은 구조 계층의 고저점관계를 바탕으로 trend 와 range 로 구별한다",
  "impulse 와 pullback 의 크기, 속도 그리고 시간을 비교한다",
  "현재 가격이 주요 구조 안에서 어디에 위치하는지 평가한다",
  "추세 약화, 구조 훼손, 반대 구조 형성을 구분한다",
  "상위 구조 (4H), 중간 구조 (1H), 하위 타점 구조 (15m) 의 시간대에 역할을 실행한다"
]);

const DEFAULT_STATE = {
  version: 1,
  activeAccount: "all",
  analyses: {},
  trades: [],
  dailyReviews: {},
  weeklyReviews: [],
  strategyGoal: { text: "", color: "#f1c75b", updatedAt: null },
  tradingPrinciples: { items: [...DEFAULT_TRADING_PRINCIPLES], updatedAt: null },
  levelSystem: { unlockedLevel: 1, lastUnlockedAt: null },
  settings: { gcMultiplier: 100, mgcMultiplier: 10, btcMultiplier: 1, customMultiplier: 1 },
  updatedAt: null
};

let state = loadState();
let dbPromise = null;
let pendingAnalysisImages = [];
let pendingTradeImages = [];
let currentTradeImageIds = [];
let confirmResolver = null;
let marketSessionTimer = null;
let calendarViewDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function showRuntimeError(context, error) {
  const message = error instanceof Error ? error.message : String(error || "알 수 없는 오류");
  console.error(`[Gold Review] ${context}`, error);
  const warning = document.getElementById("storageWarning");
  if (!warning) return;
  warning.textContent = `대시보드 일부 기능 오류 (${context}): ${message}`;
  warning.classList.remove("hidden");
  warning.dataset.runtimeError = "true";
}

function safeRun(context, task) {
  try {
    return task();
  } catch (error) {
    showRuntimeError(context, error);
    return null;
  }
}

async function safeRunAsync(context, task) {
  try {
    return await task();
  } catch (error) {
    showRuntimeError(context, error);
    return null;
  }
}

window.addEventListener("error", (event) => {
  showRuntimeError("JavaScript", event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  showRuntimeError("비동기 처리", event.reason);
});

function validateCriticalDom() {
  const criticalIds = [
    "todayLabel", "analysisStatus", "activeAccountLabel",
    "analysisView", "tradesView", "dailyView", "weeklyView", "analyticsView", "settingsView",
    "analysisDate", "analysisForm", "tradeForm", "dailyDate", "dailyReviewForm",
    "analyticsPeriod", "analyticsAccount", "storageWarning"
  ];
  const missing = criticalIds.filter((id) => !document.getElementById(id));
  if (missing.length) {
    throw new Error(`index.html과 app.js 버전 불일치: ${missing.join(", ")}`);
  }
}

function cloneDefaultState() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function normalizeTradingPrinciples(source) {
  const candidate = Array.isArray(source?.items) ? source.items : DEFAULT_TRADING_PRINCIPLES;
  const items = DEFAULT_TRADING_PRINCIPLES.map((fallback, index) => {
    const value = String(candidate[index] ?? fallback).trim();
    return value || fallback;
  });
  return { items, updatedAt: source?.updatedAt || null };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaultState();
    const parsed = JSON.parse(raw);
    return {
      ...cloneDefaultState(),
      ...parsed,
      settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
      strategyGoal: { ...DEFAULT_STATE.strategyGoal, ...(parsed.strategyGoal || {}) },
      tradingPrinciples: normalizeTradingPrinciples(parsed.tradingPrinciples),
      levelSystem: { ...DEFAULT_STATE.levelSystem, ...(parsed.levelSystem || {}) },
      analyses: parsed.analyses || {},
      trades: Array.isArray(parsed.trades) ? parsed.trades.map(normalizeTradeRecord) : [],
      dailyReviews: parsed.dailyReviews || {},
      weeklyReviews: Array.isArray(parsed.weeklyReviews) ? parsed.weeklyReviews.map(normalizeWeeklyReview) : []
    };
  } catch (error) {
    console.error("상태 불러오기 실패", error);
    return cloneDefaultState();
  }
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  updateHeader();
  renderDataStatus();
}

function openImageDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function putImage(record) {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(record);
    tx.oncomplete = () => resolve(record.id);
    tx.onerror = () => reject(tx.error);
  });
}

async function getImage(id) {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function getAllImages() {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function deleteImage(id) {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function clearImages() {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDate(dateString) {
  if (!dateString) return "-";
  const date = new Date(`${dateString}T00:00:00`);
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).format(date);
}

function formatNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: digits }).format(number);
}

function formatMoney(value) {
  const number = Number(value) || 0;
  const sign = number > 0 ? "+" : "";
  return `${sign}$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(number)}`;
}

function formatKrw(value) {
  return `₩${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(Number(value) || 0)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function splitTags(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

const STANDARD_ASSET_ORDER = ["GOLD", "BTC", "ETH", "NASDAQ", "OIL"];
const STANDARD_ASSET_LABELS = {
  GOLD: "금",
  BTC: "BTC",
  ETH: "ETH",
  NASDAQ: "나스닥",
  OIL: "원유",
  OTHER: "기타"
};

function inferAssetFromSymbol(symbol) {
  const normalized = String(symbol || "").trim().toUpperCase();
  if (["GC", "MGC", "XAU", "XAUUSD"].includes(normalized)) return "GOLD";
  if (normalized.startsWith("BTC")) return "BTC";
  if (normalized.startsWith("ETH")) return "ETH";
  if (["NQ", "MNQ", "NDX", "NASDAQ"].includes(normalized)) return "NASDAQ";
  if (["CL", "MCL", "WTI", "OIL"].includes(normalized)) return "OIL";
  return "OTHER";
}

function normalizeAssetKey(asset, customAssetName, symbol) {
  const raw = String(asset || "").trim().toUpperCase();
  const custom = String(customAssetName || "").trim();
  if (raw && raw !== "CUSTOM") return raw;
  if (custom) return custom.toUpperCase();
  return inferAssetFromSymbol(symbol);
}

function normalizeTradeStrategy(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (TRADE_STRATEGIES[raw] && raw !== "unspecified") return raw;
  if (["횡보로직 프로그램", "횡보로직", "range", "range_program"].includes(raw)) return "range_program";
  if (["추세로직 프로그램", "추세로직", "trend", "trend_program"].includes(raw)) return "trend_program";
  if (["ds trend", "ds_trend", "dstrend"].includes(raw)) return "ds_trend";
  return "unspecified";
}

function strategyOfTrade(trade) {
  return normalizeTradeStrategy(trade?.strategy);
}

function strategyLabel(strategy) {
  return TRADE_STRATEGIES[normalizeTradeStrategy(strategy)]?.label || TRADE_STRATEGIES.unspecified.label;
}

function strategyBadgeClass(strategy) {
  return TRADE_STRATEGIES[normalizeTradeStrategy(strategy)]?.badgeClass || TRADE_STRATEGIES.unspecified.badgeClass;
}

function isAutoLogicStrategy(strategy) {
  return TRADE_STRATEGIES[normalizeTradeStrategy(strategy)]?.mode === "auto";
}

function normalizeWeeklyReview(record) {
  return {
    id: record?.id || uid("weekly"),
    date: record?.date || localDateString(),
    weekStart: record?.weekStart || "",
    weekEnd: record?.weekEnd || record?.date || "",
    pnl: Number(record?.pnl || 0),
    withdrawal: Math.max(0, Number(record?.withdrawal || 0)),
    resetSeed: Math.max(0, Number(record?.resetSeed || 0)),
    fact: String(record?.fact || ""),
    emotion: String(record?.emotion || ""),
    distancing: String(record?.distancing || ""),
    discipline: String(record?.discipline || ""),
    nextRule: String(record?.nextRule || ""),
    resetStatement: String(record?.resetStatement || ""),
    mindsetChecks: Array.isArray(record?.mindsetChecks) ? record.mindsetChecks : [],
    createdAt: record?.createdAt || new Date().toISOString(),
    updatedAt: record?.updatedAt || new Date().toISOString()
  };
}

function normalizeTradeRecord(trade) {
  const asset = normalizeAssetKey(trade?.asset, trade?.customAssetName, trade?.symbol);
  return {
    ...trade,
    asset,
    strategy: normalizeTradeStrategy(trade?.strategy),
    customAssetName: trade?.customAssetName || "",
    activationCount: Math.max(0, Number(trade?.activationCount || 0)),
    manualPnl: Number(trade?.manualPnl ?? trade?.pnl ?? 0),
    autoRuntimeMinutes: Math.max(0, Number(trade?.autoRuntimeMinutes || 0)),
    autoLogicNote: String(trade?.autoLogicNote || ""),
    dsSeed: Math.max(0, Number(trade?.dsSeed || 0))
  };
}

function assetOfTrade(trade) {
  return normalizeAssetKey(trade?.asset, trade?.customAssetName, trade?.symbol);
}

function assetLabel(asset) {
  const key = String(asset || "OTHER").trim().toUpperCase();
  return STANDARD_ASSET_LABELS[key] || key;
}

function updateAssetFieldVisibility(syncSymbol = false) {
  const select = $("tradeAsset");
  if (!select) return;
  const asset = select.value;
  $("customAssetField")?.classList.toggle("hidden", asset !== "CUSTOM");
  if (syncSymbol) {
    const symbolByAsset = { GOLD: "GC", BTC: "BTC", ETH: "ETH", NASDAQ: "NQ", OIL: "CL", CUSTOM: "CUSTOM" };
    if ($("tradeSymbol") && symbolByAsset[asset]) $("tradeSymbol").value = symbolByAsset[asset];
    updateTradeCalculations();
  }
}

function syncAssetFromSymbol() {
  const inferred = inferAssetFromSymbol($("tradeSymbol")?.value);
  if (STANDARD_ASSET_ORDER.includes(inferred) && $("tradeAsset")) {
    $("tradeAsset").value = inferred;
    updateAssetFieldVisibility(false);
  }
}

function getMultiplier(symbol) {
  const normalized = String(symbol || "").toUpperCase();
  if (normalized === "GC") return Number(state.settings.gcMultiplier) || 100;
  if (normalized === "MGC") return Number(state.settings.mgcMultiplier) || 10;
  if (normalized.startsWith("BTC")) return Number(state.settings.btcMultiplier) || 1;
  return Number(state.settings.customMultiplier) || 1;
}

function calculateTrade(form = null) {
  const value = (id) => form ? Number(form[id] ?? 0) : Number($(id)?.value || 0);
  const text = (id) => form ? String(form[id] ?? "") : String($(id)?.value || "");
  const strategy = normalizeTradeStrategy(text("tradeStrategy"));
  if (isAutoLogicStrategy(strategy)) {
    const pnl = value("manualPnl");
    const duration = value("autoRuntimeMinutes") || null;
    return { pnl, grossPnl: pnl, actualR: null, plannedRR: null, duration, multiplier: 0, riskAmount: 0 };
  }
  const symbol = text("tradeSymbol");
  const direction = text("tradeDirection");
  const entry = value("entryPrice");
  const exit = value("exitPrice");
  const stop = value("stopPrice");
  const target = value("targetPrice");
  const contracts = value("contracts") || 0;
  const fees = value("fees") || 0;
  const multiplier = getMultiplier(symbol);
  const directionSign = direction === "short" ? -1 : 1;
  const grossPnl = (exit - entry) * directionSign * multiplier * contracts;
  const pnl = grossPnl - fees;
  const riskPerContract = stop ? Math.abs(entry - stop) * multiplier : 0;
  const riskAmount = riskPerContract * contracts;
  const actualR = riskAmount > 0 ? grossPnl / riskAmount : null;
  const rewardDistance = target ? Math.abs(target - entry) : 0;
  const riskDistance = stop ? Math.abs(entry - stop) : 0;
  const plannedRR = riskDistance > 0 ? rewardDistance / riskDistance : null;
  const duration = calculateDuration(text("tradeDate"), text("entryTime"), text("exitTime"));
  return { pnl, grossPnl, actualR, plannedRR, duration, multiplier, riskAmount };
}

function calculateDuration(date, entryTime, exitTime) {
  if (!date || !entryTime || !exitTime) return null;
  const start = new Date(`${date}T${entryTime}:00`);
  let end = new Date(`${date}T${exitTime}:00`);
  if (end < start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  const minutes = Math.max(0, Math.round((end - start) / 60000));
  return minutes;
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes)) return "-";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}시간 ${rest}분` : `${rest}분`;
}

function resultOfTrade(trade) {
  if (trade.pnl > 0) return "win";
  if (trade.pnl < 0) return "loss";
  return "breakeven";
}


function timeZoneParts(date, timeZone, includeName = false) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...(includeName ? { timeZoneName: "short" } : {})
  });

  const parts = {};
  formatter.formatToParts(date).forEach((part) => {
    if (part.type !== "literal") parts[part.type] = part.value;
  });

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    timeZoneName: parts.timeZoneName || ""
  };
}

function timeZoneOffsetMinutes(date, timeZone) {
  const parts = timeZoneParts(date, timeZone);
  const representedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((representedUtc - date.getTime()) / 60000);
}

function zonedDateTimeToUtc(year, month, day, hour, minute, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);

  for (let index = 0; index < 3; index += 1) {
    const offset = timeZoneOffsetMinutes(new Date(guess), timeZone);
    const corrected = Date.UTC(year, month - 1, day, hour, minute, 0) - offset * 60000;
    if (corrected === guess) break;
    guess = corrected;
  }

  return new Date(guess);
}

function addCalendarDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function isWeekdayDate(parts) {
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function marketCycleDate(now = new Date()) {
  const kst = timeZoneParts(now, MARKET_TIME_ZONE);
  const base = { year: kst.year, month: kst.month, day: kst.day };
  return kst.hour >= MARKET_SESSION_CYCLE_START_HOUR ? base : addCalendarDays(base, -1);
}

function sessionWindow(session, cycleDate) {
  return {
    start: zonedDateTimeToUtc(cycleDate.year, cycleDate.month, cycleDate.day, session.openHour, 0, session.timeZone),
    end: zonedDateTimeToUtc(cycleDate.year, cycleDate.month, cycleDate.day, session.closeHour, 0, session.timeZone)
  };
}

function sessionState(session, now, cycleDate) {
  const weekday = isWeekdayDate(cycleDate);
  const window = sessionWindow(session, cycleDate);
  let status = "upcoming";
  let progress = 0;

  if (!weekday) {
    status = "closed";
  } else if (now >= window.end) {
    status = "complete";
    progress = 100;
  } else if (now >= window.start) {
    status = "active";
    progress = ((now - window.start) / (window.end - window.start)) * 100;
  }

  return { ...session, ...window, status, progress: Math.max(0, Math.min(100, progress)) };
}

function formatClock(date, timeZone, seconds = false) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23"
  }).format(date);
}

function formatSessionRange(start, end) {
  const startParts = timeZoneParts(start, MARKET_TIME_ZONE);
  const endParts = timeZoneParts(end, MARKET_TIME_ZONE);
  const rollsToNextDay = startParts.year !== endParts.year || startParts.month !== endParts.month || startParts.day !== endParts.day;
  return `${formatClock(start, MARKET_TIME_ZONE)}–${formatClock(end, MARKET_TIME_ZONE)}${rollsToNextDay ? "(+1)" : ""}`;
}

function formatRemaining(milliseconds) {
  const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}일`);
  if (hours) parts.push(`${hours}시간`);
  parts.push(`${minutes}분`);
  return parts.join(" ");
}

function nextMarketSessionStart(now, cycleDate) {
  const candidates = [];

  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const date = addCalendarDays(cycleDate, dayOffset);
    if (!isWeekdayDate(date)) continue;

    MARKET_SESSIONS.forEach((session) => {
      const start = sessionWindow(session, date).start;
      if (start > now) candidates.push({ session, start });
    });
  }

  return candidates.sort((a, b) => a.start - b.start)[0] || null;
}

function daylightLabel(session, atDate) {
  const offset = timeZoneOffsetMinutes(atDate, session.timeZone);
  if (session.id === "europe") return offset === 60 ? "서머타임(BST)" : "윈터타임(GMT)";
  if (session.id === "newyork") return offset === -240 ? "서머타임(EDT)" : "윈터타임(EST)";
  return "고정시간(JST)";
}

function sessionStatusLabel(status) {
  if (status === "active") return "진행 중";
  if (status === "complete") return "종료";
  if (status === "closed") return "주말 휴장";
  return "개장 전";
}

function renderMarketSessions(now = new Date()) {
  const timeline = $("marketSessionTimeline");
  if (!timeline) return;

  const cycleDate = marketCycleDate(now);
  const sessions = MARKET_SESSIONS.map((session) => sessionState(session, now, cycleDate));
  const active = sessions.filter((session) => session.status === "active");
  const next = nextMarketSessionStart(now, cycleDate);

  $("marketSessionClock").textContent = formatClock(now, MARKET_TIME_ZONE, true);

  if (active.length) {
    $("currentMarketSession").textContent = active.length > 1
      ? `${active.map((session) => session.name).join(" · ")} 겹침`
      : active[0].name;
    $("currentMarketSessionDetail").textContent = active
      .map((session) => `${session.name} 종료까지 ${formatRemaining(session.end - now)}`)
      .join(" · ");
  } else if (next) {
    const weekend = !isWeekdayDate(cycleDate);
    $("currentMarketSession").textContent = weekend ? "주말 휴장" : "세션 전환 구간";
    $("currentMarketSessionDetail").textContent = `다음 ${next.session.name} 개장까지 ${formatRemaining(next.start - now)}`;
  } else {
    $("currentMarketSession").textContent = "주요 세션 종료";
    $("currentMarketSessionDetail").textContent = "다음 거래 세션을 계산하지 못했습니다.";
  }

  timeline.innerHTML = sessions.map((session) => {
    const localName = timeZoneParts(session.start, session.timeZone, true).timeZoneName;
    const progress = session.progress.toFixed(1);
    return `
      <article class="market-session-box ${session.status}" style="--session-color:${session.color};--session-fill:${session.fill};--session-progress:${progress}%">
        <div class="market-session-box-inner">
          <div class="market-session-box-head">
            <div>
              <span class="market-session-name">${session.name}</span>
              <span class="market-session-city">${session.city} · ${localName}</span>
            </div>
            <span class="market-session-status">${sessionStatusLabel(session.status)}</span>
          </div>
          <div class="market-session-time">
            <strong>${formatSessionRange(session.start, session.end)} KST</strong>
            <span>현지 ${String(session.openHour).padStart(2, "0")}:00–${String(session.closeHour).padStart(2, "0")}:00 · ${daylightLabel(session, session.start)}</span>
          </div>
          <div class="market-session-progress-track"><div class="market-session-progress-bar"></div></div>
          <div class="market-session-progress-label"><span>진행률</span><strong>${session.status === "closed" ? "휴장" : `${Math.round(session.progress)}%`}</strong></div>
        </div>
      </article>
    `;
  }).join("");

  const europe = sessions.find((session) => session.id === "europe");
  const newyork = sessions.find((session) => session.id === "newyork");
  $("marketSessionDstStatus").textContent = `유럽 ${daylightLabel(europe, europe.start)} · 뉴욕 ${daylightLabel(newyork, newyork.start)} · 자동 적용`;
}

function setupMarketSessions() {
  renderMarketSessions();
  if (marketSessionTimer) clearInterval(marketSessionTimer);
  marketSessionTimer = setInterval(() => renderMarketSessions(), 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) renderMarketSessions();
  });
}

function setupTabs() {
  const views = {
    analysis: $("analysisView"),
    trades: $("tradesView"),
    daily: $("dailyView"),
    weekly: $("weeklyView"),
    analytics: $("analyticsView"),
    settings: $("settingsView")
  };
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((item) => item.classList.toggle("active", item === tab));
      Object.entries(views).forEach(([name, view]) => view.classList.toggle("active", name === tab.dataset.view));
      if (tab.dataset.view === "analytics") renderAnalytics();
      if (tab.dataset.view === "daily") renderDaily();
      if (tab.dataset.view === "weekly") renderWeeklyReview();
      if (tab.dataset.view === "settings") renderDataStatus();
    });
  });
}

function updateHeader() {
  const today = localDateString();
  $("todayLabel").textContent = formatDate(today);
  $("analysisStatus").textContent = state.analyses[today] ? "작성 완료" : "미작성";
  $("analysisStatus").style.color = state.analyses[today] ? "var(--green)" : "var(--orange)";
  $("activeAccountLabel").textContent = state.activeAccount === "demo" ? "데모" : state.activeAccount === "live" ? "실제" : "전체";
  renderStrategyGoal();
  renderTradingPrinciples();
  renderLevelSystem();
}

function validStrategyGoalColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : DEFAULT_STATE.strategyGoal.color;
}

function renderStrategyGoal() {
  const display = $("strategyGoalText");
  const editButton = $("editStrategyGoalButton");
  if (!display || !editButton) return;

  const text = String(state.strategyGoal?.text || "").trim();
  const color = validStrategyGoalColor(state.strategyGoal?.color);

  display.textContent = text || "목표를 입력하면 모든 화면 상단에 계속 표시됩니다.";
  display.style.color = text ? color : "";
  display.classList.toggle("empty", !text);
  editButton.textContent = text ? "수정" : "목표 입력";
}

function openStrategyGoalEditor() {
  const editor = $("strategyGoalForm");
  const input = $("strategyGoalInput");
  if (!editor || !input) return;

  input.value = state.strategyGoal?.text || "";
  const color = validStrategyGoalColor(state.strategyGoal?.color);
  const radio = document.querySelector(`input[name="strategyGoalColor"][value="${color}"]`)
    || document.querySelector('input[name="strategyGoalColor"][value="#f1c75b"]');
  if (radio) radio.checked = true;

  editor.classList.remove("hidden");
  $("editStrategyGoalButton").classList.add("hidden");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function closeStrategyGoalEditor() {
  $("strategyGoalForm")?.classList.add("hidden");
  $("editStrategyGoalButton")?.classList.remove("hidden");
}

function setupStrategyGoal() {
  $("editStrategyGoalButton").addEventListener("click", openStrategyGoalEditor);
  $("cancelStrategyGoalButton").addEventListener("click", closeStrategyGoalEditor);

  $("strategyGoalForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const selectedColor = document.querySelector('input[name="strategyGoalColor"]:checked')?.value;

    state.strategyGoal = {
      text: $("strategyGoalInput").value.trim(),
      color: validStrategyGoalColor(selectedColor),
      updatedAt: new Date().toISOString()
    };

    saveState();
    closeStrategyGoalEditor();
    notify("현재 전략 목표를 저장했습니다.");
  });

  $("clearStrategyGoalButton").addEventListener("click", async () => {
    if (!String(state.strategyGoal?.text || "").trim() && !$("strategyGoalInput").value.trim()) {
      closeStrategyGoalEditor();
      return;
    }

    const accepted = await confirmAction("전략 목표 삭제", "메인 화면에 표시된 현재 전략 목표를 삭제합니다.");
    if (!accepted) return;

    state.strategyGoal = { ...DEFAULT_STATE.strategyGoal };
    saveState();
    $("strategyGoalInput").value = "";
    closeStrategyGoalEditor();
    notify("현재 전략 목표를 삭제했습니다.");
  });

  renderStrategyGoal();
}

function renderTradingPrinciples() {
  const list = $("tradingPrinciplesList");
  if (!list) return;
  const items = normalizeTradingPrinciples(state.tradingPrinciples).items;
  list.replaceChildren();
  items.forEach((principle) => {
    const item = document.createElement("li");
    item.className = "trading-principle-item";
    const text = document.createElement("span");
    text.textContent = principle;
    item.appendChild(text);
    list.appendChild(item);
  });
}

function renderTradingPrinciplesEditor() {
  const container = $("tradingPrinciplesEditorFields");
  if (!container) return;
  const items = normalizeTradingPrinciples(state.tradingPrinciples).items;
  container.replaceChildren();
  items.forEach((principle, index) => {
    const label = document.createElement("label");
    label.className = "trading-principle-edit-field";
    const caption = document.createElement("span");
    caption.textContent = `원칙 ${index + 1}`;
    const textarea = document.createElement("textarea");
    textarea.dataset.principleIndex = String(index);
    textarea.rows = 3;
    textarea.maxLength = 240;
    textarea.value = principle;
    label.append(caption, textarea);
    container.appendChild(label);
  });
}

function openTradingPrinciplesEditor() {
  renderTradingPrinciplesEditor();
  $("tradingPrinciplesForm")?.classList.remove("hidden");
  $("editTradingPrinciplesButton")?.classList.add("hidden");
  const first = $("tradingPrinciplesEditorFields")?.querySelector("textarea");
  first?.focus();
}

function closeTradingPrinciplesEditor() {
  $("tradingPrinciplesForm")?.classList.add("hidden");
  $("editTradingPrinciplesButton")?.classList.remove("hidden");
}

function setupTradingPrinciples() {
  $("editTradingPrinciplesButton").addEventListener("click", openTradingPrinciplesEditor);
  $("cancelTradingPrinciplesButton").addEventListener("click", closeTradingPrinciplesEditor);

  $("tradingPrinciplesForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const textareas = $$("#tradingPrinciplesEditorFields textarea");
    const items = DEFAULT_TRADING_PRINCIPLES.map((fallback, index) => {
      const value = String(textareas[index]?.value || "").trim();
      return value || fallback;
    });
    state.tradingPrinciples = { items, updatedAt: new Date().toISOString() };
    saveState();
    closeTradingPrinciplesEditor();
    notify("매매 원칙 7가지를 저장했습니다.");
  });

  $("resetTradingPrinciplesButton").addEventListener("click", async () => {
    const accepted = await confirmAction("기본 7원칙 복원", "현재 편집한 매매 원칙을 처음 설정한 7가지 원칙으로 되돌립니다.");
    if (!accepted) return;
    state.tradingPrinciples = { items: [...DEFAULT_TRADING_PRINCIPLES], updatedAt: new Date().toISOString() };
    saveState();
    renderTradingPrinciplesEditor();
    closeTradingPrinciplesEditor();
    notify("기본 매매 원칙 7가지를 복원했습니다.");
  });

  renderTradingPrinciples();
}

function levelEligibleTrades() {
  return [...state.trades]
    .map(normalizeTradeRecord)
    .filter((trade) => trade.account === "live")
    .filter((trade) => assetOfTrade(trade) === "GOLD")
    .filter((trade) => Boolean(trade.date))
    .sort((a, b) => `${a.date} ${a.entryTime || ""}`.localeCompare(`${b.date} ${b.entryTime || ""}`));
}

function calculateLevelStreakMilestones(days) {
  let completedBlocks = 0;
  let running = 0;
  let currentStreak = 0;
  let longestStreak = 0;

  days.forEach((day) => {
    if (day.netPnl > 0) {
      running += 1;
      longestStreak = Math.max(longestStreak, running);
    } else {
      completedBlocks += Math.floor(running / CAPITAL_LEVEL_STREAK_TARGET);
      running = 0;
    }
  });

  completedBlocks += Math.floor(running / CAPITAL_LEVEL_STREAK_TARGET);
  if (days.length && days[days.length - 1].netPnl > 0) currentStreak = running;

  return {
    completedBlocks,
    currentStreak,
    currentProgress: currentStreak % CAPITAL_LEVEL_STREAK_TARGET,
    longestStreak
  };
}

function levelSystemMetrics() {
  const days = buildDailyTradingPerformance(levelEligibleTrades());
  const milestones = calculateLevelStreakMilestones(days);
  const historicalLevel = Math.min(CAPITAL_LEVELS.length, 1 + milestones.completedBlocks);
  const storedLevel = Math.max(1, Math.min(CAPITAL_LEVELS.length, Number(state.levelSystem?.unlockedLevel) || 1));
  const unlockedLevel = Math.max(storedLevel, historicalLevel);
  const current = CAPITAL_LEVELS[unlockedLevel - 1];
  const next = CAPITAL_LEVELS[unlockedLevel] || null;

  return { days, ...milestones, historicalLevel, unlockedLevel, current, next };
}

function syncLevelSystemState() {
  const metrics = levelSystemMetrics();
  const storedLevel = Math.max(1, Number(state.levelSystem?.unlockedLevel) || 1);
  if (metrics.historicalLevel <= storedLevel) return false;

  state.levelSystem = {
    ...DEFAULT_STATE.levelSystem,
    ...(state.levelSystem || {}),
    unlockedLevel: metrics.historicalLevel,
    lastUnlockedAt: new Date().toISOString()
  };
  return true;
}

function renderLevelSystem() {
  if (!$("capitalLevelBadge")) return;
  const metrics = levelSystemMetrics();
  const atMax = !metrics.next;
  const progress = atMax ? CAPITAL_LEVEL_STREAK_TARGET : metrics.currentProgress;
  const progressPercent = atMax ? 100 : Math.min(100, progress / CAPITAL_LEVEL_STREAK_TARGET * 100);

  $("capitalLevelBadge").textContent = `LV.${metrics.unlockedLevel}`;
  $("capitalCurrentAmount").textContent = formatKrw(metrics.current.amount);
  $("capitalCurrentRule").textContent = `${metrics.current.rule} · 시작금 대비 ${formatNumber(metrics.current.multiplier, 1)}×`;

  if (metrics.next) {
    $("capitalNextAmount").textContent = formatKrw(metrics.next.amount);
    $("capitalNextLevel").textContent = `LV.${metrics.next.level} · ${metrics.next.rule}`;
    $("capitalStreakProgress").textContent = `${progress} / ${CAPITAL_LEVEL_STREAK_TARGET}일`;
    const remaining = CAPITAL_LEVEL_STREAK_TARGET - progress;
    $("capitalStreakStatus").textContent = metrics.currentStreak
      ? `현재 ${metrics.currentStreak}일 연속 수익 · ${remaining}일 더 유지하면 다음 단계 해제`
      : `다음 단계까지 ${CAPITAL_LEVEL_STREAK_TARGET}일 연속 수익 마감이 필요합니다.`;
  } else {
    $("capitalNextAmount").textContent = "1000만원대 목표 달성";
    $("capitalNextLevel").textContent = "다음 목표는 별도 설계";
    $("capitalStreakProgress").textContent = "MAX LEVEL";
    $("capitalStreakStatus").textContent = "현재 레벨업 계획의 최종 단계가 잠금 해제되었습니다.";
  }

  $("capitalStreakProgressBar").style.width = `${progressPercent}%`;
  $("capitalUnlockSummary").textContent = `${metrics.unlockedLevel} / ${CAPITAL_LEVELS.length} 단계 해제 · 최장 ${metrics.longestStreak}일`;

  const rail = $("capitalLevelRail");
  rail.innerHTML = CAPITAL_LEVELS.map((item) => {
    const unlocked = item.level <= metrics.unlockedLevel;
    const active = item.level === metrics.unlockedLevel;
    const status = active ? "ACTIVE" : unlocked ? "UNLOCKED" : "LOCKED";
    return `
      <article class="level-node ${unlocked ? "unlocked" : "locked"} ${active ? "active" : ""}">
        <div class="level-node-top"><span>LV.${item.level}</span><b>${status}</b></div>
        <strong>${escapeHtml(formatKrw(item.amount))}</strong>
        <small>${item.rule}${item.level === CAPITAL_LEVELS.length ? " · TARGET" : ""}</small>
      </article>
    `;
  }).join("");
}

function setActiveAccount(account, switchView = true) {
  state.activeAccount = account;
  saveState();
  $$(".account-card").forEach((card) => card.classList.toggle("selected", card.dataset.account === account));
  $("tradeAccount").value = account === "live" ? "live" : "demo";
  renderAccountBanner();
  renderTrades();
  if (switchView) document.querySelector(".tab[data-view='trades']")?.click();
}

function renderAccountBanner() {
  const banner = $("accountBanner");
  banner.className = `account-banner ${state.activeAccount}`;
  const label = state.activeAccount === "demo" ? "DEMO ACCOUNT" : state.activeAccount === "live" ? "LIVE ACCOUNT" : "전체 계좌";
  banner.querySelector("strong").textContent = label;
}

function setupAnalysis() {
  $("analysisDate").value = localDateString();
  $("analysisDate").addEventListener("change", loadAnalysisForm);
  $("analysisForm").addEventListener("submit", saveAnalysis);
  $("clearAnalysisButton").addEventListener("click", clearAnalysisForm);
  $("analysisImages").addEventListener("change", (event) => addPendingImages(event.target.files, "analysis"));
  $$(".account-card").forEach((card) => card.addEventListener("click", () => setActiveAccount(card.dataset.account)));
  $("showAllAccounts").addEventListener("click", () => setActiveAccount("all", false));
  loadAnalysisForm();
}

function analysisFieldIds() {
  return ["marketBias", "biasConfidence", "tradePermission", "keySupport", "keyResistance", "bullScenario", "bearScenario", "analysisSummary", "higherTimeframe", "lowerTimeframe", "macroCorrelation", "assetCorrelation", "eventRisk", "invalidation"];
}

async function loadAnalysisForm() {
  const date = $("analysisDate").value || localDateString();
  const record = state.analyses[date] || {};
  analysisFieldIds().forEach((id) => {
    const input = $(id);
    input.value = record[id] ?? (id === "marketBias" ? "neutral" : id === "biasConfidence" ? "3" : id === "tradePermission" ? "normal" : "");
  });
  pendingAnalysisImages = [];
  await renderImageIds($("analysisImageList"), record.imageIds || [], "analysis", date);
}

function clearAnalysisForm() {
  analysisFieldIds().forEach((id) => {
    const input = $(id);
    input.value = id === "marketBias" ? "neutral" : id === "biasConfidence" ? "3" : id === "tradePermission" ? "normal" : "";
  });
  pendingAnalysisImages = [];
  renderPendingImages($("analysisImageList"), [], "analysis");
}

async function saveAnalysis(event) {
  event.preventDefault();
  const date = $("analysisDate").value || localDateString();
  const previous = state.analyses[date] || {};
  const uploadedIds = await persistPendingImages(pendingAnalysisImages, { ownerType: "analysis", ownerId: date });
  const record = { date, imageIds: [...(previous.imageIds || []), ...uploadedIds], createdAt: previous.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  analysisFieldIds().forEach((id) => record[id] = $(id).value.trim());
  state.analyses[date] = record;
  pendingAnalysisImages = [];
  saveState();
  await renderImageIds($("analysisImageList"), record.imageIds, "analysis", date);
  notify("오늘의 시장 분석을 저장했습니다.");
}

function setupTradeForm() {
  $("tradeDate").value = localDateString();
  $("tradeAccount").value = state.activeAccount === "live" ? "live" : "demo";
  $("tradeAsset").value = "GOLD";
  $("tradeStrategy").value = "ds_trend";
  ["tradeSymbol", "tradeDirection", "tradeDate", "entryTime", "exitTime", "contracts", "fees", "entryPrice", "stopPrice", "targetPrice", "exitPrice", "manualPnl", "autoRuntimeMinutes"].forEach((id) => $(id)?.addEventListener("input", updateTradeCalculations));
  $("tradeStrategy").addEventListener("change", () => { updateTradeMode(); updateTradeCalculations(); });
  $("tradeAsset").addEventListener("change", () => updateAssetFieldVisibility(true));
  $("tradeSymbol").addEventListener("change", syncAssetFromSymbol);
  $("tradeForm").addEventListener("submit", saveTrade);
  $("resetTradeButton").addEventListener("click", resetTradeForm);
  $("tradeImages").addEventListener("change", (event) => addPendingImages(event.target.files, "trade"));
  $("changeAccountButton").addEventListener("click", () => document.querySelector(".tab[data-view='analysis']")?.click());
  $("reviewDepth").addEventListener("change", updateReviewDepth);
  $("tradeAccountFilter").addEventListener("change", renderTrades);
  $("tradeStrategyFilter").addEventListener("change", renderTrades);
  $("tradeAssetFilter").addEventListener("change", renderTrades);
  $("tradeResultFilter").addEventListener("change", renderTrades);
  $("tradeSearch").addEventListener("input", renderTrades);
  updateAssetFieldVisibility(false);
  updateReviewDepth();
  updateTradeMode();
  updateTradeCalculations();
}

function updateTradeMode() {
  const strategy = normalizeTradeStrategy($("tradeStrategy")?.value);
  const auto = isAutoLogicStrategy(strategy);
  $("dsTradeFields")?.classList.toggle("hidden", auto);
  $("autoLogicFields")?.classList.toggle("hidden", !auto);
  const notice = $("tradeModeNotice");
  if (notice) {
    notice.className = `strategy-mode-banner ${auto ? "auto-mode" : "ds-mode"}`;
    notice.textContent = auto
      ? `${strategyLabel(strategy).toUpperCase()} · AUTO LOGIC · 기동 횟수와 실현 순손익 중심 기록`
      : "DS TREND · 진입/손절/목표/청산 + 운용 시드 기록";
  }
  ["entryPrice", "exitPrice"].forEach((id) => { if ($(id)) $(id).required = !auto; });
  if ($("manualPnl")) $("manualPnl").required = auto;
}

function updateReviewDepth() {
  const depth = $("reviewDepth").value;
  const details = $("tradeDetailsPanel");
  details.open = depth === "deep";
  details.style.opacity = depth === "quick" ? ".62" : "1";
}

function updateTradeCalculations() {
  const calc = calculateTrade();
  $("plannedRR").textContent = calc.plannedRR == null ? "-" : `1 : ${formatNumber(calc.plannedRR, 2)}`;
  $("actualR").textContent = calc.actualR == null ? "-" : `${formatNumber(calc.actualR, 2)}R`;
  $("durationValue").textContent = formatDuration(calc.duration);
  $("calculatedPnl").textContent = formatMoney(calc.pnl);
  $("calculatedPnl").style.color = calc.pnl > 0 ? "var(--green)" : calc.pnl < 0 ? "var(--red)" : "var(--text)";
}

function tradeFieldIds() {
  return ["tradeAccount", "tradeDate", "tradeStrategy", "tradeSymbol", "tradeDirection", "entryTime", "exitTime", "contracts", "fees", "entryPrice", "stopPrice", "targetPrice", "exitPrice", "dsSeed", "activationCount", "manualPnl", "autoRuntimeMinutes", "autoLogicNote", "reviewDepth", "tradeReason", "tradeStrengths", "tradeMistakes", "nextAction", "psychology", "tradeReview", "frameworkTags", "timeframes", "analysisScore", "executionScore", "emotionScore"];
}

async function saveTrade(event) {
  event.preventDefault();
  const id = $("tradeId").value || uid("trade");
  const existingIndex = state.trades.findIndex((trade) => trade.id === id);
  const previous = existingIndex >= 0 ? state.trades[existingIndex] : {};
  const uploadedIds = await persistPendingImages(pendingTradeImages, { ownerType: "trade", ownerId: id });
  const calc = calculateTrade();
  const trade = {
    ...previous,
    id,
    imageIds: [...currentTradeImageIds, ...uploadedIds],
    followedPlan: $("followedPlan").checked,
    ruleViolation: $("ruleViolation").checked,
    revengeTrade: $("revengeTrade").checked,
    macroAligned: $("macroAligned").checked,
    pnl: calc.pnl,
    grossPnl: calc.grossPnl,
    plannedRR: calc.plannedRR,
    actualR: calc.actualR,
    durationMinutes: calc.duration,
    riskAmount: calc.riskAmount,
    multiplier: calc.multiplier,
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  tradeFieldIds().forEach((field) => {
    const idMap = { tradeAccount: "account", tradeDate: "date", tradeStrategy: "strategy", tradeSymbol: "symbol", tradeDirection: "direction" };
    const key = idMap[field] || field;
    const input = $(field);
    trade[key] = input.type === "number" ? Number(input.value || 0) : input.value.trim();
  });
  trade.frameworkTags = splitTags($("frameworkTags").value);
  trade.timeframes = splitTags($("timeframes").value);
  trade.customAssetName = $("customAssetName").value.trim();
  trade.asset = normalizeAssetKey($("tradeAsset").value, trade.customAssetName, trade.symbol);

  if (existingIndex >= 0) state.trades[existingIndex] = trade;
  else state.trades.push(trade);
  syncLevelSystemState();
  saveState();
  resetTradeForm();
  renderTrades();
  renderDaily();
  renderAnalytics();
  notify(existingIndex >= 0 ? "거래 기록을 수정했습니다." : "거래 기록을 저장했습니다.");
}

function resetTradeForm() {
  $("tradeForm").reset();
  $("tradeId").value = "";
  $("tradeDate").value = localDateString();
  $("tradeAccount").value = state.activeAccount === "live" ? "live" : "demo";
  $("tradeAsset").value = "GOLD";
  $("tradeStrategy").value = "ds_trend";
  $("customAssetName").value = "";
  $("tradeSymbol").value = "GC";
  $("tradeDirection").value = "long";
  $("contracts").value = "1";
  $("fees").value = "0";
  $("reviewDepth").value = "standard";
  $("analysisScore").value = "3";
  $("executionScore").value = "3";
  $("emotionScore").value = "3";
  pendingTradeImages = [];
  currentTradeImageIds = [];
  renderPendingImages($("tradeImageList"), [], "trade");
  updateAssetFieldVisibility(false);
  updateReviewDepth();
  updateTradeMode();
  updateTradeCalculations();
}

async function editTrade(id) {
  const trade = state.trades.find((item) => item.id === id);
  if (!trade) return;
  $("tradeId").value = trade.id;
  const keyMap = { tradeAccount: "account", tradeDate: "date", tradeStrategy: "strategy", tradeSymbol: "symbol", tradeDirection: "direction" };
  tradeFieldIds().forEach((field) => {
    const key = keyMap[field] || field;
    const input = $(field);
    const value = Array.isArray(trade[key]) ? trade[key].join(", ") : trade[key];
    input.value = value ?? "";
  });
  const savedAsset = assetOfTrade(trade);
  const isStandardAsset = STANDARD_ASSET_ORDER.includes(savedAsset);
  $("tradeAsset").value = isStandardAsset ? savedAsset : "CUSTOM";
  $("customAssetName").value = isStandardAsset ? "" : savedAsset;
  updateAssetFieldVisibility(false);
  updateTradeMode();
  $("followedPlan").checked = Boolean(trade.followedPlan);
  $("ruleViolation").checked = Boolean(trade.ruleViolation);
  $("revengeTrade").checked = Boolean(trade.revengeTrade);
  $("macroAligned").checked = Boolean(trade.macroAligned);
  pendingTradeImages = [];
  currentTradeImageIds = [...(trade.imageIds || [])];
  await renderImageIds($("tradeImageList"), currentTradeImageIds, "trade", trade.id);
  updateReviewDepth();
  updateTradeCalculations();
  window.scrollTo({ top: $("tradeForm").getBoundingClientRect().top + window.scrollY - 110, behavior: "smooth" });
}

async function removeTrade(id) {
  const accepted = await confirmAction("거래 기록 삭제", "이 거래와 연결된 차트 이미지도 삭제합니다.");
  if (!accepted) return;
  const trade = state.trades.find((item) => item.id === id);
  if (trade) await Promise.all((trade.imageIds || []).map(deleteImage));
  state.trades = state.trades.filter((item) => item.id !== id);
  saveState();
  renderTrades();
  renderDaily();
  renderAnalytics();
}

async function renderTrades() {
  if ($("tradeAccountFilter") && state.activeAccount !== "all" && $("tradeAccountFilter").value === "all") {
    $("tradeAccountFilter").value = state.activeAccount;
  }
  const accountFilter = $("tradeAccountFilter")?.value || (state.activeAccount === "all" ? "all" : state.activeAccount);
  const strategyFilter = $("tradeStrategyFilter")?.value || "all";
  const assetFilter = $("tradeAssetFilter")?.value || "all";
  const resultFilter = $("tradeResultFilter")?.value || "all";
  const query = ($("tradeSearch")?.value || "").trim().toLowerCase();

  const trades = [...state.trades]
    .map(normalizeTradeRecord)
    .filter((trade) => (accountFilter === "all" || trade.account === accountFilter))
    .filter((trade) => (strategyFilter === "all" || strategyOfTrade(trade) === strategyFilter))
    .filter((trade) => (assetFilter === "all" || assetOfTrade(trade) === assetFilter))
    .filter((trade) => (resultFilter === "all" || resultOfTrade(trade) === resultFilter))
    .filter((trade) => {
      if (!query) return true;
      return [assetLabel(assetOfTrade(trade)), strategyLabel(strategyOfTrade(trade)), trade.symbol, trade.tradeReason, trade.tradeReview, trade.tradeStrengths, trade.tradeMistakes, trade.nextAction, trade.psychology, trade.autoLogicNote, ...(trade.frameworkTags || [])].join(" ").toLowerCase().includes(query);
    })
    .sort((a, b) => `${b.date} ${b.entryTime || ""}`.localeCompare(`${a.date} ${a.entryTime || ""}`));

  const list = $("tradeList");
  if (!trades.length) {
    list.innerHTML = '<div class="empty-state">조건에 맞는 거래 기록이 없습니다.</div>';
    return;
  }

  const html = [];
  for (const trade of trades) {
    const result = resultOfTrade(trade);
    const imageRecords = await Promise.all((trade.imageIds || []).slice(0, 6).map(getImage));
    html.push(`
      <article class="trade-card ${escapeHtml(trade.account)}">
        <div class="trade-card-head">
          <div class="trade-card-title">
            <strong>${escapeHtml(trade.symbol)} · ${trade.direction === "long" ? "LONG" : "SHORT"}</strong>
            <span class="badge asset">${escapeHtml(assetLabel(assetOfTrade(trade)))}</span>
            <span class="badge ${strategyBadgeClass(strategyOfTrade(trade))}">${escapeHtml(strategyLabel(strategyOfTrade(trade)))}</span>
            <span class="badge ${escapeHtml(trade.account)}">${trade.account === "demo" ? "DEMO" : "LIVE"}</span>
            <span class="badge ${result}">${result === "win" ? "수익" : result === "loss" ? "손실" : "본전"}</span>
            <span class="badge">${formatDate(trade.date)}</span>
          </div>
          <div class="trade-actions">
            <button class="icon-button" type="button" data-edit-trade="${trade.id}" title="수정">✎</button>
            <button class="icon-button" type="button" data-delete-trade="${trade.id}" title="삭제">×</button>
          </div>
        </div>
        <div class="trade-metrics">
          <div><span>순손익</span><strong style="color:${trade.pnl > 0 ? "var(--green)" : trade.pnl < 0 ? "var(--red)" : "inherit"}">${formatMoney(trade.pnl)}</strong></div>
          ${isAutoLogicStrategy(strategyOfTrade(trade)) ? `
            <div><span>기동 횟수</span><strong>${formatNumber(trade.activationCount || 0, 0)}회</strong></div>
            <div><span>총 기동 시간</span><strong>${trade.autoRuntimeMinutes ? formatDuration(trade.autoRuntimeMinutes) : "-"}</strong></div>
            <div><span>기록 방식</span><strong>AUTO LOGIC</strong></div>
          ` : `
            <div><span>실제 R</span><strong>${trade.actualR == null ? "-" : `${formatNumber(trade.actualR,2)}R`}</strong></div>
            <div><span>계획 손익비</span><strong>${trade.plannedRR == null ? "-" : `1:${formatNumber(trade.plannedRR,2)}`}</strong></div>
            <div><span>보유 시간</span><strong>${formatDuration(trade.durationMinutes)}</strong></div>
            <div><span>진입→청산</span><strong>${formatNumber(trade.entryPrice)} → ${formatNumber(trade.exitPrice)}</strong></div>
            <div><span>계약 수</span><strong>${formatNumber(trade.contracts, 3)}</strong></div>
            <div><span>DS 시드</span><strong>${trade.dsSeed ? formatNumber(trade.dsSeed, 2) : "-"}</strong></div>
          `}
          <div><span>복기 깊이</span><strong>${trade.reviewDepth === "deep" ? "심층" : trade.reviewDepth === "quick" ? "간단" : "정상"}</strong></div>
          <div><span>전략</span><strong>${escapeHtml(strategyLabel(strategyOfTrade(trade)))}</strong></div>
        </div>
        ${isAutoLogicStrategy(strategyOfTrade(trade)) && trade.autoLogicNote ? `<div class="review-box auto-note"><span>AUTO LOGIC 운용 메모</span><p>${escapeHtml(trade.autoLogicNote)}</p></div>` : ""}
        <div class="trade-review-grid">
          <div class="review-box"><span>진입 이유</span><p>${escapeHtml(trade.tradeReason || "-")}</p></div>
          <div class="review-box"><span>거래 복기</span><p>${escapeHtml(trade.tradeReview || "-")}</p></div>
          <div class="review-box"><span>잘한 점</span><p>${escapeHtml(trade.tradeStrengths || "-")}</p></div>
          <div class="review-box"><span>잘못한 점·다음 행동</span><p>${escapeHtml([trade.tradeMistakes, trade.nextAction].filter(Boolean).join("\n") || "-")}</p></div>
        </div>
        ${imageRecords.filter(Boolean).length ? `<div class="trade-image-strip">${imageRecords.filter(Boolean).map((image) => `<img src="${image.dataUrl}" alt="거래 차트" data-view-image="${image.id}" />`).join("")}</div>` : ""}
      </article>`);
  }
  list.innerHTML = html.join("");
  $$('[data-edit-trade]', list).forEach((button) => button.addEventListener("click", () => editTrade(button.dataset.editTrade)));
  $$('[data-delete-trade]', list).forEach((button) => button.addEventListener("click", () => removeTrade(button.dataset.deleteTrade)));
  $$('[data-view-image]', list).forEach((image) => image.addEventListener("click", () => openImageViewer(image.dataset.viewImage)));
}

function setupDaily() {
  $("dailyDate").value = localDateString();
  $("dailyDate").addEventListener("change", renderDaily);
  $("dailyReviewForm").addEventListener("submit", saveDailyReview);
}

function tradesForDate(date, account = "all") {
  return state.trades.filter((trade) => trade.date === date && (account === "all" || trade.account === account));
}

function aggregateTrades(trades) {
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = losses.reduce((sum, trade) => sum + Math.abs(trade.pnl), 0);
  const netProfit = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const validR = trades.filter((trade) => Number.isFinite(trade.actualR));
  const validRR = trades.filter((trade) => Number.isFinite(trade.plannedRR));
  const durations = trades.filter((trade) => Number.isFinite(trade.durationMinutes));
  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: trades.length - wins.length - losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    grossProfit,
    grossLoss,
    netProfit,
    avgWin,
    avgLoss,
    avgR: validR.length ? validR.reduce((sum, trade) => sum + trade.actualR, 0) / validR.length : 0,
    avgPlannedRR: validRR.length ? validRR.reduce((sum, trade) => sum + trade.plannedRR, 0) / validRR.length : 0,
    avgDuration: durations.length ? durations.reduce((sum, trade) => sum + trade.durationMinutes, 0) / durations.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: trades.length ? netProfit / trades.length : 0
  };
}

function getTradesBetween(start, end) {
  return state.trades
    .map(normalizeTradeRecord)
    .filter((trade) => {
      const tradeDate = new Date(`${trade.date}T00:00:00`);
      return tradeDate >= start && tradeDate <= end;
    });
}

function winRateSnapshot(trades) {
  const stats = aggregateTrades(trades);
  return {
    count: stats.count,
    wins: stats.wins,
    winRate: stats.winRate
  };
}

function winRateCell(trades) {
  const snapshot = winRateSnapshot(trades);
  if (!snapshot.count) {
    return '<span class="wr-percent empty">-</span><small class="wr-sample">0회</small>';
  }
  return `<span class="wr-percent">${formatNumber(snapshot.winRate, 1)}%</span><small class="wr-sample">${snapshot.wins}승 / ${snapshot.count}회</small>`;
}

function orderedAssetsForTrades(trades) {
  const present = new Set(trades.map(assetOfTrade));
  const ordered = ["GOLD", "BTC"];
  STANDARD_ASSET_ORDER.forEach((asset) => {
    if (present.has(asset) && !ordered.includes(asset)) ordered.push(asset);
  });
  [...present]
    .filter((asset) => !ordered.includes(asset))
    .sort((a, b) => assetLabel(a).localeCompare(assetLabel(b), "ko"))
    .forEach((asset) => ordered.push(asset));
  return ordered;
}

function renderAccountAssetWinRate(container, trades) {
  if (!container) return;
  const normalizedTrades = trades.map(normalizeTradeRecord);
  const assets = orderedAssetsForTrades(normalizedTrades);
  const rows = assets.map((asset) => {
    const assetTrades = normalizedTrades.filter((trade) => assetOfTrade(trade) === asset);
    const demoTrades = assetTrades.filter((trade) => trade.account === "demo");
    const liveTrades = assetTrades.filter((trade) => trade.account === "live");
    return `<tr>
      <th><span class="asset-name">${escapeHtml(assetLabel(asset))}</span></th>
      <td>${winRateCell(demoTrades)}</td>
      <td>${winRateCell(liveTrades)}</td>
      <td>${winRateCell(assetTrades)}</td>
    </tr>`;
  }).join("");

  container.innerHTML = `<div class="wr-table-wrap">
    <table class="wr-table">
      <thead><tr><th>자산</th><th>데모 계좌</th><th>실제 계좌</th><th>전체</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderPeriodWinRateBreakdowns() {
  const today = new Date(`${localDateString()}T00:00:00`);
  const end = new Date(today.getTime() + 86400000 - 1);
  const weekStart = new Date(today.getTime() - 6 * 86400000);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const weekTrades = getTradesBetween(weekStart, end);
  const monthTrades = getTradesBetween(monthStart, end);

  renderAccountAssetWinRate($("weeklyWinRateBreakdown"), weekTrades);
  renderAccountAssetWinRate($("monthlyWinRateBreakdown"), monthTrades);

  if ($("weeklyWrCaption")) {
    $("weeklyWrCaption").textContent = `${localDateString(weekStart).slice(5)} ~ ${localDateString(today).slice(5)}`;
  }
  if ($("monthlyWrCaption")) {
    $("monthlyWrCaption").textContent = `${today.getFullYear()}년 ${today.getMonth() + 1}월`;
  }
}

function renderDaily() {
  const date = $("dailyDate")?.value || localDateString();
  const stats = aggregateTrades(tradesForDate(date));
  $("dailyStats").innerHTML = [
    ["총 거래", `${stats.count}회`, ""],
    ["수익 / 손실", `${stats.wins} / ${stats.losses}`, ""],
    ["평균 WR", `${formatNumber(stats.winRate, 1)}%`, stats.winRate >= 50 ? "positive" : stats.count ? "negative" : ""],
    ["순손익", formatMoney(stats.netProfit), stats.netProfit >= 0 ? "positive" : "negative"],
    ["평균 R", `${formatNumber(stats.avgR, 2)}R`, stats.avgR >= 0 ? "positive" : "negative"],
    ["평균 보유", formatDuration(Math.round(stats.avgDuration)), ""]
  ].map(([label, value, cls]) => `<div class="summary-card ${cls}"><span>${label}</span><strong>${value}</strong></div>`).join("");
  renderAccountAssetWinRate($("dailyWinRateBreakdown"), tradesForDate(date));
  if ($("dailyWrCaption")) $("dailyWrCaption").textContent = formatDate(date);
  const review = state.dailyReviews[date] || {};
  $("dailyBest").value = review.best || "";
  $("dailyMistake").value = review.mistake || "";
  $("dailyKeep").value = review.keep || "";
  $("dailyAvoid").value = review.avoid || "";
  $("dailyConclusion").value = review.conclusion || "";
}

function saveDailyReview(event) {
  event.preventDefault();
  const date = $("dailyDate").value || localDateString();
  state.dailyReviews[date] = {
    date,
    best: $("dailyBest").value.trim(),
    mistake: $("dailyMistake").value.trim(),
    keep: $("dailyKeep").value.trim(),
    avoid: $("dailyAvoid").value.trim(),
    conclusion: $("dailyConclusion").value.trim(),
    updatedAt: new Date().toISOString()
  };
  saveState();
  notify("일간 마감을 저장했습니다.");
}

function setupAnalytics() {
  $("analyticsPeriod").addEventListener("change", renderAnalytics);
  $("analyticsAccount").addEventListener("change", renderAnalytics);

  $("calendarPrevMonth")?.addEventListener("click", () => {
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1);
    renderTradeCalendar();
  });

  $("calendarNextMonth")?.addEventListener("click", () => {
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1);
    renderTradeCalendar();
  });

  $("calendarTodayButton")?.addEventListener("click", () => {
    const now = new Date();
    calendarViewDate = new Date(now.getFullYear(), now.getMonth(), 1);
    renderTradeCalendar();
  });
}

function analyticsRange(period) {
  const today = new Date(`${localDateString()}T00:00:00`);
  let start = null;
  let end = new Date(today.getTime() + 86400000 - 1);
  if (period === "week") start = new Date(today.getTime() - 6 * 86400000);
  if (period === "month") start = new Date(today.getFullYear(), today.getMonth(), 1);
  if (period === "previousMonth") {
    start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    end = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0, -1);
  }
  return { start, end };
}

function filteredAnalyticsTrades() {
  const period = $("analyticsPeriod")?.value || "month";
  const account = $("analyticsAccount")?.value || "all";
  const range = analyticsRange(period);
  return [...state.trades].filter((trade) => {
    if (account !== "all" && trade.account !== account) return false;
    const date = new Date(`${trade.date}T00:00:00`);
    return (!range.start || date >= range.start) && date <= range.end;
  }).sort((a, b) => `${a.date} ${a.entryTime || ""}`.localeCompare(`${b.date} ${b.entryTime || ""}`));
}

function renderAnalytics() {
  const trades = filteredAnalyticsTrades();
  const stats = aggregateTrades(trades);
  $("analyticsSummary").innerHTML = [
    ["총 거래", `${stats.count}회`, ""],
    ["평균 WR", `${formatNumber(stats.winRate,1)}%`, ""],
    ["총이익", formatMoney(stats.grossProfit), "positive"],
    ["총손실", formatMoney(-stats.grossLoss), "negative"],
    ["순손익", formatMoney(stats.netProfit), stats.netProfit >= 0 ? "positive" : "negative"],
    ["평균 R", `${formatNumber(stats.avgR,2)}R`, stats.avgR >= 0 ? "positive" : "negative"],
    ["평균 손익비", `1:${formatNumber(stats.avgPlannedRR,2)}`, ""],
    ["Profit Factor", stats.profitFactor === Infinity ? "∞" : formatNumber(stats.profitFactor,2), stats.profitFactor >= 1 ? "positive" : "negative"],
    ["거래당 기대값", formatMoney(stats.expectancy), stats.expectancy >= 0 ? "positive" : "negative"],
    ["평균 보유", formatDuration(Math.round(stats.avgDuration)), ""]
  ].map(([label,value,cls]) => `<div class="summary-card ${cls}"><span>${label}</span><strong>${value}</strong></div>`).join("");
  renderPeriodWinRateBreakdowns();
  renderTradeCalendar();
  renderDailyPnlChart(trades);
  renderEquityChart(trades);
  renderAccountComparison(trades);
  renderPatternSummary(trades);
}


function analyticsAccountFilteredTrades() {
  const account = $("analyticsAccount")?.value || "all";
  return [...state.trades]
    .filter((trade) => account === "all" || trade.account === account)
    .filter((trade) => Boolean(trade.date))
    .sort((a, b) => `${a.date} ${a.entryTime || ""}`.localeCompare(`${b.date} ${b.entryTime || ""}`));
}

function buildDailyTradingPerformance(trades) {
  const grouped = new Map();

  trades.forEach((trade) => {
    if (!trade.date) return;
    if (!grouped.has(trade.date)) {
      grouped.set(trade.date, {
        date: trade.date,
        trades: [],
        netPnl: 0,
        grossProfit: 0,
        grossLoss: 0,
        wins: 0,
        losses: 0,
        breakeven: 0,
        accounts: new Set(),
        assets: new Set()
      });
    }

    const day = grouped.get(trade.date);
    const pnl = Number(trade.pnl) || 0;
    day.trades.push(trade);
    day.netPnl += pnl;
    day.accounts.add(trade.account === "live" ? "실제" : "데모");
    day.assets.add(assetLabel(assetOfTrade(trade)));

    if (pnl > 0) {
      day.wins += 1;
      day.grossProfit += pnl;
    } else if (pnl < 0) {
      day.losses += 1;
      day.grossLoss += Math.abs(pnl);
    } else {
      day.breakeven += 1;
    }
  });

  return [...grouped.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({
      ...day,
      count: day.trades.length,
      winRate: day.trades.length ? day.wins / day.trades.length * 100 : 0,
      accounts: [...day.accounts],
      assets: [...day.assets],
      result: day.netPnl > 0 ? "win" : day.netPnl < 0 ? "loss" : "flat"
    }));
}

function calculateWinningStreaks(days) {
  let current = { count: 0, start: null, end: null };
  let longest = { count: 0, start: null, end: null };
  let running = { count: 0, start: null, end: null };

  days.forEach((day) => {
    if (day.netPnl > 0) {
      if (running.count === 0) running.start = day.date;
      running.count += 1;
      running.end = day.date;

      if (running.count > longest.count) {
        longest = { ...running };
      }
    } else {
      running = { count: 0, start: null, end: null };
    }
  });

  if (days.length && days[days.length - 1].netPnl > 0) {
    current = { ...running };
  }

  return { current, longest };
}

function formatStreakRange(streak) {
  if (!streak?.count || !streak.start || !streak.end) return "기록 없음";
  if (streak.start === streak.end) return formatDate(streak.start);
  return `${formatChartDate(streak.start)} ~ ${formatChartDate(streak.end)}`;
}

function renderTradeCalendar() {
  const container = $("tradeCalendar");
  if (!container) return;

  const trades = analyticsAccountFilteredTrades();
  const days = buildDailyTradingPerformance(trades);
  const dayMap = new Map(days.map((day) => [day.date, day]));
  const { current, longest } = calculateWinningStreaks(days);

  $("currentWinningStreak").textContent = `${current.count}일`;
  $("currentWinningStreakRange").textContent = current.count
    ? `${formatStreakRange(current)} · 마지막 거래일까지 연속 수익`
    : "최근 거래일이 수익으로 끝나지 않았습니다.";

  $("longestWinningStreak").textContent = `${longest.count}일`;
  $("longestWinningStreakRange").textContent = longest.count
    ? formatStreakRange(longest)
    : "기록 없음";

  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0);
  const firstWeekday = monthStart.getDay();
  const daysInMonth = monthEnd.getDate();

  $("calendarMonthLabel").textContent = `${year}년 ${month + 1}월`;

  const monthDays = days.filter((day) => {
    const date = new Date(`${day.date}T00:00:00`);
    return date.getFullYear() === year && date.getMonth() === month;
  });

  const monthWins = monthDays.filter((day) => day.netPnl > 0).length;
  const monthLosses = monthDays.filter((day) => day.netPnl < 0).length;
  const monthFlat = monthDays.filter((day) => day.netPnl === 0).length;
  const monthPnl = monthDays.reduce((sum, day) => sum + day.netPnl, 0);

  $("calendarWinningDays").textContent = `${monthWins}일`;
  $("calendarMonthSummary").textContent =
    `수익 ${monthWins} · 손실 ${monthLosses} · 본전 ${monthFlat} · ${formatMoney(monthPnl)}`;

  const previousMonth = new Date(year, month, 0);
  const previousMonthDays = previousMonth.getDate();
  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const today = localDateString();

  const cells = [];

  for (let cellIndex = 0; cellIndex < totalCells; cellIndex += 1) {
    let cellDate;
    let inCurrentMonth = true;

    if (cellIndex < firstWeekday) {
      const dayNumber = previousMonthDays - firstWeekday + cellIndex + 1;
      cellDate = new Date(year, month - 1, dayNumber);
      inCurrentMonth = false;
    } else if (cellIndex >= firstWeekday + daysInMonth) {
      const dayNumber = cellIndex - firstWeekday - daysInMonth + 1;
      cellDate = new Date(year, month + 1, dayNumber);
      inCurrentMonth = false;
    } else {
      cellDate = new Date(year, month, cellIndex - firstWeekday + 1);
    }

    const dateString = localDateString(cellDate);
    const performance = dayMap.get(dateString);
    const resultClass = performance ? performance.result : "idle";
    const isToday = dateString === today;
    const accountClass = performance?.accounts?.length === 1
      ? (performance.accounts[0] === "실제" ? "live-only" : "demo-only")
      : "";

    const tooltip = performance
      ? `
        <div class="calendar-tooltip">
          <strong>${escapeHtml(formatDate(dateString))}</strong>
          <div><span>당일 순손익</span><b class="${performance.netPnl > 0 ? "positive" : performance.netPnl < 0 ? "negative" : ""}">${escapeHtml(formatMoney(performance.netPnl))}</b></div>
          <div><span>거래 수</span><b>${performance.count}회</b></div>
          <div><span>당일 WR</span><b>${escapeHtml(formatNumber(performance.winRate, 1))}%</b></div>
          <div><span>승 / 패 / 본전</span><b>${performance.wins} / ${performance.losses} / ${performance.breakeven}</b></div>
          <small>${escapeHtml(performance.accounts.join(" · "))}${performance.assets.length ? ` · ${escapeHtml(performance.assets.join(" · "))}` : ""}</small>
        </div>
      `
      : `
        <div class="calendar-tooltip">
          <strong>${escapeHtml(formatDate(dateString))}</strong>
          <div><span>거래 기록</span><b>없음</b></div>
        </div>
      `;

    cells.push(`
      <button
        class="calendar-day ${resultClass} ${inCurrentMonth ? "" : "outside"} ${isToday ? "today" : ""} ${accountClass}"
        type="button"
        data-calendar-date="${dateString}"
        aria-label="${escapeHtml(formatDate(dateString))}${performance ? ` ${escapeHtml(formatMoney(performance.netPnl))}` : " 거래 없음"}"
      >
        <span class="calendar-day-number">${cellDate.getDate()}</span>
        ${
          performance
            ? `
              <span class="calendar-day-result">${performance.netPnl > 0 ? "WIN" : performance.netPnl < 0 ? "LOSS" : "FLAT"}</span>
              <strong class="calendar-day-pnl">${escapeHtml(formatMoney(performance.netPnl))}</strong>
              <small>${performance.count}회 · WR ${escapeHtml(formatNumber(performance.winRate, 0))}%</small>
            `
            : '<span class="calendar-day-idle">—</span>'
        }
        ${tooltip}
      </button>
    `);
  }

  container.innerHTML = cells.join("");

  $$("[data-calendar-date]", container).forEach((button) => {
    button.addEventListener("click", () => {
      const date = button.dataset.calendarDate;
      if ($("dailyDate")) $("dailyDate").value = date;
      document.querySelector(".tab[data-view='daily']")?.click();
      renderDaily();
    });
  });
}

function renderDailyPnlChart(trades) {
  const grouped = {};
  trades.forEach((trade) => grouped[trade.date] = (grouped[trade.date] || 0) + trade.pnl);
  const points = Object.entries(grouped).sort(([a],[b]) => a.localeCompare(b)).map(([date,value]) => ({ label: date.slice(5), value }));
  $("pnlChartCaption").textContent = `${points.length}거래일`;
  renderBarSvg($("dailyPnlChart"), points);
}

function renderEquityChart(trades) {
  const container = $("equityChart");
  const caption = $("equityChartCaption");
  const grouped = new Map();

  trades.forEach((trade) => {
    if (!trade.date) return;
    if (!grouped.has(trade.date)) {
      grouped.set(trade.date, {
        date: trade.date,
        trades: [],
        dailyPnl: 0,
        grossProfit: 0,
        grossLoss: 0,
        wins: 0,
        losses: 0,
        breakeven: 0,
        accounts: new Set(),
        assets: new Set()
      });
    }

    const day = grouped.get(trade.date);
    const pnl = Number(trade.pnl) || 0;
    day.trades.push(trade);
    day.dailyPnl += pnl;
    day.accounts.add(trade.account === "live" ? "실제" : "데모");
    day.assets.add(assetLabel(assetOfTrade(trade)));

    if (pnl > 0) {
      day.wins += 1;
      day.grossProfit += pnl;
    } else if (pnl < 0) {
      day.losses += 1;
      day.grossLoss += Math.abs(pnl);
    } else {
      day.breakeven += 1;
    }
  });

  let cumulative = 0;
  const points = [...grouped.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => {
      cumulative += day.dailyPnl;
      return {
        ...day,
        cumulative,
        count: day.trades.length,
        winRate: day.trades.length ? day.wins / day.trades.length * 100 : 0,
        accounts: [...day.accounts],
        assets: [...day.assets]
      };
    });

  if (!points.length) {
    caption.textContent = "날짜별 집계";
    container.innerHTML = '<div class="empty-state">표시할 거래가 없습니다.</div>';
    return;
  }

  caption.textContent = `${points.length}거래일 · ${trades.length}회 매매 · 최종 ${formatMoney(points[points.length - 1].cumulative)}`;

  const width = 980;
  const height = 390;
  const pad = { l: 82, r: 30, t: 30, b: 62 };
  const domain = chartDomain(points.map((point) => ({ value: point.cumulative })));
  const plotWidth = width - pad.l - pad.r;
  const plotHeight = height - pad.t - pad.b;
  const x = (index) => points.length === 1
    ? pad.l + plotWidth / 2
    : pad.l + index / (points.length - 1) * plotWidth;
  const y = (value) => pad.t + (domain.max - value) / (domain.max - domain.min) * plotHeight;
  const zeroY = y(0);
  const coordinates = points.map((point, index) => ({
    ...point,
    x: x(index),
    y: y(point.cumulative)
  }));

  const yTickCount = 5;
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, index) => {
    const value = domain.max - index / yTickCount * (domain.max - domain.min);
    return { value, y: y(value) };
  });

  const maxDateLabels = 8;
  const dateStep = Math.max(1, Math.ceil(points.length / maxDateLabels));
  const dateTicks = coordinates.filter((_, index) =>
    index === 0 || index === coordinates.length - 1 || index % dateStep === 0
  );

  const linePath = coordinates
    .map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L${coordinates[coordinates.length - 1].x.toFixed(2)},${zeroY.toFixed(2)} L${coordinates[0].x.toFixed(2)},${zeroY.toFixed(2)} Z`;

  const yGrid = yTicks.map((tick) => `
    <g>
      <line x1="${pad.l}" x2="${width - pad.r}" y1="${tick.y}" y2="${tick.y}" stroke="rgba(255,255,255,.075)" stroke-dasharray="3 6" />
      <text x="${pad.l - 13}" y="${tick.y + 4}" fill="#8f9bad" font-size="11" text-anchor="end">${escapeHtml(formatAxisMoney(tick.value))}</text>
    </g>
  `).join("");

  const xLabels = dateTicks.map((point) => `
    <g>
      <line x1="${point.x}" x2="${point.x}" y1="${height - pad.b + 4}" y2="${height - pad.b + 10}" stroke="rgba(255,255,255,.22)" />
      <text x="${point.x}" y="${height - 25}" fill="#8f9bad" font-size="11" text-anchor="middle">${escapeHtml(formatChartDate(point.date))}</text>
    </g>
  `).join("");

  const pointNodes = coordinates.map((point, index) => {
    const pointColor = point.dailyPnl > 0 ? "#44d48b" : point.dailyPnl < 0 ? "#ff7373" : "#f1c75b";
    return `
      <g class="equity-point-group" data-equity-index="${index}">
        <circle cx="${point.x}" cy="${point.y}" r="9" fill="${pointColor}" opacity=".12" />
        <circle cx="${point.x}" cy="${point.y}" r="4.5" fill="${pointColor}" stroke="#0b0f18" stroke-width="2" />
      </g>
    `;
  }).join("");

  const hoverBands = coordinates.map((point, index) => {
    const previousX = index === 0 ? pad.l : (coordinates[index - 1].x + point.x) / 2;
    const nextX = index === coordinates.length - 1 ? width - pad.r : (point.x + coordinates[index + 1].x) / 2;
    return `<rect class="equity-hover-band" data-equity-index="${index}" x="${previousX}" y="${pad.t}" width="${Math.max(1, nextX - previousX)}" height="${plotHeight}" fill="transparent" tabindex="0" role="button" aria-label="${escapeHtml(formatDate(point.date))} 누적 손익 ${escapeHtml(formatMoney(point.cumulative))}" />`;
  }).join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="날짜별 누적 손익 그래프">
      <defs>
        <linearGradient id="equityAreaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f1c75b" stop-opacity=".32" />
          <stop offset="100%" stop-color="#f1c75b" stop-opacity=".015" />
        </linearGradient>
        <filter id="equityGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      ${yGrid}
      <line x1="${pad.l}" x2="${width - pad.r}" y1="${zeroY}" y2="${zeroY}" stroke="rgba(241,199,91,.3)" stroke-width="1.2" />
      <text x="22" y="${pad.t + plotHeight / 2}" fill="#8f9bad" font-size="11" text-anchor="middle" transform="rotate(-90 22 ${pad.t + plotHeight / 2})">누적 손익 (USD)</text>
      <path d="${areaPath}" fill="url(#equityAreaGradient)" />
      <path d="${linePath}" fill="none" stroke="rgba(241,199,91,.22)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" filter="url(#equityGlow)" />
      <path d="${linePath}" fill="none" stroke="#f1c75b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      ${pointNodes}
      ${xLabels}
      <text x="${pad.l + plotWidth / 2}" y="${height - 5}" fill="#8f9bad" font-size="11" text-anchor="middle">거래 날짜</text>
      <line id="equityHoverGuide" x1="0" x2="0" y1="${pad.t}" y2="${height - pad.b}" stroke="rgba(255,255,255,.32)" stroke-width="1" stroke-dasharray="4 5" opacity="0" />
      <circle id="equityFocusRing" cx="0" cy="0" r="9" fill="none" stroke="#fff" stroke-width="1.5" opacity="0" />
      ${hoverBands}
    </svg>
    <div id="equityTooltip" class="equity-tooltip" aria-live="polite"></div>
  `;

  const tooltip = container.querySelector("#equityTooltip");
  const guide = container.querySelector("#equityHoverGuide");
  const focusRing = container.querySelector("#equityFocusRing");
  const svg = container.querySelector("svg");

  const showPoint = (index) => {
    const point = coordinates[index];
    if (!point) return;

    const dailyClass = point.dailyPnl > 0 ? "positive" : point.dailyPnl < 0 ? "negative" : "";
    const cumulativeClass = point.cumulative > 0 ? "positive" : point.cumulative < 0 ? "negative" : "";
    tooltip.innerHTML = `
      <div class="equity-tooltip-date">
        <strong>${escapeHtml(formatDate(point.date))}</strong>
        <span>${point.count}회 매매</span>
      </div>
      <div class="equity-tooltip-main">
        <div class="equity-tooltip-item ${cumulativeClass}"><span>누적 손익</span><strong>${escapeHtml(formatMoney(point.cumulative))}</strong></div>
        <div class="equity-tooltip-item ${dailyClass}"><span>당일 손익</span><strong>${escapeHtml(formatMoney(point.dailyPnl))}</strong></div>
        <div class="equity-tooltip-item"><span>당일 WR</span><strong>${escapeHtml(formatNumber(point.winRate, 1))}%</strong></div>
        <div class="equity-tooltip-item"><span>총이익 / 총손실</span><strong>${escapeHtml(formatMoney(point.grossProfit))} / ${escapeHtml(formatMoney(-point.grossLoss))}</strong></div>
      </div>
      <div class="equity-tooltip-footer">
        <span class="equity-tooltip-chip">승 ${point.wins}</span>
        <span class="equity-tooltip-chip">패 ${point.losses}</span>
        <span class="equity-tooltip-chip">본전 ${point.breakeven}</span>
        <span class="equity-tooltip-chip">${escapeHtml(point.accounts.join(" · ") || "-")}</span>
        <span class="equity-tooltip-chip">${escapeHtml(point.assets.join(" · ") || "-")}</span>
      </div>
    `;

    const svgRect = svg.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const left = svgRect.left - containerRect.left + point.x / width * svgRect.width;
    const top = svgRect.top - containerRect.top + point.y / height * svgRect.height;
    const safeLeft = Math.max(145, Math.min(containerRect.width - 145, left));

    const showBelow = top < 190;
    tooltip.classList.toggle("below", showBelow);
    tooltip.style.left = `${safeLeft}px`;
    tooltip.style.top = `${top}px`;
    tooltip.classList.add("visible");
    guide.setAttribute("x1", point.x);
    guide.setAttribute("x2", point.x);
    guide.setAttribute("opacity", "1");
    focusRing.setAttribute("cx", point.x);
    focusRing.setAttribute("cy", point.y);
    focusRing.setAttribute("opacity", "1");
  };

  const hidePoint = () => {
    tooltip.classList.remove("visible", "below");
    guide.setAttribute("opacity", "0");
    focusRing.setAttribute("opacity", "0");
  };

  container.querySelectorAll(".equity-hover-band").forEach((band) => {
    const index = Number(band.dataset.equityIndex);
    band.addEventListener("mouseenter", () => showPoint(index));
    band.addEventListener("mousemove", () => showPoint(index));
    band.addEventListener("focus", () => showPoint(index));
    band.addEventListener("touchstart", () => showPoint(index), { passive: true });
    band.addEventListener("mouseleave", hidePoint);
    band.addEventListener("blur", hidePoint);
  });

  container.addEventListener("mouseleave", hidePoint);
}

function formatChartDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" }).format(date);
}

function formatAxisMoney(value) {
  const absolute = Math.abs(Number(value) || 0);
  const sign = Number(value) < 0 ? "−" : "";
  if (absolute >= 1000000) return `${sign}$${formatNumber(absolute / 1000000, 1)}M`;
  if (absolute >= 1000) return `${sign}$${formatNumber(absolute / 1000, 1)}K`;
  if (absolute >= 10) return `${sign}$${formatNumber(absolute, 0)}`;
  return `${sign}$${formatNumber(absolute, 2)}`;
}

function chartDomain(points) {
  if (!points.length) return { min: -1, max: 1 };
  let min = Math.min(...points.map((point) => point.value), 0);
  let max = Math.max(...points.map((point) => point.value), 0);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * .12;
  return { min: min - pad, max: max + pad };
}

function renderBarSvg(container, points) {
  if (!points.length) { container.innerHTML = '<div class="empty-state">표시할 거래가 없습니다.</div>'; return; }
  const width = 760, height = 260, pad = { l: 58, r: 18, t: 18, b: 42 };
  const domain = chartDomain(points);
  const y = (value) => pad.t + (domain.max - value) / (domain.max - domain.min) * (height - pad.t - pad.b);
  const zeroY = y(0);
  const slot = (width - pad.l - pad.r) / points.length;
  const bars = points.map((point, index) => {
    const x = pad.l + index * slot + slot * .18;
    const barWidth = Math.max(4, slot * .64);
    const py = y(point.value);
    const top = Math.min(py, zeroY);
    const barHeight = Math.max(1, Math.abs(py - zeroY));
    const fill = point.value >= 0 ? "#44d48b" : "#ff7373";
    return `<g><rect x="${x}" y="${top}" width="${barWidth}" height="${barHeight}" rx="4" fill="${fill}" opacity=".88"><title>${point.label}: ${formatMoney(point.value)}</title></rect>${points.length <= 14 ? `<text x="${x + barWidth/2}" y="${height-17}" fill="#9ca8bb" font-size="10" text-anchor="middle">${point.label}</text>` : ""}</g>`;
  }).join("");
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img"><line x1="${pad.l}" x2="${width-pad.r}" y1="${zeroY}" y2="${zeroY}" stroke="rgba(255,255,255,.22)" />${bars}</svg>`;
}

function renderLineSvg(container, points) {
  if (!points.length) { container.innerHTML = '<div class="empty-state">표시할 거래가 없습니다.</div>'; return; }
  const width = 760, height = 260, pad = { l: 58, r: 18, t: 18, b: 35 };
  const domain = chartDomain(points);
  const x = (index) => points.length === 1 ? width / 2 : pad.l + index / (points.length - 1) * (width - pad.l - pad.r);
  const y = (value) => pad.t + (domain.max - value) / (domain.max - domain.min) * (height - pad.t - pad.b);
  const path = points.map((point,index) => `${index ? "L" : "M"}${x(index)},${y(point.value)}`).join(" ");
  const circles = points.map((point,index) => `<circle cx="${x(index)}" cy="${y(point.value)}" r="4" fill="#f1c75b"><title>${index+1}번째 거래: ${formatMoney(point.value)}</title></circle>`).join("");
  const zeroY = y(0);
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img"><line x1="${pad.l}" x2="${width-pad.r}" y1="${zeroY}" y2="${zeroY}" stroke="rgba(255,255,255,.18)" /><path d="${path}" fill="none" stroke="#f1c75b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />${circles}</svg>`;
}

function renderAccountComparison(trades) {
  const demo = aggregateTrades(trades.filter((trade) => trade.account === "demo"));
  const live = aggregateTrades(trades.filter((trade) => trade.account === "live"));
  $("accountComparison").innerHTML = `<table class="comparison-table"><thead><tr><th>지표</th><th>데모</th><th>실제</th></tr></thead><tbody>
    <tr><td>거래 수</td><td>${demo.count}</td><td>${live.count}</td></tr>
    <tr><td>승률</td><td>${formatNumber(demo.winRate,1)}%</td><td>${formatNumber(live.winRate,1)}%</td></tr>
    <tr><td>순손익</td><td>${formatMoney(demo.netProfit)}</td><td>${formatMoney(live.netProfit)}</td></tr>
    <tr><td>평균 R</td><td>${formatNumber(demo.avgR,2)}R</td><td>${formatNumber(live.avgR,2)}R</td></tr>
    <tr><td>Profit Factor</td><td>${demo.profitFactor === Infinity ? "∞" : formatNumber(demo.profitFactor,2)}</td><td>${live.profitFactor === Infinity ? "∞" : formatNumber(live.profitFactor,2)}</td></tr>
  </tbody></table>`;
}

function renderPatternSummary(trades) {
  const tags = {};
  let ruleViolations = 0, revengeTrades = 0, planFollowed = 0;
  trades.forEach((trade) => {
    (trade.frameworkTags || []).forEach((tag) => tags[tag] = (tags[tag] || 0) + 1);
    if (trade.ruleViolation) ruleViolations += 1;
    if (trade.revengeTrade) revengeTrades += 1;
    if (trade.followedPlan) planFollowed += 1;
  });
  const topTags = Object.entries(tags).sort((a,b) => b[1]-a[1]).slice(0,5);
  const rows = [
    ["계획 준수율", trades.length ? `${formatNumber(planFollowed / trades.length * 100,1)}%` : "-"],
    ["규칙 위반", `${ruleViolations}회`],
    ["복수매매", `${revengeTrades}회`],
    ...topTags.map(([tag,count]) => [`프레임워크 · ${tag}`, `${count}회`])
  ];
  $("patternSummary").innerHTML = rows.length ? `<div class="pattern-list">${rows.map(([label,value]) => `<div class="pattern-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>` : '<div class="empty-state">아직 분석할 패턴이 없습니다.</div>';
}

async function addPendingImages(fileList, type) {
  const files = [...fileList].filter((file) => file.type.startsWith("image/"));
  const converted = await Promise.all(files.map(fileToPendingRecord));
  if (type === "analysis") {
    pendingAnalysisImages.push(...converted);
    renderPendingImages($("analysisImageList"), pendingAnalysisImages, "analysis");
  } else {
    pendingTradeImages.push(...converted);
    renderMixedTradeImages();
  }
}

function fileToPendingRecord(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ tempId: uid("temp"), name: file.name, type: file.type, size: file.size, dataUrl: reader.result });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function persistPendingImages(records, owner) {
  const ids = [];
  for (const record of records) {
    const id = uid("img");
    await putImage({ id, ...owner, name: record.name, type: record.type, size: record.size, dataUrl: record.dataUrl, createdAt: new Date().toISOString() });
    ids.push(id);
  }
  return ids;
}

function renderPendingImages(container, records, type) {
  if (!records.length) { container.innerHTML = ""; return; }
  container.innerHTML = records.map((record) => `<article class="image-card"><img src="${record.dataUrl}" alt="업로드 예정 이미지" data-temp-view="${record.tempId}" /><div class="image-card-footer"><span>${escapeHtml(record.name)}</span><button class="icon-button" type="button" data-remove-temp="${record.tempId}">×</button></div></article>`).join("");
  $$('[data-remove-temp]', container).forEach((button) => button.addEventListener("click", () => {
    if (type === "analysis") pendingAnalysisImages = pendingAnalysisImages.filter((item) => item.tempId !== button.dataset.removeTemp);
    else pendingTradeImages = pendingTradeImages.filter((item) => item.tempId !== button.dataset.removeTemp);
    type === "analysis" ? renderPendingImages(container, pendingAnalysisImages, type) : renderMixedTradeImages();
  }));
  $$('[data-temp-view]', container).forEach((image) => image.addEventListener("click", () => {
    const source = (type === "analysis" ? pendingAnalysisImages : pendingTradeImages).find((item) => item.tempId === image.dataset.tempView);
    openImageData(source?.dataUrl, source?.name || "업로드 이미지");
  }));
}

async function renderImageIds(container, ids, ownerType, ownerId) {
  const records = (await Promise.all(ids.map(getImage))).filter(Boolean);
  container.innerHTML = records.map((record) => `<article class="image-card"><img src="${record.dataUrl}" alt="저장된 차트 이미지" data-view-image="${record.id}" /><div class="image-card-footer"><span>${escapeHtml(record.name)}</span><button class="icon-button" type="button" data-remove-image="${record.id}">×</button></div></article>`).join("");
  $$('[data-view-image]', container).forEach((image) => image.addEventListener("click", () => openImageViewer(image.dataset.viewImage)));
  $$('[data-remove-image]', container).forEach((button) => button.addEventListener("click", async () => {
    const accepted = await confirmAction("이미지 삭제", "이 이미지를 기록에서 제거합니다.");
    if (!accepted) return;
    await deleteImage(button.dataset.removeImage);
    if (ownerType === "analysis") {
      const record = state.analyses[ownerId];
      if (record) record.imageIds = (record.imageIds || []).filter((id) => id !== button.dataset.removeImage);
      saveState();
      renderImageIds(container, record?.imageIds || [], ownerType, ownerId);
    } else {
      currentTradeImageIds = currentTradeImageIds.filter((id) => id !== button.dataset.removeImage);
      renderMixedTradeImages();
    }
  }));
}

async function renderMixedTradeImages() {
  const records = (await Promise.all(currentTradeImageIds.map(getImage))).filter(Boolean);
  const storedHtml = records.map((record) => `<article class="image-card"><img src="${record.dataUrl}" alt="저장된 거래 차트" data-view-image="${record.id}" /><div class="image-card-footer"><span>${escapeHtml(record.name)}</span><button class="icon-button" type="button" data-remove-stored-trade-image="${record.id}">×</button></div></article>`).join("");
  const pendingHtml = pendingTradeImages.map((record) => `<article class="image-card"><img src="${record.dataUrl}" alt="업로드 예정 거래 차트" data-temp-view="${record.tempId}" /><div class="image-card-footer"><span>${escapeHtml(record.name)}</span><button class="icon-button" type="button" data-remove-temp-trade="${record.tempId}">×</button></div></article>`).join("");
  $("tradeImageList").innerHTML = storedHtml + pendingHtml;
  $$('[data-view-image]', $("tradeImageList")).forEach((image) => image.addEventListener("click", () => openImageViewer(image.dataset.viewImage)));
  $$('[data-temp-view]', $("tradeImageList")).forEach((image) => image.addEventListener("click", () => {
    const record = pendingTradeImages.find((item) => item.tempId === image.dataset.tempView);
    openImageData(record?.dataUrl, record?.name || "업로드 이미지");
  }));
  $$('[data-remove-stored-trade-image]', $("tradeImageList")).forEach((button) => button.addEventListener("click", async () => {
    await deleteImage(button.dataset.removeStoredTradeImage);
    currentTradeImageIds = currentTradeImageIds.filter((id) => id !== button.dataset.removeStoredTradeImage);
    renderMixedTradeImages();
  }));
  $$('[data-remove-temp-trade]', $("tradeImageList")).forEach((button) => button.addEventListener("click", () => {
    pendingTradeImages = pendingTradeImages.filter((item) => item.tempId !== button.dataset.removeTempTrade);
    renderMixedTradeImages();
  }));
}

async function openImageViewer(id) {
  const record = await getImage(id);
  if (record) openImageData(record.dataUrl, record.name);
}

function openImageData(dataUrl, caption) {
  $("imageViewerImage").src = dataUrl || "";
  $("imageViewerCaption").textContent = caption || "";
  $("imageViewer").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeImageViewer() {
  $("imageViewer").classList.add("hidden");
  $("imageViewerImage").src = "";
  document.body.style.overflow = "";
}

function weekStartMonday(dateString) {
  const d = new Date(`${dateString}T12:00:00`);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return localDateString(d);
}

function weeklyTradesForDate(reviewDate) {
  const start = weekStartMonday(reviewDate);
  return state.trades.filter((trade) => trade.account === "live" && trade.date >= start && trade.date <= reviewDate);
}

function weeklyPnlForDate(reviewDate) {
  return weeklyTradesForDate(reviewDate).reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
}

function weeklyResultType(pnl) {
  return pnl > 0 ? "profit" : pnl < 0 ? "loss" : "flat";
}

function renderWeeklyMindset(pnl, selected = []) {
  const type = weeklyResultType(pnl);
  const items = type === "profit" ? [
    "이번 주 수익이 다음 주 위험 한도를 키울 이유가 아니다.",
    "더 크게 벌어야 한다는 욕심 때문에 거래 빈도나 규모를 늘리지 않는다.",
    "인출은 성과 확정이지 자신감 레버리지가 아니다.",
    "다음 주도 같은 조건·같은 규칙에서만 거래한다."
  ] : type === "loss" ? [
    "이번 주 손실을 만회하기 위해 다음 주 거래 규모를 늘리지 않는다.",
    "손실 금액을 내 능력이나 가치와 동일시하지 않는다.",
    "복수매매·조급한 진입 없이 정상적인 셋업만 기다린다.",
    "손실의 원인이 규칙 위반인지 정상적인 확률 손실인지 분리해서 본다."
  ] : [
    "본전 주간도 결과를 억지로 만들 필요가 없다.",
    "거래하지 않은 것도 규칙을 지킨 결정일 수 있다.",
    "다음 주 결과를 미리 기대하지 않고 조건만 본다.",
    "거래 규모와 위험 한도를 그대로 유지한다."
  ];
  const wrap = $("weeklyMindsetChecklist");
  if (!wrap) return;
  wrap.innerHTML = `<div class="weekly-mindset-title">${type === "profit" ? "수익 주 · 탐욕 리셋" : type === "loss" ? "손실 주 · 자괴감 리셋" : "본전 주 · 중립 리셋"}</div>` + items.map((text, index) => {
    const checked = selected.includes(index);
    return `<label class="weekly-check"><input type="checkbox" data-weekly-mindset="${index}" ${checked ? "checked" : ""}/><span>${escapeHtml(text)}</span></label>`;
  }).join("");
  $("weeklyDistancingLabel").textContent = type === "profit" ? "탐욕과 거리두기" : type === "loss" ? "자괴감과 거리두기" : "결과와 거리두기";
}

function updateWeeklyReviewContext(selectedChecks = null) {
  const date = $("weeklyReviewDate")?.value || localDateString();
  const pnl = weeklyPnlForDate(date);
  const trades = weeklyTradesForDate(date);
  const start = weekStartMonday(date);
  $("weeklyPnlValue").value = pnl.toFixed(2);
  const withdrawal = $("weeklyWithdrawal");
  if (withdrawal) {
    withdrawal.disabled = pnl <= 0;
    if (pnl <= 0) withdrawal.value = "0";
  }
  const type = weeklyResultType(pnl);
  const banner = $("weeklyResultBanner");
  banner.className = `weekly-result-banner ${type}`;
  banner.textContent = type === "profit" ? `수익 주간 · ${formatMoney(pnl)} · 인출 가능` : type === "loss" ? `손실 주간 · ${formatMoney(pnl)} · 인출 없음` : `본전 주간 · ${formatMoney(pnl)} · 인출 없음`;
  $("weeklyWithdrawalHint").textContent = pnl > 0 ? "이번 주 순손익이 양수이므로 인출액을 직접 기록할 수 있습니다." : "이번 주 순손익이 0 이하이므로 인출액은 자동으로 0으로 고정됩니다.";
  const day = new Date(`${date}T12:00:00`).getDay();
  const warning = $("weeklyDateWarning");
  if (day === 5 || day === 6) {
    warning.classList.add("hidden");
  } else {
    warning.textContent = "권장 점검일은 금요일 또는 토요일입니다. 기록은 가능하지만 주간 리셋 루틴은 금·토에 실행하는 것을 기준으로 합니다.";
    warning.classList.remove("hidden");
  }
  renderWeeklyMindset(pnl, selectedChecks || [...document.querySelectorAll('[data-weekly-mindset]:checked')].map(el => Number(el.dataset.weeklyMindset)));
  $("weeklySummary").innerHTML = [
    ["점검 기간", `${formatDate(start)} → ${formatDate(date)}`],
    ["LIVE 거래", `${trades.length}건`],
    ["주간 순손익", formatMoney(pnl)],
    ["수익 거래", `${trades.filter(t => Number(t.pnl) > 0).length}건`]
  ].map(([label,value]) => `<div class="summary-card"><span>${label}</span><strong>${value}</strong></div>`).join("");
}

function setupWeeklyReview() {
  $("weeklyReviewDate").value = localDateString();
  $("weeklyReviewDate").addEventListener("change", () => updateWeeklyReviewContext([]));
  $("weeklyReviewForm").addEventListener("submit", saveWeeklyReview);
  $("weeklyResetButton").addEventListener("click", resetWeeklyReviewForm);
  updateWeeklyReviewContext([]);
  renderWeeklyReview();
}

function saveWeeklyReview(event) {
  event.preventDefault();
  const date = $("weeklyReviewDate").value || localDateString();
  const pnl = weeklyPnlForDate(date);
  const id = $("weeklyReviewId").value || uid("weekly");
  const index = state.weeklyReviews.findIndex(r => r.id === id);
  const previous = index >= 0 ? state.weeklyReviews[index] : {};
  const record = normalizeWeeklyReview({
    ...previous,
    id,
    date,
    weekStart: weekStartMonday(date),
    weekEnd: date,
    pnl,
    withdrawal: pnl > 0 ? Number($("weeklyWithdrawal").value || 0) : 0,
    resetSeed: Number($("weeklyResetSeed").value || 0),
    fact: $("weeklyFact").value.trim(),
    emotion: $("weeklyEmotion").value.trim(),
    distancing: $("weeklyDistancing").value.trim(),
    discipline: $("weeklyDiscipline").value.trim(),
    nextRule: $("weeklyNextRule").value.trim(),
    resetStatement: $("weeklyResetStatement").value.trim(),
    mindsetChecks: [...document.querySelectorAll('[data-weekly-mindset]:checked')].map(el => Number(el.dataset.weeklyMindset)),
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  if (index >= 0) state.weeklyReviews[index] = record; else state.weeklyReviews.push(record);
  saveState();
  resetWeeklyReviewForm();
  renderWeeklyReview();
  notify(index >= 0 ? "주간 기록을 수정했습니다." : "주간 인출 · 리셋 기록을 저장했습니다.");
}

function resetWeeklyReviewForm() {
  $("weeklyReviewForm").reset();
  $("weeklyReviewId").value = "";
  $("weeklyReviewDate").value = localDateString();
  updateWeeklyReviewContext([]);
}

function editWeeklyReview(id) {
  const record = state.weeklyReviews.find(r => r.id === id);
  if (!record) return;
  $("weeklyReviewId").value = record.id;
  $("weeklyReviewDate").value = record.date;
  updateWeeklyReviewContext(record.mindsetChecks || []);
  if (record.pnl > 0) $("weeklyWithdrawal").value = record.withdrawal || 0;
  $("weeklyResetSeed").value = record.resetSeed || "";
  $("weeklyFact").value = record.fact || "";
  $("weeklyEmotion").value = record.emotion || "";
  $("weeklyDistancing").value = record.distancing || "";
  $("weeklyDiscipline").value = record.discipline || "";
  $("weeklyNextRule").value = record.nextRule || "";
  $("weeklyResetStatement").value = record.resetStatement || "";
  window.scrollTo({ top: $("weeklyReviewForm").getBoundingClientRect().top + window.scrollY - 110, behavior: "smooth" });
}

async function deleteWeeklyReview(id) {
  const accepted = await confirmAction("주간 기록 삭제", "이 주간 인출 · 심리 리셋 기록을 삭제합니다.");
  if (!accepted) return;
  state.weeklyReviews = state.weeklyReviews.filter(r => r.id !== id);
  saveState();
  renderWeeklyReview();
}

function renderWeeklyReview() {
  if (!$("weeklyReviewList")) return;
  updateWeeklyReviewContext();
  const records = [...state.weeklyReviews].sort((a,b) => b.date.localeCompare(a.date));
  const totalWithdrawals = records.reduce((sum,r) => sum + Number(r.withdrawal || 0), 0);
  $("weeklyTotalWithdrawals").textContent = `누적 인출 ${formatMoney(totalWithdrawals)}`;
  if (!records.length) {
    $("weeklyReviewList").innerHTML = '<div class="empty-state">아직 저장된 주간 기록이 없습니다.</div>';
    return;
  }
  $("weeklyReviewList").innerHTML = records.map(record => {
    const type = weeklyResultType(record.pnl);
    return `<article class="weekly-review-card ${type}">
      <div class="weekly-review-head"><div><strong>${formatDate(record.weekStart)} → ${formatDate(record.weekEnd)}</strong><span>${type === "profit" ? "수익 주" : type === "loss" ? "손실 주" : "본전 주"}</span></div><div class="trade-actions"><button class="icon-button" type="button" data-edit-weekly="${record.id}">✎</button><button class="icon-button" type="button" data-delete-weekly="${record.id}">×</button></div></div>
      <div class="weekly-review-metrics"><div><span>주간 순손익</span><strong>${formatMoney(record.pnl)}</strong></div><div><span>인출액</span><strong>${formatMoney(record.withdrawal)}</strong></div><div><span>다음 주 시드</span><strong>${record.resetSeed ? formatNumber(record.resetSeed,2) : "-"}</strong></div></div>
      <div class="trade-review-grid"><div class="review-box"><span>이번 주 사실</span><p>${escapeHtml(record.fact || "-")}</p></div><div class="review-box"><span>감정 상태</span><p>${escapeHtml(record.emotion || "-")}</p></div><div class="review-box"><span>거리두기</span><p>${escapeHtml(record.distancing || "-")}</p></div><div class="review-box"><span>다음 주 한 가지</span><p>${escapeHtml(record.nextRule || "-")}</p></div></div>
      ${record.resetStatement ? `<div class="weekly-reset-statement">${escapeHtml(record.resetStatement)}</div>` : ""}
    </article>`;
  }).join("");
  $$('[data-edit-weekly]', $("weeklyReviewList")).forEach(btn => btn.addEventListener("click", () => editWeeklyReview(btn.dataset.editWeekly)));
  $$('[data-delete-weekly]', $("weeklyReviewList")).forEach(btn => btn.addEventListener("click", () => deleteWeeklyReview(btn.dataset.deleteWeekly)));
}

function setupSettings() {
  $("gcMultiplier").value = state.settings.gcMultiplier;
  $("mgcMultiplier").value = state.settings.mgcMultiplier;
  $("btcMultiplier").value = state.settings.btcMultiplier;
  $("customMultiplier").value = state.settings.customMultiplier;
  $("contractSettingsForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.settings = {
      gcMultiplier: Number($("gcMultiplier").value || 100),
      mgcMultiplier: Number($("mgcMultiplier").value || 10),
      customMultiplier: Number($("customMultiplier").value || 1)
    };
    saveState();
    updateTradeCalculations();
    notify("상품 설정을 저장했습니다.");
  });
  $("exportBackupButton").addEventListener("click", exportBackup);
  $("importBackupInput").addEventListener("change", importBackup);
  $("clearAllButton").addEventListener("click", clearAllData);
}

async function renderDataStatus() {
  if (!$("dataStatus")) return;
  let imageCount = 0;
  try { imageCount = (await getAllImages()).length; } catch (error) { console.error(error); }
  $("dataStatus").innerHTML = [
    ["시장 분석", `${Object.keys(state.analyses).length}일`],
    ["거래 기록", `${state.trades.length}건`],
    ["일간 마감", `${Object.keys(state.dailyReviews).length}일`],
    ["주간 리셋", `${state.weeklyReviews.length}건`],
    ["저장 이미지", `${imageCount}장`]
  ].map(([label,value]) => `<div class="summary-card"><span>${label}</span><strong>${value}</strong></div>`).join("");
}

async function exportBackup() {
  const images = await getAllImages();
  const payload = { exportedAt: new Date().toISOString(), app: "Gold Futures Trading Review", state, images };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `gold-trading-review-backup-${localDateString()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importBackup(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (!payload.state || !Array.isArray(payload.images)) throw new Error("지원하지 않는 백업 형식입니다.");
    const accepted = await confirmAction("백업 복원", "현재 데이터가 백업 파일 내용으로 교체됩니다.");
    if (!accepted) return;
    state = {
      ...cloneDefaultState(),
      ...payload.state,
      settings: { ...DEFAULT_STATE.settings, ...(payload.state.settings || {}) },
      strategyGoal: { ...DEFAULT_STATE.strategyGoal, ...(payload.state.strategyGoal || {}) },
      tradingPrinciples: normalizeTradingPrinciples(payload.state.tradingPrinciples),
      levelSystem: { ...DEFAULT_STATE.levelSystem, ...(payload.state.levelSystem || {}) },
      trades: Array.isArray(payload.state.trades) ? payload.state.trades.map(normalizeTradeRecord) : [],
      weeklyReviews: Array.isArray(payload.state.weeklyReviews) ? payload.state.weeklyReviews.map(normalizeWeeklyReview) : []
    };
    syncLevelSystemState();
    await clearImages();
    for (const image of payload.images) await putImage(image);
    saveState();
    location.reload();
  } catch (error) {
    alert(`백업 복원 실패: ${error.message}`);
  } finally {
    event.target.value = "";
  }
}

async function clearAllData() {
  const accepted = await confirmAction("전체 데이터 삭제", "시장 분석, 거래, 일간 마감, 주간 인출·리셋, 업로드 이미지가 모두 삭제됩니다. 이 작업은 되돌릴 수 없습니다.");
  if (!accepted) return;
  state = cloneDefaultState();
  localStorage.removeItem(STORAGE_KEY);
  await clearImages();
  location.reload();
}

function confirmAction(title, message) {
  $("confirmTitle").textContent = title;
  $("confirmMessage").textContent = message;
  $("confirmModal").classList.remove("hidden");
  return new Promise((resolve) => confirmResolver = resolve);
}

function closeConfirm(value) {
  $("confirmModal").classList.add("hidden");
  if (confirmResolver) confirmResolver(value);
  confirmResolver = null;
}

function notify(message) {
  const warning = $("storageWarning");
  warning.textContent = message;
  warning.classList.remove("hidden");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => warning.classList.add("hidden"), 2600);
}

function setupModals() {
  $$('[data-close-modal]').forEach((element) => element.addEventListener("click", closeImageViewer));
  $("confirmCancel").addEventListener("click", () => closeConfirm(false));
  $("confirmAccept").addEventListener("click", () => closeConfirm(true));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("imageViewer").classList.contains("hidden")) closeImageViewer();
      if (!$("confirmModal").classList.contains("hidden")) closeConfirm(false);
    }
  });
}

function checkStorageSupport() {
  if (!("indexedDB" in window)) {
    $("storageWarning").textContent = "이 브라우저는 IndexedDB를 지원하지 않아 이미지 저장 기능을 사용할 수 없습니다.";
    $("storageWarning").classList.remove("hidden");
  }
}

async function init() {
  safeRun("HTML 연결 검사", validateCriticalDom);

  safeRun("탭 초기화", setupTabs);
  safeRun("전략 목표 초기화", setupStrategyGoal);
  safeRun("매매 원칙 초기화", setupTradingPrinciples);
  safeRun("시장 세션 초기화", setupMarketSessions);
  safeRun("금 분석 초기화", setupAnalysis);
  safeRun("거래 기록 초기화", setupTradeForm);
  safeRun("일간 마감 초기화", setupDaily);
  safeRun("주간 인출·리셋 초기화", setupWeeklyReview);
  safeRun("통계 초기화", setupAnalytics);
  safeRun("설정·백업 초기화", setupSettings);
  safeRun("모달 초기화", setupModals);
  safeRun("저장소 지원 확인", checkStorageSupport);

  safeRun("레벨 시스템 동기화", () => {
    if (syncLevelSystemState()) {
      state.updatedAt = new Date().toISOString();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  });

  safeRun("상단 상태 렌더링", updateHeader);
  safeRun("계좌 배너 렌더링", renderAccountBanner);
  await safeRunAsync("거래 목록 렌더링", renderTrades);
  safeRun("일간 마감 렌더링", renderDaily);
  safeRun("통계 렌더링", renderAnalytics);
  await safeRunAsync("데이터 상태 렌더링", renderDataStatus);
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => showRuntimeError("초기화", error));
});
