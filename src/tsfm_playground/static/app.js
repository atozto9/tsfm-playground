const forecastUtils = window.TSFMForecastUtils;
const themeUtils = window.TSFMThemeUtils;

if (!forecastUtils) {
  throw new Error("forecast_utils.js failed to load.");
}
if (!themeUtils) {
  throw new Error("theme_utils.js failed to load.");
}

const state = {
  nextSeriesId: 1,
  series: [],
  info: null,
  models: [],
  lastResponse: null,
  isForecasting: false,
  isSwitching: false,
  isUploading: false,
  themeMode: "system",
  defaultsApplied: false,
  quantilesTouched: false,
  editingSeriesId: null,
  isEditorOpen: false,
  editorMode: "text",
  drawScope: "whole",
  drawPoints: [],
  drawReferenceValues: [],
  drawPointerId: null,
  focusStart: 0,
  focusEnd: 1,
  focusSpanReady: false,
  focusBrushDrag: null,
};

const $ = (id) => document.getElementById(id);
const SERIES_COLORS = ["#2866cc", "#4fb286", "#a46513", "#bd3e49", "#6b5bd6"];
const DRAW_CANVAS_WIDTH = 640;
const DRAW_CANVAS_HEIGHT = 220;
const DRAW_OVERVIEW_WIDTH = 640;
const DRAW_OVERVIEW_HEIGHT = 96;
const DRAW_OVERVIEW_HANDLE_WIDTH = 8;

function getStorage() {
  try {
    return window.localStorage;
  } catch (_err) {
    return null;
  }
}

function getSystemPrefersDark() {
  return !!(
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function getCssVar(name, fallback = "") {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function isBusy() {
  return state.isForecasting || state.isSwitching || state.isUploading;
}

function seriesColor(index) {
  if (index === 0) return getCssVar("--chart-line", SERIES_COLORS[0]);
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

function chartLayout(title) {
  return {
    title: { text: title, font: { size: 13 } },
    margin: { l: 44, r: 18, t: 34, b: 60 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: getCssVar("--text", "#172033") },
    xaxis: {
      title: "step",
      gridcolor: getCssVar("--chart-grid", "#dbe3ee"),
      zeroline: false,
    },
    yaxis: {
      title: "value",
      gridcolor: getCssVar("--chart-grid", "#dbe3ee"),
      zeroline: false,
    },
    legend: {
      orientation: "h",
      x: 0.5,
      xanchor: "center",
      y: -0.28,
    },
  };
}

function mergeLayout(base, overrides) {
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    xaxis: { ...base.xaxis, ...(overrides.xaxis || {}) },
    yaxis: { ...base.yaxis, ...(overrides.yaxis || {}) },
  };
}

function styleTrace(trace, index) {
  if (trace.fill === "toself") {
    return {
      ...trace,
      fillcolor: getCssVar("--chart-band", "rgba(79,178,134,0.18)"),
    };
  }
  const role = trace.meta && trace.meta.role;
  const seriesIndex = trace.meta && Number.isInteger(trace.meta.seriesIndex)
    ? trace.meta.seriesIndex
    : index;
  let color = index % 2 === 0 ? getCssVar("--chart-line", "#2866cc") : "#4fb286";
  if (role === "input-full" || role === "input-context") color = seriesColor(seriesIndex);
  if (role === "ground-truth") color = getCssVar("--gt-line", "#a46513");
  return {
    ...trace,
    line: {
      color,
      ...(trace.line || {}),
    },
    marker: {
      color,
      ...(trace.marker || {}),
    },
  };
}

function plot(targetId, traces, title, layoutOverrides = {}) {
  const target = $(targetId);
  if (!target || !window.Plotly) return null;
  const styled = traces.map((trace, index) => styleTrace(trace, index));
  let layout = mergeLayout(chartLayout(title), layoutOverrides);
  if (!styled.length) {
    layout = {
      ...layout,
      annotations: [{
        text: "No data",
        x: 0.5,
        y: 0.5,
        xref: "paper",
        yref: "paper",
        showarrow: false,
        font: { color: getCssVar("--muted", "#657386"), size: 12 },
      }],
    };
  }
  return window.Plotly.react(target, styled, layout, {
    responsive: true,
    displayModeBar: false,
    displaylogo: false,
  });
}

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = await resp.json();
      detail = body.detail || detail;
    } catch (_err) {
      detail = await resp.text();
    }
    throw new Error(detail);
  }
  return resp.json();
}

function setStatus(message, kind = "") {
  const node = $("status-msg");
  node.textContent = message || "";
  node.className = `status ${kind}`.trim();
}

function setSwitchStatus(message, kind = "") {
  const node = $("switch-status");
  node.textContent = message || "";
  node.className = `switch-status ${kind}`.trim();
}

function setValidation(message, kind = "") {
  const node = $("validation-msg");
  node.textContent = message || "";
  node.className = `validation-msg ${kind}`.trim();
}

function applyTheme(mode, options = {}) {
  state.themeMode = themeUtils.sanitizeThemeMode(mode);
  const resolved = themeUtils.resolveTheme(state.themeMode, getSystemPrefersDark());
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.querySelectorAll(".theme-input").forEach((input) => {
    input.checked = input.value === state.themeMode;
  });
  const storage = getStorage();
  if (storage && options.persist !== false) {
    themeUtils.writeStoredTheme(storage, state.themeMode);
  }
  renderCharts();
}

function wireThemeControls() {
  const storage = getStorage();
  state.themeMode = storage ? themeUtils.readStoredTheme(storage) : "system";
  document.querySelectorAll(".theme-input").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) applyTheme(input.value);
    });
  });
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (state.themeMode === "system") applyTheme("system", { persist: false });
    });
  }
  applyTheme(state.themeMode, { persist: false });
}

function selectedContextMode() {
  const checked = document.querySelector('input[name="context-mode"]:checked');
  return forecastUtils.normalizeContextMode(checked ? checked.value : "full");
}

function setContextMode(mode) {
  const node = $(`context-mode-${forecastUtils.normalizeContextMode(mode)}`);
  if (node) node.checked = true;
}

function readContextOptions() {
  return {
    contextMode: selectedContextMode(),
    contextTail: $("context-tail-input").value,
    contextStart: $("context-start-input").value,
    contextEnd: $("context-end-input").value,
  };
}

function updateContextControls() {
  const mode = selectedContextMode();
  $("context-tail-field").hidden = mode !== "tail";
  $("context-range-fields").hidden = mode !== "range";
}

function applyContextDefaultsForMode() {
  const mode = selectedContextMode();
  const length = shortestSelectedLength();
  if (length <= 0) return;
  if (mode === "tail" && !$("context-tail-input").value.trim()) {
    $("context-tail-input").value = String(length);
  }
  if (mode !== "range") return;
  if (!$("context-start-input").value.trim()) {
    $("context-start-input").value = "0";
  }
  if (!$("context-end-input").value.trim()) {
    $("context-end-input").value = String(length);
  }
}

function clampRangeContextToSelectedLength() {
  if (selectedContextMode() !== "range") return;
  const length = shortestSelectedLength();
  if (length <= 0) return;
  const startInput = $("context-start-input");
  const endInput = $("context-end-input");
  const rawStart = Number(startInput.value);
  const rawEnd = Number(endInput.value);
  const start = Number.isInteger(rawStart) ? Math.max(0, Math.min(length - 1, rawStart)) : 0;
  const end = Number.isInteger(rawEnd) ? Math.max(start + 1, Math.min(length, rawEnd)) : length;
  startInput.value = String(start);
  endInput.value = String(end);
}

