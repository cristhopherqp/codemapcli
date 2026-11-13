/* Visor Web Local de CodeMap (v1.0 — Etapas 1 a 4)
 * - Cytoscape.js + ELKjs con nodos compuestos colapsables
 * - Fusión cliente de graph.json + notes.json
 * - WebSocket en vivo (/ws), anclaje híbrido (pinned), Modo Foco (T) y Ctrl+K
 */

/* Opciones globales de ELKjs para el grafo jerárquico:
 * - algorithm: 'layered' (Sugiyama) ordena las llamadas por capas dirigidas.
 * - direction: 'DOWN' ubica puntos de entrada arriba y destinos abajo.
 * - hierarchyHandling: 'INCLUDE_CHILDREN' calcula contenedores compuestos y
 *   aristas que cruzan fronteras de módulos/archivos en una sola pasada.
 * - layered.spacing.nodeNodeBetweenLayers: distancia vertical entre capas.
 * - spacing.nodeNode: separación horizontal mínima entre nodos hermanos.
 * - padding: margen interior en contenedores para no tapar la etiqueta superior.
 * - crossingMinimization / nodePlacement: reduce cruces y alinea ramas.
 */
const ELK_LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "48",
  "elk.spacing.nodeNode": "32",
  "elk.padding": "[top=38,left=20,bottom=20,right=20]",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
};

const ROLE_LABELS = {
  entry: "Entrada",
  transform: "Transformación",
  decision: "Decisión",
  io: "I/O",
  module: "Módulo",
  file: "Archivo",
  flow: "Paso",
};

const NOTE_AUTOSAVE_MS = 500;

const state = {
  rawGraph: null,
  notes: { nodes: {}, orphans: [] },
  nodesById: new Map(),
  childrenByParent: new Map(),
  collapsedContainers: new Set(),
  expandedFunctions: new Set(),
  activeLevel: 2,
  selectedNodeId: null,
  traceMode: false,
  traceHistory: [],
  noteSaveTimer: null,
  searchMatches: [],
  searchActiveIndex: 0,
  ws: null,
  cy: null,
  elk: null,
};

// ---------------------------------------------------------------------------
// Inicialización, carga inicial y WebSocket en vivo
// ---------------------------------------------------------------------------

async function initViewer() {
  state.elk = new ELK();
  const [graphRes, notesRes] = await Promise.all([
    fetch("/graph.json", { cache: "no-store" }),
    fetch("/notes.json", { cache: "no-store" }),
  ]);
  if (!graphRes.ok) {
    throw new Error(`No se pudo cargar /graph.json (${graphRes.status})`);
  }

  state.rawGraph = await graphRes.json();
  state.notes = notesRes.ok ? await notesRes.json() : { nodes: {}, orphans: [] };
  indexGraph(state.rawGraph);

  renderHeader(state.rawGraph.meta, state.rawGraph.edges.length);
  updateOrphansBadge();
  initCytoscape();
  bindControls();
  connectWebSocket();

  const initialLevel = state.rawGraph.meta.recommended_level || 2;
  await applyLevel(initialLevel);
}

function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
  state.ws = ws;

  ws.addEventListener("open", () => {
    setLiveStatus("En vivo", "online");
  });

  ws.addEventListener("message", async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "update") {
      await applyLiveUpdate(msg.graph, msg.notes);
    } else if (msg.type === "notes_updated" && msg.notes) {
      state.notes = msg.notes;
      updateOrphansBadge();
    }
  });

  ws.addEventListener("close", () => {
    setLiveStatus("Desconectado", "offline");
  });
}

function setLiveStatus(text, cssClass) {
  const pill = document.getElementById("live-status");
  pill.textContent = text;
  pill.className = `live-pill ${cssClass}`;
}

async function applyLiveUpdate(newGraph, newNotes) {
  const zoom = state.cy.zoom();
  const pan = state.cy.pan();

  state.rawGraph = newGraph;
  if (newNotes) {
    state.notes = newNotes;
  }
  indexGraph(state.rawGraph);
  pruneStaleExpansionState();

  renderHeader(state.rawGraph.meta, state.rawGraph.edges.length);
  updateOrphansBadge();

  await refreshGraphView({ fit: false });
  state.cy.viewport({ zoom, pan });

  if (state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
    state.cy.getElementById(state.selectedNodeId).select();
    selectNode(state.selectedNodeId);
  } else {
    clearSelectionPanel();
  }
  applyTraceHighlight();
}

function pruneStaleExpansionState() {
  for (const id of Array.from(state.collapsedContainers)) {
    if (!state.nodesById.has(id)) {
      state.collapsedContainers.delete(id);
    }
  }
  for (const id of Array.from(state.expandedFunctions)) {
    if (!state.nodesById.has(id)) {
      state.expandedFunctions.delete(id);
    }
  }
}

function indexGraph(graph) {
  state.nodesById.clear();
  state.childrenByParent.clear();
  for (const node of graph.nodes) {
    state.nodesById.set(node.id, node);
    const parentKey = node.parent || null;
    if (!state.childrenByParent.has(parentKey)) {
      state.childrenByParent.set(parentKey, []);
    }
    state.childrenByParent.get(parentKey).push(node);
  }
}

function renderHeader(meta, edgeCount) {
  document.getElementById("project-title").textContent = meta.project_name;
  document.getElementById("project-stats").textContent =
    `${meta.total_functions} funciones · ${edgeCount} aristas`;
}

