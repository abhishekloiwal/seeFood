#!/usr/bin/env python3
"""
End-to-end Gemini menu digitizer and image generator.

Given a menu image, the script:
  1. Extracts structured menu items (name + one-line description).
  2. Generates an illustrative image for each menu entry.
  3. Saves JSON metadata and image assets locally.

Requirements:
  pip install google-generativeai requests

Environment:
  GEMINI_API_KEY must be defined or provided via --api-key.
  Use --flash-lite to target gemini-2.0-flash-lite.
  FAL_KEY may be set (or pass --fal-api-key) when using FAL image generation.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import base64
from pathlib import Path
from urllib.parse import urlparse
from typing import Any, Dict, List

os.environ.setdefault("GOOGLE_CLOUD_DISABLE_GRPC_ALTS", "true")

import google.generativeai as genai
import requests


MENU_EXTRACTION_PROMPT = (
    "You are a Michelin-star menu curator. You will receive an image of a menu. "
    "Extract every distinct menu listing including its name, price or cost (include the currency symbol "
    "or numeric value exactly as shown), and a concise one-sentence description no longer than 30 words. "
    "If the menu already supplies a description, summarize it to a single sentence."
    "Return strict JSON matching this schema: "
    '{"items": [{"name": "string", "price": "string", "description": "string"}]}.'
)

IMAGE_STYLE_GUIDANCE = (
    "Highly appetizing studio photography, natural lighting, shallow depth of field, "
    "served on restaurant-quality plating."
)

_FINISH_REASON_LABELS = {
    0: "STOP",
    1: "MAX_TOKENS",
    2: "SAFETY",
    3: "RECITATION",
    4: "OTHER",
    5: "BLOCKLIST",
    6: "PROHIBITED_CONTENT",
    7: "SPII",
}


def _normalize_finish_reason(value: Any) -> str:
    if value is None:
        return "UNKNOWN"
    if isinstance(value, str):
        return value.upper()
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        return str(value)
    return _FINISH_REASON_LABELS.get(numeric, str(numeric))

DEFAULT_TEXT_MODEL = "gemini-2.5-flash"
FLASH_LITE_MODEL = "gemini-2.5-flash-lite"

GEMINI_IMAGE_PROVIDER = "gemini_imagen"
FAL_IMAGE_PROVIDER = "fal_flux_krea"
DEFAULT_IMAGE_PROVIDER = FAL_IMAGE_PROVIDER
DEFAULT_FAL_MODEL = "fal-ai/flux/krea"
DEFAULT_FAL_IMAGE_SIZE = "square_hd"


def load_env_file(env_path: Path = Path('.env')) -> None:
    if not env_path.exists():
        return
    try:
        raw_lines = env_path.read_text(encoding='utf-8').splitlines()
    except OSError:
        return
    for line in raw_lines:
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        if '=' not in stripped:
            continue
        key, value = stripped.split('=', 1)
        key = key.strip()
        value = value.strip().strip("\"").strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file()

class MenuExtractionError(RuntimeError):
    """Raised when menu parsing fails."""


class ImageGenerationError(RuntimeError):
    """Raised when image generation fails."""


def configure_client(api_key: str) -> None:
    if not api_key:
        raise ValueError(
            "Gemini API key missing. Set GEMINI_API_KEY env var or pass --api-key."
        )
    genai.configure(api_key=api_key)


def upload_menu_image(path: Path):
    if not path.exists():
        raise FileNotFoundError(f"Menu image not found: {path}")
    return genai.upload_file(path=path)


def extract_menu_items(menu_file, model_name: str = DEFAULT_TEXT_MODEL) -> List[Dict[str, str]]:
    model = genai.GenerativeModel(model_name=model_name)
    response = model.generate_content(
        [menu_file, MENU_EXTRACTION_PROMPT],
        generation_config=genai.GenerationConfig(
            response_mime_type="application/json",
            temperature=0.2,
            top_p=0.95,
            max_output_tokens=2048,
        ),
    )

    text_chunks: List[str] = []
    finish_reasons: List[str] = []

    for candidate in getattr(response, 'candidates', []) or []:
        finish_reasons.append(_normalize_finish_reason(getattr(candidate, 'finish_reason', None)))
        content = getattr(candidate, 'content', None)
        parts = getattr(content, 'parts', None) if content else None
        if not parts:
            continue
        for part in parts:
            chunk = getattr(part, 'text', None)
            if chunk:
                text_chunks.append(chunk)

    raw_text = ''.join(text_chunks).strip()
    if not raw_text:
        if finish_reasons:
            summary = ', '.join(sorted(set(finish_reasons)))
            raise MenuExtractionError(
                "Gemini halted the menu extraction (finish_reason="
                f"{summary}). Try retaking the photo with clearer lighting or "
                "capture each page head-on."
            )
        raise MenuExtractionError("Gemini did not return any JSON text.")
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise MenuExtractionError(f"Failed to decode Gemini JSON: {exc}\nRaw: {raw_text}") from exc

    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise MenuExtractionError("No menu items detected in Gemini response.")

    cleaned_items: List[Dict[str, str]] = []
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        price = str(item.get("price") or "").strip()
        description = str(item.get("description") or "").strip()
        if not name:
            continue
        if not price:
            price = "N/A"
        if not description:
            description = f"A signature dish named {name}."
        cleaned_items.append({"name": name, "price": price, "description": description})

    if not cleaned_items:
        raise MenuExtractionError("All menu entries were empty after cleaning.")

    return cleaned_items


def sanitize_filename(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text or "menu-item"


def build_dish_prompt(item: Dict[str, str]) -> str:
    return f"{item['name']} — {item['description']}. {IMAGE_STYLE_GUIDANCE}"


def generate_image_with_gemini(prompt: str, model_name: str) -> bytes:
    image_model = genai.ImageGenerationModel(model_name=model_name)
    result = image_model.generate_images(
        prompt=prompt,
        number_of_images=1,
    )
    if not result.images:
        raise ImageGenerationError("No image returned from Gemini Imagen.")
    image = result.images[0]
    image_data = getattr(image, 'image_bytes', None)
    if image_data is None:
        raise ImageGenerationError("Image payload missing from Gemini response.")
    if isinstance(image_data, str):
        image_bytes = base64.b64decode(image_data)
    else:
        image_bytes = image_data
    if not image_bytes:
        raise ImageGenerationError("Empty image payload from Gemini.")
    return image_bytes


def generate_image_with_fal(
    prompt: str,
    fal_api_key: str,
    fal_model: str,
    fal_image_size: str,
) -> tuple[bytes, str | None]:
    if not fal_api_key:
        raise ValueError("FAL API key missing. Set FAL_KEY or pass --fal-api-key.")
    endpoint = fal_model.strip("/")
    url = f"https://fal.run/{endpoint}"
    headers = {
        "Authorization": f"Key {fal_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "prompt": prompt,
        "image_size": fal_image_size,
        "num_images": 1,
    }
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=120)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise ImageGenerationError(f"FAL request failed: {exc}") from exc
    try:
        data = response.json()
    except ValueError as exc:
        raise ImageGenerationError("FAL returned non-JSON payload.") from exc
    images = (
        data.get("images")
        or data.get("output", {}).get("images")
        or data.get("data", {}).get("images")
    )
    if not images:
        raise ImageGenerationError("FAL response did not include any images.")
    image_entry = images[0]
    image_url = image_entry.get("url") or image_entry.get("image_url") or image_entry.get("href")
    base64_blob = image_entry.get("base64") or image_entry.get("b64_json")
    ext_hint = None
    image_bytes: bytes | None = None
    if image_url:
        parsed = urlparse(image_url)
        ext_hint = Path(parsed.path).suffix.lower().lstrip(".") or None
    if base64_blob:
        try:
            image_bytes = base64.b64decode(base64_blob)
        except (TypeError, ValueError) as exc:
            raise ImageGenerationError("Failed to decode base64 image from FAL.") from exc
    elif image_url:
        try:
            download = requests.get(image_url, timeout=120)
            download.raise_for_status()
        except requests.RequestException as exc:
            raise ImageGenerationError(f"Failed to download FAL image: {exc}") from exc
        image_bytes = download.content
        if not ext_hint:
            content_type = download.headers.get("Content-Type", "")
            if "png" in content_type:
                ext_hint = "png"
            elif "jpeg" in content_type or "jpg" in content_type:
                ext_hint = "jpg"
    if not image_bytes:
        raise ImageGenerationError("FAL image payload was empty.")
    return image_bytes, ext_hint


def generate_item_image(
    item: Dict[str, str],
    output_dir: Path,
    seq: int,
    image_provider: str,
    image_format: str,
    gemini_model: str,
    fal_api_key: str,
    fal_model: str,
    fal_image_size: str,
) -> Path:
    prompt = build_dish_prompt(item)
    provider_key = image_provider.lower()
    ext_hint: str | None = None
    if provider_key == GEMINI_IMAGE_PROVIDER:
        image_bytes = generate_image_with_gemini(prompt, gemini_model)
        extension = image_format.lower()
    elif provider_key == FAL_IMAGE_PROVIDER:
        image_bytes, ext_hint = generate_image_with_fal(prompt, fal_api_key, fal_model, fal_image_size)
        extension = (ext_hint or image_format).lower()
    else:
        raise ValueError(f"Unsupported image provider: {image_provider}")
    extension = extension.lstrip(".")
    if extension in {"jpeg", "jpg"}:
        extension = "jpg"
    elif extension != "png" and ext_hint:
        extension = ext_hint
    if extension not in {"png", "jpg"}:
        extension = "png"
    image_filename = f"{seq:02d}-{sanitize_filename(item['name'])}.{extension}"
    image_path = output_dir / image_filename
    with open(image_path, "wb") as fh:
        fh.write(image_bytes)
    return image_path


def process_menu(
    menu_path: Path,
    output_dir: Path,
    api_key: str,
    text_model: str,
    image_provider: str,
    image_model: str,
    image_format: str,
    fal_api_key: str,
    fal_model: str,
    fal_image_size: str,
    max_workers: int,
) -> Dict[str, Any]:
    configure_client(api_key)

    if image_provider.lower() == FAL_IMAGE_PROVIDER and not fal_api_key:
        raise ValueError("FAL image generation selected but FAL API key is missing.")

    output_dir.mkdir(parents=True, exist_ok=True)

    menu_file = upload_menu_image(menu_path)
    try:
        items = extract_menu_items(menu_file, model_name=text_model)
    finally:
        try:
            genai.delete_file(menu_file)
        except Exception:
            pass

    metadata: Dict[str, Any] = {"menu_source": str(menu_path), "items": []}

    def worker(index: int, item_data: Dict[str, str]) -> Dict[str, Any]:
        image_path = generate_item_image(
            item=item_data,
            output_dir=output_dir,
            seq=index + 1,
            image_provider=image_provider,
            image_format=image_format,
            gemini_model=image_model,
            fal_api_key=fal_api_key,
            fal_model=fal_model,
            fal_image_size=fal_image_size,
        )
        return {**item_data, "image_path": str(image_path), "order": index}

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_index = {
            executor.submit(worker, idx, item): idx for idx, item in enumerate(items)
        }
        for future in concurrent.futures.as_completed(future_to_index):
            item_result = future.result()
            metadata["items"].append(item_result)

    metadata["items"].sort(key=lambda entry: entry.pop("order"))

    metadata_path = output_dir / "menu_items.json"
    with open(metadata_path, "w", encoding="utf-8") as fh:
        json.dump(metadata, fh, indent=2, ensure_ascii=False)

    return {"metadata_path": metadata_path, "items": metadata["items"]}


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Gemini-powered menu digitizer and illustrator")
    parser.add_argument("menu_image", type=Path, help="Path to the menu image file")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("menu_output"),
        help="Directory where generated assets are stored",
    )
    parser.add_argument(
        "--api-key",
        type=str,
        default=os.getenv("GEMINI_API_KEY"),
        help="Gemini API key (defaults to GEMINI_API_KEY env var)",
    )
    parser.add_argument(
        "--text-model",
        type=str,
        default=DEFAULT_TEXT_MODEL,
        help="Gemini model for menu extraction",
    )
    parser.add_argument(
        "--flash-lite",
        action="store_true",
        help=f"Shortcut for --text-model {FLASH_LITE_MODEL}",
    )
    parser.add_argument(
        "--image-provider",
        type=str,
        default=DEFAULT_IMAGE_PROVIDER,
        choices=(FAL_IMAGE_PROVIDER, GEMINI_IMAGE_PROVIDER),
        help="Image generation backend to use",
    )
    parser.add_argument(
        "--fal-api-key",
        type=str,
        default=os.getenv("FAL_KEY"),
        help="FAL API key (defaults to FAL_KEY env var)",
    )
    parser.add_argument(
        "--fal-model",
        type=str,
        default=DEFAULT_FAL_MODEL,
        help="FAL model identifier (used when --image-provider fal_flux_krea)",
    )
    parser.add_argument(
        "--fal-image-size",
        type=str,
        default=DEFAULT_FAL_IMAGE_SIZE,
        help="FAL image size preset (fal_flux_krea only)",
    )
    parser.add_argument(
        "--image-model",
        type=str,
        default="imagen-3.0",
        help="Imagen model for dish illustration",
    )
    parser.add_argument(
        "--image-format",
        type=str,
        default="png",
        choices=("png", "jpeg", "jpg"),
        help="Image format for generated dishes",
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        default=4,
        help="Maximum concurrent image generation requests",
    )
    args = parser.parse_args(argv)
    if args.flash_lite:
        args.text_model = FLASH_LITE_MODEL
    args.image_provider = args.image_provider.lower()
    args.image_format = args.image_format.lower()
    return args


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    try:
        result = process_menu(
            menu_path=args.menu_image,
            output_dir=args.output_dir,
            api_key=args.api_key,
            text_model=args.text_model,
            image_provider=args.image_provider,
            image_model=args.image_model,
            image_format=args.image_format,
            fal_api_key=args.fal_api_key,
            fal_model=args.fal_model,
            fal_image_size=args.fal_image_size,
            max_workers=args.max_workers,
        )
    except KeyboardInterrupt:
        print("Interrupted by user", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(f"Metadata saved to: {result['metadata_path']}")
    for item in result["items"]:
        price = item.get("price", "N/A")
        description = item.get("description", "")
        print(f"- {item['name']} ({price}) -> {item['image_path']}")
        if description:
            print(f"  Description: {description}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
