#!/usr/bin/env python3
"""デモアプリに必要な静的ファイルだけを localhost へ配信する。"""

from argparse import ArgumentParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


PROJECT_ROOT = Path(__file__).resolve().parent.parent
ALLOWED_PATHS = {
    "/": "index.html",
    "/index.html": "index.html",
    "/styles.css": "styles.css",
    "/src/app.js": "src/app.js",
    "/src/demo-data.js": "src/demo-data.js",
    "/src/plan-engine.js": "src/plan-engine.js",
    "/src/record-workflow.js": "src/record-workflow.js",
    "/src/utils.js": "src/utils.js",
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
            "img-src 'self' data:; object-src 'none'; base-uri 'none'; "
            "form-action 'self'; frame-ancestors 'none'",
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
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
