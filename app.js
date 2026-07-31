"use strict";

const STORAGE_KEY = "goldTradingReviewV1";
const DB_NAME = "goldTradingReviewImagesV1";
const DB_STORE = "images";
const DB_VERSION = 1;

const DEFAULT_STATE = {
  version: 1,
  activeAccount: "all",
  analyses: {},
  trades: [],
  dailyReviews: {},
  settings: {
    gcMultiplier: 100,
    mgcMultiplier: 10,
    customMultiplier: 1
  },
  updatedAt: null
};

let state = loadState();
let dbPromise = null;
let pendingAnalysisImages = [];
let pendingTradeImages = [];
let currentTradeImageIds = [];
let confirmResolver = null;

const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => [
  ...root.querySelectorAll(selector)
];

function cloneDefaultState() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return cloneDefaultState();
    }

    const parsed = JSON.parse(raw);

    return {
      ...cloneDefaultState(),
      ...parsed,
      settings: {
        ...DEFAULT_STATE.settings,
        ...(parsed.settings || {})
      },
      analyses: parsed.analyses || {},
      trades: Array.isArray(parsed.trades) ? parsed.trades : [],
      dailyReviews: parsed.dailyReviews || {}
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

        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, {
            keyPath: "id"
          });
        }
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
    const request = db
      .transaction(DB_STORE, "readonly")
      .objectStore(DB_STORE)
      .get(id);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function getAllImages() {
  const db = await openImageDb();

  return new Promise((resolve, reject) => {
    const request = db
      .transaction(DB_STORE, "readonly")
      .objectStore(DB_STORE)
      .getAll();

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
  return `${prefix}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");

  return `${y}-${m}-${d}`;
}

function formatDate(dateString) {
  if (!dateString) {
    return "-";
  }

  const date = new Date(`${dateString}T00:00:00`);

  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  }).format(date);
}

function formatNumber(value, digits = 2) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "-";
  }

  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: digits
  }).format(number);
}

function formatMoney(value) {
  const number = Number(value) || 0;
  const sign = number > 0 ? "+" : "";

  return `${sign}$${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(number)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function splitTags(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getMultiplier(symbol) {
  if (symbol === "GC") {
    return Number(state.settings.gcMultiplier) || 100;
  }

  if (symbol === "MGC") {
    return Number(state.settings.mgcMultiplier) || 10;
  }

  return Number(state.settings.customMultiplier) || 1;
}

function calculateTrade(form = null) {
  const value = (id) => {
    return form
      ? Number(form[id] ?? 0)
      : Number($(id).value || 0);
  };

  const text = (id) => {
    return form
      ? String(form[id] ?? "")
      : $(id).value;
  };

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

  const grossPnl =
    (exit - entry) *
    directionSign *
    multiplier *
    contracts;

  const pnl = grossPnl - fees;

  const riskPerContract = stop
    ? Math.abs(entry - stop) * multiplier
    : 0;

  const riskAmount = riskPerContract * contracts;

  const actualR = riskAmount > 0
    ? grossPnl / riskAmount
    : null;

  const rewardDistance = target
    ? Math.abs(target - entry)
    : 0;

  const riskDistance = stop
    ? Math.abs(entry - stop)
    : 0;

  const plannedRR = riskDistance > 0
    ? rewardDistance / riskDistance
    : null;

  const duration = calculateDuration(
    text("tradeDate"),
    text("entryTime"),
    text("exitTime")
  );

  return {
    pnl,
    grossPnl,
    actualR,
    plannedRR,
    duration,
    multiplier,
    riskAmount
  };
}

function calculateDuration(date, entryTime, exitTime) {
  if (!date || !entryTime || !exitTime) {
    return null;
  }

  const start = new Date(`${date}T${entryTime}:00`);
  let end = new Date(`${date}T${exitTime}:00`);

  if (end < start) {
    end = new Date(
      end.getTime() + 24 * 60 * 60 * 1000
    );
  }

  return Math.max(
    0,
    Math.round((end - start) / 60000)
  );
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes)) {
    return "-";
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return hours
    ? `${hours}시간 ${rest}분`
    : `${rest}분`;
}

function resultOfTrade(trade) {
  if (trade.pnl > 0.005) {
    return "win";
  }

  if (trade.pnl < -0.005) {
    return "loss";
  }

  return "breakeven";
}

function setupTabs() {
  const views = {
    analysis: $("analysisView"),
    trades: $("tradesView"),
    daily: $("dailyView"),
    analytics: $("analyticsView"),
    settings: $("settingsView")
  };

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((item) => {
        item.classList.toggle("active", item === tab);
      });

      Object.entries(views).forEach(([name, view]) => {
        view.classList.toggle(
          "active",
          name === tab.dataset.view
        );
      });

      if (tab.dataset.view === "analytics") {
        renderAnalytics();
      }

      if (tab.dataset.view === "daily") {
        renderDaily();
      }

      if (tab.dataset.view === "settings") {
        renderDataStatus();
      }
    });
  });
}

function updateHeader() {
  const today = localDateString();

  $("todayLabel").textContent = formatDate(today);

  $("analysisStatus").textContent =
    state.analyses[today]
      ? "작성 완료"
      : "미작성";

  $("analysisStatus").style.color =
    state.analyses[today]
      ? "var(--green)"
      : "var(--orange)";

  $("activeAccountLabel").textContent =
    state.activeAccount === "demo"
      ? "데모"
      : state.activeAccount === "live"
        ? "실제"
        : "전체";
}

function setActiveAccount(account, switchView = true) {
  state.activeAccount = account;
  saveState();

  $$(".account-card").forEach((card) => {
    card.classList.toggle(
      "selected",
      card.dataset.account === account
    );
  });

  $("tradeAccount").value =
    account === "live"
      ? "live"
      : "demo";

  renderAccountBanner();
  renderTrades();

  if (switchView) {
    document
      .querySelector(".tab[data-view='trades']")
      ?.click();
  }
}

function renderAccountBanner() {
  const banner = $("accountBanner");

  banner.className =
    `account-banner ${state.activeAccount}`;

  const label =
    state.activeAccount === "demo"
      ? "DEMO ACCOUNT"
      : state.activeAccount === "live"
        ? "LIVE ACCOUNT"
        : "전체 계좌";

  banner.querySelector("strong").textContent = label;
}

