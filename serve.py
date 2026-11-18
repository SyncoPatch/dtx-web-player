#!/usr/bin/env python3
"""Dev server for DTX Web Player: http.server with caching disabled,
so edits show up on plain reload instead of requiring Cmd+Shift+R.

    python3 serve.py [port]            plain HTTP (default port 8000)
    python3 serve.py --https [port]    HTTPS for LAN devices (default port 8443)
    python3 serve.py --https --sw      ... and serve sw.js (offline testing)

Over plain HTTP, a LAN address (http://192.168.x.x) is not a secure context,
so an iPad loses OPFS (separation models), WebGPU, WebCodecs (Opus stems),
mediaDevices and the service worker. --https fixes that with a local
certificate authority: trust its certificate on the device once (the server
prints how), and every certificate it issues later is trusted too.

Certificates live in ~/.config/dtx-dev-certs/, never in the repo (the deploy
publishes the repo root). The server certificate is re-issued automatically
when the Mac's addresses change; the CA stays, so devices stay trusted.
"""
import http.server
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys

args = [a for a in sys.argv[1:] if not a.startswith('--')]
flags = {a for a in sys.argv[1:] if a.startswith('--')}
HTTPS = '--https' in flags
SERVE_SW = '--sw' in flags or not HTTPS
PORT = int(args[0]) if args else (8443 if HTTPS else 8000)
CERT_DIR = os.path.expanduser('~/.config/dtx-dev-certs')
os.chdir(os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(line_buffering=True)  # show the URLs even when piped


def openssl():
    for cand in ('/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', shutil.which('openssl')):
        if cand and os.path.exists(cand):
            return cand
    sys.exit('openssl not found; it is needed for --https')


def lan_addresses():
    ips = set()
    if sys.platform == 'darwin':
        for i in range(10):
            r = subprocess.run(['ipconfig', 'getifaddr', f'en{i}'], capture_output=True, text=True)
            if r.returncode == 0 and r.stdout.strip():
                ips.add(r.stdout.strip())
    try:  # the address the default route uses (works on other systems too)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('10.255.255.255', 1))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    ips.discard('127.0.0.1')
    return sorted(ips)


def local_hostname():
    if sys.platform == 'darwin':
        r = subprocess.run(['scutil', '--get', 'LocalHostName'], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip() + '.local'
    return None


def run(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f'{" ".join(cmd[:3])} … failed:\n{r.stderr}')


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(text)


def ensure_certs(ips, host):
    os.makedirs(CERT_DIR, mode=0o700, exist_ok=True)
    ossl = openssl()
    p = lambda name: os.path.join(CERT_DIR, name)

    if not (os.path.exists(p('ca.crt')) and os.path.exists(p('ca.key'))):
        print('Creating a local certificate authority for development…')
        write_private(p('ca.cnf'), '\n'.join([
            '[req]', 'distinguished_name=dn', 'x509_extensions=ext', 'prompt=no',
            '[dn]', 'CN=DTX Web Player dev CA', 'O=DTX Web Player (local development)',
            '[ext]', 'basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign',
            'subjectKeyIdentifier=hash', 'authorityKeyIdentifier=keyid:always', '',
        ]))
        run(ossl, 'req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
            '-days', '3650', '-keyout', p('ca.key'), '-out', p('ca.crt'), '-config', p('ca.cnf'))
        os.chmod(p('ca.key'), 0o600)

    names = ['localhost'] + ([host] if host else [])
    sans = [f'DNS:{n}' for n in names] + [f'IP:{ip}' for ip in ['127.0.0.1', *ips]]
    try:
        with open(p('server.sans')) as f:
            current = json.load(f)
    except (OSError, ValueError):
        current = None
    if current == sans and os.path.exists(p('server.crt')) and os.path.exists(p('server.key')):
        return p('server.crt'), p('server.key'), p('ca.crt')

    print('Issuing a server certificate for: ' + ', '.join(s.split(':', 1)[1] for s in sans))
    write_private(p('server.cnf'), '\n'.join([
        '[req]', 'distinguished_name=dn', 'prompt=no', '[dn]', 'CN=DTX Web Player dev server',
        '[ext]', 'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth', 'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid,issuer', 'subjectAltName=' + ','.join(sans), '',
    ]))
    run(ossl, 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
        '-keyout', p('server.key'), '-out', p('server.csr'), '-config', p('server.cnf'))
    os.chmod(p('server.key'), 0o600)
    # iOS rejects server certificates valid for more than 825 days.
    run(ossl, 'x509', '-req', '-in', p('server.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'),
        '-CAcreateserial', '-days', '800', '-sha256', '-out', p('server.crt'),
        '-extfile', p('server.cnf'), '-extensions', 'ext')
    with open(p('server.sans'), 'w') as f:
        json.dump(sans, f)
    return p('server.crt'), p('server.key'), p('ca.crt')


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    ca_path = None

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if self.ca_path and path == '/dev-ca.crt':
            with open(self.ca_path, 'rb') as f:
                body = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-x509-ca-cert')
            self.send_header('Content-Disposition', 'attachment; filename="dtx-dev-ca.crt"')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # Over HTTPS the app registers its service worker, whose cache-first
        # shell would serve stale code after edits. A 404 makes the browser
        # skip it (and drop an old one on its next update check).
        if not SERVE_SW and path == '/sw.js':
            self.send_error(404, 'Service worker disabled on the dev server (use --sw)')
            return
        super().do_GET()


server = http.server.ThreadingHTTPServer(('', PORT), NoCacheHandler)

if HTTPS:
    ips = lan_addresses()
    host = local_hostname()
    cert, key, ca = ensure_certs(ips, host)
    NoCacheHandler.ca_path = ca
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    urls = [f'https://localhost:{PORT}'] + [f'https://{h}:{PORT}' for h in ([host] if host else []) + ips]
    print('Serving DTX Web Player over HTTPS:')
    for u in urls:
        print('   ' + u)
    print(f'''
First time on an iPad/iPhone (once per device):
  1. Open https://{(ips or ['<this Mac>'])[0]}:{PORT}/dev-ca.crt in Safari, tap through the warning, Allow the download.
  2. Settings → General → VPN & Device Management → install "DTX Web Player dev CA".
  3. Settings → General → About → Certificate Trust Settings → turn on full trust for it.
On another Mac: open {ca} in Keychain Access and set it to "Always Trust".
Service worker: {'served' if SERVE_SW else 'disabled (pass --sw to test offline mode)'}.''')
else:
    print(f'Serving DTX Web Player at http://localhost:{PORT}')

server.serve_forever()
