"""
Hub de Clio: servidor web + relay WebSocket. Solo usa la librería estándar de Python,
así corre en Termux (estéreo) o en la PC sin instalar nada.

  - Sirve los archivos del repo:   http://<ip>:8080/...
  - Relay WebSocket:               ws://<ip>:8080/ws?role=motor|pantalla|...
    Cada mensaje que manda un cliente se reenvía a todos los demás tal cual.
    El hub no interpreta los mensajes; solo avisa cuando alguien entra o sale
    con {"t":"hub","clients":[...roles]}.

Uso:  python hub/hub.py [--port 8080] [--host 0.0.0.0]
"""

import argparse
import asyncio
import base64
import hashlib
import json
import os
import struct
import sys
from urllib.parse import unquote, urlsplit, parse_qs

ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_HEADER = 16 * 1024
MAX_FRAME = 1024 * 1024
QUEUE_MAX = 256  # mensajes pendientes por cliente; si se llena se tiran los más viejos

# Tabla propia: en Windows el registro a veces sirve .js como text/plain y rompe los módulos.
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json", ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".wav": "audio/wav",
    ".lrc": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8", ".pmtiles": "application/octet-stream",
    ".bin": "application/octet-stream",
}

clients = set()


class Client:
    def __init__(self, writer, role):
        self.writer = writer
        self.role = role
        self.queue = asyncio.Queue(maxsize=QUEUE_MAX)

    def push(self, frame):
        if self.queue.full():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self.queue.put_nowait(frame)

    async def send_loop(self):
        while True:
            frame = await self.queue.get()
            if frame is None:
                return
            self.writer.write(frame)
            await self.writer.drain()


def ws_frame(opcode, payload):
    n = len(payload)
    if n < 126:
        head = struct.pack("!BB", 0x80 | opcode, n)
    elif n < 65536:
        head = struct.pack("!BBH", 0x80 | opcode, 126, n)
    else:
        head = struct.pack("!BBQ", 0x80 | opcode, 127, n)
    return head + payload


async def read_frame(reader):
    b1, b2 = await reader.readexactly(2)
    fin, opcode = b1 & 0x80, b1 & 0x0F
    masked, n = b2 & 0x80, b2 & 0x7F
    if n == 126:
        (n,) = struct.unpack("!H", await reader.readexactly(2))
    elif n == 127:
        (n,) = struct.unpack("!Q", await reader.readexactly(8))
    if n > MAX_FRAME:
        raise ValueError("frame demasiado grande")
    mask = await reader.readexactly(4) if masked else None
    data = await reader.readexactly(n)
    if mask:
        data = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
    return bool(fin), opcode, data


def broadcast(sender, frame):
    for c in clients:
        if c is not sender:
            c.push(frame)


def announce():
    msg = json.dumps({"t": "hub", "clients": sorted(c.role for c in clients)}).encode()
    frame = ws_frame(1, msg)
    for c in clients:
        c.push(frame)


