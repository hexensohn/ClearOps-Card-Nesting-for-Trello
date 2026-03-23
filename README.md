# Trello Card Nesting Power-Up

This project is a static Trello Power-Up that lets a card act as a **parent container** for nested cards.

The model implemented here is Trello-compatible:

- a board's nested-card state is stored in a backend database keyed by Trello board id
- those nested cards move with the parent automatically because they are not separate Trello cards yet
- a user can later choose **Extract as Card** to turn any nested card back into its own Trello card
- a standalone Trello card can be copied into a parent with **Nest This Card**

## Important platform note

Trello does **not** provide true native nested cards or a way for a Power-Up to let users drag a card out of another card directly on the board.

Because of that, this Power-Up uses an explicit extraction action instead:

- `Set as Parent` turns a card into a parent container
- `Nest This Card` copies the current card into a selected parent
- `Extract as Card` recreates a nested card as a real Trello card in the parent's current list

## Project structure

```text
.
├─ backend/
│  └─ server.py
├─ Dockerfile
├─ README.md
└─ public/
   ├─ app.js
   ├─ auth.html
   ├─ attach-child.html
   ├─ config.js
   ├─ group-panel.html
   ├─ icon.svg
   ├─ index.html
   ├─ set-parent.html
   └─ styles.css
```

## Configure Trello

Create the Power-Up in Trello admin and set:

- **Iframe Connector URL** = `https://your-domain.example/index.html`
- generate an API key for the Power-Up
- add your Power-Up origin to the API key allowed origins

Copy `public/config.example.js` to `public/config.js`, then replace the placeholders:

```js
window.POWERUP_CONFIG = {
  appName: "ClearOps Card Nesting",
  apiKey: "YOUR_TRELLO_API_KEY",
  appUrl: "https://your-domain.example"
};
```

## VPS deploy with Docker Compose

For VPS deploys, the app container now serves both the static Power-Up files and the backend API, and persists nested-card state in SQLite.

1. Clone the repo on the VPS.
2. Copy `.env.example` to `.env`.
3. Set these values in `.env`:

- `SITE_HOST`
- `HTTP_PORT`
- `HTTPS_PORT`
- `POWERUP_APP_NAME`
- `POWERUP_API_KEY`
- `POWERUP_APP_URL`
- `SQLITE_PATH`

4. Start the container:

```bash
docker compose up -d --build
```

This stack now includes Caddy, which will request and renew HTTPS certificates automatically for your domain.

Example `.env`:

```env
SITE_HOST=trello.clearops.com.au
HTTP_PORT=80
HTTPS_PORT=443
POWERUP_APP_NAME=ClearOps Card Nesting
POWERUP_API_KEY=YOUR_TRELLO_API_KEY
POWERUP_APP_URL=https://trello.clearops.com.au
SQLITE_PATH=/data/card_nesting.db
```

Then point Trello at:

- `https://trello.clearops.com.au/index.html`

Make sure the same origin is also added to your Trello API key allowed origins:

- `https://trello.clearops.com.au`

Important:

- `SITE_HOST` must already resolve publicly to your VPS IP.
- Ports `80` and `443` must be open to the internet for automatic HTTPS to work.
- Docker Compose mounts a named volume at `/data` so the SQLite database survives container rebuilds.
- Inference: if another container or reverse proxy is already using host ports `80` or `443`, Caddy will not be able to start until those ports are freed or that existing proxy is used instead.

## Local run

Run the combined frontend + backend server:

```bash
python backend/server.py
```

## What the Power-Up stores

The backend database is now the source of truth.

Each board stores:

- `parentsById[parentCardId].label`
- `parentsById[parentCardId].childItems[]`

Each nested item can contain:

- `id`
- `title`
- `sourceCardId`
- `description` only for non-source/manual items

Trello plugin data is no longer used for ongoing storage writes. It is only read as a migration source if a board still has older `cardNesting`, `cardNestingIndex`, or `cardNestingParent` data.

## Storage limits

This removes the main long-term Trello pluginData size risk because nested-card state no longer has to fit inside Trello's Power-Up storage limits.

The first time a board loads against the backend, the app will import any existing Trello-stored nesting data into the database for that board.

## Current workflow

1. Open a card and use `Set as Parent`.
2. On the parent card back, use `Add from List` in the `Card Nesting` section.
3. Or open another card and use `Nest This Card` to copy that card into a parent.
4. When needed, open the parent card and click `Extract as Card` for the nested card you want to release.

## Future improvements

- add parent search by name, shortlink, or labels
- preserve more source-card fields during extraction
- add webhooks if you later want richer sync and audit behavior