// ---------------------------------------------------------------------------
// Persistencia de notes.json (HTTP POST /notes.json)
// ---------------------------------------------------------------------------

function getNoteEntry(nodeId) {
  return state.notes.nodes[nodeId] || {
    note: "",
    pinned: false,
    x: null,
    y: null,
    custom_role: null,
    last_fingerprint: "",
  };
}

async function saveNotePatch(nodeId, patch) {
  const existing = getNoteEntry(nodeId);
  const rawNode = state.nodesById.get(nodeId);
  const merged = {
    ...existing,
    ...patch,
    last_fingerprint: (rawNode && rawNode.fingerprint) || existing.last_fingerprint || "",
  };
  state.notes.nodes[nodeId] = merged;

  const response = await fetch("/notes.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes: { [nodeId]: merged } }),
  });
  if (response.ok) {
    state.notes = await response.json();
  }
  return getNoteEntry(nodeId);
}

async function saveOrphansList(orphans) {
  state.notes.orphans = orphans;
  const response = await fetch("/notes.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orphans }),
  });
  if (response.ok) {
    state.notes = await response.json();
  }
  updateOrphansBadge();
}

// ---------------------------------------------------------------------------
// Niveles multiescala (Nivel 1, 2, 3 y 3+)
// ---------------------------------------------------------------------------

async function applyLevel(level) {
  state.activeLevel = level;
  updateLevelButtons(level);

  state.collapsedContainers.clear();
  state.expandedFunctions.clear();

  if (level === 1) {
    collapseTopModules();
  } else if (level === 3) {
    isolateFocusedFile();
  } else if (level === 4) {
    expandAllFunctionFlows();
  }

  await refreshGraphView({ fit: true });
}

function collapseTopModules() {
  const topNodes = state.childrenByParent.get(null) || [];
  const topModules = topNodes.filter((n) => n.type === "module");
  const targets = topModules.length > 0 ? topModules : topNodes.filter((n) => n.type === "file");
  for (const node of targets) {
    state.collapsedContainers.add(node.id);
  }
}

function isolateFocusedFile() {
  const focusedFileId = resolveSelectedFileId();
  if (!focusedFileId) {
    return;
  }
  for (const node of state.rawGraph.nodes) {
    if (node.type === "file" && node.id !== focusedFileId) {
      state.collapsedContainers.add(node.id);
    }
  }
}

function resolveSelectedFileId() {
  if (!state.selectedNodeId) {
    return null;
  }
  const node = state.nodesById.get(state.selectedNodeId);
  if (!node) {
    return null;
  }
  if (node.type === "file") {
    return node.id;
  }
  if (node.type === "function") {
    return node.parent;
  }
  return null;
}

function expandAllFunctionFlows() {
  for (const node of state.rawGraph.nodes) {
    if (node.type === "function" && node.internal_flow && node.internal_flow.length > 0) {
      state.expandedFunctions.add(node.id);
    }
  }
}

function updateLevelButtons(level) {
  for (const btn of document.querySelectorAll(".level-btn")) {
    const btnLevel = Number(btn.dataset.level);
    btn.classList.toggle("active", btnLevel === level);
  }
}

// ---------------------------------------------------------------------------
// Proyección jerárquica de nodos y aristas visibles (fusionando notes.json)
// ---------------------------------------------------------------------------

function buildDisplayLabel(rawNode, isCollapsed, noteEntry) {
  let label = rawNode.label;
  if (isCollapsed) {
    const childCount = countDescendantFunctions(rawNode.id);
    if (childCount > 0) {
      label = `${label} [+ ${childCount}]`;
    }
  }
  const badges = [];
  if (noteEntry.note && noteEntry.note.trim()) {
    badges.push("📝");
  }
  if (noteEntry.pinned) {
    badges.push("📌");
  }
  return badges.length > 0 ? `${label} ${badges.join("")}` : label;
}

function buildVisibleElements() {
  const visibleNodeIds = new Set();
  const nodes = [];

  for (const rawNode of state.rawGraph.nodes) {
    if (hasCollapsedAncestor(rawNode)) {
      continue;
    }
    visibleNodeIds.add(rawNode.id);

    const noteEntry = getNoteEntry(rawNode.id);
    const isCollapsed = state.collapsedContainers.has(rawNode.id);
    const isExpandedFn = rawNode.type === "function" && state.expandedFunctions.has(rawNode.id);
    const effectiveRole = noteEntry.custom_role || rawNode.role || rawNode.type;

    nodes.push({
      data: {
        id: rawNode.id,
        parent: rawNode.parent || undefined,
        label: buildDisplayLabel(rawNode, isCollapsed, noteEntry),
        type: rawNode.type,
        role: effectiveRole,
        pinned: noteEntry.pinned ? "true" : "false",
        hasNote: noteEntry.note && noteEntry.note.trim() ? "true" : "false",
        collapsed: isCollapsed ? "true" : "false",
        expandedFn: isExpandedFn ? "true" : "false",
      },
    });

    if (isExpandedFn) {
      appendInternalFlowElements(rawNode, nodes, visibleNodeIds);
    }
  }

  const edges = projectEdges(visibleNodeIds);
  appendInternalFlowEdges(nodes, edges);

  return { nodes, edges };
}

function appendInternalFlowElements(fnNode, nodes, visibleNodeIds) {
  for (const step of fnNode.internal_flow || []) {
    const stepId = `${fnNode.id}::${step.id}`;
    visibleNodeIds.add(stepId);
    nodes.push({
      data: {
        id: stepId,
        parent: fnNode.id,
        label: step.label,
        type: "flow",
        role: step.role,
        pinned: "false",
        hasNote: "false",
        collapsed: "false",
        expandedFn: "false",
        ownerFunctionId: fnNode.id,
      },
    });
  }
}