function setupAnalysis() {
  $("analysisDate").value = localDateString();

  $("analysisDate").addEventListener(
    "change",
    loadAnalysisForm
  );

  $("analysisForm").addEventListener(
    "submit",
    saveAnalysis
  );

  $("clearAnalysisButton").addEventListener(
    "click",
    clearAnalysisForm
  );

  $("analysisImages").addEventListener(
    "change",
    (event) => {
      addPendingImages(
        event.target.files,
        "analysis"
      );
    }
  );

  $$(".account-card").forEach((card) => {
    card.addEventListener("click", () => {
      setActiveAccount(card.dataset.account);
    });
  });

  $("showAllAccounts").addEventListener(
    "click",
    () => setActiveAccount("all", false)
  );

  loadAnalysisForm();
}

function analysisFieldIds() {
  return [
    "marketBias",
    "biasConfidence",
    "tradePermission",
    "keySupport",
    "keyResistance",
    "bullScenario",
    "bearScenario",
    "analysisSummary",
    "higherTimeframe",
    "lowerTimeframe",
    "macroCorrelation",
    "assetCorrelation",
    "eventRisk",
    "invalidation"
  ];
}

async function loadAnalysisForm() {
  const date =
    $("analysisDate").value ||
    localDateString();

  const record = state.analyses[date] || {};

  analysisFieldIds().forEach((id) => {
    const input = $(id);

    input.value =
      record[id] ??
      (
        id === "marketBias"
          ? "neutral"
          : id === "biasConfidence"
            ? "3"
            : id === "tradePermission"
              ? "normal"
              : ""
      );
  });

  pendingAnalysisImages = [];

  await renderImageIds(
    $("analysisImageList"),
    record.imageIds || [],
    "analysis",
    date
  );
}

function clearAnalysisForm() {
  analysisFieldIds().forEach((id) => {
    const input = $(id);

    input.value =
      id === "marketBias"
        ? "neutral"
        : id === "biasConfidence"
          ? "3"
          : id === "tradePermission"
            ? "normal"
            : "";
  });

  pendingAnalysisImages = [];

  renderPendingImages(
    $("analysisImageList"),
    [],
    "analysis"
  );
}

