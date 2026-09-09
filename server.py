#!/usr/bin/env python3
"""Static file server for Spin Doctor.

Browsers only expose motion sensors on secure origins, so by default this
serves over HTTPS using a self-signed certificate generated with the `openssl`
CLI on first run. On your phone, accept the certificate warning once and the
gyro will work.

Usage:
  python3 server.py              # HTTPS on 0.0.0.0:8443
  python3 server.py --port 9000  # custom port
  python3 server.py --http       # plain HTTP (fine for desktop drag testing,
                                 #  but phone gyro will NOT work)
"""
import argparse
import functools
import http.server
import os
import socket
import ssl
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(ROOT, ".certs")


def make_cert():
    cert = os.path.join(CERT_DIR, "cert.pem")
    key = os.path.join(CERT_DIR, "key.pem")
    if os.path.exists(cert) and os.path.exists(key):
        return cert, key
    os.makedirs(CERT_DIR, exist_ok=True)
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256",
         "-nodes", "-days", "3650",
         "-keyout", key, "-out", cert,
         "-subj", "/CN=spin-doctor.local",
         "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
        check=True, capture_output=True,
    )
    return cert, key


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--http", action="store_true", help="serve plain HTTP instead of HTTPS")
    args = ap.parse_args()

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, fmt, *a):
            sys.stderr.write("  %s - %s\n" % (self.address_string(), fmt % a))

    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), handler)
    scheme = "http"
    if not args.http:
        try:
            cert, key = make_cert()
        except (OSError, subprocess.CalledProcessError) as e:
            sys.exit(f"Could not create a self-signed cert ({e}).\n"
                     f"Install openssl, or run with --http (desktop testing only).")
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"

    ip = lan_ip()
    print()
    print("  Spin Doctor is spinning up.")
    print()
    print(f"  On this Mac:   {scheme}://localhost:{args.port}")
    print(f"  On your phone: {scheme}://{ip}:{args.port}   (same Wi-Fi)")
    if scheme == "https":
        print()
        print("  First visit on the phone: accept the self-signed certificate")
        print("  warning (iOS: Show Details -> visit this website). Then tap")
        print("  'Enable motion sensors' inside the app.")
    print("  Ctrl-C to stop.")
    print()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
