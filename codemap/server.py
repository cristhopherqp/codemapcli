"""Servidor HTTP + WebSocket unificado con aiohttp (puerto dinámico 127.0.0.1).

Sirve:
  /               -> index.html y estáticos de codemap/viewer/
  /graph.json     -> grafo estructural vigente en memoria / disco
  /export.ai.json -> grafo minificado/podado para modelos de IA (?include_flow=0|1)
  /export.ai.md   -> resumen estructurado Markdown con Mermaid (?include_flow=0|1)
  /source         -> código fuente en solo lectura de un nodo (?node_id=<id>)
  /notes.json     -> GET carga notes.json; POST aplica cambios parciales
  /known-apis     -> GET carga ~/.codemap/known_apis.json; POST marca/desmarca APIs
  /ws             -> WebSocket bidireccional (push de recarga en vivo + guardado)
"""

from __future__ import annotations

import asyncio
import json
import sys
import webbrowser
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web

from codemap.exporter import build_ai_markdown, serialize_ai_graph
from codemap.known_apis_storage import load_known_apis, update_known_apis
from codemap.notes_storage import load_notes, update_notes
from codemap.watcher import start_watcher

VIEWER_DIR = Path(__file__).parent / "viewer"
NO_STORE_HEADERS = {"Cache-Control": "no-store"}
ALLOWED_LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

APP_TARGET_PATH = web.AppKey("target_path", str)
APP_GRAPH = web.AppKey("graph", dict)
APP_REBUILD_FN = web.AppKey("rebuild_fn", object)
APP_WEBSOCKETS = web.AppKey("websockets", set)
APP_REBUILD_LOCK = web.AppKey("rebuild_lock", asyncio.Lock)
APP_NOTES_LOCK = web.AppKey("notes_lock", asyncio.Lock)
APP_BOUND_PORT = web.AppKey("bound_port", int)


def _expected_port(request: web.Request) -> int | None:
    bound_port = request.app.get(APP_BOUND_PORT)
    if isinstance(bound_port, int) and bound_port > 0:
        return bound_port
    transport = request.transport
    if transport is not None:
        sockname = transport.get_extra_info("sockname")
        if isinstance(sockname, tuple) and len(sockname) >= 2 and isinstance(sockname[1], int):
            return sockname[1]
    return None


def _is_allowed_host_header(raw_host: str, expected_port: int | None) -> bool:
    host = raw_host.strip()
    if not host:
        return False
    try:
        parsed = urlsplit(f"http://{host}")
        port = parsed.port
    except ValueError:
        return False
    if parsed.username is not None or parsed.password is not None:
        return False
    if parsed.path or parsed.query or parsed.fragment:
        return False
    hostname = (parsed.hostname or "").lower()
    if hostname not in ALLOWED_LOCAL_HOSTS:
        return False
    if expected_port is not None:
        effective_port = port if port is not None else 80
        if effective_port != expected_port:
            return False
    return True


def _is_allowed_origin_header(raw_origin: str, expected_port: int | None) -> bool:
    origin = raw_origin.strip()
    if not origin or origin.lower() == "null":
        return False
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError:
        return False
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        return False
    if parsed.username is not None or parsed.password is not None:
        return False
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        return False
    hostname = (parsed.hostname or "").lower()
    if hostname not in ALLOWED_LOCAL_HOSTS:
        return False
    if expected_port is not None:
        default_port = 443 if scheme == "https" else 80
        effective_port = port if port is not None else default_port
        if effective_port != expected_port:
            return False
    return True


@web.middleware
async def local_origin_middleware(
    request: web.Request,
    handler: Callable[[web.Request], object],
) -> web.StreamResponse:
    """Restringe el servidor local a Host/Origin loopback en el puerto asignado."""
    expected_port = _expected_port(request)
    raw_host = request.headers.get("Host") or request.host or ""
    if not _is_allowed_host_header(raw_host, expected_port):
        return web.json_response({"error": "Host no permitido"}, status=403, headers=NO_STORE_HEADERS)

    raw_origin = request.headers.get("Origin")
    if raw_origin is not None and not _is_allowed_origin_header(raw_origin, expected_port):
        return web.json_response({"error": "Origin no permitido"}, status=403, headers=NO_STORE_HEADERS)

    return await handler(request)


