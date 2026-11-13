"""Servidor HTTP local mínimo (biblioteca estándar) para el visor.

Sirve:
  /            -> archivos estáticos de codemap/viewer/
  /graph.json  -> ~/.codemap/<hash>/graph.json del proyecto analizado

Escucha solo en 127.0.0.1 con puerto dinámico (puerto 0 = el SO elige uno libre).
Nota: en la Etapa 4 se reemplaza por aiohttp + WebSocket.
"""

from __future__ import annotations

import functools
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VIEWER_DIR = Path(__file__).parent / "viewer"


class ViewerRequestHandler(SimpleHTTPRequestHandler):
    """Archivos estáticos del visor + graph.json desde el almacenamiento central."""

    def __init__(self, *args, graph_path: Path, **kwargs) -> None:
        self.graph_path = graph_path
        super().__init__(*args, directory=str(VIEWER_DIR), **kwargs)

    def do_GET(self) -> None:  # noqa: N802 (nombre impuesto por http.server)
        if self.path.split("?")[0] == "/graph.json":
            self.send_graph()
            return
        super().do_GET()

    def send_graph(self) -> None:
        body = self.graph_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass  # silencioso: la consola queda para el resumen del análisis


def serve_viewer(graph_path: Path, open_browser: bool = True) -> None:
    handler = functools.partial(ViewerRequestHandler, graph_path=graph_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Visor disponible en {url}  (Ctrl+C para salir)")
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        server.server_close()
