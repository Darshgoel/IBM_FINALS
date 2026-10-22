# Interface 3: Individual Recipient — Status

## ✅ Done

| File | Description |
|---|---|
| `recipient/index.html` | Single-page app — no login required. Location search, people/dietary/urgency selectors, recommendation banner, access-point list cards, slide-up detail panel (hours, food, capacity, directions, contact). |
| `recipient/styles/main.css` | Full styling — warm orange accent on dark background, search card, access-point cards with availability status dots, recommendation banner, slide-up detail panel, loading animation, toast, responsive layout. |

## ❌ Left To Do

| File | What's needed |
|---|---|
| `recipient/js/app.js` | Main app logic — GPS geolocation, API call to `/api/recipient/nearby`, demo data fallback, render access-point cards, smart recommendation logic, sort (nearest/available/capacity), slide-up detail panel, browser notification opt-in (`enableAlerts()`), `useMyLocation()`, `searchFood()`, `openDetail()`, `closeDetail()`, `sortResults()`. |

## Key Design Decisions (per `interface.md`)

- **No account/login** — completely open access
- **No home delivery** — system says "go to this nearby access point"
- Recommendation is **intelligent** (distance + current availability + food suitability + operating hours + urgency)
- Alerts are **optional** (browser push, no account needed)
- Interface must stay **extremely simple** — search → recommended point → list → detail → directions
