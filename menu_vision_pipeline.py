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
import mimetypes
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse
from typing import Any, Dict, List, Optional

os.environ.setdefault("GOOGLE_CLOUD_DISABLE_GRPC_ALTS", "true")

import google.generativeai as genai
import requests
from openai import OpenAI
try:
    from PIL import Image, ImageOps, UnidentifiedImageError
except ImportError:  # pragma: no cover
    Image = None  # type: ignore
    ImageOps = None  # type: ignore

    class UnidentifiedImageError(Exception):
        """Fallback Pillow error placeholder."""


MENU_EXTRACTION_PROMPT = (
    "You are a Michelin-star menu curator. Given a menu photo, list every distinct dish, drink, or offering. "
    "For each item provide the name, the price text exactly as printed (keep currency symbols or use `N/A` if absent), "
    "and a concise one-sentence description summarizing key details. Output strict JSON matching "
    "{\"items\": [{\"name\": \"string\", \"price\": \"string\", \"description\": \"string\"}]} without extra commentary."
)

IMAGE_STYLE_GUIDANCE = (
    "Highly appetizing studio photography, natural lighting, shallow depth of field, "
    "served on restaurant-quality plating."
)

DEFAULT_TEXT_MODEL = "gemini-2.5-flash"
FLASH_LITE_MODEL = "gemini-2.5-flash-lite"

GEMINI_IMAGE_PROVIDER = "gemini_imagen"
FAL_IMAGE_PROVIDER = "fal_flux_krea"
DEFAULT_IMAGE_PROVIDER = FAL_IMAGE_PROVIDER
DEFAULT_FAL_MODEL = "fal-ai/flux/krea"
DEFAULT_FAL_IMAGE_SIZE = "square_hd"
MAX_IMAGE_DIMENSION = 3072
OPENAI_MODEL = "gpt-5-mini"

_openai_client: OpenAI | None = None


def get_openai_client() -> OpenAI:
    global _openai_client
    if _openai_client is None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError(
                "OpenAI API key missing. Set OPENAI_API_KEY env var or pass via configuration."
            )
        _openai_client = OpenAI(api_key=api_key)
    return _openai_client


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


def prepare_menu_payload(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"Menu image not found: {path}")

    mime_guess, _ = mimetypes.guess_type(path.name)

    if Image is None:
        data = path.read_bytes()
        return {"mime_type": mime_guess or "image/jpeg", "data": data}

    try:
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img)
            if max(img.size) > MAX_IMAGE_DIMENSION:
                ratio = MAX_IMAGE_DIMENSION / max(img.size)
                new_size = (
                    max(1, int(img.width * ratio)),
                    max(1, int(img.height * ratio)),
                )
                img = img.resize(new_size, Image.LANCZOS)
            img = img.convert("RGB")
            try:
                img = ImageOps.autocontrast(img, cutoff=1)
            except Exception:
                pass
            buffer = BytesIO()
            img.save(buffer, format="JPEG", quality=92)
            data = buffer.getvalue()
        return {"mime_type": "image/jpeg", "data": data}
    except UnidentifiedImageError:
        data = path.read_bytes()
        return {"mime_type": mime_guess or "application/octet-stream", "data": data}


def extract_menu_items(menu_content: Dict[str, Any], model_name: str = DEFAULT_TEXT_MODEL) -> List[Dict[str, str]]:  # noqa: ARG001
    client = get_openai_client()

    image_b64 = base64.b64encode(menu_content["data"]).decode("ascii")
    data_url = f"data:{menu_content['mime_type']};base64,{image_b64}"

    response = client.responses.create(
        model=OPENAI_MODEL,
        input=[
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": MENU_EXTRACTION_PROMPT},
                    {"type": "input_image", "image_url": data_url},
                ],
            }
        ],
        max_output_tokens=4096,
        reasoning={"effort": "low"},
    )

    if getattr(response, "status", "completed") != "completed":
        raise MenuExtractionError(
            f"OpenAI response incomplete (status={response.status}). Try retaking the photo."
        )

    raw_text: Optional[str] = getattr(response, "output_text", None)
    if not raw_text:
        raise MenuExtractionError("OpenAI did not return any text for the menu image.")

    raw_text = raw_text.strip()
    if raw_text.startswith("```"):
        raw_text = raw_text.strip("`")
        if raw_text.lower().startswith("json"):
            raw_text = raw_text.split("\n", 1)[-1]

    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError:
        snippet = raw_text
        start = raw_text.find("{")
        end = raw_text.rfind("}")
        if start != -1 and end != -1:
            snippet = raw_text[start : end + 1]
        try:
            payload = json.loads(snippet)
        except json.JSONDecodeError as exc:
            raise MenuExtractionError(
                f"Failed to decode OpenAI JSON: {exc}\nRaw response: {raw_text}"
            ) from exc

    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise MenuExtractionError("No menu items detected in OpenAI response.")

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

    menu_payload = prepare_menu_payload(menu_path)
    items = extract_menu_items(menu_payload, model_name=text_model)

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
