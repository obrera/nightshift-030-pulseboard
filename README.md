# Nightshift 030 PulseBoard

Nightshift 030 PulseBoard is a Vite + React + TypeScript + Tailwind air quality planner that uses Open-Meteo geocoding, weather, and air-quality APIs to help compare up to three cities in a dark-mode operational dashboard.

## Features

- City search with live Open-Meteo geocoding.
- Current conditions plus the next 24 hours of hourly AQI and weather.
- Compare up to three saved cities with status badges and trend summaries.
- Advisory planner with AQI-based activity guidance and per-city/day notes stored in `localStorage`.
- Alerts for degraded AQI, worsening trends, precipitation risk, and wind.
- JSON export/import for saved cities and planner notes.
- GitHub Pages deployment targeting `https://obrera.github.io/nightshift-030-pulseboard/`.

## Stack

- Vite
- React 19
- TypeScript
- Tailwind CSS
- Open-Meteo APIs

## Local Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Deploy

```bash
npm run deploy
```

## Live URL

https://obrera.github.io/nightshift-030-pulseboard/

## Repository

https://github.com/obrera/nightshift-030-pulseboard

## Verification

- `npm run build`
- `npm run lint`
- `npm run deploy`
- GitHub Pages published from `gh-pages`
- Verified `https://obrera.github.io/nightshift-030-pulseboard/` returned `HTTP/2 200` on `2026-03-15T01:12:56Z`
