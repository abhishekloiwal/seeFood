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

## Custom Dev Client (run without Expo Go)

This repo is prepped with `expo-dev-client` and `eas.json`. Build the ad-hoc client once, then open the app directly on your phone without Metro running on the same network.

1. Make sure you are logged in to Expo and EAS:
   ```bash
   npx expo login           # if not already signed in
   npx eas login
   npx eas whoami           # verify the account
   ```
2. Initialise the project with your Expo account (one time):
   ```bash
   npx eas init --id <your-project-id>
   ```
   The wizard will create the project on Expo if it does not exist yet.
3. Kick off a development build:
   ```bash
   npx eas build --profile development --platform ios    # or android
   ```
   For iOS you need an Apple Developer account to generate the certificates/profiles; Expo CLI walks you through it. When the build finishes, download the `.ipa` (iOS) or `.apk` (Android) from the EAS dashboard and install it on your device.
4. To connect the custom client to a running dev server use:
   ```bash
   npx expo start --dev-client
   ```
   Scan the QR code with the custom client (not Expo Go) to load the latest bundle.

## Development Notes

- Menu uploads use `expo-image-picker` with multiple selection, live camera capture, and size limits (≤10 files, ≤12 MB each).
- Results are fetched from `${EXPO_PUBLIC_API_BASE_URL}/api/process` and rendered immediately.
- Styling follows the existing SeeFood visual language to keep parity with the web clients.

## Linting

```bash
npm run lint
```

## Next Steps

- Add offline/queueing support for uploads on flaky networks.
- Bundle telemetry or Sentry for mobile-specific diagnostics.
- Ship a preview/production EAS build for wider sharing once the UI stabilises.
