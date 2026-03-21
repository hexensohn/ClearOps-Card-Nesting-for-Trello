# Trello Card Nesting Power-Up

This project is a static Trello Power-Up that lets a card act as a **parent container** for nested cards.

The model implemented here is Trello-compatible:

- a parent card stores nested cards inside Power-Up board data
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
├─ Dockerfile
├─ README.md
├─ nginx/
│  └─ default.conf
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

For VPS deploys, the container now generates `public/config.js` from environment variables at startup, so you do not need to commit a live config file.

1. Clone the repo on the VPS.
2. Copy `.env.example` to `.env`.
3. Set these values in `.env`:

- `HOST_PORT`
- `POWERUP_APP_NAME`
- `POWERUP_API_KEY`
- `POWERUP_APP_URL`

4. Start the container:

```bash
docker compose up -d --build
```

The app will be available on `http://your-server:HOST_PORT` before you put HTTPS in front of it.

Example `.env`:

```env
HOST_PORT=8081
POWERUP_APP_NAME=ClearOps Card Nesting
POWERUP_API_KEY=YOUR_TRELLO_API_KEY
POWERUP_APP_URL=https://trello-nesting.yourdomain.com
```

Then put your VPS reverse proxy in front of that port and point Trello at:

- `https://trello-nesting.yourdomain.com/index.html`

Make sure the same origin is also added to your Trello API key allowed origins:

- `https://trello-nesting.yourdomain.com`

## Local run

You can serve the `public/` folder with any static server.

### Python

```bash
cd public
python -m http.server 8080
```

### Node

```bash
npx serve public
```

## What the Power-Up stores

Board shared data is stored under the `cardNesting` key:

- `parentsById[parentCardId].label`
- `parentsById[parentCardId].childItems[]`

Each nested card entry contains:

- `id`
- `title`
- `description`
- optional source card metadata when nested from an existing Trello card

## Current workflow

1. Open a card and use `Set as Parent`.
2. On the parent card back, use `Add from List` in the `Card Nesting` section.
3. Or open another card and use `Nest This Card` to copy that card into a parent.
4. When needed, open the parent card and click `Extract as Card` for the nested card you want to release.

## Future improvements

- add parent search by name, shortlink, or labels
- preserve more source-card fields during extraction
- add backend/webhook support if you later want audit history or richer automation