function appendInternalFlowEdges(nodes, edges) {
  const stepsByFn = new Map();
  for (const el of nodes) {
    if (el.data.type !== "flow") {
      continue;
    }
    const owner = el.data.ownerFunctionId;
    if (!stepsByFn.has(owner)) {
      stepsByFn.set(owner, []);
    }
    stepsByFn.get(owner).push(el.data.id);
  }

  for (const [owner, stepIds] of stepsByFn.entries()) {
    for (let i = 0; i < stepIds.length - 1; i += 1) {
      edges.push({
        data: {
          id: `flow_${owner}_${i}`,
          source: stepIds[i],
          target: stepIds[i + 1],
          confidence: "confirmed",
          call_count: 1,
          label: "",
          kind: "flow",
        },
      });
    }
  }
}

function hasCollapsedAncestor(node) {
  let parentId = node.parent;
  while (parentId) {
    if (state.collapsedContainers.has(parentId)) {
      return true;
    }
    const parentNode = state.nodesById.get(parentId);
    parentId = parentNode ? parentNode.parent : null;
  }
  return false;
}

function countDescendantFunctions(containerId) {
  const children = state.childrenByParent.get(containerId) || [];
  let total = 0;
  for (const child of children) {
    if (child.type === "function") {
      total += 1;
    } else {
      total += countDescendantFunctions(child.id);
    }
  }
  return total;
}

function resolveVisibleEndpoint(nodeId, visibleNodeIds) {
  let currentId = nodeId;
  while (currentId) {
    if (visibleNodeIds.has(currentId)) {
      return currentId;
    }
    const current = state.nodesById.get(currentId);
    currentId = current ? current.parent : null;
  }
  return null;
}

