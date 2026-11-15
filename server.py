#!/usr/bin/env python3
"""Small local web UI and proxy for LM Studio's OpenAI-compatible API."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from pathlib import Path
import json
import os
import sys
import base64
import io
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent


def load_dotenv(path):
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


load_dotenv(ROOT / ".env")

MAX_UPLOAD_BYTES = 15 * 1024 * 1024
MAX_EXTRACTED_CHARS = 500_000
MAX_DOCUMENT_IMAGES = 8


def extract_document(filename, raw):
    suffix = Path(filename).suffix.lower()
    if suffix == ".docx":
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            document = ET.fromstring(archive.read("word/document.xml"))
            ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            paragraphs = []
            for paragraph in document.findall(".//w:p", ns):
                text = "".join(node.text or "" for node in paragraph.findall(".//w:t", ns))
                if text.strip():
                    paragraphs.append(text)
            images = []
            for name in archive.namelist():
                if not name.startswith("word/media/") or name.endswith("/"):
                    continue
                ext = Path(name).suffix.lower()
                mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}.get(ext)
                if not mime or len(images) >= MAX_DOCUMENT_IMAGES:
                    continue
                data = archive.read(name)
                if len(data) <= 12 * 1024 * 1024:
                    images.append({"url": f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"})
            return {"text": "\n".join(paragraphs)[:MAX_EXTRACTED_CHARS], "images": images}
    if suffix == ".pdf":
        try:
            import pymupdf
        except ImportError as exc:
            repair_command = f'"{sys.executable}" -m pip install --upgrade --force-reinstall PyMuPDF'
            raise RuntimeError(
                f"O Python usado pela app não conseguiu importar PyMuPDF. Interpretador: {sys.executable}. "
                f"Erro original: {exc}. Para instalar/reparar neste mesmo Python, executa: {repair_command}"
            ) from exc
        try:
            pdf = pymupdf.open(stream=raw, filetype="pdf")
        except Exception as exc:
            raise ValueError("Não foi possível abrir este PDF. Confirma que o ficheiro não está danificado ou protegido por palavra-passe.") from exc
        page_texts = [page.get_text().strip() for page in pdf]
        text = "\n\n".join(f"[Página {i + 1}]\n{content}" for i, content in enumerate(page_texts) if content)
        if len(pdf) <= MAX_DOCUMENT_IMAGES:
            render_indices = range(len(pdf))
        else:
            render_indices = [i for i, content in enumerate(page_texts) if not content][:MAX_DOCUMENT_IMAGES]
        images = []
        for i in render_indices:
            pixmap = pdf[i].get_pixmap(matrix=pymupdf.Matrix(1.25, 1.25), alpha=False)
            images.append({"url": "data:image/png;base64," + base64.b64encode(pixmap.tobytes("png")).decode("ascii"), "page": i + 1})
        if not text and not images:
            raise ValueError("Não foi possível extrair texto ou imagens deste PDF.")
        return {"text": text[:MAX_EXTRACTED_CHARS], "images": images, "page_count": len(pdf)}
    raise ValueError("Formato não suportado. Usa PDF ou Word (.docx).")

MODEL_URL = os.environ.get("MODEL_BASE_URL", "http://127.0.0.1:1235/v1").rstrip("/")
API_KEY = os.environ.get("MODEL_API_KEY", "")
PORT = int(os.environ.get("PORT", "8000"))


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
        if self.path not in ("/api/chat", "/api/extract"):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 22 * 1024 * 1024:
                self.send_json(413, {"error": "O pedido excede o limite de tamanho."})
                return
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if self.path == "/api/extract":
                name = Path(payload["name"]).name
                raw = base64.b64decode(payload["data"], validate=True)
                if len(raw) > MAX_UPLOAD_BYTES:
                    self.send_json(413, {"error": "O ficheiro excede o limite de 15 MB."})
                    return
                self.send_json(200, extract_document(name, raw))
                return
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
        except Exception as exc:
            try:
                status = 400 if self.path == "/api/extract" else 502
                self.send_json(status, {"error": f"{type(exc).__name__}: {exc}"})
            except (BrokenPipeError, ConnectionResetError):
                pass

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    print(f"Webapp em http://0.0.0.0:{PORT} — modelo em {MODEL_URL}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
