# SeeFood Mobile Frontend

Mobile-first React experience for SeeFood operations. Built with Vite + React 19 and tuned for iOS-sized viewports.

## Getting started

```bash
cd mobile-frontend
npm install
VITE_API_BASE_URL=https://your-backend.example.com npm run dev
```

Use `.env.local` to store the `VITE_API_BASE_URL` when developing locally.

## Features

- Touch friendly uploader with drag-and-drop fallback
- Horizontal thumbnail strip for captured pages
- Card-based dish gallery with prices and descriptions
- Backend integration via `/api/process`

## Building

```bash
npm run build
npm preview
```

Deploy the contents of `dist/` to your hosting provider of choice.
