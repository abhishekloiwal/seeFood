# SeeFood Backend & Web Frontend Status

## Completed Work
- Implemented an end-to-end menu digitization pipeline (`menu_vision_pipeline.py`) that now relies on OpenAI `gpt-5-mini` for multimodal text extraction and FAL Flux/Krea for dish image generation, with Pillow-based preprocessing to normalize uploads.
- Hardened the Flask backend (`app.py`) with multi-page uploads, session-scoped storage, structured JSON API at `/api/process`, and CORS support for a separate frontend origin.
- Added local assets and utilities (`static/`, `test_images/`) plus updated environment handling so `.env` values are auto-loaded and `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `FAL_KEY` are required as appropriate.
- Deployed the backend to Railway (`https://web-production-b6dfc.up.railway.app/`) using Gunicorn via `Procfile`, confirmed health checks, and validated the API against test menus including degraded image samples.
- Created a Vite + React web frontend (`frontend/`) that supports multi-page uploads, displays generated menu cards, and can be pointed at local or Railway backends through `VITE_API_BASE_URL` in `frontend/.env.local`.
- Version control is synced to GitHub (`abhishekloiwal/seeFood`, branch `main` @ `b44c1a1`) with the current deployment reflecting these changes.

## Running Locally
- Backend: `python -m venv venv && source venv/bin/activate && pip install -r requirements.txt && FLASK_ENV=development OPENAI_API_KEY=... GEMINI_API_KEY=... FAL_KEY=... python app.py`
- Frontend: `cd frontend && npm install && echo "VITE_API_BASE_URL=http://127.0.0.1:5000" > .env.local && npm run dev`

## Next Steps
1. Stand up a dedicated mobile-focused front-end (React Native or Expo) that mirrors the web UX: multi-page image upload (camera & library), progress feedback, and a grid/list of generated menu cards.
2. Abstract the API client into a shared module (fetch wrapper with retries + error states) and ensure it targets the Railway deployment by default, with easy overrides for local debugging.
3. Implement authentication-safe handling for API keys on mobile (e.g., proxy upload through backend rather than storing secrets on-device) and document required environment variables for mobile builds.
4. Enhance backend responses for edge cases (e.g., clarify OpenAI failure messaging, include per-item status) and consider lightweight telemetry/logging suitable for production monitoring on Railway.
