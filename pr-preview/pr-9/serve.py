#!/usr/bin/env python3
"""Dev server for DTX Web Player: http.server with caching disabled,
so edits show up on plain reload instead of requiring Cmd+Shift+R."""
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


print(f'Serving DTX Web Player at http://localhost:{PORT}')
http.server.ThreadingHTTPServer(('', PORT), NoCacheHandler).serve_forever()
