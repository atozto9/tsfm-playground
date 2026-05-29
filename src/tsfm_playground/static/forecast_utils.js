(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.TSFMForecastUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function parseNumberList(text) {
    return String(text || "")
      .replace(/,/g, " ")
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => Number(item));
  }

  function parseSeriesValues(text) {
    const values = parseNumberList(text);
    if (!values.length) {
      return { ok: false, error: "Enter at least one numeric value.", values: [] };
    }
    if (values.some((value) => !Number.isFinite(value))) {
      return { ok: false, error: "Series contains a non-numeric value.", values: [] };
    }
    return { ok: true, error: "", values };
  }

  function normalizeDrawPoints(points) {
    const normalized = [];
    for (const point of points || []) {
      const x = Number(point && point.x);
      const y = Number(point && point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      normalized.push({
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
      });
    }
    normalized.sort((a, b) => a.x - b.x);
    const deduped = [];
    for (const point of normalized) {
      const previous = deduped[deduped.length - 1];
      if (previous && Math.abs(previous.x - point.x) < 0.000001) {
        previous.y = point.y;
      } else {
        deduped.push(point);
      }
    }
    return deduped;
  }

  function drawnValueAt(points, ratio, minValue, maxValue) {
    if (points.length === 1) {
      return maxValue - points[0].y * (maxValue - minValue);
    }
    if (ratio <= points[0].x) {
      return maxValue - points[0].y * (maxValue - minValue);
    }
    const last = points[points.length - 1];
    if (ratio >= last.x) {
      return maxValue - last.y * (maxValue - minValue);
    }
    for (let index = 1; index < points.length; index += 1) {
      const right = points[index];
      if (ratio > right.x) continue;
      const left = points[index - 1];
      const span = Math.max(0.000001, right.x - left.x);
      const localRatio = (ratio - left.x) / span;
      const y = left.y + (right.y - left.y) * localRatio;
      return maxValue - y * (maxValue - minValue);
    }
    return maxValue - last.y * (maxValue - minValue);
  }

  function roundDrawnValue(value) {
    return Number(value.toFixed(6));
  }

  function resampleDrawnSeries(points, options = {}) {
    const length = Number(options.length);
    const minValue = Number(options.minValue);
    const maxValue = Number(options.maxValue);
    if (!Number.isInteger(length) || length <= 0) {
      return { ok: false, error: "Draw length must be a positive integer.", values: [] };
    }
    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
      return { ok: false, error: "Draw range must use numeric min and max.", values: [] };
    }
    if (minValue >= maxValue) {
      return { ok: false, error: "Draw min must be less than max.", values: [] };
    }
    const normalized = normalizeDrawPoints(points);
    if (!normalized.length) {
      return { ok: false, error: "Draw at least one point.", values: [] };
    }
    const values = Array.from({ length }, (_item, index) => {
      const ratio = length === 1 ? 0 : index / (length - 1);
      return roundDrawnValue(drawnValueAt(normalized, ratio, minValue, maxValue));
    });
    return { ok: true, error: "", values };
  }

  function mergeDrawnSeries(baseValues, points, options = {}) {
    const source = (baseValues || []).map((value) => Number(value));
    const length = Number(options.length == null ? source.length : options.length);
    const minValue = Number(options.minValue);
    const maxValue = Number(options.maxValue);
    if (!Number.isInteger(length) || length <= 0 || source.length !== length) {
      return { ok: false, error: "Draw patch length must match the active series.", values: source };
    }
    if (source.some((value) => !Number.isFinite(value))) {
      return { ok: false, error: "Active series contains a non-numeric value.", values: source };
    }
    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
      return { ok: false, error: "Draw range must use numeric min and max.", values: source };
    }
    if (minValue >= maxValue) {
      return { ok: false, error: "Draw min must be less than max.", values: source };
    }
    const normalized = normalizeDrawPoints(points);
    if (!normalized.length) {
      return { ok: false, error: "Draw at least one point.", values: source };
    }

    const ratioToIndex = (ratio) => (
      length <= 1 ? 0 : Math.round(Math.max(0, Math.min(1, ratio)) * (length - 1))
    );
    let startIndex = ratioToIndex(normalized[0].x);
    let endIndex = startIndex;
    if (normalized.length > 1) {
      const left = Math.min(...normalized.map((point) => point.x));
      const right = Math.max(...normalized.map((point) => point.x));
      startIndex = Math.max(0, Math.min(length - 1, Math.floor(left * (length - 1))));
      endIndex = Math.max(startIndex, Math.min(length - 1, Math.ceil(right * (length - 1))));
    }

    const values = source.slice();
    for (let index = startIndex; index <= endIndex; index += 1) {
      const ratio = length === 1 ? 0 : index / (length - 1);
      values[index] = roundDrawnValue(drawnValueAt(normalized, ratio, minValue, maxValue));
    }
    return { ok: true, error: "", values, startIndex, endIndex: endIndex + 1 };
  }

  function brushToIndexSpan(startRatio, endRatio, length, options = {}) {
    const size = Number(length);
    const minLength = Number.isInteger(options.minLength) && options.minLength > 0
      ? options.minLength
      : 1;
    if (!Number.isInteger(size) || size <= 0) {
      return { ok: false, error: "Span source length must be a positive integer.", startIndex: 0, endIndex: 0 };
    }
    const left = Math.max(0, Math.min(1, Number(startRatio)));
    const right = Math.max(0, Math.min(1, Number(endRatio)));
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return { ok: false, error: "Brush ratios must be numeric.", startIndex: 0, endIndex: 0 };
    }
    let startIndex = Math.floor(Math.min(left, right) * size);
    let endIndex = Math.ceil(Math.max(left, right) * size);
    startIndex = Math.max(0, Math.min(size - 1, startIndex));
    endIndex = Math.max(startIndex + minLength, Math.min(size, endIndex));
    if (endIndex > size) {
      endIndex = size;
      startIndex = Math.max(0, endIndex - minLength);
    }
    return { ok: true, error: "", startIndex, endIndex };
  }

  function validateEditSpan(values, startIndex, endIndex) {
    const length = (values || []).length;
    const start = Number(startIndex);
    const end = Number(endIndex);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return { ok: false, error: "Edit span start and end must be integers.", startIndex: 0, endIndex: 0 };
    }
    if (start < 0 || end > length || start >= end) {
      return {
        ok: false,
        error: `Edit span must satisfy 0 <= start < end <= ${length}.`,
        startIndex: 0,
        endIndex: 0,
      };
    }
    return { ok: true, error: "", startIndex: start, endIndex: end };
  }

  function replaceSeriesSpan(values, startIndex, endIndex, replacement) {
    const source = (values || []).slice();
    const span = validateEditSpan(source, startIndex, endIndex);
    if (!span.ok) return { ok: false, error: span.error, values: source };
    const nextValues = (replacement || []).map((value) => Number(value));
    if (nextValues.some((value) => !Number.isFinite(value))) {
      return { ok: false, error: "Replacement values must be numeric.", values: source };
    }
    const expectedLength = span.endIndex - span.startIndex;
    if (nextValues.length !== expectedLength) {
      return {
        ok: false,
        error: `Replacement length must equal edit span length (${expectedLength}).`,
        values: source,
      };
    }
    return {
      ok: true,
      error: "",
      values: source.slice(0, span.startIndex).concat(nextValues, source.slice(span.endIndex)),
    };
  }

  function parseQuantiles(text) {
    const values = parseNumberList(text);
    if (!values.length) {
      return { ok: false, error: "Enter at least one quantile.", values: [] };
    }
    const seen = new Set();
    for (const value of values) {
      if (!Number.isFinite(value) || value <= 0 || value >= 1) {
        return { ok: false, error: "Quantiles must be between 0 and 1.", values: [] };
      }
      if (seen.has(value)) {
        return { ok: false, error: "Quantiles must be unique.", values: [] };
      }
      seen.add(value);
    }
    return { ok: true, error: "", values: values.slice().sort((a, b) => a - b) };
  }

  function parsePositiveInteger(text, label, options = {}) {
    const raw = String(text || "").trim();
    if (!raw) {
      if (options.optional) return { ok: true, error: "", value: null };
      return { ok: false, error: `${label} is required.`, value: null };
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      return { ok: false, error: `${label} must be a positive integer.`, value: null };
    }
    if (options.max != null && value > options.max) {
      return { ok: false, error: `${label} must be <= ${options.max}.`, value: null };
    }
    return { ok: true, error: "", value };
  }

  function parseJsonObject(text, label = "JSON") {
    const raw = String(text || "").trim();
    if (!raw) return { ok: true, error: "", value: {} };
    try {
      const value = JSON.parse(raw);
      if (!value || Array.isArray(value) || typeof value !== "object") {
        return { ok: false, error: `${label} must be an object.`, value: null };
      }
      return { ok: true, error: "", value };
    } catch (err) {
      return { ok: false, error: `Invalid ${label}: ${err.message}`, value: null };
    }
  }

  function toInteger(value, label, options = {}) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) {
      if (options.optional) return { ok: true, error: "", value: null };
      return { ok: false, error: `${label} is required.`, value: null };
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      return { ok: false, error: `${label} must be an integer.`, value: null };
    }
    if (options.min != null && parsed < options.min) {
      return { ok: false, error: `${label} must be >= ${options.min}.`, value: null };
    }
    if (options.max != null && parsed > options.max) {
      return { ok: false, error: `${label} must be <= ${options.max}.`, value: null };
    }
    return { ok: true, error: "", value: parsed };
  }

  function normalizeContextMode(mode) {
    return ["full", "tail", "range"].includes(mode) ? mode : "full";
  }

  function enabledSeries(series) {
    return (series || []).filter((item) => item.enabled);
  }

  function seriesKey(item) {
    return String(item.id);
  }

  function originalLengths(series) {
    const lengths = {};
    for (const item of series) {
      lengths[seriesKey(item)] = (item.values || []).length;
    }
    return lengths;
  }

  function minSeriesLength(series) {
    if (!series.length) return 0;
    return Math.min(...series.map((item) => (item.values || []).length));
  }

  function applyContextWindow(values, contextWindow) {
    if (contextWindow == null) return values.slice();
    return values.slice(Math.max(0, values.length - contextWindow));
  }

  function resolveContextSpec(series, options = {}) {
    const selected = enabledSeries(series);
    if (!selected.length) {
      return { ok: false, error: "Select at least one series.", context: null };
    }

    const mode = normalizeContextMode(
      options.contextMode || (options.contextWindow == null ? "full" : "tail"),
    );
    const context = {
      mode,
      startIndex: null,
      endIndex: null,
      tailLength: null,
      originalLengths: originalLengths(selected),
    };

    if (mode === "full") {
      return { ok: true, error: "", context };
    }

    if (mode === "tail") {
      const tail = toInteger(
        options.contextTail == null ? options.contextWindow : options.contextTail,
        "Context length",
        { min: 1 },
      );
      if (!tail.ok) return { ok: false, error: tail.error, context: null };
      context.tailLength = tail.value;
      return { ok: true, error: "", context };
    }

    const start = toInteger(options.contextStart, "Context start", { min: 0 });
    if (!start.ok) return { ok: false, error: start.error, context: null };
    const end = toInteger(options.contextEnd, "Context end", { min: 1 });
    if (!end.ok) return { ok: false, error: end.error, context: null };
    if (start.value >= end.value) {
      return {
        ok: false,
        error: "Context start must be less than context end.",
        context: null,
      };
    }
    const minLength = minSeriesLength(selected);
    if (end.value > minLength) {
      return {
        ok: false,
        error: `Context end must be <= shortest selected series length (${minLength}).`,
        context: null,
      };
    }
    context.startIndex = start.value;
    context.endIndex = end.value;
    return { ok: true, error: "", context };
  }

  function applyContextSelection(values, timestamps, context) {
    const mode = normalizeContextMode(context && context.mode);
    let start = 0;
    let end = values.length;
    if (mode === "tail") {
      const tailLength = context && context.tailLength;
      if (tailLength != null) start = Math.max(0, values.length - tailLength);
    } else if (mode === "range") {
      start = context.startIndex;
      end = context.endIndex;
    }
    const selectedTimestamps = timestamps && timestamps.length === values.length
      ? timestamps.slice(start, end)
      : null;
    return {
      values: values.slice(start, end),
      timestamps: selectedTimestamps,
      startIndex: start,
      endIndex: end,
    };
  }

  function apiContext(context) {
    return {
      mode: normalizeContextMode(context && context.mode),
      start_index: context && context.startIndex != null ? context.startIndex : null,
      end_index: context && context.endIndex != null ? context.endIndex : null,
      original_lengths: context && context.originalLengths ? context.originalLengths : {},
    };
  }

  function summarizeSeries(values) {
    if (!values.length) return "n=0";
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return `n=${values.length} min=${min.toFixed(3)} max=${max.toFixed(3)} mean=${mean.toFixed(3)}`;
  }

  function quantileKey(value) {
    return Number(value).toString();
  }

  function nearestQuantileKey(quantiles, target) {
    const keys = Object.keys(quantiles || {});
    if (!keys.length) return null;
    return keys.reduce((best, key) => {
      if (best == null) return key;
      return Math.abs(Number(key) - target) < Math.abs(Number(best) - target) ? key : best;
    }, null);
  }

  function sortedQuantileKeys(quantiles) {
    return Object.keys(quantiles || {})
      .map((key) => ({ key, value: Number(key) }))
      .filter((item) => Number.isFinite(item.value))
      .sort((a, b) => a.value - b.value);
  }

  function intervalKeys(quantiles) {
    const keys = sortedQuantileKeys(quantiles);
    if (keys.length < 2) return null;
    const below = keys.filter((item) => item.value < 0.5);
    const above = keys.filter((item) => item.value > 0.5);
    if (below.length && above.length) {
      return { low: below[0].key, high: above[above.length - 1].key };
    }
    return { low: keys[0].key, high: keys[keys.length - 1].key };
  }

  function contextStartForSeries(context, seriesId, historyLength) {
    if (!context) return 0;
    if (context.mode === "range" && context.start_index != null) return context.start_index;
    if (context.mode === "tail" && context.original_lengths) {
      const originalLength = context.original_lengths[String(seriesId)];
      if (Number.isInteger(originalLength)) return Math.max(0, originalLength - historyLength);
    }
    return 0;
  }

  function contextEndForSeries(context, seriesId, historyLength) {
    if (context && context.mode === "range" && context.end_index != null) {
      return context.end_index;
    }
    const start = contextStartForSeries(context, seriesId, historyLength);
    return start + historyLength;
  }

  function axisValues(history, forecast, context, seriesId) {
    const start = contextStartForSeries(context, seriesId, history.values.length);
    const end = contextEndForSeries(context, seriesId, history.values.length);
    const xHistory = history.timestamps && history.timestamps.length === history.values.length
      ? history.timestamps
      : history.values.map((_value, index) => start + index);
    const xForecast = forecast.timestamps && forecast.timestamps.length === forecast.point.length
      ? forecast.timestamps
      : (forecast.point || []).map((_value, index) => end + index);
    return { xHistory, xForecast };
  }

  function originalSeriesById(series) {
    return new Map((series || []).map((item) => [seriesKey(item), item]));
  }

  function groundTruthTraceForForecast(forecast, original, context) {
    if (!original || !context || context.mode !== "range") return null;
    if (context.end_index == null) return null;
    const values = original.values || [];
    const forecastLength = (forecast.point || []).length;
    const start = context.end_index;
    const end = Math.min(values.length, start + forecastLength);
    if (end <= start) return null;
    const timestamps = original.timestamps && original.timestamps.length === values.length
      ? original.timestamps
      : null;
    const useForecastTimestamps = forecast.timestamps && forecast.timestamps.length === forecastLength;
    const x = useForecastTimestamps && timestamps
      ? timestamps.slice(start, end)
      : values.slice(start, end).map((_value, index) => start + index);
    const label = forecast.name || original.name || forecast.id;
    return {
      type: "scatter",
      mode: "lines+markers",
      name: `${label} GT`,
      x,
      y: values.slice(start, end),
      line: { dash: "dot", width: 2 },
      marker: { size: 5, symbol: "circle-open" },
      meta: { role: "ground-truth", seriesId: forecast.id, startIndex: start },
    };
  }

  function buildGroundTruthTraces(response, originalSeries = []) {
    const context = response && response.context ? response.context : null;
    if (!context || context.mode !== "range") return [];
    const originals = originalSeriesById(originalSeries);
    const traces = [];
    for (const forecast of response.forecasts || []) {
      const trace = groundTruthTraceForForecast(
        forecast,
        originals.get(String(forecast.id)),
        context,
      );
      if (trace) traces.push(trace);
    }
    return traces;
  }

  function countGroundTruthPoints(response, originalSeries = []) {
    return buildGroundTruthTraces(response, originalSeries).reduce(
      (sum, trace) => sum + (trace.y || []).length,
      0,
    );
  }

  function buildForecastTraces(response, originalSeries = []) {
    const traces = [];
    const context = response.context || null;
    const echoesById = new Map((response.input_echo || []).map((item) => [item.id, item]));
    for (const forecast of response.forecasts || []) {
      const echo = echoesById.get(forecast.id);
      const history = {
        values: echo ? echo.values || [] : [],
        timestamps: echo ? echo.timestamps || null : null,
      };
      const point = forecast.point || [];
      const { xHistory, xForecast } = axisValues(history, forecast, context, forecast.id);
      const label = forecast.name || forecast.id;
      traces.push({
        type: "scatter",
        mode: "lines",
        name: `${label} history`,
        x: xHistory,
        y: history.values,
        meta: { role: "history", seriesId: forecast.id },
      });
      const bandKeys = intervalKeys(forecast.quantiles);
      if (bandKeys) {
        const low = forecast.quantiles[bandKeys.low] || [];
        const high = forecast.quantiles[bandKeys.high] || [];
        if (low.length === point.length && high.length === point.length) {
          traces.push({
            type: "scatter",
            mode: "lines",
            name: `${label} q${bandKeys.low}-q${bandKeys.high}`,
            x: xForecast.concat(xForecast.slice().reverse()),
            y: high.concat(low.slice().reverse()),
            fill: "toself",
            line: { width: 0 },
            hoverinfo: "skip",
            meta: { role: "interval", seriesId: forecast.id },
          });
        }
      }
      traces.push({
        type: "scatter",
        mode: "lines",
        name: `${label} forecast`,
        x: xForecast,
        y: point,
        line: { dash: "solid" },
        meta: { role: "forecast", seriesId: forecast.id },
      });
    }
    return traces.concat(buildGroundTruthTraces(response, originalSeries));
  }

  function buildInputContextTraces(series, context) {
    const traces = [];
    for (const [index, item] of (series || []).entries()) {
      const values = item.values || [];
      const timestamps = item.timestamps && item.timestamps.length === values.length
        ? item.timestamps
        : null;
      const xFull = timestamps || values.map((_value, index) => index);
      traces.push({
        type: "scatter",
        mode: "lines",
        name: item.name || seriesKey(item),
        x: xFull,
        y: values,
        opacity: item.enabled ? 0.38 : 0.18,
        line: { width: 1 },
        meta: { role: "input-full", seriesId: seriesKey(item), seriesIndex: index, startIndex: 0 },
      });
      if (!item.enabled || !context || context.mode === "full") continue;
      const selected = applyContextSelection(values, timestamps, context);
      const xSelected = selected.timestamps || selected.values.map(
        (_value, index) => selected.startIndex + index,
      );
      traces.push({
        type: "scatter",
        mode: "lines+markers",
        name: `${item.name || seriesKey(item)} context`,
        x: xSelected,
        y: selected.values,
        opacity: 1,
        line: { width: 3 },
        marker: { size: 4 },
        meta: {
          role: "input-context",
          seriesId: seriesKey(item),
          seriesIndex: index,
          startIndex: selected.startIndex,
        },
      });
    }
    return traces;
  }

  function rangeFromSelectedPoints(points) {
    const indexes = [];
    for (const point of points || []) {
      const meta = point.data && point.data.meta ? point.data.meta : {};
      const pointIndex = Number.isInteger(point.pointIndex)
        ? point.pointIndex
        : point.pointNumber;
      if (!Number.isInteger(pointIndex)) continue;
      const startIndex = Number.isInteger(meta.startIndex) ? meta.startIndex : 0;
      indexes.push(startIndex + pointIndex);
    }
    if (!indexes.length) {
      return { ok: false, error: "No selectable points.", startIndex: null, endIndex: null };
    }
    return {
      ok: true,
      error: "",
      startIndex: Math.min(...indexes),
      endIndex: Math.max(...indexes) + 1,
    };
  }

  function buildForecastRequest(series, options) {
    const selected = enabledSeries(series);
    const resolved = resolveContextSpec(selected, options);
    if (!resolved.ok) throw new Error(resolved.error);
    return {
      series: selected.map((item) => {
        const selectedContext = applyContextSelection(
          item.values || [],
          item.timestamps || null,
          resolved.context,
        );
        const out = {
          id: seriesKey(item),
          name: item.name,
          values: selectedContext.values,
        };
        if (selectedContext.timestamps) out.timestamps = selectedContext.timestamps;
        return out;
      }),
      horizon: options.horizon,
      quantiles: options.quantiles,
      target: options.target || "value",
      model_options: options.modelOptions || {},
      context: apiContext(resolved.context),
    };
  }

  return {
    applyContextSelection,
    applyContextWindow,
    buildGroundTruthTraces,
    buildForecastRequest,
    buildForecastTraces,
    buildInputContextTraces,
    brushToIndexSpan,
    countGroundTruthPoints,
    mergeDrawnSeries,
    normalizeDrawPoints,
    nearestQuantileKey,
    normalizeContextMode,
    parseJsonObject,
    parsePositiveInteger,
    parseQuantiles,
    parseSeriesValues,
    quantileKey,
    rangeFromSelectedPoints,
    replaceSeriesSpan,
    resampleDrawnSeries,
    resolveContextSpec,
    summarizeSeries,
    validateEditSpan,
  };
});