function projectEdges(visibleNodeIds) {
  const grouped = new Map();

  for (const edge of state.rawGraph.edges) {
    const source = resolveVisibleEndpoint(edge.source, visibleNodeIds);
    const target = resolveVisibleEndpoint(edge.target, visibleNodeIds);
    if (!source || !target) {
      continue;
    }
    if (source === target && (source !== edge.source || target !== edge.target)) {
      continue;
    }

    const key = `${source}->${target}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        source,
        target,
        confidence: edge.confidence,
        call_count: edge.call_count || 1,
      });
    } else {
      existing.call_count += edge.call_count || 1;
      if (edge.confidence === "confirmed") {
        existing.confidence = "confirmed";
      }
    }
  }

  const projected = [];
  let idx = 1;
  for (const item of grouped.values()) {
    projected.push({
      data: {
        id: `pe_${idx++}`,
        source: item.source,
        target: item.target,
        confidence: item.confidence,
        call_count: item.call_count,
        label: item.call_count > 1 ? `×${item.call_count}` : "",
        kind: "call",
      },
    });
  }
  return projected;
}

// ---------------------------------------------------------------------------
// Cytoscape.js + ELKjs layout híbrido (respetando nodos pinned)
// ---------------------------------------------------------------------------

function initCytoscape() {
  state.cy = cytoscape({
    container: document.getElementById("cy"),
    elements: [],
    style: buildStylesheet(),
    wheelSensitivity: 0.25,
    minZoom: 0.15,
    maxZoom: 3,
  });

  state.cy.on("tap", "node", (event) => {
    const data = event.target.data();
    const targetId = data.ownerFunctionId || data.id;
    selectNode(targetId);
    if (state.traceMode) {
      applyTraceHighlight();
    }
  });

  state.cy.on("tap", (event) => {
    if (event.target === state.cy && state.traceMode) {
      applyTraceHighlight();
    }
  });

  state.cy.on("dbltap", "node", async (event) => {
    const data = event.target.data();
    const nodeId = data.ownerFunctionId || data.id;
    await toggleNodeExpansion(nodeId);
  });

  // Anclaje híbrido: arrastrar un nodo fija pinned=true y persiste (x, y).
  state.cy.on("dragfree", "node", async (event) => {
    await handleNodeDragFree(event.target);
  });
}

async function handleNodeDragFree(cyNode) {
  const leafNodes = cyNode.isParent()
    ? cyNode.descendants().filter((item) => !item.isParent() && item.data("type") !== "flow")
    : [cyNode];

  const patchNodes = {};
  for (const item of leafNodes) {
    const id = item.id();
    if (!state.nodesById.has(id)) {
      continue;
    }
    const pos = item.position();
    const existing = getNoteEntry(id);
    const raw = state.nodesById.get(id);
    const entry = {
      ...existing,
      pinned: true,
      x: Math.round(pos.x * 10) / 10,
      y: Math.round(pos.y * 10) / 10,
      last_fingerprint: (raw && raw.fingerprint) || existing.last_fingerprint || "",
    };
    state.notes.nodes[id] = entry;
    patchNodes[id] = entry;
    item.data("pinned", "true");
    item.data("label", buildDisplayLabel(raw, item.data("collapsed") === "true", entry));
  }

  if (Object.keys(patchNodes).length === 0) {
    return;
  }

  const response = await fetch("/notes.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes: patchNodes }),
  });
  if (response.ok) {
    state.notes = await response.json();
  }
  if (state.selectedNodeId && patchNodes[state.selectedNodeId]) {
    updatePinButton(getNoteEntry(state.selectedNodeId).pinned);
  }
}

function buildStylesheet() {
  return [
    {
      selector: 'node[type = "module"], node[type = "file"]',
      style: {
        "background-color": "#161f2b",
        "background-opacity": 0.72,
        "border-width": 1.5,
        "border-color": "#3c4d63",
        "shape": "round-rectangle",
        "padding": 18,
        "label": "data(label)",
        "color": "#cbd5e1",
        "font-size": 12,
        "font-weight": "bold",
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": -6,
      },
    },
    {
      selector: 'node[type = "module"]',
      style: {
        "border-style": "dashed",
        "border-color": "#526680",
        "background-color": "#111822",
      },
    },
    {
      selector: 'node[collapsed = "true"]',
      style: {
        "background-color": "#1e293b",
        "background-opacity": 0.95,
        "border-color": "#38bdf8",
        "border-style": "solid",
        "width": 175,
        "height": 54,
        "text-valign": "center",
        "text-margin-y": 0,
      },
    },
    {
      selector: 'node[type = "function"], node[type = "flow"]',
      style: {
        "label": "data(label)",
        "color": "#f8fafc",
        "font-size": 11,
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "wrap",
        "text-max-width": 170,
        "border-width": 2,
        "width": "label",
        "height": "label",
        "padding": 12,
      },
    },
    {
      selector: 'node[expandedFn = "true"]',
      style: {
        "background-color": "#142030",
        "background-opacity": 0.9,
        "border-width": 2,
        "text-valign": "top",
        "text-margin-y": -6,
        "padding": 18,
      },
    },
    {
      selector: 'node[role = "entry"]',
      style: { "shape": "ellipse", "background-color": "#0d3b2e", "border-color": "#10b981" },
    },
    {
      selector: 'node[role = "transform"]',
      style: { "shape": "round-rectangle", "background-color": "#172b4d", "border-color": "#3b82f6" },
    },
    {
      selector: 'node[role = "decision"]',
      style: { "shape": "diamond", "background-color": "#452a08", "border-color": "#f59e0b", "padding": 18 },
    },
    {
      selector: 'node[role = "io"]',
      style: { "shape": "barrel", "background-color": "#33184d", "border-color": "#a855f7" },
    },
    {
      selector: 'node[pinned = "true"]',
      style: { "border-style": "double", "border-width": 3 },
    },
    {
      selector: "node:selected",
      style: { "border-width": 3.5, "border-color": "#38bdf8" },
    },
    // Aristas
    {
      selector: "edge",
      style: {
        "width": 1.8,
        "line-color": "#64748b",
        "target-arrow-color": "#64748b",
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        "label": "data(label)",
        "font-size": 10,
        "color": "#cbd5e1",
        "text-background-color": "#0f141b",
        "text-background-opacity": 0.85,
        "text-background-padding": 2,
      },
    },
    {
      selector: 'edge[confidence = "confirmed"]',
      style: { "line-style": "solid", "line-color": "#7dd3fc", "target-arrow-color": "#7dd3fc" },
    },
    {
      selector: 'edge[confidence = "inferred"]',
      style: { "line-style": "dashed", "line-color": "#94a3b8", "target-arrow-color": "#94a3b8" },
    },
    {
      selector: 'edge[kind = "flow"]',
      style: { "width": 1.4, "line-color": "#475569", "target-arrow-color": "#475569" },
    },
    // Clases del Modo Foco / Trazado (Tecla T)
    {
      selector: ".dimmed",
      style: { "opacity": 0.15 },
    },
    {
      selector: "node.trace-focus",
      style: { "opacity": 1, "border-width": 4, "border-color": "#38bdf8" },
    },
    {
      selector: "node.trace-caller",
      style: { "opacity": 1, "border-width": 3, "border-color": "#22d3ee" },
    },
    {
      selector: "edge.trace-caller",
      style: { "opacity": 1, "width": 3, "line-color": "#22d3ee", "target-arrow-color": "#22d3ee" },
    },
    {
      selector: "node.trace-callee",
      style: { "opacity": 1, "border-width": 3, "border-color": "#fbbf24" },
    },
    {
      selector: "edge.trace-callee",
      style: { "opacity": 1, "width": 3, "line-color": "#fbbf24", "target-arrow-color": "#fbbf24" },
    },
  ];
}

async function refreshGraphView({ fit = true } = {}) {
  const { nodes, edges } = buildVisibleElements();
  state.cy.elements().remove();
  state.cy.add([...nodes, ...edges]);
  await runElkLayout(nodes, edges);
  if (fit) {
    state.cy.fit(undefined, 36);
  }
  applyTraceHighlight();
}

async function runElkLayout(visibleNodes, visibleEdges) {
  const elkGraph = buildElkInput(visibleNodes, visibleEdges);
  const layouted = await state.elk.layout(elkGraph);

  const elkPositions = new Map();
  collectAbsolutePositions(layouted, 0, 0, elkPositions);

  state.cy.batch(() => {
    state.cy.nodes().forEach((cyNode) => {
      if (cyNode.isParent()) {
        return;
      }
      // Si el nodo está fijado (pinned) y tiene coordenadas guardadas en notes.json,
      // mantenemos su ubicación espacial intacta y solo reubicamos los no fijados.
      const noteEntry = getNoteEntry(cyNode.id());
      if (noteEntry.pinned && typeof noteEntry.x === "number" && typeof noteEntry.y === "number") {
        cyNode.position({ x: noteEntry.x, y: noteEntry.y });
        return;
      }
      const pos = elkPositions.get(cyNode.id());
      if (pos) {
        cyNode.position(pos);
      }
    });
  });
}

function buildElkInput(visibleNodes, visibleEdges) {
  const elkNodes = new Map();
  for (const item of visibleNodes) {
    const size = estimateNodeSize(item.data);
    elkNodes.set(item.data.id, {
      id: item.data.id,
      width: size.width,
      height: size.height,
      children: [],
      layoutOptions: item.data.expandedFn === "true"
        ? {
            "elk.direction": "DOWN",
            "elk.layered.spacing.nodeNodeBetweenLayers": "24",
            "elk.padding": "[top=34,left=16,bottom=16,right=16]",
          }
        : undefined,
    });
  }

  const rootChildren = [];
  for (const item of visibleNodes) {
    const elkNode = elkNodes.get(item.data.id);
    const parentId = item.data.parent;
    if (parentId && elkNodes.has(parentId)) {
      elkNodes.get(parentId).children.push(elkNode);
    } else {
      rootChildren.push(elkNode);
    }
  }

  for (const elkNode of elkNodes.values()) {
    if (elkNode.children.length > 0) {
      delete elkNode.width;
      delete elkNode.height;
    } else {
      delete elkNode.children;
    }
  }

  const elkEdges = visibleEdges.map((edge) => ({
    id: edge.data.id,
    sources: [edge.data.source],
    targets: [edge.data.target],
  }));

  return {
    id: "root",
    layoutOptions: ELK_LAYOUT_OPTIONS,
    children: rootChildren,
    edges: elkEdges,
  };
}

function estimateNodeSize(data) {
  if (data.collapsed === "true") {
    return { width: 185, height: 54 };
  }
  const textLen = (data.label || "").length;
  const width = Math.max(125, Math.min(245, textLen * 7.5 + 36));
  const height = data.role === "decision" ? 68 : 44;
  return { width, height };
}

function collectAbsolutePositions(elkNode, offsetX, offsetY, outMap) {
  if (!elkNode.children) {
    return;
  }
  for (const child of elkNode.children) {
    const absX = offsetX + (child.x || 0);
    const absY = offsetY + (child.y || 0);
    if (child.children && child.children.length > 0) {
      collectAbsolutePositions(child, absX, absY, outMap);
    } else {
      outMap.set(child.id, {
        x: absX + (child.width || 125) / 2,
        y: absY + (child.height || 44) / 2,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Modo Foco / Trazado (Tecla T, cian = llamadores, ámbar = destinos, ← / →)
// ---------------------------------------------------------------------------

function toggleTraceMode() {
  state.traceMode = !state.traceMode;
  document.getElementById("btn-trace").classList.toggle("active", state.traceMode);

  if (state.traceMode && !state.selectedNodeId) {
    const fallback = state.cy.nodes('node[role = "entry"]').first()
      || state.cy.nodes('node[type = "function"]').first();
    if (fallback && fallback.length > 0) {
      fallback.select();
      selectNode(fallback.id());
    }
  }

  applyTraceHighlight();
}

function applyTraceHighlight() {
  if (!state.cy) {
    return;
  }
  const all = state.cy.elements();
  all.removeClass("dimmed trace-focus trace-caller trace-callee");

  if (!state.traceMode || !state.selectedNodeId) {
    return;
  }

  const focus = state.cy.getElementById(state.selectedNodeId);
  if (!focus || focus.length === 0) {
    return;
  }

  const inEdges = focus.incomers('edge[kind = "call"]');
  const callers = inEdges.sources();
  const outEdges = focus.outgoers('edge[kind = "call"]');
  const callees = outEdges.targets();

  all.addClass("dimmed");
  focus.removeClass("dimmed").addClass("trace-focus");
  inEdges.removeClass("dimmed").addClass("trace-caller");
  callers.removeClass("dimmed").addClass("trace-caller");
  outEdges.removeClass("dimmed").addClass("trace-callee");
  callees.removeClass("dimmed").addClass("trace-callee");

  // Mantener opacidad normal en contenedores ancestros de los nodos iluminados.
  focus.ancestors().removeClass("dimmed");
  callers.ancestors().removeClass("dimmed");
  callees.ancestors().removeClass("dimmed");
}

function stepTrace(direction) {
  if (!state.traceMode || !state.selectedNodeId) {
    return;
  }
  const focus = state.cy.getElementById(state.selectedNodeId);
  if (!focus || focus.length === 0) {
    return;
  }

  let nextNode = null;
  if (direction === "forward") {
    const callees = focus.outgoers('edge[kind = "call"]').targets().sort((a, b) => a.id().localeCompare(b.id()));
    if (callees.length > 0) {
      state.traceHistory.push(state.selectedNodeId);
      nextNode = callees[0];
    }
  } else if (direction === "backward") {
    if (state.traceHistory.length > 0) {
      const prevId = state.traceHistory.pop();
      const candidate = state.cy.getElementById(prevId);
      if (candidate && candidate.length > 0) {
        nextNode = candidate;
      }
    }
    if (!nextNode) {
      const callers = focus.incomers('edge[kind = "call"]').sources().sort((a, b) => a.id().localeCompare(b.id()));
      if (callers.length > 0) {
        nextNode = callers[0];
      }
    }
  }

  if (!nextNode) {
    return;
  }
  state.cy.nodes().unselect();
  nextNode.select();
  selectNode(nextNode.id());
  applyTraceHighlight();
  state.cy.animate({ center: { eles: nextNode }, duration: 180 });
}

// ---------------------------------------------------------------------------
// Panel lateral, autoguardado de notas y controles de nodo
// ---------------------------------------------------------------------------

async function toggleNodeExpansion(nodeId) {
  const node = state.nodesById.get(nodeId);
  if (!node) {
    return;
  }
  if (node.type === "module" || node.type === "file") {
    if (state.collapsedContainers.has(nodeId)) {
      state.collapsedContainers.delete(nodeId);
    } else {
      state.collapsedContainers.add(nodeId);
    }
    await refreshGraphView({ fit: true });
    selectNode(nodeId);
  } else if (node.type === "function" && node.internal_flow && node.internal_flow.length > 0) {
    if (state.expandedFunctions.has(nodeId)) {
      state.expandedFunctions.delete(nodeId);
    } else {
      state.expandedFunctions.add(nodeId);
    }
    await refreshGraphView({ fit: true });
    selectNode(nodeId);
  }
}

function clearSelectionPanel() {
  state.selectedNodeId = null;
  document.getElementById("details-empty").classList.remove("hidden");
  document.getElementById("details-content").classList.add("hidden");
}

function selectNode(nodeId) {
  const node = state.nodesById.get(nodeId);
  if (!node) {
    return;
  }
  state.selectedNodeId = nodeId;
  const noteEntry = getNoteEntry(nodeId);

  document.getElementById("details-empty").classList.add("hidden");
  document.getElementById("details-content").classList.remove("hidden");

  const effectiveRole = noteEntry.custom_role || node.role || node.type;
  const badge = document.getElementById("detail-badge");
  badge.textContent = ROLE_LABELS[effectiveRole] || effectiveRole;
  badge.className = `role-badge role-${effectiveRole}`;

  document.getElementById("detail-title").textContent = node.label;
  document.getElementById("detail-id").textContent = node.id;

  updateVsCodeLink(node);
  updatePinButton(noteEntry.pinned);
  updateToggleButton(node);
  updateRoleSelector(node, noteEntry);

  document.getElementById("detail-note-input").value = noteEntry.note || "";
  document.getElementById("note-save-status").textContent = "";

  updateOptionalBlock("detail-signature-block", "detail-signature", node.signature);
  updateOptionalBlock("detail-docstring-block", "detail-docstring", node.docstring);
  updateOptionalBlock("detail-fingerprint-block", "detail-fingerprint", node.fingerprint);
  updateFlowBlock(node);
}

function updateVsCodeLink(node) {
  const link = document.getElementById("detail-vscode");
  let filePath = node.file_path;
  const line = node.line || 1;

  if (!filePath && node.type === "function") {
    const fileNode = state.nodesById.get(node.parent);
    filePath = fileNode ? fileNode.file_path : null;
  }

  if (filePath) {
    link.href = `vscode://file/${filePath}:${line}`;
    link.textContent = node.line ? `Abrir en VS Code (línea ${node.line})` : "Abrir en VS Code";
    link.classList.remove("hidden");
  } else {
    link.classList.add("hidden");
  }
}

