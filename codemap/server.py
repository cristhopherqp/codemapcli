"""Servidor HTTP + WebSocket unificado con aiohttp (puerto dinámico 127.0.0.1).

Sirve:
  /               -> index.html y estáticos de codemap/viewer/
  /graph.json     -> grafo estructural vigente en memoria / disco
  /export.ai.json -> grafo minificado/podado para modelos de IA (?include_flow=0|1)
  /export.ai.md   -> resumen estructurado Markdown con Mermaid (?include_flow=0|1)
  /notes.json     -> GET carga notes.json; POST aplica cambios parciales
  /known-apis     -> GET carga ~/.codemap/known_apis.json; POST marca/desmarca APIs
  /ws             -> WebSocket bidireccional (push de recarga en vivo + guardado)
"""

from __future__ import annotations

import asyncio
import json
import webbrowser
from collections.abc import Callable
from pathlib import Path

from aiohttp import WSMsgType, web

from codemap.exporter import build_ai_markdown, serialize_ai_graph
from codemap.known_apis_storage import load_known_apis, update_known_apis
from codemap.notes_storage import load_notes, update_notes
from codemap.watcher import start_watcher

VIEWER_DIR = Path(__file__).parent / "viewer"
NO_STORE_HEADERS = {"Cache-Control": "no-store"}

APP_TARGET_PATH = web.AppKey("target_path", str)
APP_GRAPH = web.AppKey("graph", dict)
APP_REBUILD_FN = web.AppKey("rebuild_fn", object)
APP_WEBSOCKETS = web.AppKey("websockets", set)
APP_REBUILD_LOCK = web.AppKey("rebuild_lock", asyncio.Lock)


def create_app(
    target_path: str,
    graph: dict,
    rebuild_fn: Callable[[], tuple[dict, dict]] | None = None,
) -> web.Application:
    """Construye la aplicación aiohttp con rutas REST, WebSocket y estáticos."""
    app = web.Application()
    app[APP_TARGET_PATH] = target_path
    app[APP_GRAPH] = graph
    app[APP_REBUILD_FN] = rebuild_fn
    app[APP_WEBSOCKETS] = set()
    app[APP_REBUILD_LOCK] = asyncio.Lock()

    app.router.add_get("/", handle_index)
    app.router.add_get("/graph.json", handle_get_graph)
    app.router.add_get("/export.ai.json", handle_export_ai_json)
    app.router.add_get("/export.ai.md", handle_export_ai_markdown)
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

    notes = update_notes(request.app[APP_TARGET_PATH], payload, request.app[APP_GRAPH])
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

    known_apis = update_known_apis(payload)
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
        notes = update_notes(app[APP_TARGET_PATH], payload, app[APP_GRAPH])
        await ws.send_json({"type": "notes_updated", "notes": notes})
    elif msg_type == "save_known_apis" and isinstance(payload, dict):
        known_apis = update_known_apis(payload)
        await _broadcast_json(app, {"type": "known_apis_updated", "known_apis": known_apis})


async def _broadcast_json(app: web.Application, payload: dict) -> None:
    stale: list[web.WebSocketResponse] = []
    for ws in list(app[APP_WEBSOCKETS]):
        if ws.closed:
            stale.append(ws)
            continue
        try:
            await ws.send_json(payload)
        except ConnectionResetError:
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
        graph, notes = await asyncio.to_thread(rebuild_fn)
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
