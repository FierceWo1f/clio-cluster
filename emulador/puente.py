"""
Puente WebSocket <-> TCP para Clio Cluster.

Un navegador no puede abrir sockets TCP. Este puente recibe la conexión de la app
(ws://127.0.0.1:35001) y la reenvía a un ELM327 por red:
  - el emulador ELM327-emulator corriendo en modo red (127.0.0.1:35000), o
  - un ELM327 WiFi real (normalmente 192.168.0.10:35000).

El destino se elige desde la app: ws://127.0.0.1:35001/?host=192.168.0.10&port=35000
"""

import asyncio
import ipaddress
import sys
from urllib.parse import urlparse, parse_qs

import websockets

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 35001
ALLOWED_ORIGINS = ("http://localhost", "http://127.0.0.1")


def destino_permitido(host: str) -> bool:
    """Solo localhost o red local: evita que el puente se use para salir a internet."""
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return host == "localhost"
    return ip.is_loopback or ip.is_private


async def atender(ws):
    origin = ws.request.headers.get("Origin", "")
    if origin and not origin.startswith(ALLOWED_ORIGINS):
        print(f"Rechazado: origen no permitido {origin!r}")
        await ws.close(1008, "Origen no permitido")
        return

    q = parse_qs(urlparse(ws.request.path).query)
    host = q.get("host", ["127.0.0.1"])[0]
    port = int(q.get("port", ["35000"])[0])
    if not destino_permitido(host):
        await ws.close(1008, "Destino no permitido")
        return

    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=5)
    except Exception as e:
        print(f"No se pudo conectar a {host}:{port}: {e}")
        await ws.close(1011, f"No se pudo conectar a {host}:{port}")
        return

    print(f"Conectado: app <-> {host}:{port}")

    async def tcp_a_ws():
        while data := await reader.read(4096):
            await ws.send(data.decode("latin-1"))

    async def ws_a_tcp():
        async for msg in ws:
            writer.write(msg.encode("latin-1") if isinstance(msg, str) else msg)
            await writer.drain()

    tareas = [asyncio.create_task(tcp_a_ws()), asyncio.create_task(ws_a_tcp())]
    try:
        await asyncio.wait(tareas, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tareas:
            t.cancel()
        writer.close()
        await ws.close()
        print(f"Desconectado de {host}:{port}")


async def main():
    async with websockets.serve(atender, LISTEN_HOST, LISTEN_PORT):
        print(f"Puente listo en ws://{LISTEN_HOST}:{LISTEN_PORT}  (Ctrl+C para salir)")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
