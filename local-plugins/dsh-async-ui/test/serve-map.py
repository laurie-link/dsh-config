#!/usr/bin/env python3
"""Serves the dsh-async-ui package plus /async-img-style, for client-half tests.

The real route lives in lib/index.js; this is only so a browser fixture can
exercise the fetch path without starting DSH.
"""
import http.server
import json
import os
import socketserver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STYLE = os.path.join(ROOT, "assets", "liberty-style.json")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path.split("?")[0] == "/async-img-style":
            with open(STYLE, "rb") as handle:
                body = handle.read()
            json.loads(body)  # fail loudly if the asset is broken
            self.send_response(200)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", 8901), Handler) as httpd:
    httpd.serve_forever()
