const assert = require("node:assert/strict");
const test = require("node:test");

const utils = require("../src/tsfm_playground/static/forecast_utils.js");

test("parseSeriesValues accepts comma and whitespace separated values", () => {
  const parsed = utils.parseSeriesValues("1, 2 3\n4");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.values, [1, 2, 3, 4]);
});

test("resampleDrawnSeries converts normalized sketch points to values", () => {
  const sampled = utils.resampleDrawnSeries(
    [
      { x: 0, y: 1 },
      { x: 0.5, y: 0 },
      { x: 1, y: 0.5 },
    ],
    { length: 5, minValue: 0, maxValue: 10 },
  );
  assert.equal(sampled.ok, true);
  assert.deepEqual(sampled.values, [0, 5, 10, 7.5, 5]);
});

test("resampleDrawnSeries sorts and clamps drawn points", () => {
  const sampled = utils.resampleDrawnSeries(
    [
      { x: 1.4, y: -1 },
      { x: -0.2, y: 2 },
    ],
    { length: 3, minValue: -5, maxValue: 5 },
  );
  assert.equal(sampled.ok, true);
  assert.deepEqual(sampled.values, [-5, 0, 5]);
});

test("resampleDrawnSeries validates draw options", () => {
  assert.equal(
    utils.resampleDrawnSeries([{ x: 0, y: 0 }], { length: 0, minValue: 0, maxValue: 1 }).ok,
    false,
  );
  assert.equal(
    utils.resampleDrawnSeries([{ x: 0, y: 0 }], { length: 2, minValue: 1, maxValue: 1 }).ok,
    false,
  );
  assert.equal(
    utils.resampleDrawnSeries([], { length: 2, minValue: 0, maxValue: 1 }).ok,
    false,
  );
});

test("mergeDrawnSeries patches a single clicked index", () => {
  const merged = utils.mergeDrawnSeries(
    [0, 1, 2, 3, 4],
    [{ x: 0.5, y: 0 }],
    { length: 5, minValue: 0, maxValue: 10 },
  );
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.values, [0, 1, 10, 3, 4]);
  assert.equal(merged.startIndex, 2);
  assert.equal(merged.endIndex, 3);
});

test("mergeDrawnSeries leaves untouched indexes unchanged", () => {
  const merged = utils.mergeDrawnSeries(
    [10, 10, 10, 10, 10],
    [
      { x: 0.25, y: 1 },
      { x: 0.75, y: 0 },
    ],
    { length: 5, minValue: 0, maxValue: 10 },
  );
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.values, [10, 0, 5, 10, 10]);
  assert.equal(merged.startIndex, 1);
  assert.equal(merged.endIndex, 4);
});

test("mergeDrawnSeries validates active length and patch points", () => {
  assert.equal(
    utils.mergeDrawnSeries([1, 2], [{ x: 0, y: 0 }], { length: 3, minValue: 0, maxValue: 1 }).ok,
    false,
  );
  assert.equal(
    utils.mergeDrawnSeries([1, 2], [], { length: 2, minValue: 0, maxValue: 1 }).ok,
    false,
  );
});

test("brushToIndexSpan maps visual brush ratios to exclusive index spans", () => {
  assert.deepEqual(utils.brushToIndexSpan(0.25, 0.75, 8), {
    ok: true,
    error: "",
    startIndex: 2,
    endIndex: 6,
  });
  assert.deepEqual(utils.brushToIndexSpan(0.8, 0.2, 10), {
    ok: true,
    error: "",
    startIndex: 2,
    endIndex: 8,
  });
  assert.deepEqual(utils.brushToIndexSpan(0.5, 0.5, 4, { minLength: 2 }), {
    ok: true,
    error: "",
    startIndex: 2,
    endIndex: 4,
  });
});

test("replaceSeriesSpan updates only the selected edit span", () => {
  const replaced = utils.replaceSeriesSpan([0, 1, 2, 3, 4], 1, 4, [10, 11, 12]);
  assert.equal(replaced.ok, true);
  assert.deepEqual(replaced.values, [0, 10, 11, 12, 4]);
});

