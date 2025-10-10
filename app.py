from __future__ import annotations

import os
import uuid
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
        if not directory.exists():
            continue
        for file_path in directory.glob("**/*"):
            if file_path.is_file():
                file_path.unlink(missing_ok=True)
        for nested_dir in sorted(directory.glob("**"), reverse=True):
            if nested_dir.is_dir():
                nested_dir.rmdir()
        directory.rmdir()


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
                max_workers=4,
            )

            for item in result.get("items", []):
                image_path = Path(item.get("image_path", ""))
                image_url = make_static_url(image_path)
                menu_items.append(
                    {
                        "name": item.get("name", "Unnamed Item"),
                        "price": item.get("price", "N/A"),
                        "description": item.get("description", ""),
                        "image_url": image_url,
                        "page": index,
                    }
                )

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


if __name__ == "__main__":
    app.run(debug=True)
