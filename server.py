#!/usr/bin/env python3
"""Small local web UI and proxy for LM Studio's OpenAI-compatible API."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import urlencode, urlparse, parse_qs
from html.parser import HTMLParser
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


class SearchResultsParser(HTMLParser):
    """Extract DuckDuckGo HTML result links and snippets."""
    def __init__(self):
        super().__init__()
        self.results = []
        self.current = None
        self.capture = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = attrs.get("class", "").split()
        if tag == "a" and "result__a" in classes:
            self.current = {"title": "", "url": attrs.get("href", "")}
            parsed = urlparse(self.current["url"])
            redirect = parse_qs(parsed.query).get("uddg")
            if redirect:
                self.current["url"] = redirect[0]
            self.capture = "title"
        elif self.results and "result__snippet" in classes:
            self.current = self.results[-1]
            self.current["snippet"] = ""
            self.capture = "snippet"

    def handle_data(self, data):
        if self.current is not None and self.capture:
            self.current[self.capture] += data

    def handle_endtag(self, tag):
        if tag == "a" and self.capture == "title" and self.current:
            self.capture = None
            if self.current.get("title"):
                self.results.append(self.current)
                self.current = None
        elif self.current is not None and self.capture == "snippet" and tag in ("a", "div"):
            self.capture = None
            self.current = None


def web_search(query):
    if not query.strip():
        return []
    url = "https://html.duckduckgo.com/html/?" + urlencode({"q": query[:500]})
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"})
    with urlopen(req, timeout=15) as response:
        markup = response.read(2_000_000).decode("utf-8", errors="replace")
    parser = SearchResultsParser()
    parser.feed(markup)
    return parser.results[:5]


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
MODEL_ROOT = MODEL_URL[:-3].rstrip("/") if MODEL_URL.endswith("/v1") else MODEL_URL
API_KEY = os.environ.get("MODEL_API_KEY", "")
PORT = int(os.environ.get("PORT", "8000"))
CHAT_MODE = os.environ.get("LMSTUDIO_CHAT_MODE", "native").strip().lower()
try:
    MCP_INTEGRATIONS = json.loads(os.environ.get("LMSTUDIO_INTEGRATIONS_JSON", "[]"))
except json.JSONDecodeError as exc:
    raise RuntimeError("LMSTUDIO_INTEGRATIONS_JSON tem de conter JSON válido.") from exc
if not isinstance(MCP_INTEGRATIONS, list):
    raise RuntimeError("LMSTUDIO_INTEGRATIONS_JSON tem de ser uma lista JSON.")


def native_input(messages, response_id):
    last_user_index = next((i for i in range(len(messages) - 1, -1, -1) if messages[i].get("role") == "user"), None)
    if last_user_index is None:
        raise ValueError("A conversa não contém uma mensagem do utilizador.")
    content = messages[last_user_index].get("content", "")
    parts = content if isinstance(content, list) else [{"type": "text", "text": str(content)}]
    native_parts = []
    for part in parts:
        if part.get("type") == "text":
            native_parts.append({"type": "text", "content": part.get("text", "")})
        elif part.get("type") == "image_url":
            native_parts.append({"type": "image", "data_url": part.get("image_url", {}).get("url", "")})
    if response_id:
        return native_parts
    prior = []
    for message in messages[:last_user_index]:
        role = "Utilizador" if message.get("role") == "user" else "Assistente"
        old_content = message.get("content", "")
        if isinstance(old_content, list):
            text = " ".join(p.get("text", "[imagem anexada]") for p in old_content if p.get("type") in ("text", "image_url"))
        else:
            text = str(old_content)
        prior.append(f"{role}: {text}")
    if prior:
        native_parts.insert(0, {"type": "text", "content": "Contexto anterior da conversa:\n" + "\n".join(prior)})
    return native_parts


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
        if self.path.startswith("/api/search?"):
            query = parse_qs(urlparse(self.path).query).get("q", [""])[0]
            try:
                self.send_json(200, {"results": web_search(query)})
            except (HTTPError, URLError, TimeoutError, ValueError) as exc:
                self.send_json(502, {"error": f"A pesquisa na Internet falhou: {exc}"})
            return
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
            if CHAT_MODE == "native":
                request_body = {
                    "model": payload["model"],
                    "input": native_input(payload["messages"], payload.get("response_id")),
                    "stream": True,
                    "store": True,
                }
                if payload.get("response_id"):
                    request_body["previous_response_id"] = payload["response_id"]
                if MCP_INTEGRATIONS:
                    request_body["integrations"] = MCP_INTEGRATIONS
                chat_url = MODEL_ROOT + "/api/v1/chat"
            elif CHAT_MODE == "openai":
                request_body = {
                    "model": payload["model"],
                    "messages": payload["messages"],
                    "stream": True,
                }
                chat_url = MODEL_URL + "/chat/completions"
            else:
                raise ValueError("LMSTUDIO_CHAT_MODE deve ser 'native' ou 'openai'.")
            req = Request(
                chat_url,
                data=json.dumps(request_body).encode("utf-8"),
                headers=api_headers(),
                method="POST",
            )
            with urlopen(req, timeout=600) as response:
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                if CHAT_MODE == "native":
                    event_type = ""
                    for raw_line in response:
                        line = raw_line.decode("utf-8", errors="replace").strip()
                        if line.startswith("event:"):
                            event_type = line[6:].strip()
                            continue
                        if not line.startswith("data:"):
                            continue
                        try:
                            event = json.loads(line[5:].strip())
                        except ValueError:
                            continue
                        kind = event.get("type", event_type)
                        normalized = None
                        if kind == "message.delta":
                            normalized = {"message": {"content": event.get("content", "")}}
                        elif kind == "tool_call.start":
                            normalized = {"tool_event": {"name": event.get("tool", "ferramenta"), "status": "start"}}
                        elif kind == "tool_call.success":
                            normalized = {"tool_event": {"name": event.get("tool", "ferramenta"), "status": "success"}}
                        elif kind == "tool_call.failure":
                            normalized = {"tool_event": {"name": event.get("metadata", {}).get("tool_name", "ferramenta"), "status": "failure", "error": event.get("reason", "")}}
                        elif kind == "error":
                            normalized = {"error": event.get("error", {}).get("message", "Erro na integração MCP.")}
                        elif kind == "chat.end":
                            result = event.get("result", {})
                            normalized = {"response_id": result.get("response_id"), "done": True}
                        if normalized:
                            self.wfile.write((json.dumps(normalized, ensure_ascii=False) + "\n").encode("utf-8"))
                            self.wfile.flush()
                        event_type = ""
                else:
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
