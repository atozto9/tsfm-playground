"""Parse uploaded files into one-or-more time series candidates."""

from __future__ import annotations

import csv
import io
import json
import math
from pathlib import PurePosixPath
from typing import Any

import numpy as np


class FileParseError(ValueError):
    """Raised when an uploaded file cannot be interpreted as time series."""


def parse_upload(filename: str, data: bytes) -> list[dict[str, Any]]:
    """Dispatch based on file extension. Returns list of {name, values}."""
    suffix = PurePosixPath(filename).suffix.lower()
    if suffix == ".json":
        return _parse_json(data)
    if suffix in {".csv", ".tsv"}:
        delimiter = "," if suffix == ".csv" else "\t"
        return _parse_csv(data, delimiter=delimiter)
    if suffix == ".npy":
        return _parse_npy(data)
    if suffix in {".txt", ""}:
        return _parse_txt(data)
    raise FileParseError(f"Unsupported file extension: {suffix or '<none>'}")


def _is_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return math.isfinite(float(value))
    return False


def _values_from_sequence(seq: list[Any]) -> list[float]:
    if not all(_is_number(value) for value in seq):
        raise FileParseError("Sequence contains non-finite numeric values.")
    return [float(value) for value in seq]


def _ensure_finite_values(values: list[float]) -> list[float]:
    if any(not math.isfinite(value) for value in values):
        raise FileParseError("Series values must be finite numbers.")
    return values


def _parse_json(data: bytes) -> list[dict[str, Any]]:
    try:
        obj = json.loads(data.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise FileParseError(f"Invalid JSON: {exc}") from exc

    if isinstance(obj, list) and obj and _is_number(obj[0]):
        return [{"name": "series_0", "values": _values_from_sequence(obj)}]

    if isinstance(obj, list) and obj and isinstance(obj[0], list):
        return [
            {"name": f"series_{index}", "values": _values_from_sequence(row)}
            for index, row in enumerate(obj)
        ]

    if isinstance(obj, dict):
        for key in ("values", "ts_values", "target"):
            value = obj.get(key)
            if isinstance(value, list) and value and _is_number(value[0]):
                return [{"name": key, "values": _values_from_sequence(value)}]
            if isinstance(value, list) and value and isinstance(value[0], list):
                return [
                    {"name": f"{key}_{index}", "values": _values_from_sequence(row)}
                    for index, row in enumerate(value)
                ]

        candidates: list[dict[str, Any]] = []
        timestamps = obj.get("timestamps")
        for key, value in obj.items():
            if isinstance(value, list) and value and _is_number(value[0]):
                item: dict[str, Any] = {"name": str(key), "values": _values_from_sequence(value)}
                if isinstance(timestamps, list) and len(timestamps) == len(item["values"]):
                    item["timestamps"] = [str(ts) for ts in timestamps]
                candidates.append(item)
        if candidates:
            return candidates

    raise FileParseError("JSON payload does not contain a recognizable time series.")


def _parse_csv(data: bytes, *, delimiter: str) -> list[dict[str, Any]]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise FileParseError(f"Could not decode CSV as UTF-8: {exc}") from exc

    rows = [
        row
        for row in csv.reader(io.StringIO(text), delimiter=delimiter)
        if any(cell.strip() for cell in row)
    ]
    if not rows:
        raise FileParseError("Empty CSV file.")

    first = rows[0]
    has_header = not all(_is_floatable(cell) for cell in first)
    if has_header:
        headers = [cell.strip() or f"col_{index}" for index, cell in enumerate(first)]
        body = rows[1:]
    else:
        headers = [f"col_{index}" for index in range(len(first))]
        body = rows

    if not body:
        raise FileParseError("CSV file has no data rows.")

    columns: list[list[float]] = [[] for _ in headers]
    column_is_numeric = [True for _ in headers]
    for row in body:
        for index in range(len(headers)):
            cell = row[index].strip() if index < len(row) else ""
            if not cell or not _is_floatable(cell):
                column_is_numeric[index] = False
                continue
            columns[index].append(float(cell))

    out = []
    for index, name in enumerate(headers):
        if column_is_numeric[index] and columns[index]:
            out.append({"name": name, "values": columns[index]})
    if not out:
        raise FileParseError("CSV file has no numeric columns.")
    return out


def _is_floatable(cell: str) -> bool:
    cell = cell.strip()
    if not cell:
        return False
    try:
        value = float(cell)
    except ValueError:
        return False
    return math.isfinite(value)


def _parse_npy(data: bytes) -> list[dict[str, Any]]:
    try:
        arr = np.load(io.BytesIO(data), allow_pickle=False)
    except ValueError as exc:
        raise FileParseError(f"Invalid .npy file: {exc}") from exc

    arr = np.asarray(arr)
    if arr.ndim == 1:
        values = _ensure_finite_values([float(value) for value in arr.tolist()])
        return [{"name": "series_0", "values": values}]
    if arr.ndim == 2:
        rows, cols = arr.shape
        if rows > cols * 4 and cols > 1:
            arr = arr.T
            rows, _cols = arr.shape
        return [
            {
                "name": f"series_{index}",
                "values": _ensure_finite_values(
                    [float(value) for value in arr[index].tolist()]
                ),
            }
            for index in range(rows)
        ]
    raise FileParseError(f"Unsupported .npy rank: {arr.ndim}")


def _parse_txt(data: bytes) -> list[dict[str, Any]]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise FileParseError(f"Could not decode TXT as UTF-8: {exc}") from exc

    tokens = text.replace(",", " ").split()
    if not tokens:
        raise FileParseError("Empty TXT file.")
    try:
        values = [float(token) for token in tokens]
    except ValueError as exc:
        raise FileParseError(f"Non-numeric token in TXT: {exc}") from exc
    return [{"name": "series_0", "values": _ensure_finite_values(values)}]
