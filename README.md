# tsfm-playground

`tsfm-playground`는 Chronos-2, TimesFM, 로컬 커스텀 adapter 같은 시계열 foundation model을 같은 웹 인터페이스에서 실험하기 위한 플레이그라운드다.

첫 라운드 구현은 실제 모델 다운로드를 기본값으로 만들지 않고, `fake` backend로 API와 UI가 바로 동작하는 실행 골격을 제공한다. Chronos-2/TimesFM/custom backend는 같은 `ForecastBackend` 계약 뒤에 붙도록 경계를 잡아두었다.

## 설치

필수 도구:

- Python 3.10+

권장 도구:

- [`uv`](https://docs.astral.sh/uv/)

서버에 `uv`가 없으면 먼저 설치한다. 시스템 Python에 직접 설치하기보다 사용자
site 또는 가상환경 안에 설치하는 것을 권장한다.

```bash
python -m pip install --user uv
# PATH 설정이 안 된 환경에서는 아래처럼 실행할 수 있다.
python -m uv --version
```

개발/테스트 의존성까지 설치한다.

```bash
uv sync --extra dev
```

Chronos-2를 실제로 실행하려면 opt-in extra를 함께 설치한다.

```bash
uv sync --extra dev --extra chronos2
```

### uv 없이 pip만 사용하는 경우

서버 정책상 `uv` 설치가 어렵다면 표준 venv와 pip로도 실행할 수 있다.

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
```

Chronos-2까지 설치하려면 extra를 함께 설치한다.

```bash
python -m pip install -e ".[dev,chronos2]"
```

## 실행

### 기본 실행: fake backend

모델 파일이나 네트워크 다운로드 없이 UI/API를 확인할 수 있다.

```bash
uv run tsfm-playground --host 127.0.0.1 --port 7860
```

브라우저에서 `http://127.0.0.1:7860/`에 접속한다.

기본 `configs/default.yaml`은 `fake` backend를 사용하므로 모델 파일이나 네트워크 다운로드가 필요 없다.

### Chronos-2 실행

`configs/chronos2-local.yaml`은 `chronos2-amazon`을 active model로 두고,
`fake` baseline도 selector에 남겨둔다. Chronos-2 모델은 서버 시작 시점이 아니라
forecast를 처음 실행할 때 lazy load된다.

```bash
uv run tsfm-playground --config configs/chronos2-local.yaml --host 127.0.0.1 --port 7860
```

이 config는 Hugging Face 모델 ID `amazon/chronos-2` 사용을 명시적으로 허용한다.
로컬 캐시에 모델이 없으면 첫 forecast 시점에 adapter가 다운로드를 시도할 수 있다.

### 헬스체크

```bash
curl http://127.0.0.1:7860/api/health
```

## 로컬 모델/라이브러리 연결

모델 라이브러리를 pip dependency로 고정하지 않고, config에서 path를 주입할 수 있다.

```yaml
models:
  - id: "local-timesfm"
    label: "Local TimesFM"
    backend: timesfm
    library_path: "../my-timesfm-fork/src"
    model_path: "/models/timesfm-2.5"
    preload: false
    allow_remote_download: false
```

완전히 커스텀한 adapter도 `module:ClassName` 형식으로 연결한다.

```yaml
models:
  - id: "custom-forecast"
    label: "Custom forecast adapter"
    backend: custom
    library_path: "../my-model-package/src"
    adapter_class: "my_pkg.playground:MyForecastAdapter"
    model_path: "/models/custom"
    preload: false
```

custom adapter는 `load(config)`, `forecast(request)`, `info()` 메서드를 구현하면 된다. `forecast()`는 `ForecastResponse` 또는 같은 shape의 dict를 반환할 수 있다.

## Context 선택

Forecast UI는 입력 시계열 전체(`Full`), 마지막 N개(`Last N`), 또는 0-based `[start, end)` 구간(`Range`)을 context로 보낼 수 있다. `Range` 모드에서는 숫자 입력과 입력 차트 선택이 같은 `start_index`/`end_index` 요청 메타데이터로 정규화된다. Quantiles는 직접 입력 대신 80%/90%/60% band와 median-only preset 중에서 선택한다. `Target column`은 adapter 내부 dataframe 컬럼명이라 일반 입력 흐름에서는 기본값 `value`를 그대로 쓴다.

`Range` context가 원본 시계열의 중간까지만 사용되면, 결과 차트는 forecast horizon과 겹치는 이후 실제값을 `GT` trace로 함께 표시한다. 이 trace는 모델 요청에는 포함되지 않은 holdout 구간이며, raw JSON 응답은 backend 결과 그대로 유지된다.

## Input Series 패널

입력 패널은 source toolbar, add/edit drawer, series manager, preview chart로 나뉜다. `New`는 수동 입력 drawer를 열고, `Paste`/`Upload`/`Wave`는 시리즈를 바로 추가한다.

입력 시계열은 리스트의 `Edit` 버튼으로 이름과 값을 다시 편집할 수 있다. drawer의 `Text` 모드는 숫자 값을 직접 편집하고, `Draw` 모드는 지정한 length/min/max 기준으로 그린 선을 numeric values로 resample해 같은 textarea draft에 반영한다. 기존 draft 길이와 draw length가 같으면 `Whole`도 stroke가 지나간 index만 patch하므로 점 하나는 가까운 index 하나만 바꾼다. `Focus` scope는 전체 series overview에서 brush로 수정 구간을 고르고, 확대된 edit canvas에 다시 그린 값만 해당 `[start, end)` span 안에서 patch한다. Start/End 입력은 정밀 보정용 fallback이며, 실제 series 변경은 `Save Series`에서만 확정된다. 값 개수가 유지되는 편집은 업로드에서 온 timestamp를 보존하고, 길이가 바뀌면 timestamp를 제거해 값/시간축 불일치를 피한다.

## API 요약

| Method | Path | 용도 |
|---|---|---|
| `GET` | `/api/health` | 헬스체크 |
| `GET` | `/api/info` | 현재 session의 backend/model 상태 |
| `GET` | `/api/models` | 선택 가능한 모델 목록 |
| `POST` | `/api/switch` | 현재 session의 모델 선택 |
| `POST` | `/api/parse-file` | 업로드 파일을 시계열 후보로 파싱 |
| `POST` | `/api/forecast` | 예측 실행 |

## 테스트

```bash
uv run pytest tests/ -q
node --test tests_js/*.test.js
uv run ruff check .
```

테스트는 실제 Chronos-2/TimesFM 모델을 로드하지 않고 `fake` backend만 사용한다.