test("replaceSeriesSpan validates span and replacement length", () => {
  assert.equal(utils.replaceSeriesSpan([1, 2, 3], 2, 2, []).ok, false);
  assert.equal(utils.replaceSeriesSpan([1, 2, 3], 1, 3, [9]).ok, false);
  assert.equal(utils.replaceSeriesSpan([1, 2, 3], 1, 3, [9, Number.NaN]).ok, false);
});

test("parseQuantiles validates range and uniqueness", () => {
  assert.deepEqual(utils.parseQuantiles("0.9,0.1,0.5").values, [0.1, 0.5, 0.9]);
  assert.equal(utils.parseQuantiles("0.1,1.2").ok, false);
  assert.equal(utils.parseQuantiles("0.5,0.5").ok, false);
});

test("parsePositiveInteger validates bounds and optional empty values", () => {
  assert.deepEqual(utils.parsePositiveInteger("12", "Horizon", { max: 24 }), {
    ok: true,
    error: "",
    value: 12,
  });
  assert.equal(utils.parsePositiveInteger("25", "Horizon", { max: 24 }).ok, false);
  assert.equal(utils.parsePositiveInteger("", "Context", { optional: true }).value, null);
});

test("parseJsonObject accepts objects only", () => {
  assert.deepEqual(utils.parseJsonObject('{"frequency": 0}').value, { frequency: 0 });
  assert.equal(utils.parseJsonObject("[1,2]").ok, false);
  assert.equal(utils.parseJsonObject("{bad").ok, false);
});

test("buildForecastRequest includes only enabled tail-windowed series", () => {
  const request = utils.buildForecastRequest(
    [
      { id: 1, name: "A", values: [1, 2, 3, 4], enabled: true },
      { id: 2, name: "B", values: [3, 4], enabled: false },
    ],
    { horizon: 2, quantiles: [0.5], target: "value", contextWindow: 2 },
  );
  assert.deepEqual(request.series, [{ id: "1", name: "A", values: [3, 4] }]);
  assert.equal(request.horizon, 2);
  assert.deepEqual(request.context, {
    mode: "tail",
    start_index: null,
    end_index: null,
    original_lengths: { 1: 4 },
  });
});

test("buildForecastRequest slices a common range and preserves timestamps", () => {
  const request = utils.buildForecastRequest(
    [
      {
        id: "a",
        name: "A",
        values: [10, 11, 12, 13],
        timestamps: ["t0", "t1", "t2", "t3"],
        enabled: true,
      },
    ],
    {
      horizon: 2,
      quantiles: [0.5],
      target: "value",
      contextMode: "range",
      contextStart: 1,
      contextEnd: 3,
    },
  );
  assert.deepEqual(request.series, [
    { id: "a", name: "A", values: [11, 12], timestamps: ["t1", "t2"] },
  ]);
  assert.deepEqual(request.context, {
    mode: "range",
    start_index: 1,
    end_index: 3,
    original_lengths: { a: 4 },
  });
});

test("resolveContextSpec rejects out-of-bounds ranges", () => {
  const resolved = utils.resolveContextSpec(
    [{ id: "a", values: [1, 2, 3], enabled: true }],
    { contextMode: "range", contextStart: 1, contextEnd: 4 },
  );
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /shortest selected series length/);
});

test("buildForecastTraces creates history forecast and band traces", () => {
  const traces = utils.buildForecastTraces({
    input_echo: [{ id: "a", name: "A", values: [1, 2, 3] }],
    forecasts: [
      {
        id: "a",
        name: "A",
        point: [4, 5],
        quantiles: { "0.1": [3, 4], "0.9": [5, 6] },
      },
    ],
  });
  assert.equal(traces.length, 3);
  assert.deepEqual(traces[0].x, [0, 1, 2]);
  assert.equal(traces[1].fill, "toself");
  assert.deepEqual(traces[2].x, [3, 4]);
  assert.equal(traces[2].meta.role, "forecast");
});