function contextSuffix(options) {
  if (!options || !options.context) return "";
  const context = options.context;
  if (context.mode === "range") return ` · ctx=${context.startIndex}:${context.endIndex}`;
  if (context.mode === "tail") return ` · ctx=last ${context.tailLength}`;
  return " · ctx=full";
}

function contextSummary(options) {
  if (!options || !options.context) return "invalid";
  const context = options.context;
  if (context.mode === "range") {
    return `${context.startIndex}:${context.endIndex} · n=${context.endIndex - context.startIndex}`;
  }
  if (context.mode === "tail") return `last ${context.tailLength}`;
  return "full";
}

function updateInputPanelSummary(validation) {
  const total = state.series.length;
  const selectedCount = selectedSeries().length;
  $("series-count").textContent = total ? `${selectedCount}/${total} selected` : "0 series";
  $("series-list-hint").textContent = total ? `${total} attached` : "none";
  $("input-context-chip").textContent = validation.ok ? contextSummary(validation.options) : "no context";
}

function addSeries(name, values, timestamps = null) {
  state.lastResponse = null;
  state.series.push({
    id: state.nextSeriesId++,
    name: name || `series_${state.nextSeriesId - 1}`,
    values,
    timestamps: timestamps && timestamps.length === values.length ? timestamps : null,
    enabled: true,
  });
  clampRangeContextToSelectedLength();
  render();
}

function clearSeries() {
  state.series = [];
  state.lastResponse = null;
  state.editingSeriesId = null;
  state.isEditorOpen = true;
  setStatus("");
  clearSeriesForm();
  render();
}

function removeSeries(id) {
  state.series = state.series.filter((item) => item.id !== id);
  state.lastResponse = null;
  if (state.editingSeriesId === id) {
    state.editingSeriesId = null;
    state.isEditorOpen = state.series.length === 0;
    clearSeriesForm();
    setStatus("");
  }
  clampRangeContextToSelectedLength();
  render();
}

function setSeriesEnabled(id, enabled) {
  const item = state.series.find((series) => series.id === id);
  if (!item) return;
  item.enabled = enabled;
  state.lastResponse = null;
  clampRangeContextToSelectedLength();
  render();
}

function selectedSeries() {
  return state.series.filter((series) => series.enabled);
}

function selectedContextSeries() {
  const validation = validateForecastForm({ silent: true });
  if (!validation.ok) return selectedSeries();
  return selectedSeries().map((series) => {
    const selected = forecastUtils.applyContextSelection(
      series.values,
      series.timestamps,
      validation.options.context,
    );
    return {
      ...series,
      values: selected.values,
      timestamps: selected.timestamps,
    };
  });
}

function shortestSelectedLength() {
  const selected = selectedSeries();
  if (!selected.length) return 0;
  return Math.min(...selected.map((series) => series.values.length));
}

function seriesValuesText(values) {
  return values.map((value) => Number(value).toString()).join(", ");
}

function formatDrawNumber(value) {
  if (!Number.isFinite(value)) return "";
  return Number(value.toPrecision(7)).toString();
}

function inferDrawRange(values) {
  const finite = (values || []).filter((value) => Number.isFinite(value));
  if (!finite.length) return { minValue: 0, maxValue: 1 };
  let minValue = Math.min(...finite);
  let maxValue = Math.max(...finite);
  if (minValue === maxValue) {
    const pad = Math.max(1, Math.abs(minValue) * 0.1);
    minValue -= pad;
    maxValue += pad;
  }
  return { minValue, maxValue };
}

function setDrawStatus(message, kind = "") {
  const node = $("draw-status");
  if (!node) return;
  node.textContent = message || "";
  node.className = `status ${kind}`.trim();
}

function readDrawOptions() {
  let length = Number($("draw-length-input").value);
  if (state.drawScope === "focus") {
    const values = currentTextValues();
    const span = clampFocusSpan(values);
    if (span.length > 0) length = span.endIndex - span.startIndex;
  }
  const minValue = Number($("draw-min-input").value);
  const maxValue = Number($("draw-max-input").value);
  if (!Number.isInteger(length) || length <= 0) {
    return { ok: false, error: "Draw length must be a positive integer.", options: null };
  }
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    return { ok: false, error: "Draw range must use numeric min and max.", options: null };
  }
  if (minValue >= maxValue) {
    return { ok: false, error: "Draw min must be less than max.", options: null };
  }
  return { ok: true, error: "", options: { length, minValue, maxValue } };
}

function defaultFocusSpan(length) {
  if (!Number.isInteger(length) || length <= 0) {
    return { startIndex: 0, endIndex: 0, length: 0 };
  }
  const startIndex = Math.min(length - 1, Math.floor(length * 0.25));
  const endIndex = Math.max(startIndex + 1, Math.min(length, Math.ceil(length * 0.75)));
  return { startIndex, endIndex, length };
}

function clampFocusSpan(values, options = {}) {
  const length = (values || []).length;
  if (length <= 0) {
    state.focusStart = 0;
    state.focusEnd = 1;
    state.focusSpanReady = false;
    if (state.drawScope === "focus") state.drawScope = "whole";
    return { startIndex: 0, endIndex: 0, length: 0 };
  }

  if (!state.focusSpanReady || options.forceDefault) {
    const span = defaultFocusSpan(length);
    state.focusStart = span.startIndex;
    state.focusEnd = span.endIndex;
    state.focusSpanReady = true;
    return span;
  }

  let startIndex = Number.isInteger(state.focusStart) ? state.focusStart : 0;
  let endIndex = Number.isInteger(state.focusEnd) ? state.focusEnd : startIndex + 1;
  startIndex = Math.max(0, Math.min(length - 1, startIndex));
  endIndex = Math.max(startIndex + 1, Math.min(length, endIndex));
  if (endIndex > length) {
    endIndex = length;
    startIndex = Math.max(0, endIndex - 1);
  }
  state.focusStart = startIndex;
  state.focusEnd = endIndex;
  return { startIndex, endIndex, length };
}

function activeDrawValues(values) {
  const source = Array.isArray(values) ? values : [];
  if (state.drawScope !== "focus" || !source.length) return source;
  const span = clampFocusSpan(source);
  return source.slice(span.startIndex, span.endIndex);
}

function drawStatusForLength(length) {
  if (state.drawScope === "focus") {
    return `focus ${state.focusStart}:${state.focusEnd} · n=${length}`;
  }
  return `n=${length}`;
}

function setDrawControlsFromValues(values) {
  const source = Array.isArray(values) && values.length ? values : [];
  const range = inferDrawRange(source);
  $("draw-length-input").value = String(source.length || 72);
  $("draw-min-input").value = formatDrawNumber(range.minValue);
  $("draw-max-input").value = formatDrawNumber(range.maxValue);
}

function valuesToDrawPoints(values, minValue, maxValue) {
  const span = Math.max(0.000001, maxValue - minValue);
  return (values || []).map((value, index) => ({
    x: values.length <= 1 ? 0 : index / (values.length - 1),
    y: Math.max(0, Math.min(1, (maxValue - value) / span)),
  }));
}

