# Anime Letter Race

A single-page multiplayer anime-character name race built with React, TypeScript, Vite, a Netlify Function, and Netlify Blobs. The browser calls `/.netlify/functions/game` directly; no path redirect is required.

## Features

- 4-letter uppercase room codes and rooms for 2–8 players.
- Nicknames and per-browser player IDs, so a normal browser and an Incognito window act as separate players.
- Character pool seeded with Goku, Vegeta, Frieza, Luffy, Zoro, Sanji, Nami, Eren, Levi, Mikasa, Deku, Bakugo, and Todoroki.
- Server-side round start time and a new correct letter every 4 seconds. The last letter stays hidden until someone wins, so the round does not solve itself.
- First correct guess wins; score starts at 1,000 and loses 12 points per elapsed second plus 100 points for each revealed letter (minimum 100 points).
- Live room state via polling every 750 ms.
- Persistent room scores across rounds, host handoff when the host leaves, and lobby instructions.
- Netlify Blobs strong-consistency reads, `onlyIfNew` room-code claims, and `onlyIfMatch` conditional writes for guarded room updates.

## Requirements

- Node.js 22.12 or newer (Vite 8 requirement).
- npm.

## Run locally

1. Extract this project folder.
2. Open a terminal inside `anime-letter-race`.
3. Install the packages:

   ```bash
   npm install
   ```

4. Start the Vite dev server with Netlify's local platform plugin:

   ```bash
   npm run dev
   ```

5. Open the local URL shown in the terminal (normally `http://localhost:5173`). The Netlify Vite plugin emulates Netlify Functions and Blobs locally. The app still calls the direct path `/.netlify/functions/game`.

If you prefer the Netlify CLI workflow, install the CLI and use `netlify dev`; the default function directory is already configured in `netlify.toml`.

## Test with two distinct players

1. In a normal browser window, open the local app, enter a nickname, and click **Create Room**.
2. Copy the 4-letter room code.
3. Open an Incognito/Private window to the same local URL. Enter a different nickname, type the code, and click **Join Room**.
4. Return to the normal window. The second player should appear in the roster within about a second. Click **Start Match**.
5. Watch both windows: the underscores reveal letters together, and either player can submit a guess. Enter a correct character name in the guess field and press **Guess**.
6. The first correct submitted guess wins and earns points. The host can click **Next Round** to play again. Scores persist for the life of the room.

Both windows must use the exact same local URL/port so they reach the same local function and Blobs emulator. Normal and Incognito windows have separate local storage, which gives them different player IDs.

## Build and type-check

```bash
npm run typecheck
npm run build
npm run preview
```

## Deploy to Netlify

1. Push the project to a Git provider or deploy it with the Netlify CLI.
2. Set the build command to `npm run build` and publish directory to `dist` (both are already in `netlify.toml`).
3. Deploy. Netlify supplies the site/deploy environment to `@netlify/blobs` from the Function runtime; no Blobs API token needs to be hard-coded.
4. Use the deployed site's URL in two browser windows to test multiplayer.

## Implementation notes / production boundary

- Room state is stored under one blob per room. Strong reads and ETag-based conditional writes protect room creation and prevent a stale concurrent room update from blindly overwriting the newer version; the function retries compare-and-swap conflicts.
- Netlify Blobs is a highly available key/value store, not a transactional game database. Its own documentation recommends a database for workloads requiring stronger transaction/concurrency guarantees. This is a good core-loop prototype for small rooms; before a large public launch, move room membership, winner claims, and scoring to a transactional database (for example, Netlify Database/Postgres) or a dedicated realtime backend, and add rate limits / abuse protection.
- The function does not reveal the secret answer until a round is finished. Reveals are derived from the server's `startedAt` timestamp, avoiding a background timer that would be lost between serverless invocations.
- Polling is deliberately simple for local testing. At higher scale, use a managed realtime pub/sub layer or WebSockets and consider a transactional store for the authoritative room state.

## Source layout

```text
anime-letter-race/
├── index.html
├── netlify.toml
├── package.json
├── vite.config.ts
├── tsconfig.json
├── netlify/
│   └── functions/
│       └── game.ts
└── src/
    ├── App.tsx
    ├── main.tsx
    └── styles.css
```

## Official references

- [Netlify Blobs: consistency and conditional writes](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)
- [Netlify Functions: TypeScript handlers and local testing](https://docs.netlify.com/build/functions/get-started/)
- [Netlify Vite plugin](https://docs.netlify.com/build/frameworks/framework-setup-guides/vite/)