async function saveAnalysis(event) {
  event.preventDefault();

  const date =
    $("analysisDate").value ||
    localDateString();

  const previous =
    state.analyses[date] || {};

  const uploadedIds = await persistPendingImages(
    pendingAnalysisImages,
    {
      ownerType: "analysis",
      ownerId: date
    }
  );

  const record = {
    date,
    imageIds: [
      ...(previous.imageIds || []),
      ...uploadedIds
    ],
    createdAt:
      previous.createdAt ||
      new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  analysisFieldIds().forEach((id) => {
    record[id] = $(id).value.trim();
  });

  state.analyses[date] = record;
  pendingAnalysisImages = [];

  saveState();

  await renderImageIds(
    $("analysisImageList"),
    record.imageIds,
    "analysis",
    date
  );

  notify("오늘의 시장 분석을 저장했습니다.");
}

function setupTradeForm() {
  $("tradeDate").value = localDateString();

  $("tradeAccount").value =
    state.activeAccount === "live"
      ? "live"
      : "demo";

  [
    "tradeSymbol",
    "tradeDirection",
    "tradeDate",
    "entryTime",
    "exitTime",
    "contracts",
    "fees",
    "entryPrice",
    "stopPrice",
    "targetPrice",
    "exitPrice"
  ].forEach((id) => {
    $(id).addEventListener(
      "input",
      updateTradeCalculations
    );
  });

  $("tradeForm").addEventListener(
    "submit",
    saveTrade
  );

  $("resetTradeButton").addEventListener(
    "click",
    resetTradeForm
  );

  $("tradeImages").addEventListener(
    "change",
    (event) => {
      addPendingImages(
        event.target.files,
        "trade"
      );
    }
  );

  $("changeAccountButton").addEventListener(
    "click",
    () => {
      document
        .querySelector(".tab[data-view='analysis']")
        ?.click();
    }
  );

  $("reviewDepth").addEventListener(
    "change",
    updateReviewDepth
  );

  $("tradeAccountFilter").addEventListener(
    "change",
    renderTrades
  );

  $("tradeResultFilter").addEventListener(
    "change",
    renderTrades
  );

  $("tradeSearch").addEventListener(
    "input",
    renderTrades
  );

  updateReviewDepth();
  updateTradeCalculations();
}

function updateReviewDepth() {
  const depth = $("reviewDepth").value;
  const details = $("tradeDetailsPanel");

  details.open = depth === "deep";

  details.style.opacity =
    depth === "quick"
      ? ".62"
      : "1";
}

function updateTradeCalculations() {
  const calc = calculateTrade();

  $("plannedRR").textContent =
    calc.plannedRR == null
      ? "-"
      : `1 : ${formatNumber(calc.plannedRR, 2)}`;

  $("actualR").textContent =
    calc.actualR == null
      ? "-"
      : `${formatNumber(calc.actualR, 2)}R`;

  $("durationValue").textContent =
    formatDuration(calc.duration);

  $("calculatedPnl").textContent =
    formatMoney(calc.pnl);

  $("calculatedPnl").style.color =
    calc.pnl > 0
      ? "var(--green)"
      : calc.pnl < 0
        ? "var(--red)"
        : "var(--text)";
}

function tradeFieldIds() {
  return [
    "tradeAccount",
    "tradeDate",
    "tradeSymbol",
    "tradeDirection",
    "entryTime",
    "exitTime",
    "contracts",
    "fees",
    "entryPrice",
    "stopPrice",
    "targetPrice",
    "exitPrice",
    "reviewDepth",
    "tradeReason",
    "tradeStrengths",
    "tradeMistakes",
    "nextAction",
    "psychology",
    "tradeReview",
    "frameworkTags",
    "timeframes",
    "analysisScore",
    "executionScore",
    "emotionScore"
  ];
}

async function saveTrade(event) {
  event.preventDefault();

  const id =
    $("tradeId").value ||
    uid("trade");

  const existingIndex =
    state.trades.findIndex(
      (trade) => trade.id === id
    );

  const previous =
    existingIndex >= 0
      ? state.trades[existingIndex]
      : {};

  const uploadedIds =
    await persistPendingImages(
      pendingTradeImages,
      {
        ownerType: "trade",
        ownerId: id
      }
    );

  const calc = calculateTrade();

  const trade = {
    ...previous,
    id,
    imageIds: [
      ...currentTradeImageIds,
      ...uploadedIds
    ],
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
    createdAt:
      previous.createdAt ||
      new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  tradeFieldIds().forEach((field) => {
    const idMap = {
      tradeAccount: "account",
      tradeDate: "date",
      tradeSymbol: "symbol",
      tradeDirection: "direction"
    };

    const key = idMap[field] || field;
    const input = $(field);

    trade[key] =
      input.type === "number"
        ? Number(input.value || 0)
        : input.value.trim();
  });

  trade.frameworkTags =
    splitTags($("frameworkTags").value);

  trade.timeframes =
    splitTags($("timeframes").value);

  if (existingIndex >= 0) {
    state.trades[existingIndex] = trade;
  } else {
    state.trades.push(trade);
  }

  saveState();
  resetTradeForm();
  renderTrades();
  renderDaily();

  notify(
    existingIndex >= 0
      ? "거래 기록을 수정했습니다."
      : "거래 기록을 저장했습니다."
  );
}

function resetTradeForm() {
  $("tradeForm").reset();
  $("tradeId").value = "";
  $("tradeDate").value = localDateString();

  $("tradeAccount").value =
    state.activeAccount === "live"
      ? "live"
      : "demo";

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

  renderPendingImages(
    $("tradeImageList"),
    [],
    "trade"
  );

  updateReviewDepth();
  updateTradeCalculations();
}

async function editTrade(id) {
  const trade =
    state.trades.find(
      (item) => item.id === id
    );

  if (!trade) {
    return;
  }

  $("tradeId").value = trade.id;

  const keyMap = {
    tradeAccount: "account",
    tradeDate: "date",
    tradeSymbol: "symbol",
    tradeDirection: "direction"
  };

  tradeFieldIds().forEach((field) => {
    const key = keyMap[field] || field;
    const input = $(field);

    const value =
      Array.isArray(trade[key])
        ? trade[key].join(", ")
        : trade[key];

    input.value = value ?? "";
  });

  $("followedPlan").checked =
    Boolean(trade.followedPlan);

  $("ruleViolation").checked =
    Boolean(trade.ruleViolation);

  $("revengeTrade").checked =
    Boolean(trade.revengeTrade);

  $("macroAligned").checked =
    Boolean(trade.macroAligned);

  pendingTradeImages = [];
  currentTradeImageIds = [
    ...(trade.imageIds || [])
  ];

  await renderImageIds(
    $("tradeImageList"),
    currentTradeImageIds,
    "trade",
    trade.id
  );

  updateReviewDepth();
  updateTradeCalculations();

  window.scrollTo({
    top:
      $("tradeForm").getBoundingClientRect().top +
      window.scrollY -
      110,
    behavior: "smooth"
  });
}

async function removeTrade(id) {
  const accepted =
    await confirmAction(
      "거래 기록 삭제",
      "이 거래와 연결된 차트 이미지도 삭제합니다."
    );

  if (!accepted) {
    return;
  }

  const trade =
    state.trades.find(
      (item) => item.id === id
    );

  if (trade) {
    await Promise.all(
      (trade.imageIds || []).map(deleteImage)
    );
  }

  state.trades =
    state.trades.filter(
      (item) => item.id !== id
    );

  saveState();
  renderTrades();
  renderDaily();
  renderAnalytics();
}

async function renderTrades() {
  if (
    $("tradeAccountFilter") &&
    state.activeAccount !== "all" &&
    $("tradeAccountFilter").value === "all"
  ) {
    $("tradeAccountFilter").value =
      state.activeAccount;
  }

  const accountFilter =
    $("tradeAccountFilter")?.value ||
    (
      state.activeAccount === "all"
        ? "all"
        : state.activeAccount
    );

  const resultFilter =
    $("tradeResultFilter")?.value ||
    "all";

  const query =
    ($("tradeSearch")?.value || "")
      .trim()
      .toLowerCase();

  const trades = [...state.trades]
    .filter((trade) => {
      return (
        accountFilter === "all" ||
        trade.account === accountFilter
      );
    })
    .filter((trade) => {
      return (
        resultFilter === "all" ||
        resultOfTrade(trade) === resultFilter
      );
    })
    .filter((trade) => {
      if (!query) {
        return true;
      }

      return [
        trade.tradeReason,
        trade.tradeReview,
        trade.tradeStrengths,
        trade.tradeMistakes,
        trade.nextAction,
        trade.psychology,
        ...(trade.frameworkTags || [])
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => {
      return `${b.date} ${b.entryTime || ""}`
        .localeCompare(
          `${a.date} ${a.entryTime || ""}`
        );
    });

  const list = $("tradeList");

  if (!trades.length) {
    list.innerHTML =
      '<div class="empty-state">조건에 맞는 거래 기록이 없습니다.</div>';

    return;
  }

  const html = [];

  for (const trade of trades) {
    const result = resultOfTrade(trade);

    const imageRecords =
      await Promise.all(
        (trade.imageIds || [])
          .slice(0, 6)
          .map(getImage)
      );

    html.push(`
      <article class="trade-card ${escapeHtml(trade.account)}">
        <div class="trade-card-head">
          <div class="trade-card-title">
            <strong>${escapeHtml(trade.symbol)} · ${trade.direction === "long" ? "LONG" : "SHORT"}</strong>
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
          <div>
            <span>순손익</span>
            <strong style="color:${trade.pnl > 0 ? "var(--green)" : trade.pnl < 0 ? "var(--red)" : "inherit"}">
              ${formatMoney(trade.pnl)}
            </strong>
          </div>
          <div>
            <span>실제 R</span>
            <strong>${trade.actualR == null ? "-" : `${formatNumber(trade.actualR, 2)}R`}</strong>
          </div>
          <div>
            <span>계획 손익비</span>
            <strong>${trade.plannedRR == null ? "-" : `1:${formatNumber(trade.plannedRR, 2)}`}</strong>
          </div>
          <div>
            <span>보유 시간</span>
            <strong>${formatDuration(trade.durationMinutes)}</strong>
          </div>
          <div>
            <span>진입→청산</span>
            <strong>${formatNumber(trade.entryPrice)} → ${formatNumber(trade.exitPrice)}</strong>
          </div>
          <div>
            <span>복기 깊이</span>
            <strong>${trade.reviewDepth === "deep" ? "심층" : trade.reviewDepth === "quick" ? "간단" : "정상"}</strong>
          </div>
        </div>
        <div class="trade-review-grid">
          <div class="review-box">
            <span>진입 이유</span>
            <p>${escapeHtml(trade.tradeReason || "-")}</p>
          </div>
          <div class="review-box">
            <span>거래 복기</span>
            <p>${escapeHtml(trade.tradeReview || "-")}</p>
          </div>
          <div class="review-box">
            <span>잘한 점</span>
            <p>${escapeHtml(trade.tradeStrengths || "-")}</p>
          </div>
          <div class="review-box">
            <span>잘못한 점·다음 행동</span>
            <p>${escapeHtml([
              trade.tradeMistakes,
              trade.nextAction
            ].filter(Boolean).join("\n") || "-")}</p>
          </div>
        </div>
        ${
          imageRecords.filter(Boolean).length
            ? `
              <div class="trade-image-strip">
                ${
                  imageRecords
                    .filter(Boolean)
                    .map((image) => `
                      <img
                        src="${image.dataUrl}"
                        alt="거래 차트"
                        data-view-image="${image.id}"
                      />
                    `)
                    .join("")
                }
              </div>
            `
            : ""
        }
      </article>
    `);
  }

  list.innerHTML = html.join("");

  $$("[data-edit-trade]", list).forEach((button) => {
    button.addEventListener("click", () => {
      editTrade(button.dataset.editTrade);
    });
  });

  $$("[data-delete-trade]", list).forEach((button) => {
    button.addEventListener("click", () => {
      removeTrade(button.dataset.deleteTrade);
    });
  });

  $$("[data-view-image]", list).forEach((image) => {
    image.addEventListener("click", () => {
      openImageViewer(image.dataset.viewImage);
    });
  });
}

function setupDaily() {
  $("dailyDate").value = localDateString();

  $("dailyDate").addEventListener(
    "change",
    renderDaily
  );

  $("dailyReviewForm").addEventListener(
    "submit",
    saveDailyReview
  );
}

function tradesForDate(date, account = "all") {
  return state.trades.filter((trade) => {
    return (
      trade.date === date &&
      (
        account === "all" ||
        trade.account === account
      )
    );
  });
}

function aggregateTrades(trades) {
  const wins =
    trades.filter(
      (trade) => trade.pnl > 0
    );

  const losses =
    trades.filter(
      (trade) => trade.pnl < 0
    );

  const grossProfit =
    wins.reduce(
      (sum, trade) => sum + trade.pnl,
      0
    );

  const grossLoss =
    losses.reduce(
      (sum, trade) => sum + Math.abs(trade.pnl),
      0
    );

  const netProfit =
    trades.reduce(
      (sum, trade) => sum + trade.pnl,
      0
    );

  const avgWin =
    wins.length
      ? grossProfit / wins.length
      : 0;

  const avgLoss =
    losses.length
      ? grossLoss / losses.length
      : 0;

  const validR =
    trades.filter(
      (trade) => Number.isFinite(trade.actualR)
    );

  const validRR =
    trades.filter(
      (trade) => Number.isFinite(trade.plannedRR)
    );

  const durations =
    trades.filter(
      (trade) => Number.isFinite(trade.durationMinutes)
    );

  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven:
      trades.length -
      wins.length -
      losses.length,
    winRate:
      trades.length
        ? (wins.length / trades.length) * 100
        : 0,
    grossProfit,
    grossLoss,
    netProfit,
    avgWin,
    avgLoss,
    avgR:
      validR.length
        ? validR.reduce(
            (sum, trade) => sum + trade.actualR,
            0
          ) / validR.length
        : 0,
    avgPlannedRR:
      validRR.length
        ? validRR.reduce(
            (sum, trade) => sum + trade.plannedRR,
            0
          ) / validRR.length
        : 0,
    avgDuration:
      durations.length
        ? durations.reduce(
            (sum, trade) =>
              sum + trade.durationMinutes,
            0
          ) / durations.length
        : 0,
    profitFactor:
      grossLoss > 0
        ? grossProfit / grossLoss
        : grossProfit > 0
          ? Infinity
          : 0,
    expectancy:
      trades.length
        ? netProfit / trades.length
        : 0
  };
}

function renderDaily() {
  const date =
    $("dailyDate")?.value ||
    localDateString();

  const stats =
    aggregateTrades(
      tradesForDate(date)
    );

  $("dailyStats").innerHTML = [
    [
      "총 거래",
      `${stats.count}회`,
      ""
    ],
    [
      "수익 / 손실",
      `${stats.wins} / ${stats.losses}`,
      ""
    ],
    [
      "순손익",
      formatMoney(stats.netProfit),
      stats.netProfit >= 0
        ? "positive"
        : "negative"
    ],
    [
      "평균 R",
      `${formatNumber(stats.avgR, 2)}R`,
      stats.avgR >= 0
        ? "positive"
        : "negative"
    ],
    [
      "평균 보유",
      formatDuration(
        Math.round(stats.avgDuration)
      ),
      ""
    ]
  ]
    .map(([label, value, cls]) => {
      return `
        <div class="summary-card ${cls}">
          <span>${label}</span>
          <strong>${value}</strong>
        </div>
      `;
    })
    .join("");

  const review =
    state.dailyReviews[date] || {};

  $("dailyBest").value =
    review.best || "";

  $("dailyMistake").value =
    review.mistake || "";

  $("dailyKeep").value =
    review.keep || "";

  $("dailyAvoid").value =
    review.avoid || "";

  $("dailyConclusion").value =
    review.conclusion || "";
}

function saveDailyReview(event) {
  event.preventDefault();

  const date =
    $("dailyDate").value ||
    localDateString();

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
  $("analyticsPeriod").addEventListener(
    "change",
    renderAnalytics
  );

  $("analyticsAccount").addEventListener(
    "change",
    renderAnalytics
  );
}

function analyticsRange(period) {
  const today =
    new Date(
      `${localDateString()}T00:00:00`
    );

  let start = null;

  let end =
    new Date(
      today.getTime() +
      86400000 -
      1
    );

  if (period === "week") {
    start =
      new Date(
        today.getTime() -
        6 * 86400000
      );
  }

  if (period === "month") {
    start =
      new Date(
        today.getFullYear(),
        today.getMonth(),
        1
      );
  }

  if (period === "previousMonth") {
    start =
      new Date(
        today.getFullYear(),
        today.getMonth() - 1,
        1
      );

    end =
      new Date(
        today.getFullYear(),
        today.getMonth(),
        1,
        0,
        0,
        0,
        -1
      );
  }

  return {
    start,
    end
  };
}

function filteredAnalyticsTrades() {
  const period =
    $("analyticsPeriod")?.value ||
    "month";

  const account =
    $("analyticsAccount")?.value ||
    "all";

  const range =
    analyticsRange(period);

  return [...state.trades]
    .filter((trade) => {
      if (
        account !== "all" &&
        trade.account !== account
      ) {
        return false;
      }

      const date =
        new Date(
          `${trade.date}T00:00:00`
        );

      return (
        (!range.start || date >= range.start) &&
        date <= range.end
      );
    })
    .sort((a, b) => {
      return `${a.date} ${a.entryTime || ""}`
        .localeCompare(
          `${b.date} ${b.entryTime || ""}`
        );
    });
}

function renderAnalytics() {
  const trades =
    filteredAnalyticsTrades();

  const stats =
    aggregateTrades(trades);

  $("analyticsSummary").innerHTML = [
    [
      "총 거래",
      `${stats.count}회`,
      ""
    ],
    [
      "승률",
      `${formatNumber(stats.winRate, 1)}%`,
      ""
    ],
    [
      "총이익",
      formatMoney(stats.grossProfit),
      "positive"
    ],
    [
      "총손실",
      formatMoney(-stats.grossLoss),
      "negative"
    ],
    [
      "순손익",
      formatMoney(stats.netProfit),
      stats.netProfit >= 0
        ? "positive"
        : "negative"
    ],
    [
      "평균 R",
      `${formatNumber(stats.avgR, 2)}R`,
      stats.avgR >= 0
        ? "positive"
        : "negative"
    ],
    [
      "평균 손익비",
      `1:${formatNumber(stats.avgPlannedRR, 2)}`,
      ""
    ],
    [
      "Profit Factor",
      stats.profitFactor === Infinity
        ? "∞"
        : formatNumber(stats.profitFactor, 2),
      stats.profitFactor >= 1
        ? "positive"
        : "negative"
    ],
    [
      "거래당 기대값",
      formatMoney(stats.expectancy),
      stats.expectancy >= 0
        ? "positive"
        : "negative"
    ],
    [
      "평균 보유",
      formatDuration(
        Math.round(stats.avgDuration)
      ),
      ""
    ]
  ]
    .map(([label, value, cls]) => {
      return `
        <div class="summary-card ${cls}">
          <span>${label}</span>
          <strong>${value}</strong>
        </div>
      `;
    })
    .join("");

  renderDailyPnlChart(trades);
  renderEquityChart(trades);
  renderAccountComparison(trades);
  renderPatternSummary(trades);
}

function renderDailyPnlChart(trades) {
  const grouped = {};

  trades.forEach((trade) => {
    grouped[trade.date] =
      (grouped[trade.date] || 0) +
      trade.pnl;
  });

  const points =
    Object.entries(grouped)
      .sort(([a], [b]) => {
        return a.localeCompare(b);
      })
      .map(([date, value]) => {
        return {
          label: date.slice(5),
          value
        };
      });

  $("pnlChartCaption").textContent =
    `${points.length}거래일`;

  renderBarSvg(
    $("dailyPnlChart"),
    points
  );
}

function renderEquityChart(trades) {
  let total = 0;

  const points =
    trades.map((trade, index) => {
      total += trade.pnl;

      return {
        label: String(index + 1),
        value: total
      };
    });

  renderLineSvg(
    $("equityChart"),
    points
  );
}

function chartDomain(points) {
  if (!points.length) {
    return {
      min: -1,
      max: 1
    };
  }

  let min =
    Math.min(
      ...points.map((point) => point.value),
      0
    );

  let max =
    Math.max(
      ...points.map((point) => point.value),
      0
    );

  if (min === max) {
    min -= 1;
    max += 1;
  }

  const pad = (max - min) * .12;

  return {
    min: min - pad,
    max: max + pad
  };
}

function renderBarSvg(container, points) {
  if (!points.length) {
    container.innerHTML =
      '<div class="empty-state">표시할 거래가 없습니다.</div>';

    return;
  }

  const width = 760;
  const height = 260;

  const pad = {
    l: 58,
    r: 18,
    t: 18,
    b: 42
  };

  const domain =
    chartDomain(points);

  const y = (value) => {
    return (
      pad.t +
      (
        (domain.max - value) /
        (domain.max - domain.min)
      ) *
      (
        height -
        pad.t -
        pad.b
      )
    );
  };

  const zeroY = y(0);

  const slot =
    (
      width -
      pad.l -
      pad.r
    ) / points.length;

  const bars =
    points.map((point, index) => {
      const x =
        pad.l +
        index * slot +
        slot * .18;

      const barWidth =
        Math.max(
          4,
          slot * .64
        );

      const py = y(point.value);
      const top = Math.min(py, zeroY);

      const barHeight =
        Math.max(
          1,
          Math.abs(py - zeroY)
        );

      const fill =
        point.value >= 0
          ? "#44d48b"
          : "#ff7373";

      return `
        <g>
          <rect
            x="${x}"
            y="${top}"
            width="${barWidth}"
            height="${barHeight}"
            rx="4"
            fill="${fill}"
            opacity=".88"
          >
            <title>${point.label}: ${formatMoney(point.value)}</title>
          </rect>
          ${
            points.length <= 14
              ? `
                <text
                  x="${x + barWidth / 2}"
                  y="${height - 17}"
                  fill="#9ca8bb"
                  font-size="10"
                  text-anchor="middle"
                >
                  ${point.label}
                </text>
              `
              : ""
          }
        </g>
      `;
    })
    .join("");

  container.innerHTML = `
    <svg
      viewBox="0 0 ${width} ${height}"
      role="img"
    >
      <line
        x1="${pad.l}"
        x2="${width - pad.r}"
        y1="${zeroY}"
        y2="${zeroY}"
        stroke="rgba(255,255,255,.22)"
      />
      ${bars}
    </svg>
  `;
}

function renderLineSvg(container, points) {
  if (!points.length) {
    container.innerHTML =
      '<div class="empty-state">표시할 거래가 없습니다.</div>';

    return;
  }

  const width = 760;
  const height = 260;

  const pad = {
    l: 58,
    r: 18,
    t: 18,
    b: 35
  };

  const domain =
    chartDomain(points);

  const x = (index) => {
    return points.length === 1
      ? width / 2
      : (
        pad.l +
        (
          index /
          (points.length - 1)
        ) *
        (
          width -
          pad.l -
          pad.r
        )
      );
  };

  const y = (value) => {
    return (
      pad.t +
      (
        (domain.max - value) /
        (domain.max - domain.min)
      ) *
      (
        height -
        pad.t -
        pad.b
      )
    );
  };

  const path =
    points.map((point, index) => {
      return `${index ? "L" : "M"}${x(index)},${y(point.value)}`;
    }).join(" ");

  const circles =
    points.map((point, index) => {
      return `
        <circle
          cx="${x(index)}"
          cy="${y(point.value)}"
          r="4"
          fill="#f1c75b"
        >
          <title>${index + 1}번째 거래: ${formatMoney(point.value)}</title>
        </circle>
      `;
    }).join("");

  const zeroY = y(0);

  container.innerHTML = `
    <svg
      viewBox="0 0 ${width} ${height}"
      role="img"
    >
      <line
        x1="${pad.l}"
        x2="${width - pad.r}"
        y1="${zeroY}"
        y2="${zeroY}"
        stroke="rgba(255,255,255,.18)"
      />
      <path
        d="${path}"
        fill="none"
        stroke="#f1c75b"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      ${circles}
    </svg>
  `;
}

function renderAccountComparison(trades) {
  const demo =
    aggregateTrades(
      trades.filter(
        (trade) => trade.account === "demo"
      )
    );

  const live =
    aggregateTrades(
      trades.filter(
        (trade) => trade.account === "live"
      )
    );

  $("accountComparison").innerHTML = `
    <table class="comparison-table">
      <thead>
        <tr>
          <th>지표</th>
          <th>데모</th>
          <th>실제</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>거래 수</td>
          <td>${demo.count}</td>
          <td>${live.count}</td>
        </tr>
        <tr>
          <td>승률</td>
          <td>${formatNumber(demo.winRate, 1)}%</td>
          <td>${formatNumber(live.winRate, 1)}%</td>
        </tr>
        <tr>
          <td>순손익</td>
          <td>${formatMoney(demo.netProfit)}</td>
          <td>${formatMoney(live.netProfit)}</td>
        </tr>
        <tr>
          <td>평균 R</td>
          <td>${formatNumber(demo.avgR, 2)}R</td>
          <td>${formatNumber(live.avgR, 2)}R</td>
        </tr>
        <tr>
          <td>Profit Factor</td>
          <td>${demo.profitFactor === Infinity ? "∞" : formatNumber(demo.profitFactor, 2)}</td>
          <td>${live.profitFactor === Infinity ? "∞" : formatNumber(live.profitFactor, 2)}</td>
        </tr>
      </tbody>
    </table>
  `;
}

function renderPatternSummary(trades) {
  const tags = {};

  let ruleViolations = 0;
  let revengeTrades = 0;
  let planFollowed = 0;

  trades.forEach((trade) => {
    (trade.frameworkTags || []).forEach((tag) => {
      tags[tag] = (tags[tag] || 0) + 1;
    });

    if (trade.ruleViolation) {
      ruleViolations += 1;
    }

    if (trade.revengeTrade) {
      revengeTrades += 1;
    }

    if (trade.followedPlan) {
      planFollowed += 1;
    }
  });

  const topTags =
    Object.entries(tags)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

  const rows = [
    [
      "계획 준수율",
      trades.length
        ? `${formatNumber(
            planFollowed /
            trades.length *
            100,
            1
          )}%`
        : "-"
    ],
    [
      "규칙 위반",
      `${ruleViolations}회`
    ],
    [
      "복수매매",
      `${revengeTrades}회`
    ],
    ...topTags.map(([tag, count]) => {
      return [
        `프레임워크 · ${tag}`,
        `${count}회`
      ];
    })
  ];

  $("patternSummary").innerHTML =
    rows.length
      ? `
        <div class="pattern-list">
          ${
            rows.map(([label, value]) => `
              <div class="pattern-item">
                <span>${escapeHtml(label)}</span>
                <strong>${escapeHtml(value)}</strong>
              </div>
            `).join("")
          }
        </div>
      `
      : '<div class="empty-state">아직 분석할 패턴이 없습니다.</div>';
}

async function addPendingImages(fileList, type) {
  const files =
    [...fileList].filter((file) => {
      return file.type.startsWith("image/");
    });

  const converted =
    await Promise.all(
      files.map(fileToPendingRecord)
    );

  if (type === "analysis") {
    pendingAnalysisImages.push(...converted);

    renderPendingImages(
      $("analysisImageList"),
      pendingAnalysisImages,
      "analysis"
    );
  } else {
    pendingTradeImages.push(...converted);
    renderMixedTradeImages();
  }
}

function fileToPendingRecord(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      resolve({
        tempId: uid("temp"),
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl: reader.result
      });
    };

    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function persistPendingImages(records, owner) {
  const ids = [];

  for (const record of records) {
    const id = uid("img");

    await putImage({
      id,
      ...owner,
      name: record.name,
      type: record.type,
      size: record.size,
      dataUrl: record.dataUrl,
      createdAt: new Date().toISOString()
    });

    ids.push(id);
  }

  return ids;
}

function renderPendingImages(container, records, type) {
  if (!records.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML =
    records.map((record) => `
      <article class="image-card">
        <img
          src="${record.dataUrl}"
          alt="업로드 예정 이미지"
          data-temp-view="${record.tempId}"
        />
        <div class="image-card-footer">
          <span>${escapeHtml(record.name)}</span>
          <button
            class="icon-button"
            type="button"
            data-remove-temp="${record.tempId}"
          >
            ×
          </button>
        </div>
      </article>
    `).join("");

  $$("[data-remove-temp]", container)
    .forEach((button) => {
      button.addEventListener("click", () => {
        if (type === "analysis") {
          pendingAnalysisImages =
            pendingAnalysisImages.filter(
              (item) =>
                item.tempId !==
                button.dataset.removeTemp
            );
        } else {
          pendingTradeImages =
            pendingTradeImages.filter(
              (item) =>
                item.tempId !==
                button.dataset.removeTemp
            );
        }

        if (type === "analysis") {
          renderPendingImages(
            container,
            pendingAnalysisImages,
            type
          );
        } else {
          renderMixedTradeImages();
        }
      });
    });

  $$("[data-temp-view]", container)
    .forEach((image) => {
      image.addEventListener("click", () => {
        const source =
          (
            type === "analysis"
              ? pendingAnalysisImages
              : pendingTradeImages
          ).find((item) => {
            return (
              item.tempId ===
              image.dataset.tempView
            );
          });

        openImageData(
          source?.dataUrl,
          source?.name || "업로드 이미지"
        );
      });
    });
}

async function renderImageIds(
  container,
  ids,
  ownerType,
  ownerId
) {
  const records =
    (
      await Promise.all(
        ids.map(getImage)
      )
    ).filter(Boolean);

  container.innerHTML =
    records.map((record) => `
      <article class="image-card">
        <img
          src="${record.dataUrl}"
          alt="저장된 차트 이미지"
          data-view-image="${record.id}"
        />
        <div class="image-card-footer">
          <span>${escapeHtml(record.name)}</span>
          <button
            class="icon-button"
            type="button"
            data-remove-image="${record.id}"
          >
            ×
          </button>
        </div>
      </article>
    `).join("");

  $$("[data-view-image]", container)
    .forEach((image) => {
      image.addEventListener("click", () => {
        openImageViewer(
          image.dataset.viewImage
        );
      });
    });

  $$("[data-remove-image]", container)
    .forEach((button) => {
      button.addEventListener(
        "click",
        async () => {
          const accepted =
            await confirmAction(
              "이미지 삭제",
              "이 이미지를 기록에서 제거합니다."
            );

          if (!accepted) {
            return;
          }

          await deleteImage(
            button.dataset.removeImage
          );

          if (ownerType === "analysis") {
            const record =
              state.analyses[ownerId];

            if (record) {
              record.imageIds =
                (record.imageIds || [])
                  .filter((id) => {
                    return (
                      id !==
                      button.dataset.removeImage
                    );
                  });
            }

            saveState();

            renderImageIds(
              container,
              record?.imageIds || [],
              ownerType,
              ownerId
            );
          } else {
            currentTradeImageIds =
              currentTradeImageIds.filter(
                (id) => {
                  return (
                    id !==
                    button.dataset.removeImage
                  );
                }
              );

            renderMixedTradeImages();
          }
        }
      );
    });
}

async function renderMixedTradeImages() {
  const records =
    (
      await Promise.all(
        currentTradeImageIds.map(getImage)
      )
    ).filter(Boolean);

  const storedHtml =
    records.map((record) => `
      <article class="image-card">
        <img
          src="${record.dataUrl}"
          alt="저장된 거래 차트"
          data-view-image="${record.id}"
        />
        <div class="image-card-footer">
          <span>${escapeHtml(record.name)}</span>
          <button
            class="icon-button"
            type="button"
            data-remove-stored-trade-image="${record.id}"
          >
            ×
          </button>
        </div>
      </article>
    `).join("");

  const pendingHtml =
    pendingTradeImages.map((record) => `
      <article class="image-card">
        <img
          src="${record.dataUrl}"
          alt="업로드 예정 거래 차트"
          data-temp-view="${record.tempId}"
        />
        <div class="image-card-footer">
          <span>${escapeHtml(record.name)}</span>
          <button
            class="icon-button"
            type="button"
            data-remove-temp-trade="${record.tempId}"
          >
            ×
          </button>
        </div>
      </article>
    `).join("");

  $("tradeImageList").innerHTML =
    storedHtml + pendingHtml;

  $$(
    "[data-view-image]",
    $("tradeImageList")
  ).forEach((image) => {
    image.addEventListener("click", () => {
      openImageViewer(
        image.dataset.viewImage
      );
    });
  });

  $$(
    "[data-temp-view]",
    $("tradeImageList")
  ).forEach((image) => {
    image.addEventListener("click", () => {
      const record =
        pendingTradeImages.find((item) => {
          return (
            item.tempId ===
            image.dataset.tempView
          );
        });

      openImageData(
        record?.dataUrl,
        record?.name || "업로드 이미지"
      );
    });
  });

  $$(
    "[data-remove-stored-trade-image]",
    $("tradeImageList")
  ).forEach((button) => {
    button.addEventListener(
      "click",
      async () => {
        await deleteImage(
          button.dataset
            .removeStoredTradeImage
        );

        currentTradeImageIds =
          currentTradeImageIds.filter((id) => {
            return (
              id !==
              button.dataset
                .removeStoredTradeImage
            );
          });

        renderMixedTradeImages();
      }
    );
  });

  $$(
    "[data-remove-temp-trade]",
    $("tradeImageList")
  ).forEach((button) => {
    button.addEventListener("click", () => {
      pendingTradeImages =
        pendingTradeImages.filter((item) => {
          return (
            item.tempId !==
            button.dataset.removeTempTrade
          );
        });

      renderMixedTradeImages();
    });
  });
}

async function openImageViewer(id) {
  const record = await getImage(id);

  if (record) {
    openImageData(
      record.dataUrl,
      record.name
    );
  }
}

function openImageData(dataUrl, caption) {
  $("imageViewerImage").src =
    dataUrl || "";

  $("imageViewerCaption").textContent =
    caption || "";

  $("imageViewer").classList.remove(
    "hidden"
  );

  document.body.style.overflow =
    "hidden";
}

function closeImageViewer() {
  $("imageViewer").classList.add(
    "hidden"
  );

  $("imageViewerImage").src = "";
  document.body.style.overflow = "";
}

function setupSettings() {
  $("gcMultiplier").value =
    state.settings.gcMultiplier;

  $("mgcMultiplier").value =
    state.settings.mgcMultiplier;

  $("customMultiplier").value =
    state.settings.customMultiplier;

  $("contractSettingsForm")
    .addEventListener("submit", (event) => {
      event.preventDefault();

      state.settings = {
        gcMultiplier:
          Number(
            $("gcMultiplier").value || 100
          ),
        mgcMultiplier:
          Number(
            $("mgcMultiplier").value || 10
          ),
        customMultiplier:
          Number(
            $("customMultiplier").value || 1
          )
      };

      saveState();
      updateTradeCalculations();

      notify("상품 설정을 저장했습니다.");
    });

  $("exportBackupButton")
    .addEventListener(
      "click",
      exportBackup
    );

  $("importBackupInput")
    .addEventListener(
      "change",
      importBackup
    );

  $("clearAllButton")
    .addEventListener(
      "click",
      clearAllData
    );
}

async function renderDataStatus() {
  if (!$("dataStatus")) {
    return;
  }

  let imageCount = 0;

  try {
    imageCount =
      (await getAllImages()).length;
  } catch (error) {
    console.error(error);
  }

  $("dataStatus").innerHTML = [
    [
      "시장 분석",
      `${Object.keys(state.analyses).length}일`
    ],
    [
      "거래 기록",
      `${state.trades.length}건`
    ],
    [
      "일간 마감",
      `${Object.keys(state.dailyReviews).length}일`
    ],
    [
      "저장 이미지",
      `${imageCount}장`
    ]
  ]
    .map(([label, value]) => `
      <div class="summary-card">
        <span>${label}</span>
        <strong>${value}</strong>
      </div>
    `)
    .join("");
}

async function exportBackup() {
  const images = await getAllImages();

  const payload = {
    exportedAt: new Date().toISOString(),
    app: "Gold Futures Trading Review",
    state,
    images
  };

  const blob = new Blob(
    [JSON.stringify(payload, null, 2)],
    {
      type: "application/json"
    }
  );

  const url =
    URL.createObjectURL(blob);

  const link =
    document.createElement("a");

  link.href = url;

  link.download =
    `gold-trading-review-backup-${localDateString()}.json`;

  link.click();
  URL.revokeObjectURL(url);
}

async function importBackup(event) {
  const file =
    event.target.files?.[0];

  if (!file) {
    return;
  }

  try {
    const payload =
      JSON.parse(await file.text());

    if (
      !payload.state ||
      !Array.isArray(payload.images)
    ) {
      throw new Error(
        "지원하지 않는 백업 형식입니다."
      );
    }

    const accepted =
      await confirmAction(
        "백업 복원",
        "현재 데이터가 백업 파일 내용으로 교체됩니다."
      );

    if (!accepted) {
      return;
    }

    state = {
      ...cloneDefaultState(),
      ...payload.state,
      settings: {
        ...DEFAULT_STATE.settings,
        ...(payload.state.settings || {})
      }
    };

    await clearImages();

    for (const image of payload.images) {
      await putImage(image);
    }

    saveState();
    location.reload();
  } catch (error) {
    alert(
      `백업 복원 실패: ${error.message}`
    );
  } finally {
    event.target.value = "";
  }
}

async function clearAllData() {
  const accepted =
    await confirmAction(
      "전체 데이터 삭제",
      "시장 분석, 거래, 일간 마감, 업로드 이미지가 모두 삭제됩니다. 이 작업은 되돌릴 수 없습니다."
    );

  if (!accepted) {
    return;
  }

  state = cloneDefaultState();

  localStorage.removeItem(
    STORAGE_KEY
  );

  await clearImages();
  location.reload();
}

function confirmAction(title, message) {
  $("confirmTitle").textContent =
    title;

  $("confirmMessage").textContent =
    message;

  $("confirmModal").classList.remove(
    "hidden"
  );

  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function closeConfirm(value) {
  $("confirmModal").classList.add(
    "hidden"
  );

  if (confirmResolver) {
    confirmResolver(value);
  }

  confirmResolver = null;
}

function notify(message) {
  const warning =
    $("storageWarning");

  warning.textContent = message;

  warning.classList.remove(
    "hidden"
  );

  clearTimeout(notify.timer);

  notify.timer = setTimeout(() => {
    warning.classList.add("hidden");
  }, 2600);
}

function setupModals() {
  $$("[data-close-modal]")
    .forEach((element) => {
      element.addEventListener(
        "click",
        closeImageViewer
      );
    });

  $("confirmCancel")
    .addEventListener(
      "click",
      () => closeConfirm(false)
    );

  $("confirmAccept")
    .addEventListener(
      "click",
      () => closeConfirm(true)
    );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        if (
          !$("imageViewer")
            .classList
            .contains("hidden")
        ) {
          closeImageViewer();
        }

        if (
          !$("confirmModal")
            .classList
            .contains("hidden")
        ) {
          closeConfirm(false);
        }
      }
    }
  );
}

function checkStorageSupport() {
  if (!("indexedDB" in window)) {
    $("storageWarning").textContent =
      "이 브라우저는 IndexedDB를 지원하지 않아 이미지 저장 기능을 사용할 수 없습니다.";

    $("storageWarning").classList.remove(
      "hidden"
    );
  }
}

async function init() {
  setupTabs();
  setupAnalysis();
  setupTradeForm();
  setupDaily();
  setupAnalytics();
  setupSettings();
  setupModals();
  checkStorageSupport();
  updateHeader();
  renderAccountBanner();

  await renderTrades();

  renderDaily();
  renderAnalytics();

  await renderDataStatus();
}

document.addEventListener(
  "DOMContentLoaded",
  init
);
