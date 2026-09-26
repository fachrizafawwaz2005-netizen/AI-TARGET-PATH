#!/usr/bin/env python3
"""
TargetPath static server.

TargetPath has NO Python backend and NO server-side algorithm: every part of
the pipeline (disease search, Open Targets calls, ChEMBL calls, the Greedy
Best-First Search itself, and ranking) runs as plain JavaScript directly in
your browser (see assets/pipeline.js).

The only job of this script is to serve index.html and assets/ over
http://localhost so the browser doesn't hit file:// CORS restrictions that
some browsers apply to fetch(). This uses ONLY the Python standard library
- nothing needs to be installed (see requirements.txt).
"""
import http.server
import os
import socket
import sys
import threading
import webbrowser

PORT = 8000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, format, *args):
        sys.stdout.write("[server] " + (format % args) + "\n")


def find_free_port(start_port):
    port = start_port
    while port < start_port + 20:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
        port += 1
    return start_port


def main():
    port = find_free_port(PORT)
    url = f"http://localhost:{port}/index.html"
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"TargetPath is running at {url}")
    print("Press Ctrl+C in this window to stop the server.")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping TargetPath server...")
        httpd.shutdown()


if __name__ == "__main__":
    main()
