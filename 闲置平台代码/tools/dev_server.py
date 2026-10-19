# -*- coding: utf-8 -*-
"""
本地开发/联调静态服务器（模拟 docker-compose 中的 nginx）
------------------------------------------------------------------
把 frontend 目录以静态站点方式提供在 3000 端口，
并把 /api、/uploads 反向代理到后端 8000，效果与 nginx.conf 一致。

运行： python tools/dev_server.py [--port 3000] [--backend http://127.0.0.1:8000]
      也可通过环境变量 PORT / BACKEND_ORIGIN 配置（命令行参数优先）
"""
import argparse
import os
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"

# 命令行参数优先，其次环境变量，最后默认值
_ap = argparse.ArgumentParser(add_help=True)
_ap.add_argument("--port", type=int, default=int(os.getenv("PORT", "3000")))
_ap.add_argument("--backend", default=os.getenv("BACKEND_ORIGIN", "http://127.0.0.1:8000"))
_args, _unknown = _ap.parse_known_args()

BACKEND_ORIGIN = _args.backend.rstrip("/")
PORT = _args.port

PROXY_PREFIXES = ("/api/", "/uploads/")


class ProxyHandler(SimpleHTTPRequestHandler):
    def _proxy(self):
        target = BACKEND_ORIGIN + self.path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {}
        for k in ("Authorization", "Content-Type", "Accept"):
            if self.headers.get(k):
                headers[k] = self.headers.get(k)
        req = urllib.request.Request(target, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                payload = resp.read()
                self.send_response(resp.status)
                ct = resp.headers.get("Content-Type")
                if ct:
                    self.send_header("Content-Type", ct)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except urllib.error.HTTPError as e:
            payload = e.read()
            self.send_response(e.code)
            ct = e.headers.get("Content-Type") if e.headers else None
            if ct:
                self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def do_GET(self):
        if self.path.startswith(PROXY_PREFIXES):
            return self._proxy()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith(PROXY_PREFIXES):
            return self._proxy()
        return super().do_POST()

    def do_PUT(self):
        if self.path.startswith(PROXY_PREFIXES):
            return self._proxy()
        return super().do_PUT()

    def do_DELETE(self):
        if self.path.startswith(PROXY_PREFIXES):
            return self._proxy()
        return super().do_DELETE()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    os.chdir(str(FRONTEND))
    handler = partial(ProxyHandler, directory=str(FRONTEND))
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    print(f"前端站点已启动： http://127.0.0.1:{PORT}  （API 代理到 {BACKEND_ORIGIN}）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()
