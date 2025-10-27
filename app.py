from __future__ import annotations

import json
import os
import uuid
import shutil
from pathlib import Path
from typing import List, Dict, Any

from flask import Flask, render_template, request, url_for, jsonify
from flask_cors import CORS
from werkzeug.utils import secure_filename

from menu_vision_pipeline import (
    process_menu,
    DEFAULT_TEXT_MODEL,
    DEFAULT_IMAGE_PROVIDER,
    DEFAULT_FAL_MODEL,
    DEFAULT_FAL_IMAGE_SIZE,
    generate_item_image,
    ImageGenerationError,
    MenuExtractionError,
)

BASE_DIR = Path(__file__).parent.resolve()
STATIC_ROOT = BASE_DIR / "static"
UPLOAD_ROOT = STATIC_ROOT / "uploads"
OUTPUT_ROOT = STATIC_ROOT / "generated"

for directory in (UPLOAD_ROOT, OUTPUT_ROOT):
    directory.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "heic", "webp"}
MAX_FILES = 10

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-key")
CORS(app, resources={r"/api/*": {"origins": os.getenv("FRONTEND_ORIGIN", "*")}})

IMAGE_MODEL_DEFAULT = "imagen-3.0"
IMAGE_FORMAT_DEFAULT = "png"
SESSION_METADATA_FILENAME = "session.json"


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def make_static_url(path: Path) -> str:
    """Return a static URL for a filesystem path located under the static folder."""
    absolute_path = path if path.is_absolute() else (BASE_DIR / path)
    try:
        relative = absolute_path.resolve().relative_to(STATIC_ROOT.resolve())
    except ValueError:
        # Fallback to direct path reference; this should not happen when directories are configured correctly.
        return absolute_path.as_uri()
    return url_for("static", filename=str(relative).replace(os.sep, "/"))


def cleanup_session_directories(*directories: Path) -> None:
    for directory in directories:
        shutil.rmtree(directory, ignore_errors=True)


def session_metadata_path(session_id: str) -> Path:
    return OUTPUT_ROOT / session_id / SESSION_METADATA_FILENAME


def load_session_metadata(session_id: str) -> Dict[str, Any] | None:
    path = session_metadata_path(session_id)
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None


def save_session_metadata(session_id: str, payload: Dict[str, Any]) -> None:
    path = session_metadata_path(session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)


def update_page_metadata(output_dir_rel: str, items: List[Dict[str, Any]], menu_source: str) -> None:
    page_dir = STATIC_ROOT / output_dir_rel
    metadata_path = page_dir / "menu_items.json"
    page_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "menu_source": menu_source,
        "items": items,
    }
    with open(metadata_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)