function updatePinButton(isPinned) {
  const btn = document.getElementById("btn-pin-node");
  btn.textContent = isPinned ? "Liberar posición 📌" : "Fijar posición";
  btn.classList.toggle("pinned", Boolean(isPinned));
}

function updateRoleSelector(node, noteEntry) {
  const block = document.getElementById("detail-role-block");
  const select = document.getElementById("detail-role-select");
  if (node.type === "function") {
    select.value = noteEntry.custom_role || "";
    block.classList.remove("hidden");
  } else {
    block.classList.add("hidden");
  }
}

function updateToggleButton(node) {
  const btn = document.getElementById("btn-toggle-node");
  if (node.type === "module" || node.type === "file") {
    const collapsed = state.collapsedContainers.has(node.id);
    btn.textContent = collapsed ? "Expandir contenedor" : "Colapsar contenedor";
    btn.classList.remove("hidden");
  } else if (node.type === "function" && node.internal_flow && node.internal_flow.length > 0) {
    const expanded = state.expandedFunctions.has(node.id);
    btn.textContent = expanded ? "Ocultar flujo interno" : "Expandir flujo interno (3+)";
    btn.classList.remove("hidden");
  } else {
    btn.classList.add("hidden");
  }
}

function updateOptionalBlock(blockId, valueId, value) {
  const block = document.getElementById(blockId);
  if (value) {
    document.getElementById(valueId).textContent = value;
    block.classList.remove("hidden");
  } else {
    block.classList.add("hidden");
  }
}

