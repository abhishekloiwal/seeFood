# SeeFood Mobile (Expo)

React Native + Expo client for the SeeFood pipeline. The UI mirrors the web/mobile web front-ends: pick up to 10 menu images, stream them to the Flask backend, and render the generated cards.

## Prerequisites

- Node 18+ and npm (ships with Expo CLI).
- Expo CLI (`npm install -g expo-cli`) is optional; we rely on `npx expo`.
- Access to the SeeFood backend (Railway deploy or local Flask server).

## Environment

Set the backend URL via the public Expo env variable. Create a `.env` file in this directory or export it before starting Expo:

```bash
echo "EXPO_PUBLIC_API_BASE_URL=https://web-production-b6dfc.up.railway.app" > .env
```

Expo automatically inlines variables prefixed with `EXPO_PUBLIC_` and makes them available as `process.env.EXPO_PUBLIC_API_BASE_URL`.

## Install & Run

```bash
npm install
npx expo start    # or npm run ios / npm run android
```

The Metro dashboard will provide a QR code. Scan it with Expo Go, or press the on-screen shortcuts (`i`, `a`, or `w`) to launch the iOS simulator, Android emulator, or web preview.

## Development Notes

- Menu uploads use `expo-image-picker` with multiple selection, live camera capture, and size limits (≤10 files, ≤12 MB each).
- Results are fetched from `${EXPO_PUBLIC_API_BASE_URL}/api/process` and rendered immediately.
- Styling follows the existing SeeFood visual language to keep parity with the web clients.

## Linting

```bash
npm run lint
```

## Next Steps

- Integrate an in-app camera flow (`expo-camera`) for live captures.
- Add offline/queueing support for uploads on flaky networks.
- Bundle telemetry or Sentry for mobile-specific diagnostics.