function drawPointsToSvg(points) {
  return (points || [])
    .map((point) => {
      const x = Math.max(0, Math.min(1, point.x)) * DRAW_CANVAS_WIDTH;
      const y = Math.max(0, Math.min(1, point.y)) * DRAW_CANVAS_HEIGHT;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function overviewPointsToSvg(values) {
  const source = Array.isArray(values) ? values : [];
  if (!source.length) return "";
  const range = inferDrawRange(source);
  const span = Math.max(0.000001, range.maxValue - range.minValue);
  return source
    .map((value, index) => {
      const x = source.length <= 1 ? 0 : (index / (source.length - 1)) * DRAW_OVERVIEW_WIDTH;
      const y = Math.max(
        0,
        Math.min(1, (range.maxValue - value) / span),
      ) * DRAW_OVERVIEW_HEIGHT;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function currentTextValues() {
  const parsed = forecastUtils.parseSeriesValues($("values-input").value);
  return parsed.ok ? parsed.values : [];
}

function updateEditorDraftStatus() {
  if (!shouldShowSeriesEditor()) return;
  const parsed = forecastUtils.parseSeriesValues($("values-input").value);
  const isEditing = state.editingSeriesId != null;
  const editing = isEditing
    ? state.series.find((series) => series.id === state.editingSeriesId)
    : null;
  if (parsed.ok) {
    $("series-editor-status").textContent = forecastUtils.summarizeSeries(parsed.values);
  } else if (editing) {
    $("series-editor-status").textContent = forecastUtils.summarizeSeries(editing.values);
  } else {
    $("series-editor-status").textContent = "manual";
  }
}

function updateDrawScopeControls(values) {
  const source = Array.isArray(values) ? values : [];
  if (state.drawScope === "focus" && !source.length) state.drawScope = "whole";
  const isFocus = state.drawScope === "focus";
  const span = isFocus ? clampFocusSpan(source) : { startIndex: 0, endIndex: source.length };
  const activeLength = isFocus ? span.endIndex - span.startIndex : source.length;

  $("draw-scope-whole").checked = !isFocus;
  $("draw-scope-focus").checked = isFocus;
  $("draw-scope-whole").disabled = isBusy();
  $("draw-scope-focus").disabled = isBusy() || !source.length;
  $("draw-focus-panel").hidden = !isFocus;
  $("draw-span-chip").textContent = isFocus
    ? `${span.startIndex}:${span.endIndex} · n=${activeLength}`
    : `whole · n=${source.length}`;

  const startInput = $("draw-span-start-input");
  const endInput = $("draw-span-end-input");
  startInput.min = "0";
  startInput.max = String(Math.max(0, source.length - 1));
  startInput.value = String(isFocus ? span.startIndex : 0);
  startInput.disabled = isBusy() || !isFocus;
  endInput.min = "1";
  endInput.max = String(Math.max(1, source.length));
  endInput.value = String(isFocus ? span.endIndex : Math.max(1, source.length));
  endInput.disabled = isBusy() || !isFocus;

  const lengthInput = $("draw-length-input");
  if (isFocus) lengthInput.value = String(Math.max(1, activeLength));
  lengthInput.disabled = isBusy() || isFocus;
}

function renderDrawOverview(values) {
  const line = $("draw-overview-line");
  if (!line) return;
  const source = Array.isArray(values) ? values : [];
  line.setAttribute("points", overviewPointsToSvg(source));
  const maskLeft = $("draw-overview-mask-left");
  const maskRight = $("draw-overview-mask-right");
  const brush = $("draw-overview-brush");
  const leftHandle = $("draw-overview-left-handle");
  const rightHandle = $("draw-overview-right-handle");

  if (!source.length || state.drawScope !== "focus") {
    [maskLeft, maskRight, brush, leftHandle, rightHandle].forEach((node) => {
      node.setAttribute("x", "0");
      node.setAttribute("width", "0");
    });
    return;
  }

  const span = clampFocusSpan(source);
  const left = (span.startIndex / source.length) * DRAW_OVERVIEW_WIDTH;
  const right = (span.endIndex / source.length) * DRAW_OVERVIEW_WIDTH;
  const width = Math.max(1, right - left);

  maskLeft.setAttribute("x", "0");
  maskLeft.setAttribute("width", left.toFixed(2));
  maskRight.setAttribute("x", right.toFixed(2));
  maskRight.setAttribute("width", Math.max(0, DRAW_OVERVIEW_WIDTH - right).toFixed(2));
  brush.setAttribute("x", left.toFixed(2));
  brush.setAttribute("width", width.toFixed(2));
  leftHandle.setAttribute(
    "x",
    Math.max(0, left - DRAW_OVERVIEW_HANDLE_WIDTH / 2).toFixed(2),
  );
  leftHandle.setAttribute("width", String(DRAW_OVERVIEW_HANDLE_WIDTH));
  rightHandle.setAttribute(
    "x",
    Math.min(
      DRAW_OVERVIEW_WIDTH - DRAW_OVERVIEW_HANDLE_WIDTH,
      right - DRAW_OVERVIEW_HANDLE_WIDTH / 2,
    ).toFixed(2),
  );
  rightHandle.setAttribute("width", String(DRAW_OVERVIEW_HANDLE_WIDTH));
}

function renderDrawEditor() {
  const canvas = $("draw-canvas");
  if (!canvas) return;
  const values = currentTextValues();
  updateDrawScopeControls(values);
  renderDrawOverview(values);
  const options = readDrawOptions();
  const range = options.ok ? options.options : { minValue: 0, maxValue: 1 };
  const referencePoints = valuesToDrawPoints(
    state.drawReferenceValues,
    range.minValue,
    range.maxValue,
  );
  $("draw-reference-line").setAttribute("points", drawPointsToSvg(referencePoints));
  $("draw-line").setAttribute("points", drawPointsToSvg(state.drawPoints));
}

function resetDrawEditor(values = []) {
  state.drawScope = "whole";
  state.drawPoints = [];
  state.drawPointerId = null;
  state.focusBrushDrag = null;
  state.focusSpanReady = false;
  const source = Array.isArray(values) ? values : [];
  const activeValues = activeDrawValues(source);
  state.drawReferenceValues = activeValues.slice();
  setDrawControlsFromValues(activeValues);
  if (activeValues.length) {
    const options = readDrawOptions();
    if (options.ok) {
      state.drawPoints = valuesToDrawPoints(
        activeValues,
        options.options.minValue,
        options.options.maxValue,
      );
    }
  }
  setDrawStatus(activeValues.length ? drawStatusForLength(activeValues.length) : "idle");
  renderDrawEditor();
}

function syncDrawFromText() {
  const values = currentTextValues();
  if (!values.length) {
    state.drawPoints = [];
    state.drawReferenceValues = [];
    renderDrawEditor();
    setDrawStatus("idle");
    return;
  }
  const activeValues = activeDrawValues(values);
  state.drawReferenceValues = activeValues.slice();
  setDrawControlsFromValues(activeValues);
  const options = readDrawOptions();
  if (options.ok) {
    state.drawPoints = valuesToDrawPoints(
      activeValues,
      options.options.minValue,
      options.options.maxValue,
    );
    setDrawStatus(drawStatusForLength(activeValues.length), "ok");
  }
  renderDrawEditor();
}

function applyDrawToText(options = {}) {
  const drawOptions = readDrawOptions();
  if (!drawOptions.ok) {
    setDrawStatus(drawOptions.error, "err");
    return false;
  }
  const baseValues = currentTextValues();
  if (state.drawScope === "focus") {
    const span = clampFocusSpan(baseValues);
    const activeValues = baseValues.slice(span.startIndex, span.endIndex);
    const merged = forecastUtils.mergeDrawnSeries(
      activeValues,
      state.drawPoints,
      drawOptions.options,
    );
    if (!merged.ok) {
      setDrawStatus(merged.error, "err");
      return false;
    }
    const replaced = forecastUtils.replaceSeriesSpan(
      baseValues,
      span.startIndex,
      span.endIndex,
      merged.values,
    );
    if (!replaced.ok) {
      setDrawStatus(replaced.error, "err");
      return false;
    }
    $("values-input").value = seriesValuesText(replaced.values);
    state.drawReferenceValues = merged.values.slice();
    if (options.normalize !== false) {
      state.drawPoints = valuesToDrawPoints(
        merged.values,
        drawOptions.options.minValue,
        drawOptions.options.maxValue,
      );
    }
    setDrawStatus(
      `${drawStatusForLength(merged.values.length)} · changed `
        + `${span.startIndex + merged.startIndex}:${span.startIndex + merged.endIndex}`,
      "ok",
    );
    updateEditorDraftStatus();
    renderDrawEditor();
    return true;
  }

  if (baseValues.length === drawOptions.options.length) {
    const merged = forecastUtils.mergeDrawnSeries(
      baseValues,
      state.drawPoints,
      drawOptions.options,
    );
    if (!merged.ok) {
      setDrawStatus(merged.error, "err");
      return false;
    }
    $("values-input").value = seriesValuesText(merged.values);
    state.drawReferenceValues = merged.values.slice();
    if (options.normalize !== false) {
      state.drawPoints = valuesToDrawPoints(
        merged.values,
        drawOptions.options.minValue,
        drawOptions.options.maxValue,
      );
    }
    setDrawStatus(`${drawStatusForLength(merged.values.length)} · changed ${merged.startIndex}:${merged.endIndex}`, "ok");
    updateEditorDraftStatus();
    renderDrawEditor();
    return true;
  }

  const sampled = forecastUtils.resampleDrawnSeries(state.drawPoints, drawOptions.options);
  if (!sampled.ok) {
    setDrawStatus(sampled.error, "err");
    return false;
  }
  $("values-input").value = seriesValuesText(sampled.values);
  state.drawReferenceValues = sampled.values.slice();
  if (options.normalize !== false) {
    state.drawPoints = valuesToDrawPoints(
      sampled.values,
      drawOptions.options.minValue,
      drawOptions.options.maxValue,
    );
  }
  setDrawStatus(drawStatusForLength(sampled.values.length), "ok");
  updateEditorDraftStatus();
  renderDrawEditor();
  return true;
}

function smoothValues(values) {
  return values.map((value, index, source) => {
    const left = source[Math.max(0, index - 1)];
    const right = source[Math.min(source.length - 1, index + 1)];
    return Number(((left + value + right) / 3).toFixed(6));
  });
}

function smoothEditorValues() {
  const parsed = forecastUtils.parseSeriesValues($("values-input").value);
  if (!parsed.ok) {
    setDrawStatus(parsed.error, "err");
    return;
  }
  let values = smoothValues(parsed.values);
  let activeValues = values;
  if (state.drawScope === "focus") {
    const span = clampFocusSpan(parsed.values);
    activeValues = smoothValues(parsed.values.slice(span.startIndex, span.endIndex));
    const replaced = forecastUtils.replaceSeriesSpan(
      parsed.values,
      span.startIndex,
      span.endIndex,
      activeValues,
    );
    if (!replaced.ok) {
      setDrawStatus(replaced.error, "err");
      return;
    }
    values = replaced.values;
  }
  $("values-input").value = seriesValuesText(values);
  state.drawReferenceValues = activeValues.slice();
  const options = readDrawOptions();
  if (options.ok) {
    state.drawPoints = valuesToDrawPoints(
      activeValues,
      options.options.minValue,
      options.options.maxValue,
    );
  }
  setDrawStatus(drawStatusForLength(activeValues.length), "ok");
  updateEditorDraftStatus();
  renderDrawEditor();
}

function clearDrawSketch() {
  state.drawPoints = [];
  if (state.drawScope !== "focus") {
    $("values-input").value = "";
    state.drawReferenceValues = [];
  } else {
    state.drawReferenceValues = activeDrawValues(currentTextValues()).slice();
  }
  setDrawStatus("idle");
  updateEditorDraftStatus();
  renderDrawEditor();
}

function updateEditorModeControls() {
  const mode = state.editorMode === "draw" ? "draw" : "text";
  $("editor-mode-text").checked = mode === "text";
  $("editor-mode-draw").checked = mode === "draw";
  $("drop-zone").hidden = mode !== "text";
  $("draw-editor-panel").hidden = mode !== "draw";
  if (mode === "draw") renderDrawEditor();
}

function switchEditorMode(mode) {
  state.editorMode = mode === "draw" ? "draw" : "text";
  if (state.editorMode === "draw") syncDrawFromText();
  updateEditorModeControls();
}

function drawPointFromEvent(event) {
  const canvas = $("draw-canvas");
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
  };
}

function eventIsInsideElement(event, id) {
  const node = $(id);
  if (!node) return false;
  const rect = node.getBoundingClientRect();
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

function appendDrawPoint(point) {
  const previous = state.drawPoints[state.drawPoints.length - 1];
  if (
    previous &&
    Math.abs(previous.x - point.x) < 0.004 &&
    Math.abs(previous.y - point.y) < 0.004
  ) {
    return;
  }
  state.drawPoints.push(point);
}

function beginDrawStroke(event, pointerId) {
  if (
    state.editorMode !== "draw" ||
    isBusy() ||
    state.drawPointerId != null ||
    state.focusBrushDrag != null
  ) {
    return false;
  }
  state.drawPointerId = pointerId;
  state.drawPoints = [];
  appendDrawPoint(drawPointFromEvent(event));
  renderDrawEditor();
  setDrawStatus("drawing");
  event.preventDefault();
  return true;
}

function moveDrawStroke(event, pointerId) {
  if (state.drawPointerId !== pointerId) return false;
  appendDrawPoint(drawPointFromEvent(event));
  renderDrawEditor();
  event.preventDefault();
  return true;
}

function finishDrawStroke(event, pointerId, shouldAppend = true) {
  if (state.drawPointerId !== pointerId) return false;
  if (shouldAppend) appendDrawPoint(drawPointFromEvent(event));
  state.drawPointerId = null;
  applyDrawToText();
  event.preventDefault();
  return true;
}

function overviewRatioFromEvent(event) {
  const canvas = $("draw-overview-canvas");
  const rect = canvas.getBoundingClientRect();
  return Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
}

function setFocusSpanIndexes(startIndex, endIndex, options = {}) {
  const values = currentTextValues();
  if (!values.length) return false;
  const start = Math.max(0, Math.min(values.length - 1, Number(startIndex)));
  const end = Math.max(start + 1, Math.min(values.length, Number(endIndex)));
  const span = forecastUtils.validateEditSpan(values, start, end);
  if (!span.ok) {
    setDrawStatus(span.error, "err");
    return false;
  }
  state.drawScope = "focus";
  state.focusStart = span.startIndex;
  state.focusEnd = span.endIndex;
  state.focusSpanReady = true;
  if (options.sync === false) {
    updateDrawScopeControls(values);
    renderDrawOverview(values);
  } else {
    syncDrawFromText();
  }
  return true;
}

function setFocusSpanFromRatios(startRatio, endRatio, options = {}) {
  const values = currentTextValues();
  if (!values.length) return false;
  const span = forecastUtils.brushToIndexSpan(startRatio, endRatio, values.length);
  if (!span.ok) {
    setDrawStatus(span.error, "err");
    return false;
  }
  return setFocusSpanIndexes(span.startIndex, span.endIndex, options);
}

function beginFocusBrush(event, pointerId) {
  if (
    state.editorMode !== "draw" ||
    state.drawScope !== "focus" ||
    isBusy() ||
    state.focusBrushDrag != null ||
    state.drawPointerId != null
  ) {
    return false;
  }
  const values = currentTextValues();
  if (!values.length) return false;
  const span = clampFocusSpan(values);
  const ratio = overviewRatioFromEvent(event);
  const rect = $("draw-overview-canvas").getBoundingClientRect();
  const leftClient = rect.left + (span.startIndex / values.length) * rect.width;
  const rightClient = rect.left + (span.endIndex / values.length) * rect.width;
  const threshold = 14;
  let mode = "create";
  if (Math.abs(event.clientX - leftClient) <= threshold) {
    mode = "left";
  } else if (Math.abs(event.clientX - rightClient) <= threshold) {
    mode = "right";
  } else if (event.clientX > leftClient && event.clientX < rightClient) {
    mode = "move";
  }
  state.focusBrushDrag = {
    pointerId,
    mode,
    anchorRatio: ratio,
    startIndex: span.startIndex,
    endIndex: span.endIndex,
  };
  if (mode === "create") setFocusSpanFromRatios(ratio, ratio, { sync: true });
  event.preventDefault();
  return true;
}

function moveFocusBrush(event, pointerId) {
  const drag = state.focusBrushDrag;
  if (!drag || drag.pointerId !== pointerId) return false;
  const values = currentTextValues();
  if (!values.length) return false;
  const ratio = overviewRatioFromEvent(event);
  const length = values.length;

  if (drag.mode === "move") {
    const spanLength = Math.max(1, drag.endIndex - drag.startIndex);
    const delta = Math.round((ratio - drag.anchorRatio) * length);
    const start = Math.max(0, Math.min(length - spanLength, drag.startIndex + delta));
    setFocusSpanIndexes(start, start + spanLength, { sync: true });
  } else if (drag.mode === "left") {
    setFocusSpanFromRatios(ratio, drag.endIndex / length, { sync: true });
  } else if (drag.mode === "right") {
    setFocusSpanFromRatios(drag.startIndex / length, ratio, { sync: true });
  } else {
    setFocusSpanFromRatios(drag.anchorRatio, ratio, { sync: true });
  }
  event.preventDefault();
  return true;
}

function finishFocusBrush(event, pointerId) {
  const drag = state.focusBrushDrag;
  if (!drag || drag.pointerId !== pointerId) return false;
  state.focusBrushDrag = null;
  syncDrawFromText();
  event.preventDefault();
  return true;
}

function clearSeriesForm() {
  $("values-input").value = "";
  $("series-name").value = "";
  resetDrawEditor([]);
}

function shouldShowSeriesEditor() {
  return state.isEditorOpen || state.editingSeriesId != null || state.series.length === 0;
}

function openSeriesEditor() {
  state.editingSeriesId = null;
  state.isEditorOpen = true;
  state.editorMode = "text";
  clearSeriesForm();
  setStatus("");
  render();
  $("values-input").focus();
}

function updateSeriesFormControls() {
  const isEditing = state.editingSeriesId != null;
  const visible = shouldShowSeriesEditor();
  const editing = isEditing
    ? state.series.find((series) => series.id === state.editingSeriesId)
    : null;
  $("series-editor").hidden = !visible;
  $("series-editor-title").textContent = isEditing ? `Edit ${editing ? editing.name : "series"}` : "New series";
  updateEditorDraftStatus();
  $("add-series-btn").textContent = isEditing ? "Save Series" : "Add Series";
  $("cancel-edit-btn").hidden = !visible || (!isEditing && state.series.length === 0);
  $("new-series-btn").textContent = visible && !isEditing ? "Adding" : "New";
  $("new-series-btn").disabled = isBusy() || (visible && !isEditing);
  const pane = document.querySelector(".input-pane");
  if (pane) {
    pane.classList.toggle("editing-series", isEditing);
    pane.classList.toggle("editor-open", visible);
  }
}

function startSeriesEdit(id) {
  const series = state.series.find((item) => item.id === id);
  if (!series) return;
  state.editingSeriesId = id;
  state.isEditorOpen = true;
  state.editorMode = "text";
  $("series-name").value = series.name;
  $("values-input").value = seriesValuesText(series.values);
  resetDrawEditor(series.values);
  setStatus("");
  render();
  $("values-input").focus();
}

function cancelSeriesEdit() {
  state.editingSeriesId = null;
  state.isEditorOpen = false;
  state.editorMode = "text";
  clearSeriesForm();
  setStatus("");
  render();
}

function renderSeriesList() {
  const root = $("series-list");
  root.innerHTML = "";
  if (!state.series.length) {
    const empty = document.createElement("div");
    empty.className = "empty-series";
    empty.textContent = "No series";
    root.appendChild(empty);
    return;
  }
  state.series.forEach((series, index) => {
    const item = document.createElement("div");
    item.className = "series-item";
    if (state.editingSeriesId === series.id) item.classList.add("editing");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = series.enabled;
    checkbox.setAttribute("aria-label", `Select ${series.name}`);
    checkbox.addEventListener("change", () => setSeriesEnabled(series.id, checkbox.checked));

    const swatch = document.createElement("span");
    swatch.className = "series-swatch";
    swatch.style.background = series.enabled ? seriesColor(index) : getCssVar("--border-strong");

    const label = document.createElement("div");
    label.className = "series-label";
    const title = document.createElement("div");
    title.className = "series-title";
    title.textContent = series.name;
    const meta = document.createElement("div");
    meta.className = "series-meta";
    meta.textContent = forecastUtils.summarizeSeries(series.values);
    label.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "series-actions";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = state.editingSeriesId === series.id ? "Editing" : "Edit";
    edit.disabled = state.editingSeriesId === series.id;
    edit.addEventListener("click", () => startSeriesEdit(series.id));

    const clone = document.createElement("button");
    clone.type = "button";
    clone.textContent = "Clone";
    clone.addEventListener("click", () => addSeries(
      `${series.name} copy`,
      series.values.slice(),
      series.timestamps ? series.timestamps.slice() : null,
    ));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeSeries(series.id));

    actions.append(edit, clone, remove);
    item.append(checkbox, swatch, label, actions);
    root.appendChild(item);
  });
}

function attachInputChartSelection() {
  const target = $("input-chart");
  if (!target || target.dataset.selectionWired === "true" || !target.on) return;
  target.dataset.selectionWired = "true";
  target.on("plotly_selected", (event) => {
    if (selectedContextMode() !== "range" || !event || !event.points) return;
    const range = forecastUtils.rangeFromSelectedPoints(event.points);
    if (!range.ok) return;
    $("context-start-input").value = String(range.startIndex);
    $("context-end-input").value = String(range.endIndex);
    updateContextControls();
    updateForecastButton();
    renderInputChart();
  });
}

function chartIndexFromClientX(clientX) {
  const target = $("input-chart");
  if (!target) return null;
  const length = shortestSelectedLength();
  if (length < 2) return null;
  const rect = target.getBoundingClientRect();
  const leftPad = 44;
  const rightPad = 18;
  const plotWidth = Math.max(1, rect.width - leftPad - rightPad);
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left - leftPad) / plotWidth));
  return Math.round(ratio * (length - 1));
}

function chartXPosition(index) {
  const target = $("input-chart");
  const length = shortestSelectedLength();
  if (!target || length < 2) return null;
  const rect = target.getBoundingClientRect();
  const leftPad = 44;
  const rightPad = 18;
  const plotWidth = Math.max(1, rect.width - leftPad - rightPad);
  return leftPad + (Math.max(0, Math.min(length - 1, index)) / (length - 1)) * plotWidth;
}

function ensureRangeDragPreview() {
  const target = $("input-chart");
  if (!target) return null;
  let preview = target.querySelector(".range-drag-preview");
  if (!preview) {
    preview = document.createElement("div");
    preview.className = "range-drag-preview";
    preview.hidden = true;
    const badge = document.createElement("span");
    badge.className = "range-drag-badge";
    preview.appendChild(badge);
    target.appendChild(preview);
  }
  return preview;
}

function updateRangeDragPreview(startIndex, currentIndex) {
  const preview = ensureRangeDragPreview();
  if (!preview) return;
  const start = Math.max(0, Math.min(startIndex, currentIndex));
  const end = Math.max(startIndex, currentIndex) + 1;
  const left = chartXPosition(start);
  const right = chartXPosition(Math.max(start, end - 1));
  if (left == null || right == null) return;
  preview.hidden = false;
  preview.style.left = `${Math.min(left, right)}px`;
  preview.style.width = `${Math.max(8, Math.abs(right - left))}px`;
  const badge = preview.querySelector(".range-drag-badge");
  if (badge) badge.textContent = `${start}:${end}`;
}

function hideRangeDragPreview() {
  const preview = ensureRangeDragPreview();
  if (preview) preview.hidden = true;
}

function applyChartDragRange(startIndex, endIndex) {
  const length = shortestSelectedLength();
  if (length < 2 || startIndex == null || endIndex == null) return;
  const start = Math.max(0, Math.min(startIndex, endIndex));
  let end = Math.min(length, Math.max(startIndex, endIndex) + 1);
  if (end <= start) end = Math.min(length, start + 1);
  $("context-start-input").value = String(start);
  $("context-end-input").value = String(end);
  setContextMode("range");
  updateContextControls();
  updateForecastButton();
  renderInputChart();
}

function attachInputChartRangeDrag() {
  const target = $("input-chart");
  if (!target || target.dataset.rangeDragWired === "true") return;
  target.dataset.rangeDragWired = "true";
  let dragStart = null;

  target.addEventListener("mousedown", (event) => {
    if (selectedContextMode() !== "range" || event.button !== 0) return;
    const index = chartIndexFromClientX(event.clientX);
    if (index == null) return;
    dragStart = index;
    updateRangeDragPreview(dragStart, index);
    event.preventDefault();
    event.stopPropagation();
  }, true);

  window.addEventListener("mousemove", (event) => {
    if (dragStart == null) return;
    const dragCurrent = chartIndexFromClientX(event.clientX);
    if (dragCurrent != null) updateRangeDragPreview(dragStart, dragCurrent);
    event.preventDefault();
    event.stopPropagation();
  }, true);

  window.addEventListener("mouseup", (event) => {
    if (dragStart == null) return;
    const dragEnd = chartIndexFromClientX(event.clientX);
    if (dragEnd != null) applyChartDragRange(dragStart, dragEnd);
    dragStart = null;
    hideRangeDragPreview();
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

function renderInputChart() {
  const validation = validateForecastForm({ silent: true });
  let context = validation.ok ? validation.options.context : null;
  if (!context) {
    const fallback = forecastUtils.resolveContextSpec(selectedSeries(), { contextMode: "full" });
    context = fallback.ok ? fallback.context : null;
  }
  const traces = forecastUtils.buildInputContextTraces(state.series, context);
  const target = $("input-chart");
  if (target) target.classList.toggle("range-selecting", selectedContextMode() === "range");
  const rangeLayout = {};
  if (
    context &&
    context.mode === "range" &&
    context.startIndex != null &&
    context.endIndex != null
  ) {
    const start = context.startIndex;
    const end = context.endIndex;
    rangeLayout.shapes = [{
      type: "rect",
      xref: "x",
      yref: "paper",
      x0: start - 0.5,
      x1: end - 0.5,
      y0: 0,
      y1: 1,
      fillcolor: getCssVar("--range-fill", "rgba(40,102,204,0.12)"),
      line: { width: 0 },
      layer: "below",
    }];
    rangeLayout.annotations = [{
      text: `${start}:${end} · n=${end - start}`,
      x: (start + end - 1) / 2,
      y: 1.04,
      xref: "x",
      yref: "paper",
      showarrow: false,
      bgcolor: getCssVar("--accent-strong", "#194f9e"),
      bordercolor: getCssVar("--accent-strong", "#194f9e"),
      borderpad: 3,
      font: { color: "#ffffff", size: 11 },
    }];
  }
  const plotted = plot("input-chart", traces, "Attached series", {
    dragmode: selectedContextMode() === "range" ? "select" : "zoom",
    margin: { l: 44, r: 18, t: 34, b: 54 },
    legend: {
      orientation: "h",
      x: 0.5,
      xanchor: "center",
      y: -0.18,
    },
    xaxis: { title: "" },
    selectdirection: "h",
    ...rangeLayout,
  });
  if (plotted && plotted.then) {
    plotted.then(() => {
      attachInputChartSelection();
      attachInputChartRangeDrag();
    });
  }
}

function renderResultChart() {
  if (!state.lastResponse) {
    plot("result-chart", [], "Forecast result");
    return;
  }
  plot(
    "result-chart",
    forecastUtils.buildForecastTraces(state.lastResponse, state.series),
    "Forecast result",
  );
}

function renderCharts() {
  renderInputChart();
  renderResultChart();
}

function renderModels() {
  const select = $("model-select");
  select.innerHTML = "";
  if (!state.models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "no models";
    select.appendChild(option);
    select.disabled = true;
    return;
  }
  state.models.forEach((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.label} (${model.backend})${model.loaded ? " loaded" : " lazy"}`;
    option.selected = model.active;
    select.appendChild(option);
  });
  select.disabled = state.isSwitching || state.isForecasting;
}

function compactSourceRef(value) {
  if (!value) return "";
  const text = String(value);
  return text.length <= 44 ? text : `...${text.slice(-41)}`;
}

function quantilePresetValue(values) {
  return (values || [0.1, 0.5, 0.9]).map((value) => Number(value).toString()).join(",");
}

function setQuantilePreset(values) {
  const select = $("quantiles-input");
  const value = quantilePresetValue(values);
  const existingRuntimeOption = select.querySelector("option[data-runtime-default]");
  if (existingRuntimeOption) existingRuntimeOption.remove();
  if (![...select.options].some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `Config default · ${value.replaceAll(",", " / ")}`;
    option.dataset.runtimeDefault = "true";
    select.appendChild(option);
  }
  select.value = value;
}

function renderInfo() {
  const info = state.info;
  if (!info) {
    $("backend-info").textContent = "backend unknown";
    return;
  }
  const caps = info.capabilities || {};
  const capText = [
    caps.multivariate ? "multi" : "uni",
    caps.covariates ? "covariates" : "no-covariates",
    caps.quantiles ? "quantiles" : "point",
  ].join(" · ");
  const loaded = info.loaded ? "loaded" : "lazy";
  const sourceText = info.source_ref ? ` · src=${compactSourceRef(info.source_ref)}` : "";
  const loadErrorText = info.extra && info.extra.load_error ? " · load failed" : "";
  $("backend-info").textContent = `${info.backend} · ${info.model_id || "default"} · ${loaded} · ${capText}${sourceText}${loadErrorText}`;
  $("backend-info").title = info.source_ref || "";
  setDemoButtonLabel();
  if (info.defaults && !state.defaultsApplied) {
    $("horizon-input").value = info.defaults.horizon || $("horizon-input").value;
    if (!state.quantilesTouched) {
      setQuantilePreset(info.defaults.quantiles || [0.1, 0.5, 0.9]);
    }
    state.defaultsApplied = true;
  }
}

function updateForecastButton() {
  const validation = validateForecastForm({ silent: true });
  const blocked = state.isForecasting || state.isSwitching || state.isUploading || !validation.ok;
  $("forecast-btn").disabled = blocked;
  $("copy-json-btn").disabled = !state.lastResponse;
  const selectedCount = selectedSeries().length;
  $("selection-hint").textContent = `${selectedCount} selected${contextSuffix(validation.options)}`;
  $("context-summary").textContent = contextSummary(validation.options);
  updateInputPanelSummary(validation);
  setValidation(validation.ok ? "ready" : validation.error, validation.ok ? "ok" : "err");
}

function renderRawJson() {
  const raw = $("raw-json");
  if (state.isForecasting) {
    raw.textContent = "Running forecast...";
  } else {
    raw.textContent = state.lastResponse
      ? JSON.stringify(state.lastResponse, null, 2)
      : "No forecast yet.";
  }
  $("result-meta").textContent = state.lastResponse
    ? `${state.lastResponse.backend} · ${state.lastResponse.forecasts.length} forecast(s)`
      + gtMetaSuffix(state.lastResponse)
    : "idle";
}

function gtMetaSuffix(response) {
  const count = forecastUtils.countGroundTruthPoints(response, state.series);
  return count > 0 ? ` · GT ${count} point(s)` : "";
}

function render() {
  renderSeriesList();
  renderModels();
  renderInfo();
  renderRawJson();
  updateContextControls();
  updateSeriesFormControls();
  updateEditorModeControls();
  updateForecastButton();
  renderCharts();
}

function validateForecastForm(options = {}) {
  if (selectedSeries().length === 0) {
    return { ok: false, error: "Select at least one series.", options: null };
  }
  const maxHorizon = state.info && state.info.defaults ? state.info.defaults.max_horizon : 10000;
  const horizon = forecastUtils.parsePositiveInteger(
    $("horizon-input").value,
    "Horizon",
    { max: maxHorizon },
  );
  if (!horizon.ok) return { ok: false, error: horizon.error, options: null };
  const quantiles = forecastUtils.parseQuantiles($("quantiles-input").value);
  if (!quantiles.ok) {
    return { ok: false, error: quantiles.error, options: null };
  }
  const context = forecastUtils.resolveContextSpec(selectedSeries(), readContextOptions());
  if (!context.ok) return { ok: false, error: context.error, options: null };
  const modelOptions = forecastUtils.parseJsonObject($("model-options-input").value, "backend options JSON");
  if (!modelOptions.ok) return { ok: false, error: modelOptions.error, options: null };
  const resolved = {
    horizon: horizon.value,
    quantiles: quantiles.values,
    ...readContextOptions(),
    context: context.context,
    target: $("target-input").value.trim() || "value",
    modelOptions: modelOptions.value,
  };
  if (!options.silent) setValidation("ready", "ok");
  return { ok: true, error: "", options: resolved };
}

function readForecastOptions() {
  const validation = validateForecastForm();
  if (!validation.ok) throw new Error(validation.error);
  return validation.options;
}

function disableBusyControls(disabled) {
  [
    "new-series-btn",
    "add-series-btn",
    "cancel-edit-btn",
    "editor-mode-text",
    "editor-mode-draw",
    "draw-scope-whole",
    "draw-scope-focus",
    "draw-length-input",
    "draw-min-input",
    "draw-max-input",
    "draw-span-start-input",
    "draw-span-end-input",
    "draw-apply-btn",
    "draw-smooth-btn",
    "draw-clear-btn",
    "paste-btn",
    "demo-btn",
    "clear-series-btn",
    "upload-btn",
    "horizon-input",
    "quantiles-input",
    "target-input",
    "context-mode-full",
    "context-mode-tail",
    "context-mode-range",
    "context-tail-input",
    "context-start-input",
    "context-end-input",
    "clear-context-btn",
    "model-options-input",
  ].forEach((id) => {
    const node = $(id);
    if (node) node.disabled = disabled;
  });
}

async function refreshInfo() {
  state.info = await api("/api/info");
  state.models = (await api("/api/models")).models;
  render();
}

async function switchModel(modelId) {
  state.isSwitching = true;
  setSwitchStatus("loading...");
  renderModels();
  try {
    await api("/api/switch", {
      method: "POST",
      body: JSON.stringify({ model_id: modelId }),
    });
    await refreshInfo();
    setSwitchStatus("ready", "ok");
  } catch (err) {
    setSwitchStatus(err.message, "err");
  } finally {
    state.isSwitching = false;
    render();
  }
}

async function runForecast() {
  state.isForecasting = true;
  setStatus("running...");
  disableBusyControls(true);
  updateForecastButton();
  try {
    const body = forecastUtils.buildForecastRequest(state.series, readForecastOptions());
    state.lastResponse = await api("/api/forecast", {
      method: "POST",
      body: JSON.stringify(body),
    });
    setStatus("done", "ok");
  } catch (err) {
    setStatus(err.message, "err");
  } finally {
    state.isForecasting = false;
    disableBusyControls(false);
    render();
  }
}

function addFromText() {
  const parsed = forecastUtils.parseSeriesValues($("values-input").value);
  if (!parsed.ok) {
    setStatus(parsed.error, "err");
    return;
  }
  const editing = state.editingSeriesId == null
    ? null
    : state.series.find((series) => series.id === state.editingSeriesId);
  if (editing) {
    editing.name = $("series-name").value.trim() || editing.name;
    editing.timestamps = editing.timestamps && editing.timestamps.length === parsed.values.length
      ? editing.timestamps
      : null;
    editing.values = parsed.values;
    state.editingSeriesId = null;
    state.isEditorOpen = false;
    state.lastResponse = null;
    clampRangeContextToSelectedLength();
    clearSeriesForm();
    setStatus("series updated", "ok");
    render();
    return;
  }
  state.isEditorOpen = false;
  addSeries($("series-name").value.trim(), parsed.values);
  $("values-input").value = "";
  $("series-name").value = "";
  setStatus("");
}

function chronos2MultiseriesDemo() {
  const length = 96;
  return Array.from({ length }, (_item, index) => {
    const weekly = Math.sin((2 * Math.PI * index) / 7);
    const weeklyLag = Math.sin((2 * Math.PI * (index - 2)) / 7);
    const slow = Math.sin((2 * Math.PI * index) / 48);
    const eventLift = index >= 58 && index <= 70 ? 7.5 : 0;
    const demand = 120 + index * 0.18 + weekly * 9 + slow * 4 + eventLift;
    const traffic = 74 + index * 0.11 + weeklyLag * 6 + slow * 3 + eventLift * 0.45;
    const temperature = 18 + slow * 8 - weekly * 1.6 + Math.max(0, index - 72) * 0.05;
    return { demand, traffic, temperature };
  });
}

function demoDefinitions(mode) {
  if (mode === "chronos2_multiseries") {
    const rows = chronos2MultiseriesDemo();
    return [
      {
        name: "retail_demand",
        values: rows.map((row) => Number(row.demand.toFixed(4))),
      },
      {
        name: "site_traffic",
        values: rows.map((row) => Number(row.traffic.toFixed(4))),
      },
      {
        name: "ambient_temperature",
        values: rows.map((row) => Number(row.temperature.toFixed(4))),
      },
    ];
  }
  return [{
    name: "demo_wave",
    values: Array.from({ length: 72 }, (_item, index) => {
      const trend = index * 0.08;
      const seasonal = Math.sin(index / 4) * 2.4;
      return Number((20 + trend + seasonal).toFixed(4));
    }),
  }];
}

function initialDemoMode() {
  return state.info && state.info.defaults && state.info.defaults.initial_demo
    ? state.info.defaults.initial_demo
    : "wave";
}

function demoLabel(mode) {
  return mode === "chronos2_multiseries" ? "Multi-series" : "Wave";
}

function setDemoButtonLabel() {
  const node = $("demo-btn");
  if (!node) return;
  node.textContent = demoLabel(initialDemoMode());
}

function loadConfiguredDemo() {
  const definitions = demoDefinitions(initialDemoMode());
  state.series = definitions.map((definition) => ({
    id: state.nextSeriesId++,
    name: definition.name,
    values: definition.values,
    timestamps: null,
    enabled: true,
  }));
  state.lastResponse = null;
  state.editingSeriesId = null;
  state.isEditorOpen = false;
  state.editorMode = "text";
  clearSeriesForm();
  clampRangeContextToSelectedLength();
  setStatus("");
  render();
}

async function pasteValues() {
  let text = "";
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      text = await navigator.clipboard.readText();
    }
  } catch (_err) {
    text = "";
  }
  if (!text) {
    text = window.prompt("Paste numeric values") || "";
  }
  if (!text.trim()) return;
  $("values-input").value = text;
  addFromText();
}

async function uploadFile(file) {
  const form = new FormData();
  form.append("file", file);
  const resp = await fetch("/api/parse-file", { method: "POST", body: form });
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      detail = (await resp.json()).detail || detail;
    } catch (_err) {}
    throw new Error(detail);
  }
  const body = await resp.json();
  body.series.forEach((item) => addSeries(item.name, item.values, item.timestamps));
}

async function uploadFiles(files) {
  if (!files.length) return;
  state.isUploading = true;
  disableBusyControls(true);
  setStatus("uploading...");
  updateForecastButton();
  try {
    for (const file of files) {
      await uploadFile(file);
    }
    state.editingSeriesId = null;
    state.isEditorOpen = false;
    state.editorMode = "text";
    clearSeriesForm();
    setStatus(`uploaded ${files.length} file(s)`, "ok");
  } catch (err) {
    setStatus(err.message, "err");
  } finally {
    state.isUploading = false;
    disableBusyControls(false);
    render();
  }
}

function refreshAfterControlChange() {
  updateContextControls();
  updateForecastButton();
  renderInputChart();
}

function wireContextControls() {
  document.querySelectorAll(".context-mode-input").forEach((input) => {
    input.addEventListener("change", () => {
      applyContextDefaultsForMode();
      refreshAfterControlChange();
    });
  });
  [
    "context-tail-input",
    "context-start-input",
    "context-end-input",
    "horizon-input",
    "quantiles-input",
    "target-input",
    "model-options-input",
  ].forEach((id) => {
    $(id).addEventListener("input", refreshAfterControlChange);
  });
  $("quantiles-input").addEventListener("change", () => {
    state.quantilesTouched = true;
    refreshAfterControlChange();
  });
  $("clear-context-btn").addEventListener("click", () => {
    $("context-tail-input").value = "";
    $("context-start-input").value = "";
    $("context-end-input").value = "";
    setContextMode("full");
    refreshAfterControlChange();
  });
}

function wireDrawControls() {
  document.querySelectorAll(".editor-mode-input").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) switchEditorMode(input.value);
    });
  });
  document.querySelectorAll(".draw-scope-input").forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      state.drawScope = input.value === "focus" ? "focus" : "whole";
      if (state.drawScope === "focus") {
        clampFocusSpan(currentTextValues(), { forceDefault: !state.focusSpanReady });
      }
      syncDrawFromText();
    });
  });
  $("values-input").addEventListener("input", () => {
    updateEditorDraftStatus();
  });
  ["draw-length-input", "draw-min-input", "draw-max-input"].forEach((id) => {
    $(id).addEventListener("input", () => {
      if (state.drawPoints.length) {
        applyDrawToText({ normalize: false });
      } else {
        renderDrawEditor();
      }
    });
  });
  $("draw-apply-btn").addEventListener("click", () => applyDrawToText());
  $("draw-smooth-btn").addEventListener("click", smoothEditorValues);
  $("draw-clear-btn").addEventListener("click", clearDrawSketch);
  ["draw-span-start-input", "draw-span-end-input"].forEach((id) => {
    $(id).addEventListener("input", () => {
      setFocusSpanIndexes(
        Number($("draw-span-start-input").value),
        Number($("draw-span-end-input").value),
        { sync: true },
      );
    });
  });

  const canvas = $("draw-canvas");
  canvas.addEventListener("pointerdown", (event) => {
    if (!beginDrawStroke(event, event.pointerId)) return;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!moveDrawStroke(event, event.pointerId) && event.buttons === 1) {
      beginDrawStroke(event, event.pointerId);
    }
  });
  ["pointerup", "pointercancel"].forEach((eventName) => {
    canvas.addEventListener(eventName, (event) => {
      if (state.drawPointerId !== event.pointerId) return;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      finishDrawStroke(event, event.pointerId, eventName === "pointerup");
    });
  });
  canvas.addEventListener("mousedown", (event) => {
    beginDrawStroke(event, "mouse");
  });
  window.addEventListener("mousemove", (event) => {
    if (
      !moveDrawStroke(event, "mouse") &&
      event.buttons === 1 &&
      eventIsInsideElement(event, "draw-canvas")
    ) {
      beginDrawStroke(event, "mouse");
    }
  }, true);
  window.addEventListener("mouseup", (event) => {
    finishDrawStroke(event, "mouse");
  }, true);

  const overview = $("draw-overview-canvas");
  overview.addEventListener("pointerdown", (event) => {
    if (!beginFocusBrush(event, event.pointerId)) return;
    overview.setPointerCapture(event.pointerId);
  });
  overview.addEventListener("pointermove", (event) => {
    if (!moveFocusBrush(event, event.pointerId) && event.buttons === 1) {
      beginFocusBrush(event, event.pointerId);
    }
  });
  ["pointerup", "pointercancel"].forEach((eventName) => {
    overview.addEventListener(eventName, (event) => {
      if (!state.focusBrushDrag || state.focusBrushDrag.pointerId !== event.pointerId) return;
      if (overview.hasPointerCapture(event.pointerId)) {
        overview.releasePointerCapture(event.pointerId);
      }
      finishFocusBrush(event, event.pointerId);
    });
  });
  overview.addEventListener("mousedown", (event) => {
    beginFocusBrush(event, "mouse");
  });
  window.addEventListener("mousemove", (event) => {
    if (
      !moveFocusBrush(event, "mouse") &&
      event.buttons === 1 &&
      eventIsInsideElement(event, "draw-overview-canvas")
    ) {
      beginFocusBrush(event, "mouse");
    }
  }, true);
  window.addEventListener("mouseup", (event) => {
    finishFocusBrush(event, "mouse");
  }, true);
}

function wireControls() {
  $("new-series-btn").addEventListener("click", openSeriesEditor);
  $("add-series-btn").addEventListener("click", addFromText);
  $("cancel-edit-btn").addEventListener("click", cancelSeriesEdit);
  $("paste-btn").addEventListener("click", () => pasteValues());
  $("demo-btn").addEventListener("click", loadConfiguredDemo);
  $("clear-series-btn").addEventListener("click", clearSeries);
  $("upload-btn").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", async () => {
    const files = Array.from($("file-input").files || []);
    await uploadFiles(files);
    $("file-input").value = "";
  });
  $("forecast-btn").addEventListener("click", runForecast);
  $("copy-json-btn").addEventListener("click", async () => {
    if (!state.lastResponse) return;
    await navigator.clipboard.writeText(JSON.stringify(state.lastResponse, null, 2));
    setStatus("copied", "ok");
  });
  $("model-select").addEventListener("change", (event) => {
    if (event.target.value) switchModel(event.target.value);
  });
  wireContextControls();
  wireDrawControls();
  const dropZone = $("drop-zone");
  ["dragenter", "dragover"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove("dragging"));
  });
  dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    await uploadFiles(Array.from(event.dataTransfer.files || []));
  });
}

async function init() {
  wireThemeControls();
  wireControls();
  await refreshInfo();
  loadConfiguredDemo();
  render();
}

init().catch((err) => {
  setStatus(err.message, "err");
  render();
});
