# Design

## Source of truth
- Status: Draft
- Last refreshed: 2026-05-18
- Primary product surfaces: forecasting workbench web UI, FastAPI forecast API, model adapter configuration
- Evidence reviewed: `tsllm-playground/README.md`, `tsllm-playground/AGENTS.md`, `tsllm-playground/src/tsllm_playground/*`, `tsllm-playground/tests/*`

## Brand
- Personality: technical, compact, inspection-friendly
- Trust signals: visible model status, input echo, forecast intervals, raw JSON for reproducibility
- Avoid: marketing pages, decorative visuals, prompt-chat metaphors, hidden model downloads

## Product goals
- Goals: compare time-series foundation model forecasts through one browser UI; support Chronos-2, TimesFM, and local custom adapters; run a fake backend without model files
- Non-goals: model training, dataset management, production deployment, automatic benchmark scoring
- Success signals: user can upload/paste/edit a series, choose a model, select the forecast context, set horizon/quantiles, run forecast, compare range-context forecasts against visible GT holdout, inspect chart and JSON

## Personas and jobs
- Primary personas: time-series ML researchers, model engineers, applied forecasting experimenters
- User jobs: sanity-check a local model, compare backend behavior, inspect forecast uncertainty, validate file parsing
- Key contexts of use: local workstation, GPU server exposed through a browser, no-build static UI

## Information architecture
- Primary navigation: single workbench screen
- Core routes/screens: root workbench, API health/info/models/forecast/parse-file
- Content hierarchy: model/status header, input series panel with source toolbar/text-or-draw editor drawer/series manager/preview, forecast controls, result chart, raw output

## Design principles
- Principle 1: Forecasting is the primary action, so charts and horizon controls replace prompt/generation controls.
- Principle 2: Backend-specific complexity stays behind adapter/config boundaries until it must be exposed.
- Tradeoffs: compact controls over guided onboarding; local path flexibility over dependency auto-installation

## Visual language
- Color: neutral workbench base with blue action, green success, amber warning, red error
- Typography: system sans for UI, system mono for model IDs and raw payloads
- Spacing/layout rhythm: dense two-column desktop workbench, stacked mobile panels
- Shape/radius/elevation: 8px-or-less radius, light borders, minimal shadows
- Motion: no decorative motion; only chart interaction and button state changes
- Imagery/iconography: Plotly forecast charts are the primary visual asset

## Components
- Existing components to reuse: tsllm-style theme toggle, model selector, file parser, time-series preview cards, Plotly rendering pattern
- New/changed components: input source toolbar, text/draw add/edit series drawer, draw whole/focus scope switch, focus overview brush, compact series manager, context preview chart, forecast controls, context mode/range selector, quantile preset selector, historical+forecast+GT chart, raw forecast JSON panel
- Variants and states: loading, empty input, add drawer open, text editing, whole draw editing, focus draw span editing, series editing, validation error, model switching, forecast success, range-context GT overlay
- Chronos-2 local config opens with a multi-series demo (`retail_demand`, `site_traffic`, `ambient_temperature`) while keeping model loading lazy until forecast.
- Token/component ownership: static CSS variables in `src/tsfm_playground/static/app.css`

## Accessibility
- Target standard: pragmatic WCAG 2.1 AA for contrast, labels, keyboard operation
- Keyboard/focus behavior: native form controls and visible focus outlines
- Contrast/readability: readable chart labels in light and dark themes
- Screen-reader semantics: labels for controls, status region for async actions
- Reduced motion and sensory considerations: no required animation

## Responsive behavior
- Supported breakpoints/devices: desktop first, usable tablet/mobile stack
- Layout adaptations: two-column grid collapses to one column under 900px
- Touch/hover differences: controls remain native and touch-sized; draw canvas and focus overview brush support pointer/touch input

## Interaction states
- Loading: forecast and switch buttons disable while request is active
- Empty: result panel shows placeholder text and no chart traces
- Error: status text shows API validation or backend load messages
- Success: chart and raw JSON refresh together
- Disabled: model selector and forecast button disable during in-flight work
- Offline/slow network, if applicable: API error text is surfaced directly

## Content voice
- Tone: concise technical labels
- Terminology: use `series`, `context`, `horizon`, `quantiles`, `backend`, `adapter`, `forecast`
- Microcopy rules: show constraints in validation messages, avoid explanatory blocks in the workbench

## Implementation constraints
- Framework/styling system: FastAPI plus static HTML/CSS/Vanilla JS, no frontend build system
- Design-token constraints: CSS custom properties only
- Performance constraints: fake backend must be fast; real adapters load on demand unless `preload: true`
- Compatibility constraints: Python 3.10+, Pydantic v2, tests must not require real model files
- Test/screenshot expectations: unit/API tests first; browser smoke is useful after major UI changes

## Open questions
- [ ] Decide how much Chronos-2 covariate UI to expose once a real local model is available / owner: product / impact: adapter option surface
- [ ] Decide whether TimesFM XReg controls belong in v1 UI or advanced JSON options / owner: product / impact: UI complexity