function updateFlowBlock(node) {
  const block = document.getElementById("detail-flow-block");
  const list = document.getElementById("detail-flow-list");
  list.innerHTML = "";

  if (!node.internal_flow || node.internal_flow.length === 0) {
    block.classList.add("hidden");
    return;
  }

  for (const step of node.internal_flow) {
    const li = document.createElement("li");
    li.className = `flow-step role-${step.role}`;
    li.textContent = step.label;
    list.appendChild(li);
  }
  block.classList.remove("hidden");
}

function refreshCyNodeMetadata(nodeId) {
  const raw = state.nodesById.get(nodeId);
  const cyNode = state.cy.getElementById(nodeId);
  if (!raw || !cyNode || cyNode.length === 0) {
    return;
  }
  const entry = getNoteEntry(nodeId);
  cyNode.data("role", entry.custom_role || raw.role || raw.type);
  cyNode.data("pinned", entry.pinned ? "true" : "false");
  cyNode.data("label", buildDisplayLabel(raw, cyNode.data("collapsed") === "true", entry));
}

// ---------------------------------------------------------------------------
// Buscador instantáneo (Ctrl + K) y gestor de notas huérfanas
// ---------------------------------------------------------------------------

function openSearchModal() {
  const modal = document.getElementById("search-modal");
  const input = document.getElementById("search-input");
  modal.classList.remove("hidden");
  input.value = "";
  renderSearchResults("");
  input.focus();
}

