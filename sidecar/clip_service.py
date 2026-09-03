#!/usr/bin/env python3
"""Persistent line-delimited JSON-RPC service for Chinese-CLIP embeddings."""

from __future__ import annotations

import json
import os
import sys
import traceback
from contextlib import ExitStack
from pathlib import Path
from typing import Any, Iterable

MODEL_NAME = "OFA-Sys/chinese-clip-vit-base-patch16"
EMBEDDING_DIMENSIONS = 512


class ClipEncoder:
    def __init__(self) -> None:
        self._torch: Any | None = None
        self._model: Any | None = None
        self._processor: Any | None = None
        self._device = "mps"
        self._text_cache: dict[str, list[float]] = {}

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def device(self) -> str:
        return self._device

    def _load(self) -> None:
        if self.loaded:
            return

        import torch
        from transformers import ChineseCLIPModel, ChineseCLIPProcessor

        requested_device = os.environ.get("TRIPCUT_CLIP_DEVICE", "mps").strip().lower()
        if requested_device != "mps":
            raise RuntimeError(
                "TRIPCUT_CLIP_DEVICE must be 'mps'; P2-C2 does not support the ONNX/CPU path"
            )
        if not torch.backends.mps.is_available():
            raise RuntimeError("PyTorch MPS is unavailable on this Mac")

        model_directory = os.environ.get("TRIPCUT_CLIP_MODEL_DIR", "").strip()
        if not model_directory:
            raise RuntimeError(
                "TRIPCUT_CLIP_MODEL_DIR must point to a verified local Chinese-CLIP model"
            )
        model_path = Path(model_directory).expanduser().resolve(strict=True)
        if not model_path.is_dir():
            raise RuntimeError("TRIPCUT_CLIP_MODEL_DIR is not a directory")
        model = ChineseCLIPModel.from_pretrained(str(model_path), local_files_only=True)
        processor = ChineseCLIPProcessor.from_pretrained(str(model_path), local_files_only=True)
        model.to(requested_device)
        model.eval()

        self._torch = torch
        self._model = model
        self._processor = processor
        self._device = requested_device

    def embed_text(self, query: str) -> list[float]:
        return self._embed_texts([query])[0]

    def _embed_texts(self, queries: list[str]) -> list[list[float]]:
        self._load()
        assert self._torch is not None
        assert self._model is not None
        assert self._processor is not None

        missing = list(dict.fromkeys(query for query in queries if query not in self._text_cache))
        if missing:
            with self._torch.no_grad():
                inputs = self._processor(text=missing, padding=True, return_tensors="pt").to(
                    self._device
                )
                features = _feature_tensor(self._model.get_text_features(**inputs))
                features = _normalize_rows(features)
                if self._device == "mps":
                    self._torch.mps.synchronize()
            rows = features.detach().float().cpu().tolist()
            for query, row in zip(missing, rows):
                self._text_cache[query] = _validated_vector(row)
        return [self._text_cache[query] for query in queries]

    def embed_images(
        self, paths: list[str], strip_frame_count: int | None = None
    ) -> list[list[float]]:
        self._load()
        assert self._torch is not None
        assert self._model is not None
        assert self._processor is not None

        from PIL import Image

        if not paths:
            raise ValueError("paths must contain at least one image")
        if strip_frame_count is not None and len(paths) != 1:
            raise ValueError("strip_frame_count requires exactly one strip image path")

        with ExitStack() as stack:
            opened = [stack.enter_context(Image.open(path)).convert("RGB") for path in paths]
            images = (
                _crop_strip(opened[0], strip_frame_count)
                if strip_frame_count is not None
                else opened
            )
            with self._torch.no_grad():
                inputs = self._processor(images=images, return_tensors="pt").to(self._device)
                features = _feature_tensor(self._model.get_image_features(**inputs))
                features = _normalize_rows(features)
                if self._device == "mps":
                    self._torch.mps.synchronize()
            rows = features.detach().float().cpu().tolist()
        return [_validated_vector(row) for row in rows]

    def classify(
        self, image: str, dimension_prototypes: dict[str, list[str]]
    ) -> dict[str, float]:
        """Return mean cosine similarity for each label's Chinese prompt group."""
        image_vector = self.embed_images([image])[0]
        prompts = [
            prompt
            for label_prompts in dimension_prototypes.values()
            for prompt in label_prompts
        ]
        text_vectors = iter(self._embed_texts(prompts))
        scores: dict[str, float] = {}
        for label, label_prompts in dimension_prototypes.items():
            similarities = [
                sum(left * right for left, right in zip(image_vector, next(text_vectors)))
                for _ in label_prompts
            ]
            scores[label] = sum(similarities) / len(similarities)
        return scores