def update_page_item_image(output_dir_rel: str, item_id: str, image_path_rel: str) -> None:
    metadata_path = STATIC_ROOT / output_dir_rel / "menu_items.json"
    if not metadata_path.exists():
        return
    try:
        with open(metadata_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return
    items = data.get("items", [])
    for entry in items:
        if entry.get("id") == item_id:
            entry["image_path"] = image_path_rel
            break
    try:
        with open(metadata_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
    except OSError:
        pass


def process_uploaded_files(files):
    valid_files = [f for f in files if f and f.filename]

    if not valid_files:
        return {"error": "Please select at least one image file."}
    if len(valid_files) > MAX_FILES:
        return {"error": f"You can upload a maximum of {MAX_FILES} menu pages per run."}

    session_id = uuid.uuid4().hex[:8]
    upload_dir = UPLOAD_ROOT / session_id
    output_base_dir = OUTPUT_ROOT / session_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    output_base_dir.mkdir(parents=True, exist_ok=True)

    uploaded_pages: List[Dict[str, str]] = []
    menu_items: List[Dict[str, Any]] = []
    session_metadata: Dict[str, Any] = {
        "session_id": session_id,
        "image_provider": DEFAULT_IMAGE_PROVIDER,
        "image_model": IMAGE_MODEL_DEFAULT,
        "image_format": IMAGE_FORMAT_DEFAULT,
        "fal_model": DEFAULT_FAL_MODEL,
        "fal_image_size": DEFAULT_FAL_IMAGE_SIZE,
        "items": [],
    }

    try:
        for index, storage_file in enumerate(valid_files, start=1):
            filename = secure_filename(storage_file.filename)
            if not filename:
                filename = f"menu_page_{index}.jpg"
            if not allowed_file(filename):
                raise ValueError(f"Unsupported file type for {storage_file.filename}.")

            saved_path = upload_dir / filename
            storage_file.save(saved_path)

            uploaded_pages.append(
                {
                    "name": storage_file.filename,
                    "url": make_static_url(saved_path),
                    "page": index,
                }
            )

            page_output_dir = output_base_dir / f"page_{index:02d}"
            page_output_dir.mkdir(parents=True, exist_ok=True)
            output_dir_rel = str(page_output_dir.resolve().relative_to(STATIC_ROOT.resolve()))

            result = process_menu(
                menu_path=saved_path,
                output_dir=page_output_dir,
                api_key=os.getenv("GEMINI_API_KEY"),
                text_model=DEFAULT_TEXT_MODEL,
                image_provider=DEFAULT_IMAGE_PROVIDER,
                image_model=IMAGE_MODEL_DEFAULT,
                image_format=IMAGE_FORMAT_DEFAULT,
                fal_api_key=os.getenv("FAL_KEY"),
                fal_model=DEFAULT_FAL_MODEL,
                fal_image_size=DEFAULT_FAL_IMAGE_SIZE,
                max_workers=1,
                generate_images=False,
            )

            page_items_metadata: List[Dict[str, Any]] = []

            for item_idx, item in enumerate(result.get("items", []), start=1):
                item_id = f"{session_id}-p{index:02d}-i{item_idx:02d}"
                name = item.get("name", "Unnamed Item")
                price = item.get("price", "N/A")
                description = item.get("description", "")

                session_metadata["items"].append(
                    {
                        "id": item_id,
                        "name": name,
                        "price": price,
                        "description": description,
                        "page": index,
                        "sequence": item_idx,
                        "output_dir": output_dir_rel,
                        "image_path": None,
                    }
                )

                page_items_metadata.append(
                    {
                        "id": item_id,
                        "name": name,
                        "price": price,
                        "description": description,
                        "page": index,
                        "sequence": item_idx,
                        "image_path": None,
                    }
                )

                menu_items.append(
                    {
                        "id": item_id,
                        "name": name,
                        "price": price,
                        "description": description,
                        "image_url": None,
                        "imageStatus": "pending",
                        "page": index,
                    }
                )

            update_page_metadata(
                output_dir_rel=output_dir_rel,
                items=page_items_metadata,
                menu_source=str(saved_path),
            )

        save_session_metadata(session_id, session_metadata)

    except MenuExtractionError:
        cleanup_session_directories(upload_dir, output_base_dir)
        return {
            "error": "Gemini could not extract structured items from the menu. "
            "Try retaking the photo with better lighting or upload a different page."
        }
    except Exception as exc:  # pylint: disable=broad-except
        cleanup_session_directories(upload_dir, output_base_dir)
        return {"error": str(exc)}

    return {
        "session_id": session_id,
        "pages": uploaded_pages,
        "items": menu_items,
    }


@app.route("/", methods=["GET", "POST"])
def index():
    error_message: str | None = None
    menu_items: List[Dict[str, Any]] = []
    uploaded_pages: List[Dict[str, str]] = []

    if request.method == "POST":
        processing = process_uploaded_files(request.files.getlist("menu_images"))
        error_message = processing.get("error")
        if not error_message:
            uploaded_pages = processing["pages"]
            menu_items = processing["items"]

    return render_template(
        "index.html",
        error_message=error_message,
        uploaded_pages=uploaded_pages,
        menu_items=menu_items,
    )


@app.route("/api/process", methods=["POST"])
def api_process_menu():
    processing = process_uploaded_files(request.files.getlist("menu_images"))
    error_message = processing.get("error")
    if error_message:
        return jsonify({"error": error_message}), 400

    return jsonify(
        {
            "sessionId": processing["session_id"],
            "pages": processing["pages"],
            "items": processing["items"],
        }
    )


@app.route("/api/generate-image", methods=["POST"])
def api_generate_image():
    payload = request.get_json(silent=True) or {}
    session_id = payload.get("sessionId")
    item_id = payload.get("itemId")

    if not session_id or not item_id:
        return jsonify({"error": "sessionId and itemId are required."}), 400

    metadata = load_session_metadata(session_id)
    if not metadata:
        return jsonify({"error": "Session not found."}), 404

    items = metadata.get("items", [])
    target = next((item for item in items if item.get("id") == item_id), None)
    if target is None:
        return jsonify({"error": "Item not found in session."}), 404

    existing_relative = target.get("image_path")
    if existing_relative:
        existing_path = STATIC_ROOT / existing_relative
        if existing_path.exists():
            return jsonify(
                {
                    "itemId": item_id,
                    "imageUrl": make_static_url(existing_path),
                    "status": "ready",
                }
            )

    output_dir_rel = target.get("output_dir")
    if not output_dir_rel:
        return jsonify({"error": "Output directory missing for item."}), 400

    output_dir = STATIC_ROOT / output_dir_rel
    output_dir.mkdir(parents=True, exist_ok=True)

    image_provider = metadata.get("image_provider", DEFAULT_IMAGE_PROVIDER)
    image_model = metadata.get("image_model", IMAGE_MODEL_DEFAULT)
    image_format = metadata.get("image_format", IMAGE_FORMAT_DEFAULT)
    fal_model = metadata.get("fal_model", DEFAULT_FAL_MODEL)
    fal_image_size = metadata.get("fal_image_size", DEFAULT_FAL_IMAGE_SIZE)

    fal_key = os.getenv("FAL_KEY", "")

    sequence = int(target.get("sequence") or 1)
    if sequence < 1:
        sequence = 1

    try:
        image_path = generate_item_image(
            item={
                "name": target.get("name", "Unnamed Item"),
                "description": target.get("description", ""),
                "price": target.get("price", "N/A"),
            },
            output_dir=output_dir,
            seq=sequence,
            image_provider=image_provider,
            image_format=image_format,
            gemini_model=image_model,
            fal_api_key=fal_key,
            fal_model=fal_model,
            fal_image_size=fal_image_size,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except ImageGenerationError as exc:
        return jsonify({"error": str(exc)}), 502

    relative_image_path = str(image_path.resolve().relative_to(STATIC_ROOT.resolve()))
    target["image_path"] = relative_image_path
    save_session_metadata(session_id, metadata)
    update_page_item_image(output_dir_rel, item_id, relative_image_path)

    return jsonify(
        {
            "itemId": item_id,
            "imageUrl": make_static_url(image_path),
            "status": "ready",
            "page": target.get("page"),
        }
    )


if __name__ == "__main__":
    app.run(debug=True)