function closeSearchModal() {
  document.getElementById("search-modal").classList.add("hidden");
}

function renderSearchResults(query) {
  const term = query.trim().toLowerCase();
  const list = document.getElementById("search-results");
  list.innerHTML = "";

  const matches = [];
  for (const node of state.rawGraph.nodes) {
    const noteText = (getNoteEntry(node.id).note || "").trim();
    const haystack = `${node.label} ${node.id} ${node.signature || ""} ${noteText}`.toLowerCase();
    if (!term || haystack.includes(term)) {
      matches.push({ node, noteText });
      if (matches.length >= 25) {
        break;
      }
    }
  }

  state.searchMatches = matches;
  state.searchActiveIndex = 0;

  matches.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = index === 0 ? "search-item active" : "search-item";

    const title = document.createElement("div");
    title.className = "search-item-title";
    title.innerHTML = `<span>${escapeHtml(item.node.label)}</span><span>${escapeHtml(item.node.type)}</span>`;
    li.appendChild(title);

    const sub = document.createElement("div");
    sub.className = "search-item-sub";
    sub.textContent = item.node.id;
    li.appendChild(sub);

    if (item.noteText) {
      const noteEl = document.createElement("div");
      noteEl.className = "search-item-note";
      noteEl.textContent = item.noteText;
      li.appendChild(noteEl);
    }

    li.addEventListener("click", () => focusSearchResult(item.node.id));
    list.appendChild(li);
  });
}

async function focusSearchResult(nodeId) {
  closeSearchModal();
  let changed = false;
  let current = state.nodesById.get(nodeId);
  while (current && current.parent) {
    if (state.collapsedContainers.delete(current.parent)) {
      changed = true;
    }
    current = state.nodesById.get(current.parent);
  }
  if (changed) {
    await refreshGraphView({ fit: false });
  }

  const cyNode = state.cy.getElementById(nodeId);
  if (cyNode && cyNode.length > 0) {
    state.cy.nodes().unselect();
    cyNode.select();
    selectNode(nodeId);
    applyTraceHighlight();
    state.cy.animate({ center: { eles: cyNode }, zoom: Math.max(state.cy.zoom(), 1.1), duration: 220 });
  }
}

function updateOrphansBadge() {
  const count = (state.notes.orphans || []).length;
  const btn = document.getElementById("btn-orphans");
  btn.textContent = `Huérfanas (${count})`;
  btn.classList.toggle("has-orphans", count > 0);
}

function openOrphansModal() {
  const modal = document.getElementById("orphans-modal");
  const hint = document.getElementById("orphans-hint");
  const list = document.getElementById("orphans-list");
  const orphans = state.notes.orphans || [];

  list.innerHTML = "";
  if (orphans.length === 0) {
    hint.textContent = "No hay notas huérfanas pendientes.";
  } else if (state.selectedNodeId) {
    hint.textContent = `Destino seleccionado para recuperar: ${state.selectedNodeId}`;
  } else {
    hint.textContent = "Tip: selecciona primero un nodo en el grafo si deseas recuperar una nota sobre él.";
  }

  orphans.forEach((orphan, index) => {
    const li = document.createElement("li");
    li.className = "orphan-card";

    const meta = document.createElement("div");
    meta.className = "orphan-meta";
    meta.textContent = `${orphan.old_id} · huella ${orphan.last_fingerprint || "—"} · ${orphan.orphaned_at || ""}`;
    li.appendChild(meta);

    const note = document.createElement("div");
    note.className = "orphan-note";
    note.textContent = orphan.note || "(sin texto, solo rol/anclaje)";
    li.appendChild(note);

    const actions = document.createElement("div");
    actions.className = "orphan-actions";

    const recoverBtn = document.createElement("button");
    recoverBtn.type = "button";
    recoverBtn.textContent = "Recuperar en nodo seleccionado";
    recoverBtn.disabled = !state.selectedNodeId;
    recoverBtn.addEventListener("click", async () => {
      await recoverOrphan(index);
    });

    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.className = "danger";
    discardBtn.textContent = "Descartar";
    discardBtn.addEventListener("click", async () => {
      await discardOrphan(index);
    });

    actions.appendChild(recoverBtn);
    actions.appendChild(discardBtn);
    li.appendChild(actions);
    list.appendChild(li);
  });

  modal.classList.remove("hidden");
}

function closeOrphansModal() {
  document.getElementById("orphans-modal").classList.add("hidden");
}

async function recoverOrphan(index) {
  if (!state.selectedNodeId) {
    return;
  }
  const orphans = [...(state.notes.orphans || [])];
  const [picked] = orphans.splice(index, 1);
  if (!picked) {
    return;
  }
  const current = getNoteEntry(state.selectedNodeId);
  const combinedNote = current.note && picked.note
    ? `${current.note}\n${picked.note}`
    : (picked.note || current.note);

  await saveNotePatch(state.selectedNodeId, {
    note: combinedNote,
    custom_role: picked.custom_role || current.custom_role,
  });
  await saveOrphansList(orphans);
  refreshCyNodeMetadata(state.selectedNodeId);
  selectNode(state.selectedNodeId);
  openOrphansModal();
}

