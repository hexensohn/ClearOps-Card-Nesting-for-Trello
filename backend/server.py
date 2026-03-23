import json
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
PUBLIC_DIR = ROOT_DIR / "public"
SQLITE_PATH = os.environ.get("SQLITE_PATH", "/data/card_nesting.db")
PORT = int(os.environ.get("PORT", "80"))
TRELLO_TIMEOUT_SECONDS = float(os.environ.get("TRELLO_TIMEOUT_SECONDS", "10"))
AUTH_CACHE_TTL_SECONDS = int(os.environ.get("AUTH_CACHE_TTL_SECONDS", "300"))

APP_NAME = os.environ.get("POWERUP_APP_NAME", "ClearOps Card Nesting")
API_KEY = os.environ.get("POWERUP_API_KEY", "REPLACE_WITH_TRELLO_API_KEY")
APP_URL = os.environ.get("POWERUP_APP_URL", "https://your-powerup-domain.example.com")


def json_dumps(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class StorageDB:
    def __init__(self, sqlite_path):
        self.sqlite_path = sqlite_path
        self.lock = threading.Lock()
        db_dir = Path(sqlite_path).resolve().parent
        db_dir.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self):
        connection = sqlite3.connect(self.sqlite_path, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self):
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS board_stores (
                  board_id TEXT PRIMARY KEY,
                  store_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            connection.commit()

    def get_store(self, board_id):
        with self.lock, self._connect() as connection:
            row = connection.execute(
                "SELECT store_json FROM board_stores WHERE board_id = ?",
                (board_id,),
            ).fetchone()

        if not row:
            return None

        return json.loads(row["store_json"])

    def put_store(self, board_id, store):
        payload = json_dumps(store)
        updated_at = now_iso()

        with self.lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO board_stores (board_id, store_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(board_id) DO UPDATE SET
                  store_json = excluded.store_json,
                  updated_at = excluded.updated_at
                """,
                (board_id, payload, updated_at),
            )
            connection.commit()

        return store


class TrelloAccessValidator:
    def __init__(self):
        self.lock = threading.Lock()
        self.cache = {}

    def _cache_key(self, board_id, api_key, token):
        return f"{board_id}:{api_key}:{token}"

    def validate_board_access(self, board_id, api_key, token):
        if not board_id:
            raise PermissionError("Missing board id.")
        if not api_key:
            raise PermissionError("Missing Trello API key.")
        if not token:
            raise PermissionError("Missing Trello token.")

        cache_key = self._cache_key(board_id, api_key, token)
        now = time.time()

        with self.lock:
            expires_at = self.cache.get(cache_key)
            if expires_at and expires_at > now:
                return

        query = urllib.parse.urlencode(
            {
                "fields": "id",
                "key": api_key,
                "token": token,
            }
        )
        url = f"https://api.trello.com/1/boards/{urllib.parse.quote(board_id)}?{query}"
        request = urllib.request.Request(url, method="GET")

        try:
            with urllib.request.urlopen(request, timeout=TRELLO_TIMEOUT_SECONDS) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code in {401, 403, 404}:
                raise PermissionError("Trello token does not have access to this board.") from error
            raise
        except urllib.error.URLError as error:
            raise RuntimeError(f"Unable to reach Trello to validate board access: {error.reason}") from error

        if payload.get("id") != board_id:
            raise PermissionError("Trello token does not have access to this board.")

        with self.lock:
            self.cache[cache_key] = now + AUTH_CACHE_TTL_SECONDS


def normalize_store(store):
    raw_store = store if isinstance(store, dict) else {}
    raw_parents = raw_store.get("parentsById", {})
    parents_by_id = raw_parents if isinstance(raw_parents, dict) else {}

    return {
        "parentsById": parents_by_id,
    }


def build_config_js():
    config = {
        "appName": APP_NAME,
        "apiKey": API_KEY,
        "appUrl": APP_URL,
    }
    return f"window.POWERUP_CONFIG = {json.dumps(config, ensure_ascii=True, indent=2)};\n"


db = StorageDB(SQLITE_PATH)
validator = TrelloAccessValidator()


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/health":
            return self._send_text("ok\n")

        if parsed.path == "/config.js":
            return self._send_javascript(build_config_js())

        if parsed.path.startswith("/api/"):
            return self._handle_api("GET", parsed.path)

        return super().do_GET()

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self._handle_api("PUT", parsed.path)

        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def translate_path(self, path):
        parsed = urllib.parse.urlparse(path)
        clean_path = parsed.path
        if clean_path in {"", "/"}:
            clean_path = "/index.html"

        full_path = PUBLIC_DIR / clean_path.lstrip("/")
        if full_path.is_dir():
            full_path = full_path / "index.html"

        if full_path.exists():
            return str(full_path)

        return str(PUBLIC_DIR / "index.html")

    def end_headers(self):
        self._write_common_headers()
        super().end_headers()

    def _write_common_headers(self):
        self.send_header("Cache-Control", "no-store")

    def _read_json_body(self):
        content_length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(content_length) if content_length else b""
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, text, status=HTTPStatus.OK):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_javascript(self, source, status=HTTPStatus.OK):
        body = source.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/javascript; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _extract_board_id(self, path):
        parts = [part for part in path.split("/") if part]
        if len(parts) == 4 and parts[0] == "api" and parts[1] == "boards" and parts[3] == "store":
            return urllib.parse.unquote(parts[2])
        return None

    def _require_board_access(self, board_id):
        validator.validate_board_access(
            board_id=board_id,
            api_key=self.headers.get("X-Trello-Key", ""),
            token=self.headers.get("X-Trello-Token", ""),
        )

    def _handle_api(self, method, path):
        board_id = self._extract_board_id(path)
        if not board_id:
            return self._send_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

        try:
            self._require_board_access(board_id)
        except PermissionError as error:
            return self._send_json({"error": str(error)}, status=HTTPStatus.FORBIDDEN)
        except RuntimeError as error:
            return self._send_json({"error": str(error)}, status=HTTPStatus.BAD_GATEWAY)
        except Exception as error:
            return self._send_json({"error": f"Unexpected authentication error: {error}"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

        if method == "GET":
            store = db.get_store(board_id)
            return self._send_json(
                {
                    "found": store is not None,
                    "store": normalize_store(store),
                }
            )

        if method == "PUT":
            try:
                payload = self._read_json_body()
            except json.JSONDecodeError:
                return self._send_json({"error": "Invalid JSON body."}, status=HTTPStatus.BAD_REQUEST)

            store = normalize_store(payload.get("store"))
            saved = db.put_store(board_id, store)
            return self._send_json({"ok": True, "store": saved})

        return self._send_json({"error": "Method not allowed"}, status=HTTPStatus.METHOD_NOT_ALLOWED)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), AppHandler)
    print(f"Serving on port {PORT} with sqlite database at {SQLITE_PATH}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
