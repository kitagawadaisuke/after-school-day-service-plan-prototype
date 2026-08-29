#!/usr/bin/env python3
"""デモアプリに必要な静的ファイルだけを localhost へ配信する。"""

from argparse import ArgumentParser
from collections import defaultdict, deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from threading import Lock
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import unquote, urlsplit


PROJECT_ROOT = Path(__file__).resolve().parent.parent
ALLOWED_PATHS = {
    "/": "index.html",
    "/index.html": "index.html",
    "/styles.css": "styles.css",
    "/src/app.js": "src/app.js",
    "/src/journal-chat.js": "src/journal-chat.js",
    "/src/demo-data.js": "src/demo-data.js",
    "/src/plan-engine.js": "src/plan-engine.js",
    "/src/record-workflow.js": "src/record-workflow.js",
    "/src/utils.js": "src/utils.js",
}
WRITING_ASSIST_PATH = "/api/demo/writing-assist"
WRITING_TARGET_MIN = 80
WRITING_TARGET_MAX = 800
WRITING_REQUEST_MAX_BYTES = 12_000
WRITING_REQUESTS_PER_IP = 3
WRITING_REQUEST_WINDOW_SECONDS = 10 * 60
WRITING_REQUESTS_GLOBAL = 20
WRITING_GLOBAL_WINDOW_SECONDS = 60 * 60
_writing_request_times = defaultdict(deque)
_writing_request_lock = Lock()


