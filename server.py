#!/usr/bin/env python3
"""Small local web UI and proxy for LM Studio's OpenAI-compatible API."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from pathlib import Path
import json
import os

ROOT = Path(__file__).resolve().parent
MODEL_URL = os.environ.get("MODEL_BASE_URL", "http://127.0.0.1:1234/v1").rstrip("/")
API_KEY = os.environ.get("MODEL_API_KEY", "")


def api_headers():
    headers = {"Content-Type": "application/json"}
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"
    return headers


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, data):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/api/models":
            try:
                req = Request(MODEL_URL + "/models", headers=api_headers())
                with urlopen(req, timeout=5) as response:
                    data = json.loads(response.read().decode("utf-8"))
                self.send_json(200, {"models": [m.get("id") for m in data.get("data", [])]})
            except (HTTPError, URLError, TimeoutError, ValueError) as exc:
                self.send_json(502, {"error": f"Não foi possível contactar o LM Studio em {MODEL_URL}: {exc}"})
            return
        if self.path in ("/", "/index.html"):
            body = (ROOT / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/style.css":
            body = (ROOT / "style.css").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/css; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/app.js":
            body = (ROOT / "app.js").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_POST(self):
        if self.path != "/api/chat":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            req = Request(
                MODEL_URL + "/chat/completions",
                data=json.dumps({
                    "model": payload["model"],
                    "messages": payload["messages"],
                    "stream": True,
                }).encode("utf-8"),
                headers=api_headers(),
                method="POST",
            )
            with urlopen(req, timeout=600) as response:
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                for line in response:
                    line = line.decode("utf-8", errors="replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        self.wfile.write(b'{"done":true}\n')
                        self.wfile.flush()
                        continue
                    try:
                        chunk = json.loads(data)
                        content = chunk.get("choices", [{}])[0].get("delta", {}).get("content") or ""
                        normalized = json.dumps({"message": {"content": content}, "done": False}, ensure_ascii=False)
                        self.wfile.write((normalized + "\n").encode("utf-8"))
                        self.wfile.flush()
                    except (ValueError, IndexError, AttributeError):
                        continue
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            if not self.wfile.closed:
                try:
                    self.send_json(502, {"error": detail or str(exc)})
                except (BrokenPipeError, ConnectionResetError):
                    pass
        except (URLError, TimeoutError, ValueError, KeyError, OSError) as exc:
            try:
                self.send_json(502, {"error": str(exc)})
            except (BrokenPipeError, ConnectionResetError):
                pass

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"Webapp em http://127.0.0.1:{port} — modelo em {MODEL_URL}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
