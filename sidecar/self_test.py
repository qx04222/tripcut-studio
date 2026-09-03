#!/usr/bin/env python3
"""Dependency-free protocol smoke test; it does not download model weights."""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory

from clip_service import ClipEncoder, handle_request


class FakeEncoder(ClipEncoder):
    def classify(
        self, image: str, dimension_prototypes: dict[str, list[str]]
    ) -> dict[str, float]:
        assert Path(image).is_file()
        return {label: 0.5 for label in dimension_prototypes}


def main() -> None:
    encoder = ClipEncoder()
    ping = handle_request(
        {"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}}, encoder
    )
    assert ping["id"] == 1
    assert ping["result"]["status"] == "ok"
    assert ping["result"]["model_loaded"] is False

    missing = handle_request(
        {"jsonrpc": "2.0", "id": 2, "method": "does_not_exist", "params": {}},
        encoder,
    )
    assert missing["id"] == 2
    assert missing["error"]["code"] == -32601

    with TemporaryDirectory() as directory:
        image = Path(directory) / "cover.jpg"
        image.touch()
        classified = handle_request(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "classify",
                "params": {
                    "image": str(image),
                    "dimension_prototypes": {
                        "subject::人": ["以人物为主要主体"],
                        "subject::风景": ["自然风景和户外景观"],
                    },
                },
            },
            FakeEncoder(),
        )
        assert classified["result"] == {"subject::人": 0.5, "subject::风景": 0.5}

    invalid = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "classify",
            "params": {"image": "/missing.jpg", "dimension_prototypes": {}},
        },
        encoder,
    )
    assert invalid["error"]["code"] == -32602
    print("clip_service protocol self-test: ok")


if __name__ == "__main__":
    main()