async function discardOrphan(index) {
  const orphans = [...(state.notes.orphans || [])];
  orphans.splice(index, 1);
  await saveOrphansList(orphans);
  openOrphansModal();
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ---------------------------------------------------------------------------
// Eventos de barra, panel lateral y atajos de teclado
// ---------------------------------------------------------------------------

function bindControls() {
  for (const btn of document.querySelectorAll(".level-btn")) {
    btn.addEventListener("click", () => applyLevel(Number(btn.dataset.level)));
  }

  document.getElementById("btn-relayout").addEventListener("click", () => {
    refreshGraphView({ fit: false });
  });
  document.getElementById("btn-fit").addEventListener("click", () => {
    state.cy.fit(undefined, 36);
  });
  document.getElementById("btn-trace").addEventListener("click", toggleTraceMode);
  document.getElementById("btn-search").addEventListener("click", openSearchModal);
  document.getElementById("btn-orphans").addEventListener("click", openOrphansModal);
  document.getElementById("btn-close-orphans").addEventListener("click", closeOrphansModal);

  document.getElementById("btn-toggle-node").addEventListener("click", () => {
    if (state.selectedNodeId) {
      toggleNodeExpansion(state.selectedNodeId);
    }
  });

  document.getElementById("btn-pin-node").addEventListener("click", async () => {
    if (!state.selectedNodeId) {
      return;
    }
    const entry = getNoteEntry(state.selectedNodeId);
    const cyNode = state.cy.getElementById(state.selectedNodeId);
    if (entry.pinned) {
      await saveNotePatch(state.selectedNodeId, { pinned: false, x: null, y: null });
      refreshCyNodeMetadata(state.selectedNodeId);
      updatePinButton(false);
      await refreshGraphView({ fit: false });
    } else if (cyNode && cyNode.length > 0 && !cyNode.isParent()) {
      const pos = cyNode.position();
      await saveNotePatch(state.selectedNodeId, {
        pinned: true,
        x: Math.round(pos.x * 10) / 10,
        y: Math.round(pos.y * 10) / 10,
      });
      refreshCyNodeMetadata(state.selectedNodeId);
      updatePinButton(true);
    }
  });

  document.getElementById("detail-role-select").addEventListener("change", async (event) => {
    if (!state.selectedNodeId) {
      return;
    }
    const customRole = event.target.value || null;
    await saveNotePatch(state.selectedNodeId, { custom_role: customRole });
    refreshCyNodeMetadata(state.selectedNodeId);
    selectNode(state.selectedNodeId);
  });

  const noteInput = document.getElementById("detail-note-input");
  noteInput.addEventListener("input", () => {
    if (!state.selectedNodeId) {
      return;
    }
    const targetId = state.selectedNodeId;
    const status = document.getElementById("note-save-status");
    status.textContent = "Guardando…";
    if (state.noteSaveTimer) {
      clearTimeout(state.noteSaveTimer);
    }
    state.noteSaveTimer = setTimeout(async () => {
      await saveNotePatch(targetId, { note: noteInput.value });
      refreshCyNodeMetadata(targetId);
      status.textContent = "Guardado";
    }, NOTE_AUTOSAVE_MS);
  });

  bindSearchModalEvents();
  bindGlobalShortcuts();
}

function bindSearchModalEvents() {
  const modal = document.getElementById("search-modal");
  const input = document.getElementById("search-input");

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeSearchModal();
    }
  });
  document.getElementById("orphans-modal").addEventListener("click", (event) => {
    if (event.target.id === "orphans-modal") {
      closeOrphansModal();
    }
  });

  input.addEventListener("input", () => {
    renderSearchResults(input.value);
  });

  input.addEventListener("keydown", (event) => {
    const items = document.querySelectorAll("#search-results .search-item");
    if (event.key === "ArrowDown" && items.length > 0) {
      event.preventDefault();
      state.searchActiveIndex = (state.searchActiveIndex + 1) % items.length;
      updateActiveSearchItem(items);
    } else if (event.key === "ArrowUp" && items.length > 0) {
      event.preventDefault();
      state.searchActiveIndex = (state.searchActiveIndex - 1 + items.length) % items.length;
      updateActiveSearchItem(items);
    } else if (event.key === "Enter" && state.searchMatches[state.searchActiveIndex]) {
      event.preventDefault();
      focusSearchResult(state.searchMatches[state.searchActiveIndex].node.id);
    }
  });
}

function updateActiveSearchItem(items) {
  items.forEach((el, idx) => {
    el.classList.toggle("active", idx === state.searchActiveIndex);
  });
}

function isTypingInField(target) {
  if (!target) {
    return false;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function bindGlobalShortcuts() {
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearchModal();
      return;
    }
    if (event.key === "Escape") {
      closeSearchModal();
      closeOrphansModal();
      return;
    }
    if (isTypingInField(event.target)) {
      return;
    }

    const key = event.key.toLowerCase();
    if (key === "r" && !event.ctrlKey && !event.metaKey) {
      refreshGraphView({ fit: false });
    } else if (key === "t" && !event.ctrlKey && !event.metaKey) {
      toggleTraceMode();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      stepTrace("forward");
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepTrace("backward");
    }
  });
}

initViewer().catch((error) => {
  document.getElementById("project-title").textContent = "Error al iniciar CodeMap";
  console.error(error);
});