def _feature_tensor(output: Any) -> Any:
    pooler_output = getattr(output, "pooler_output", None)
    if pooler_output is not None:
        return pooler_output
    if hasattr(output, "ndim"):
        return output
    if isinstance(output, (tuple, list)) and output:
        return output[0]
    raise RuntimeError("Chinese-CLIP returned an unsupported feature object")


def _normalize_rows(features: Any) -> Any:
    return features / features.norm(p=2, dim=-1, keepdim=True).clamp_min(1e-12)


def _validated_vector(values: Iterable[Any]) -> list[float]:
    vector = [float(value) for value in values]
    if len(vector) != EMBEDDING_DIMENSIONS:
        raise RuntimeError(
            f"Chinese-CLIP returned {len(vector)} dimensions; expected {EMBEDDING_DIMENSIONS}"
        )
    if not all(value == value and abs(value) != float("inf") for value in vector):
        raise RuntimeError("Chinese-CLIP returned a non-finite embedding")
    return vector


def _crop_strip(image: Any, frame_count: int) -> list[Any]:
    if not isinstance(frame_count, int) or isinstance(frame_count, bool):
        raise ValueError("strip_frame_count must be an integer")
    if frame_count < 1 or frame_count > 12:
        raise ValueError("strip_frame_count must be between 1 and 12")
    width, height = image.size
    if width < frame_count or height < 1:
        raise ValueError("strip image dimensions are invalid for the requested frame count")

    frames = []
    for index in range(frame_count):
        left = round(index * width / frame_count)
        right = round((index + 1) * width / frame_count)
        frames.append(image.crop((left, 0, right, height)))
    return frames


def _require_object(params: Any) -> dict[str, Any]:
    if params is None:
        return {}
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    return params


def _require_prototypes(value: Any) -> dict[str, list[str]]:
    if not isinstance(value, dict) or not value:
        raise ValueError("dimension_prototypes must be a non-empty object")
    prototypes: dict[str, list[str]] = {}
    for label, prompts in value.items():
        if not isinstance(label, str) or not label.strip():
            raise ValueError("prototype labels must be non-empty strings")
        if (
            not isinstance(prompts, list)
            or not 1 <= len(prompts) <= 8
            or not all(isinstance(prompt, str) and prompt.strip() for prompt in prompts)
        ):
            raise ValueError("each prototype label must contain 1-8 non-empty prompts")
        prototypes[label.strip()] = [prompt.strip() for prompt in prompts]
    if len(prototypes) > 64:
        raise ValueError("dimension_prototypes must contain at most 64 labels")
    return prototypes


def dispatch(method: str, params: Any, encoder: ClipEncoder) -> Any:
    values = _require_object(params)
    if method == "ping":
        return {
            "status": "ok",
            "model": MODEL_NAME,
            "model_loaded": encoder.loaded,
            "device": encoder.device,
        }
    if method == "embed_text":
        query = values.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query must be a non-empty string")
        return encoder.embed_text(query.strip())
    if method == "embed_images":
        paths = values.get("paths")
        if not isinstance(paths, list) or not all(isinstance(path, str) for path in paths):
            raise ValueError("paths must be an array of strings")
        missing = [path for path in paths if not Path(path).is_file()]
        if missing:
            raise ValueError(f"image path does not exist: {missing[0]}")
        return encoder.embed_images(paths, values.get("strip_frame_count"))
    if method == "classify":
        image = values.get("image")
        if not isinstance(image, str) or not Path(image).is_file():
            raise ValueError("image must be an existing image path")
        prototypes = _require_prototypes(values.get("dimension_prototypes"))
        return encoder.classify(image, prototypes)
    raise LookupError(f"method not found: {method}")


def handle_request(request: Any, encoder: ClipEncoder) -> dict[str, Any]:
    request_id = request.get("id") if isinstance(request, dict) else None
    try:
        if not isinstance(request, dict):
            raise ValueError("request must be an object")
        if request.get("jsonrpc") != "2.0":
            raise ValueError("jsonrpc must be '2.0'")
        method = request.get("method")
        if not isinstance(method, str) or not method:
            raise ValueError("method must be a non-empty string")
        result = dispatch(method, request.get("params"), encoder)
        return {"jsonrpc": "2.0", "id": request_id, "result": result}
    except LookupError as error:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": str(error)},
        }
    except (TypeError, ValueError) as error:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32602, "message": str(error)},
        }
    except Exception as error:  # Keep one response per input line even on model failures.
        traceback.print_exc(file=sys.stderr)
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32000, "message": str(error)},
        }


def main() -> None:
    encoder = ClipEncoder()
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"invalid JSON: {error.msg}"},
            }
        else:
            response = handle_request(request, encoder)
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
