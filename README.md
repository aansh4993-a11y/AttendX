# Attendance Register

A daily attendance tracker for students. Enter today's attendance, it's added
to your running total automatically, and every day you save stays in a
permanent history table underneath.

## Features

- Automatic cumulative attendance — no manual math, ever.
- "Total classes held today" defaults to 8, always editable.
- Shows exactly how many classes you need to reach 75%, or how many you can
  skip and stay above it.
- Full attendance history, newest day on top, with edit and delete per row
  (later cumulative totals recalculate automatically).
- A planner that previews tomorrow's attendance under a few scenarios.
- Everything is saved to `localStorage` — survives refreshes and closing the
  browser. Nothing is sent to a server.
- Responsive from 320px phones up through desktop.

## Running locally

No build step. Just serve the folder:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open the printed local URL.

## Deploying to Vercel

This is a static site — no framework, no backend, no environment variables.

1. Push this folder to a Git repository.
2. In Vercel, "Add New Project" → import the repo.
3. Framework preset: **Other**. Build command: none. Output directory: `.`
4. Deploy.

Or with the Vercel CLI, from inside this folder:

```bash
vercel
```

## Files

- `index.html` — markup
- `style.css` — styling
- `script.js` — all app logic (vanilla JS, no dependencies)