test("buildForecastTraces offsets numeric axes for range context", () => {
  const traces = utils.buildForecastTraces({
    context: { mode: "range", start_index: 10, end_index: 13, original_lengths: { a: 20 } },
    input_echo: [{ id: "a", name: "A", values: [1, 2, 3] }],
    forecasts: [
      {
        id: "a",
        name: "A",
        point: [4, 5],
        quantiles: { "0.5": [4, 5] },
      },
    ],
  });
  assert.deepEqual(traces[0].x, [10, 11, 12]);
  assert.deepEqual(traces[1].x, [13, 14]);
});

test("buildForecastTraces overlays future ground truth for held-out range context", () => {
  const response = {
    context: { mode: "range", start_index: 0, end_index: 3, original_lengths: { a: 6 } },
    input_echo: [{ id: "a", name: "A", values: [1, 2, 3] }],
    forecasts: [
      {
        id: "a",
        name: "A",
        point: [3.8, 4.8, 5.8, 6.8],
        quantiles: { "0.5": [3.8, 4.8, 5.8, 6.8] },
      },
    ],
  };
  const originalSeries = [{ id: "a", name: "A", values: [1, 2, 3, 4, 5, 6], enabled: true }];
  const traces = utils.buildForecastTraces(response, originalSeries);
  const gt = traces.find((trace) => trace.meta && trace.meta.role === "ground-truth");
  assert.ok(gt);
  assert.equal(gt.name, "A GT");
  assert.deepEqual(gt.x, [3, 4, 5]);
  assert.deepEqual(gt.y, [4, 5, 6]);
  assert.equal(utils.countGroundTruthPoints(response, originalSeries), 3);
});

test("buildGroundTruthTraces skips full context and ranges without future actuals", () => {
  const originalSeries = [{ id: "a", values: [1, 2, 3], enabled: true }];
  assert.deepEqual(
    utils.buildGroundTruthTraces({
      context: { mode: "full", start_index: null, end_index: null, original_lengths: { a: 3 } },
      input_echo: [{ id: "a", values: [1, 2, 3] }],
      forecasts: [{ id: "a", point: [4], quantiles: { "0.5": [4] } }],
    }, originalSeries),
    [],
  );
  assert.deepEqual(
    utils.buildGroundTruthTraces({
      context: { mode: "range", start_index: 1, end_index: 3, original_lengths: { a: 3 } },
      input_echo: [{ id: "a", values: [2, 3] }],
      forecasts: [{ id: "a", point: [4], quantiles: { "0.5": [4] } }],
    }, originalSeries),
    [],
  );
});

test("buildForecastTraces uses timestamps when available", () => {
  const traces = utils.buildForecastTraces({
    input_echo: [{ id: "a", values: [1, 2], timestamps: ["2026-01-01", "2026-01-02"] }],
    forecasts: [
      {
        id: "a",
        point: [3],
        timestamps: ["2026-01-03"],
        quantiles: { "0.5": [3] },
      },
    ],
  });
  assert.deepEqual(traces[0].x, ["2026-01-01", "2026-01-02"]);
  assert.deepEqual(traces[1].x, ["2026-01-03"]);
});

test("buildInputContextTraces overlays the selected context", () => {
  const resolved = utils.resolveContextSpec(
    [{ id: "a", values: [1, 2, 3, 4], enabled: true }],
    { contextMode: "range", contextStart: 1, contextEnd: 3 },
  );
  const traces = utils.buildInputContextTraces(
    [{ id: "a", name: "A", values: [1, 2, 3, 4], enabled: true }],
    resolved.context,
  );
  assert.equal(traces.length, 2);
  assert.equal(traces[0].meta.role, "input-full");
  assert.equal(traces[1].meta.role, "input-context");
  assert.deepEqual(traces[1].x, [1, 2]);
  assert.deepEqual(traces[1].y, [2, 3]);
});

test("rangeFromSelectedPoints returns an exclusive end index", () => {
  const range = utils.rangeFromSelectedPoints([
    { pointIndex: 4, data: { meta: { startIndex: 0 } } },
    { pointIndex: 2, data: { meta: { startIndex: 10 } } },
  ]);
  assert.deepEqual(range, { ok: true, error: "", startIndex: 4, endIndex: 13 });
});
