from __future__ import annotations

import io

import numpy as np
import pytest

from tsfm_playground.ts_parsing import FileParseError, parse_upload


def test_parse_json_flat_list():
    parsed = parse_upload("series.json", b"[1, 2, 3]")
    assert parsed == [{"name": "series_0", "values": [1.0, 2.0, 3.0]}]


def test_parse_json_object_candidates_with_timestamps():
    parsed = parse_upload(
        "series.json",
        b'{"timestamps": ["a", "b"], "target": [1, 2], "other": [3, 4]}',
    )
    assert parsed == [{"name": "target", "values": [1.0, 2.0]}]


def test_parse_csv_numeric_columns():
    parsed = parse_upload("series.csv", b"date,y,z\n2026-01-01,1,10\n2026-01-02,2,20\n")
    assert parsed == [
        {"name": "y", "values": [1.0, 2.0]},
        {"name": "z", "values": [10.0, 20.0]},
    ]


def test_parse_txt_values():
    parsed = parse_upload("series.txt", b"1, 2 3\n4")
    assert parsed == [{"name": "series_0", "values": [1.0, 2.0, 3.0, 4.0]}]


def test_parse_npy_rows():
    buf = io.BytesIO()
    np.save(buf, np.array([[1, 2], [3, 4]], dtype=float))
    parsed = parse_upload("series.npy", buf.getvalue())
    assert parsed == [
        {"name": "series_0", "values": [1.0, 2.0]},
        {"name": "series_1", "values": [3.0, 4.0]},
    ]


@pytest.mark.parametrize(
    ("filename", "data"),
    [
        ("series.json", b"[1, Infinity]"),
        ("series.txt", b"1 inf"),
    ],
)
def test_parse_rejects_non_finite_values(filename: str, data: bytes):
    with pytest.raises(FileParseError, match="finite"):
        parse_upload(filename, data)


def test_parse_npy_rejects_non_finite_values():
    buf = io.BytesIO()
    np.save(buf, np.array([1.0, np.nan], dtype=float))

    with pytest.raises(FileParseError, match="finite"):
        parse_upload("series.npy", buf.getvalue())


def test_parse_unsupported_extension():
    with pytest.raises(FileParseError, match="Unsupported"):
        parse_upload("series.parquet", b"nope")