def create_app(
    target_path: str,
    graph: dict,
    rebuild_fn: Callable[[], tuple[dict, dict]] | None = None,
) -> web.Application:
    """Construye la aplicación aiohttp con rutas REST, WebSocket y estáticos."""
    app = web.Application(middlewares=[local_origin_middleware])
    app[APP_TARGET_PATH] = target_path
    app[APP_GRAPH] = graph
    app[APP_REBUILD_FN] = rebuild_fn
    app[APP_WEBSOCKETS] = set()
    app[APP_REBUILD_LOCK] = asyncio.Lock()
    app[APP_NOTES_LOCK] = asyncio.Lock()

    app.router.add_get("/", handle_index)
    app.router.add_get("/graph.json", handle_get_graph)
    app.router.add_get("/export.ai.json", handle_export_ai_json)
    app.router.add_get("/export.ai.md", handle_export_ai_markdown)
    app.router.add_get("/source", handle_get_source)
    app.router.add_get("/notes.json", handle_get_notes)
    app.router.add_post("/notes.json", handle_post_notes)
    app.router.add_get("/known-apis", handle_get_known_apis)
    app.router.add_post("/known-apis", handle_post_known_apis)
    app.router.add_get("/ws", handle_websocket)
    app.router.add_static("/", VIEWER_DIR, show_index=False)
    app.on_shutdown.append(close_websockets)
    return app


async def handle_index(_request: web.Request) -> web.FileResponse:
    return web.FileResponse(VIEWER_DIR / "index.html", headers=NO_STORE_HEADERS)


async def handle_get_graph(request: web.Request) -> web.Response:
    return web.json_response(request.app[APP_GRAPH], headers=NO_STORE_HEADERS)