class WritingAssistError(Exception):
    """Safe message returned to the browser for writing-assist failures."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def character_count(value: str) -> int:
    return len(str(value or "").strip())


def clean_text(value: object, *, max_length: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()[:max_length]


def writing_rate_limit_key(handler: SimpleHTTPRequestHandler) -> str:
    # このデモはリバースプロキシ配下で動作するため、プロキシが付与した
    # X-Real-IP を使う。直接アクセス時に任意ヘッダーで制限を回避されないよう、
    # ループバック接続である場合だけこのヘッダーを信頼する。
    client_ip = handler.client_address[0]
    if client_ip in {"127.0.0.1", "::1"}:
        return handler.headers.get("X-Real-IP", "").strip() or client_ip
    return client_ip


def allow_writing_request(handler: SimpleHTTPRequestHandler) -> bool:
    now = time.monotonic()
    key = writing_rate_limit_key(handler)
    with _writing_request_lock:
        for request_key, requests in list(_writing_request_times.items()):
            window = WRITING_GLOBAL_WINDOW_SECONDS if request_key == "__global__" else WRITING_REQUEST_WINDOW_SECONDS
            while requests and requests[0] <= now - window:
                requests.popleft()
            if not requests:
                del _writing_request_times[request_key]
        global_requests = _writing_request_times["__global__"]
        client_requests = _writing_request_times[key]
        if len(global_requests) >= WRITING_REQUESTS_GLOBAL or len(client_requests) >= WRITING_REQUESTS_PER_IP:
            return False
        global_requests.append(now)
        client_requests.append(now)
        return True


def openai_output_text(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""
    direct = payload.get("output_text")
    if isinstance(direct, str):
        return direct.strip()
    output = payload.get("output")
    if not isinstance(output, list):
        return ""
    parts = []
    for item in output:
        if not isinstance(item, dict):
            continue
        for content in item.get("content", []):
            if isinstance(content, dict) and content.get("type") == "output_text" and isinstance(content.get("text"), str):
                parts.append(content["text"])
    return "".join(parts).strip()


def writing_prompt(*, source_text: str, field_label: str, activity: str, target_characters: int, revision_text: str = "", revision_count: int = 0) -> str:
    context = [f"入力欄: {field_label}"]
    if activity:
        context.append(f"活動・場面: {activity}")
    context.append(f"職員が入力した事実: {source_text}")
    if revision_text:
        context.extend([
            "前回の下書き:",
            revision_text,
            f"前回の下書きは{revision_count}字でした。内容を変えずに、{target_characters}字ちょうどになるよう文字数だけを調整してください。",
        ])
    return "\n".join([
        "あなたは放課後等デイサービスの記録作成を支援する日本語の文章補助です。",
        "以下に記載された事実だけを使い、職員が確認・修正する下書きを作成してください。",
        f"出力は本文だけを、必ず日本語の文字数でちょうど{target_characters}字にしてください。",
        "入力にない本人の心情、未記載の支援・日時・数値、評価を断定したり、同じ内容を繰り返して水増ししたりしないでください。",
        "根拠が足りない場合は推測せず、生成できないことを示す短い一文だけを返してください。",
        "見出し、箇条書き、注釈、文字数の説明は出力しないでください。",
        "",
        "入力:",
        *context,
    ])


def request_openai(prompt: str, *, api_key: str, model: str) -> str:
    body = json.dumps({
        "model": model,
        "store": False,
        "input": prompt,
        "max_output_tokens": 1200,
    }).encode("utf-8")
    request = Request(
        os.environ.get("OPENAI_API_URL", "https://api.openai.com/v1/responses"),
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError, OSError) as error:
        raise WritingAssistError(503, "AIによる文章作成に接続できません。しばらくしてから再度お試しください。") from error
    text = openai_output_text(payload)
    if not text:
        raise WritingAssistError(503, "AIによる文章作成を完了できませんでした。入力内容を確認して再度お試しください。")
    return text


def generate_writing_draft(payload: object) -> dict:
    if os.environ.get("DEMO_WRITING_ENABLED") != "true":
        raise WritingAssistError(503, "AI文章作成はこのデモ環境でまだ有効化されていません。")
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise WritingAssistError(503, "AI文章作成の設定が不足しています。管理者へお問い合わせください。")
    if not isinstance(payload, dict):
        raise WritingAssistError(400, "送信内容を確認してください。")
    source_text = clean_text(payload.get("sourceText"), max_length=4_000)
    field_label = clean_text(payload.get("fieldLabel"), max_length=80) or "記録内容"
    activity = clean_text(payload.get("activity"), max_length=500)
    target_characters = payload.get("targetCharacters")
    if not isinstance(target_characters, int) or isinstance(target_characters, bool) or not WRITING_TARGET_MIN <= target_characters <= WRITING_TARGET_MAX:
        raise WritingAssistError(400, f"目標文字数は{WRITING_TARGET_MIN}〜{WRITING_TARGET_MAX}字で指定してください。")
    if not source_text:
        raise WritingAssistError(400, "文章を整える内容を入力してください。")
    if character_count(source_text) < max(20, target_characters // 10):
        raise WritingAssistError(422, "記録の根拠が短いため、この文字数へ安全に広げられません。活動内容・本人の様子・行った支援を追記してください。")

    model = os.environ.get("OPENAI_MODEL", "gpt-4.1").strip() or "gpt-4.1"
    generated = ""
    for attempt in range(3):
        generated = request_openai(
            writing_prompt(
                source_text=source_text,
                field_label=field_label,
                activity=activity,
                target_characters=target_characters,
                revision_text=generated if attempt else "",
                revision_count=character_count(generated),
            ),
            api_key=api_key,
            model=model,
        )
        if character_count(generated) == target_characters:
            break
    if character_count(generated) != target_characters:
        raise WritingAssistError(503, f"指定した{target_characters}字に整えられませんでした。入力内容を少し具体的にして、もう一度お試しください。")
    return {
        "text": generated,
        "characterCount": character_count(generated),
        "targetCharacters": target_characters,
    }


class AppOnlyHandler(SimpleHTTPRequestHandler):
    """サンプルJPGやディレクトリ一覧を公開しないハンドラ。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def _is_allowed(self) -> bool:
        request_path = unquote(urlsplit(self.path).path)
        return request_path in ALLOWED_PATHS

    def do_GET(self):  # noqa: N802 - stdlib callback name
        if not self._is_allowed():
            self.send_error(404, "Not found")
            return
        super().do_GET()

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802 - stdlib callback name
        if unquote(urlsplit(self.path).path) != WRITING_ASSIST_PATH:
            self.send_error(404, "Not found")
            return
        content_length = self.headers.get("Content-Length", "")
        try:
            length = int(content_length)
        except ValueError:
            self._send_json(400, {"error": {"message": "送信内容を確認してください。"}})
            return
        if length < 1 or length > WRITING_REQUEST_MAX_BYTES:
            self._send_json(413, {"error": {"message": "送信内容が大きすぎます。"}})
            return
        if not allow_writing_request(self):
            self._send_json(429, {"error": {"message": "AI文章作成の利用回数が上限に達しました。少し時間をおいてお試しください。"}})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            generated = generate_writing_draft(payload)
        except UnicodeDecodeError:
            self._send_json(400, {"error": {"message": "送信内容を確認してください。"}})
            return
        except json.JSONDecodeError:
            self._send_json(400, {"error": {"message": "送信内容を確認してください。"}})
            return
        except WritingAssistError as error:
            self._send_json(error.status, {"error": {"message": error.message}})
            return
        self._send_json(200, generated)

    def do_HEAD(self):  # noqa: N802 - stdlib callback name
        if not self._is_allowed():
            self.send_error(404, "Not found")
            return
        super().do_HEAD()

    def translate_path(self, path: str) -> str:
        request_path = unquote(urlsplit(path).path)
        relative_path = ALLOWED_PATHS.get(request_path, "__not_found__")
        return str(PROJECT_ROOT / relative_path)

    def end_headers(self):
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; "
            "form-action 'self'; frame-ancestors 'none'",
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(self), geolocation=()")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    parser = ArgumentParser(description="みちのーとのローカルデモを安全に起動します。")
    parser.add_argument("--host", default="127.0.0.1", help="バインド先（既定: 127.0.0.1）")
    parser.add_argument("--port", type=int, default=4173, help="ポート（既定: 4173）")
    args = parser.parse_args()

    with ThreadingHTTPServer((args.host, args.port), AppOnlyHandler) as server:
        print(f"みちのーと: http://{args.host}:{args.port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