async def handle_ws(reader, writer, headers, query):
    key = headers.get("sec-websocket-key", "")
    accept = base64.b64encode(hashlib.sha1(key.encode() + WS_GUID).digest()).decode()
    writer.write((
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
    await writer.drain()

    role = (query.get("role", ["?"])[0] or "?")[:24]
    client = Client(writer, role)
    clients.add(client)
    sender_task = asyncio.create_task(client.send_loop())
    peer = writer.get_extra_info("peername")
    print(f"+ {role} {peer[0] if peer else ''}  ({len(clients)} conectados)")
    announce()

    parts, part_op = [], 0
    try:
        while True:
            fin, opcode, data = await read_frame(reader)
            if opcode == 0x8:  # close
                client.push(ws_frame(0x8, data[:2]))
                break
            if opcode == 0x9:  # ping
                client.push(ws_frame(0xA, data))
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode in (0x1, 0x2):
                parts, part_op = [data], opcode
            elif opcode == 0x0:
                parts.append(data)
            if fin and parts:
                broadcast(client, ws_frame(part_op, b"".join(parts)))
                parts = []
    except (asyncio.IncompleteReadError, ConnectionError, ValueError):
        pass
    finally:
        clients.discard(client)
        sender_task.cancel()
        try:
            writer.close()
        except Exception:
            pass
        print(f"- {role}  ({len(clients)} conectados)")
        announce()


async def handle_http(writer, method, path):
    rel = unquote(path).lstrip("/")
    full = os.path.realpath(os.path.join(ROOT, rel))
    if full != ROOT and not full.startswith(ROOT + os.sep):
        return await respond(writer, 403, b"Prohibido")
    if os.path.isdir(full):
        if not path.endswith("/"):
            return await respond(writer, 301, b"", {"Location": path + "/"})
        full = os.path.join(full, "index.html")
    if not os.path.isfile(full):
        return await respond(writer, 404, b"No encontrado")
    ext = os.path.splitext(full)[1].lower()
    with open(full, "rb") as f:
        body = f.read()
    await respond(writer, 200, body if method == "GET" else b"",
                  {"Content-Type": MIME.get(ext, "application/octet-stream"),
                   "Cache-Control": "no-cache"}, length=len(body))


async def respond(writer, status, body, extra=None, length=None):
    reason = {200: "OK", 301: "Moved", 400: "Bad Request", 403: "Forbidden",
              404: "Not Found", 405: "Method Not Allowed"}.get(status, "")
    hdrs = {"Content-Length": str(len(body) if length is None else length), "Connection": "close"}
    hdrs.update(extra or {})
    head = f"HTTP/1.1 {status} {reason}\r\n" + "".join(f"{k}: {v}\r\n" for k, v in hdrs.items())
    writer.write(head.encode() + b"\r\n" + body)
    await writer.drain()
    writer.close()


async def on_connect(reader, writer):
    try:
        raw = await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
        writer.close()
        return
    lines = raw.decode("latin-1").split("\r\n")
    try:
        method, target, _ = lines[0].split(" ", 2)
    except ValueError:
        return await respond(writer, 400, b"")
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    url = urlsplit(target)

    if url.path == "/ws" and headers.get("upgrade", "").lower() == "websocket":
        return await handle_ws(reader, writer, headers, parse_qs(url.query))
    if url.path == "/hub/status":
        body = json.dumps({"clients": sorted(c.role for c in clients)}).encode()
        return await respond(writer, 200, body, {"Content-Type": "application/json",
                                                 "Access-Control-Allow-Origin": "*"})
    if method not in ("GET", "HEAD"):
        return await respond(writer, 405, b"")
    try:
        await handle_http(writer, method, url.path)
    except ConnectionError:
        pass


def local_ips():
    """IPs IPv4 de este equipo (sin loopback), para saber qué dirección abrir en el estéreo."""
    # Nunca debe tumbar el hub: si no se pueden leer las IPs, simplemente no se muestran.
    try:
        import fcntl  # noqa: F401  (solo existe en Linux / Android)
    except ImportError:
        return _ips_windows()
    try:
        return _ips_linux()
    except Exception:
        return []


def _ips_linux():
    # SIOCGIFCONF (ioctl clásico). En Android 11+ Termux no puede usar netlink
    # (socket.if_nameindex da "Permission denied"), pero este ioctl sí funciona.
    import array
    import fcntl
    import socket
    ifreq = 40 if struct.calcsize("P") == 8 else 32  # tamaño de struct ifreq en 64 / 32 bits
    size = ifreq * 64
    buf = array.array("B", bytes(size))
    addr = buf.buffer_info()[0]
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        res = fcntl.ioctl(s.fileno(), 0x8912, struct.pack("iP", size, addr))  # SIOCGIFCONF
    used = struct.unpack("iP", res)[0]
    data = buf.tobytes()
    found = []
    for off in range(0, used, ifreq):
        name = data[off:off + 16].split(b"\0", 1)[0].decode(errors="replace")
        ip = socket.inet_ntoa(data[off + 20:off + 24])  # sockaddr_in: familia(2) + puerto(2) + IP
        if not ip.startswith("127."):
            found.append((name, ip))
    return found


def _ips_windows():
    import socket
    try:
        ips = sorted({a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)})
    except OSError:
        return []
    return [("red", ip) for ip in ips if not ip.startswith("127.")]


async def main():
    try:
        sys.stdout.reconfigure(line_buffering=True)  # ver el log en vivo aunque se redirija
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description="Hub de Clio (web + relay WebSocket)")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8080)
    args = ap.parse_args()
    server = await asyncio.start_server(on_connect, args.host, args.port, limit=MAX_HEADER)
    print(f"Hub listo (carpeta {ROOT})   Ctrl+C para salir")
    print(f"  En este equipo:  http://localhost:{args.port}/tools/linktest/")
    for name, ip in local_ips():
        print(f"  Desde el estéreo ({name}):  http://{ip}:{args.port}/tools/linktest/")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