def _parse_bool_query(request: web.Request, name: str) -> bool:
    raw = request.query.get(name, "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


async def handle_export_ai_json(request: web.Request) -> web.Response:
    include_flow = _parse_bool_query(request, "include_flow")
    graph = request.app[APP_GRAPH]
    payload = serialize_ai_graph(graph, include_flow=include_flow)
    raw_bytes = len(json.dumps(graph, indent=2, ensure_ascii=False).encode("utf-8"))
    headers = {
        **NO_STORE_HEADERS,
        "X-CodeMap-Raw-Bytes": str(raw_bytes),
    }
    return web.Response(
        text=payload,
        content_type="application/json",
        charset="utf-8",
        headers=headers,
    )


async def handle_export_ai_markdown(request: web.Request) -> web.Response:
    include_flow = _parse_bool_query(request, "include_flow")
    graph = request.app[APP_GRAPH]
    markdown = build_ai_markdown(graph, include_flow=include_flow)
    return web.Response(
        text=markdown,
        content_type="text/markdown",
        charset="utf-8",
        headers=NO_STORE_HEADERS,
    )


def _is_within_project_target(file_path: Path, target_path: str) -> bool:
    """Confirma que `file_path` permanece estrictamente confinado al proyecto analizado."""
    try:
        resolved_file = file_path.resolve()
        resolved_target = Path(target_path).resolve()
    except OSError:
        return False
    if resolved_target.is_file():
        return resolved_file == resolved_target
    return resolved_file.is_relative_to(resolved_target)


def _read_source_slice(file_path: Path, start_line: int, end_line: int | None) -> tuple[int, int, str, list[dict]]:
    raw = file_path.read_text(encoding="utf-8", errors="replace")
    normalized = raw.replace("\r\n", "\n").replace("\r", "\n")
    all_lines = normalized.split("\n")
    if all_lines and all_lines[-1] == "":
        all_lines.pop()
    total = len(all_lines)
    if total == 0:
        return 1, 1, "", []

    clamped_start = max(1, min(start_line, total))
    requested_end = total if end_line is None or end_line <= 0 else end_line
    clamped_end = max(clamped_start, min(requested_end, total))
    sliced = all_lines[clamped_start - 1 : clamped_end]
    lines_payload = [
        {"number": clamped_start + offset, "text": text}
        for offset, text in enumerate(sliced)
    ]
    return clamped_start, clamped_end, "\n".join(sliced), lines_payload


async def handle_get_source(request: web.Request) -> web.Response:
    """Sirve en solo lectura el fragmento de código fuente de un nodo del grafo actual."""
    node_id = request.query.get("node_id", "").strip()
    if not node_id:
        return web.json_response({"error": "Parámetro node_id requerido"}, status=400, headers=NO_STORE_HEADERS)

    graph = request.app[APP_GRAPH]
    nodes_by_id = {n["id"]: n for n in graph.get("nodes", []) if isinstance(n, dict) and "id" in n}
    node = nodes_by_id.get(node_id)
    if node is None:
        return web.json_response({"error": "Nodo no encontrado"}, status=404, headers=NO_STORE_HEADERS)

    node_type = node.get("type")
    if node_type == "function":
        file_node = nodes_by_id.get(node.get("parent") or "")
        file_path_str = file_node.get("file_path") if isinstance(file_node, dict) else None
        file_id = file_node.get("id", "") if isinstance(file_node, dict) else ""
        language = file_node.get("language", "") if isinstance(file_node, dict) else ""
        req_start = max(1, int(node.get("line") or 1))
        raw_end = int(node.get("end_line") or 0)
        req_end: int | None = raw_end if raw_end >= req_start else req_start
    elif node_type == "file":
        file_path_str = node.get("file_path")
        file_id = node.get("id", "")
        language = node.get("language", "")
        req_start = 1
        req_end = None
    else:
        return web.json_response(
            {"error": "El nodo seleccionado no tiene código fuente asociado"},
            status=400,
            headers=NO_STORE_HEADERS,
        )

    if not file_path_str:
        return web.json_response({"error": "Ruta de archivo no disponible"}, status=404, headers=NO_STORE_HEADERS)

    file_path = Path(file_path_str)
    if not _is_within_project_target(file_path, request.app[APP_TARGET_PATH]):
        return web.json_response({"error": "Archivo fuera del proyecto analizado"}, status=403, headers=NO_STORE_HEADERS)
    if not file_path.is_file():
        return web.json_response({"error": "Archivo no encontrado en disco"}, status=404, headers=NO_STORE_HEADERS)

    try:
        start_line, end_line, code, lines_payload = await asyncio.to_thread(
            _read_source_slice, file_path, req_start, req_end
        )
    except OSError:
        return web.json_response({"error": "No se pudo leer el archivo fuente"}, status=500, headers=NO_STORE_HEADERS)

    return web.json_response(
        {
            "node_id": node_id,
            "file_id": file_id,
            "language": language,
            "start_line": start_line,
            "end_line": end_line,
            "code": code,
            "lines": lines_payload,
        },
        headers=NO_STORE_HEADERS,
    )


async def handle_get_notes(request: web.Request) -> web.Response:
    notes = load_notes(request.app[APP_TARGET_PATH])
    return web.json_response(notes, headers=NO_STORE_HEADERS)


async def handle_post_notes(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "JSON inválido"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"error": "Se esperaba un objeto JSON"}, status=400)

    async with request.app[APP_NOTES_LOCK]:
        notes = await asyncio.to_thread(
            update_notes, request.app[APP_TARGET_PATH], payload, request.app[APP_GRAPH]
        )
    await _broadcast_json(request.app, {"type": "notes_updated", "notes": notes})
    return web.json_response(notes, headers=NO_STORE_HEADERS)


async def handle_get_known_apis(_request: web.Request) -> web.Response:
    return web.json_response(load_known_apis(), headers=NO_STORE_HEADERS)


async def handle_post_known_apis(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "JSON inválido"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"error": "Se esperaba un objeto JSON"}, status=400)

    known_apis = await asyncio.to_thread(update_known_apis, payload)
    await _broadcast_json(request.app, {"type": "known_apis_updated", "known_apis": known_apis})
    return web.json_response(known_apis, headers=NO_STORE_HEADERS)


async def handle_websocket(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    request.app[APP_WEBSOCKETS].add(ws)

    try:
        notes = load_notes(request.app[APP_TARGET_PATH])
        known_apis = load_known_apis()
        await ws.send_json(
            {"type": "init", "graph": request.app[APP_GRAPH], "notes": notes, "known_apis": known_apis}
        )

        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            await _handle_ws_message(request.app, ws, msg.data)
    finally:
        request.app[APP_WEBSOCKETS].discard(ws)

    return ws


async def _handle_ws_message(app: web.Application, ws: web.WebSocketResponse, raw_data: str) -> None:
    try:
        message = json.loads(raw_data)
    except json.JSONDecodeError:
        return
    msg_type = message.get("type")
    payload = message.get("payload")
    if msg_type == "save_notes" and isinstance(payload, dict):
        async with app[APP_NOTES_LOCK]:
            notes = await asyncio.to_thread(
                update_notes, app[APP_TARGET_PATH], payload, app[APP_GRAPH]
            )
        await _broadcast_json(app, {"type": "notes_updated", "notes": notes})
    elif msg_type == "save_known_apis" and isinstance(payload, dict):
        known_apis = await asyncio.to_thread(update_known_apis, payload)
        await _broadcast_json(app, {"type": "known_apis_updated", "known_apis": known_apis})


async def _broadcast_json(app: web.Application, payload: dict) -> None:
    stale: list[web.WebSocketResponse] = []
    for ws in list(app[APP_WEBSOCKETS]):
        if ws.closed:
            stale.append(ws)
            continue
        try:
            await ws.send_json(payload)
        except (ConnectionResetError, RuntimeError):
            stale.append(ws)
    for ws in stale:
        app[APP_WEBSOCKETS].discard(ws)


async def broadcast_update(app: web.Application, graph: dict, notes: dict) -> None:
    """Envía el nuevo grafo y las notas conciliadas a todos los visores conectados."""
    await _broadcast_json(app, {"type": "update", "graph": graph, "notes": notes})


async def rebuild_and_broadcast(app: web.Application) -> None:
    rebuild_fn = app[APP_REBUILD_FN]
    if rebuild_fn is None:
        return
    async with app[APP_REBUILD_LOCK]:
        try:
            graph, notes = await asyncio.to_thread(rebuild_fn)
        except Exception as exc:  # noqa: BLE001
            print(f"[CodeMap] Error al reconstruir el grafo: {exc}", file=sys.stderr)
            return
        app[APP_GRAPH] = graph
        await broadcast_update(app, graph, notes)


async def close_websockets(app: web.Application) -> None:
    for ws in list(app[APP_WEBSOCKETS]):
        await ws.close()
    app[APP_WEBSOCKETS].clear()


async def run_server(
    target_path: str,
    graph: dict,
    rebuild_fn: Callable[[], tuple[dict, dict]] | None,
    watch: bool = True,
    open_browser: bool = True,
) -> None:
    app = create_app(target_path, graph, rebuild_fn=rebuild_fn)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()

    observer = None
    try:
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]  # noqa: SLF001
        app[APP_BOUND_PORT] = port
        url = f"http://127.0.0.1:{port}/"

        if watch and rebuild_fn is not None:
            loop = asyncio.get_running_loop()
            target = Path(target_path)
            observer = start_watcher(
                target=target,
                is_single_file=target.is_file(),
                loop=loop,
                on_rebuild=lambda: rebuild_and_broadcast(app),
            )
            print(f"Visor en vivo en {url}  (observando cambios, Ctrl+C para salir)")
        else:
            print(f"Visor disponible en {url}  (modo estático --once, Ctrl+C para salir)")

        if open_browser:
            webbrowser.open(url)

        await asyncio.Event().wait()
    finally:
        if observer is not None:
            observer.stop()
            observer.join(timeout=2)
        await runner.cleanup()


def serve_viewer(
    target_path: str,
    graph: dict,
    rebuild_fn: Callable[[], tuple[dict, dict]] | None = None,
    watch: bool = True,
    open_browser: bool = True,
) -> None:
    try:
        asyncio.run(run_server(target_path, graph, rebuild_fn, watch=watch, open_browser=open_browser))
    except KeyboardInterrupt:
        print("\nServidor detenido.")
