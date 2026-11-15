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
  knownApis: { version: 1, known: {} },
  nodesById: new Map(),
  childrenByParent: new Map(),
  collapsedContainers: new Set(),
  expandedFunctions: new Set(),
  activeLevel: 2,
  selectedNodeId: null,
  activeFlowStepId: null,
  leftSidebarCollapsed: true,
  legendCollapsed: false,
  legendUserToggled: false,
  panelCollapsed: false,
  spacePanning: false,
  suppressNextTap: false,
  traceMode: false,
  traceHistory: [],
  noteSaveTimer: null,
  searchMatches: [],
  searchActiveIndex: 0,
  apisModalTab: "pending",
  apisSearchQuery: "",
  ws: null,
  cy: null,
  elk: null,
};

// ---------------------------------------------------------------------------
// Inicialización, carga inicial y WebSocket en vivo
// ---------------------------------------------------------------------------

async function initViewer() {
  state.elk = new ELK();
  const [graphRes, notesRes, apisRes] = await Promise.all([
    fetch("/graph.json", { cache: "no-store" }),
    fetch("/notes.json", { cache: "no-store" }),
    fetch("/known-apis", { cache: "no-store" }),
  ]);
  if (!graphRes.ok) {
    throw new Error(`No se pudo cargar /graph.json (${graphRes.status})`);
  }

  state.rawGraph = await graphRes.json();
  state.notes = notesRes.ok ? await notesRes.json() : { nodes: {}, orphans: [] };
  state.knownApis = apisRes.ok ? await apisRes.json() : { version: 1, known: {} };
  indexGraph(state.rawGraph);

  renderHeader(state.rawGraph.meta, state.rawGraph.edges.length);
  updateOrphansBadge();
  updateKnownApisButton();
  initCytoscape();
  bindControls();
  connectWebSocket();

  const totalFuncs = (state.rawGraph.meta && state.rawGraph.meta.total_functions) || 0;
  if (!state.legendUserToggled && (state.rawGraph.nodes.length > 25 || totalFuncs >= 20)) {
    toggleLegend(true);
  }

  const initialLevel = state.rawGraph.meta.recommended_level || 2;
  await applyLevel(initialLevel);
  updateZoomIndicator();
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
    if (msg.type === "init") {
      if (msg.known_apis) {
        applyKnownApisState(msg.known_apis);
      }
    } else if (msg.type === "update") {
      await applyLiveUpdate(msg.graph, msg.notes);
    } else if (msg.type === "notes_updated" && msg.notes) {
      state.notes = msg.notes;
      updateOrphansBadge();
    } else if (msg.type === "known_apis_updated" && msg.known_apis) {
      applyKnownApisState(msg.known_apis);
    }
  });

  ws.addEventListener("close", () => {
    setLiveStatus("Estático", "offline");
  });

  ws.addEventListener("error", () => {
    setLiveStatus("Estático", "offline");
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
  updateKnownApisButton();

  await refreshGraphView({ fit: false });
  state.cy.viewport({ zoom, pan });

  if (state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
    state.cy.getElementById(state.selectedNodeId).select();
    selectNode(state.selectedNodeId, state.activeFlowStepId);
  } else {
    clearSelectionPanel();
  }
  if (!document.getElementById("apis-modal").classList.contains("hidden")) {
    renderApisModal();
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

function buildDisplayLabel(rawNode, isCollapsed, noteEntry, effectiveRole = null) {
  let label = rawNode.label;
  if (isCollapsed) {
    const childCount = countDescendantFunctions(rawNode.id);
    if (childCount > 0) {
      label = `${label} [+ ${childCount}]`;
    }
  }
  const tags = [];
  if (rawNode.type === "function") {
    const role = effectiveRole || noteEntry.custom_role || rawNode.role;
    if (role === "entry") {
      tags.push("INICIO");
    }
    if (rawNode.is_terminal) {
      tags.push("FIN");
    }
  }
  if (noteEntry.note && noteEntry.note.trim()) {
    tags.push("📝");
  }
  if (noteEntry.pinned) {
    tags.push("📌");
  }
  return tags.length > 0 ? `${label} [${tags.join(" · ")}]` : label;
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
        label: buildDisplayLabel(rawNode, isCollapsed, noteEntry, effectiveRole),
        type: rawNode.type,
        role: effectiveRole,
        terminal: rawNode.type === "function" && rawNode.is_terminal ? "true" : "false",
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
  appendInternalFlowEdges(nodes, edges, visibleNodeIds);

  return { nodes, edges };
}

function estimateFlowStepSize(role, kind, label) {
  if (kind === "merge") {
    return { width: 62, height: 28 };
  }
  if (role === "decision") {
    const { lineCount, longestLine } = estimateWrappedTextMetrics(label, 27);
    const w = Math.max(92, Math.min(195, longestLine * 7.2));
    const h = Math.max(18, lineCount * 15);
    return {
      width: Math.round(w * 1.65 + 54),
      height: Math.max(72, Math.round(h * 1.65 + 42)),
    };
  }
  const { lineCount, longestLine } = estimateWrappedTextMetrics(label, 36);
  const width = Math.max(140, Math.min(295, longestLine * 7.2 + 30));
  const height = Math.max(46, lineCount * 16 + 24);
  return { width, height };
}

function appendInternalFlowElements(fnNode, nodes, visibleNodeIds) {
  const flowSteps = fnNode.internal_flow || [];
  const stepIds = new Set(flowSteps.map((step) => step.id));
  for (const step of flowSteps) {
    const stepId = `${fnNode.id}::${step.id}`;
    const parentNodeId = step.parent_id && stepIds.has(step.parent_id)
      ? `${fnNode.id}::${step.parent_id}`
      : fnNode.id;
    visibleNodeIds.add(stepId);
    const stepKind = step.kind || "step";
    const displayLabel = stepKind === "merge"
      ? (step.label || "fin")
      : (step.role === "entry" && step.label.startsWith("in:")
          ? `ENTRADA\n${step.label}`
          : step.label);
    const stepSize = estimateFlowStepSize(step.role, stepKind, displayLabel);
    nodes.push({
      data: {
        id: stepId,
        parent: parentNodeId,
        label: displayLabel,
        type: "flow",
        role: step.role,
        flowKind: stepKind,
        flowContainer: step.is_container ? "true" : "false",
        nodeWidth: stepSize.width,
        nodeHeight: stepSize.height,
        flowEdges: Array.isArray(step.edges) ? step.edges : null,
        pinned: "false",
        hasNote: "false",
        collapsed: "false",
        expandedFn: "false",
        ownerFunctionId: fnNode.id,
        stepId: step.id,
        stepCode: step.code || step.label,
      },
    });
  }
}

function appendInternalFlowEdges(nodes, edges, visibleNodeIds) {
  const stepsByFn = new Map();
  for (const el of nodes) {
    if (el.data.type !== "flow") {
      continue;
    }
    const owner = el.data.ownerFunctionId;
    if (!stepsByFn.has(owner)) {
      stepsByFn.set(owner, []);
    }
    stepsByFn.get(owner).push(el);
  }

  for (const [owner, stepEls] of stepsByFn.entries()) {
    const hasExplicitSchema = stepEls.some((el) => Array.isArray(el.data.flowEdges));
    if (hasExplicitSchema) {
      let edgeIdx = 0;
      const seenEdges = new Set();
      for (const el of stepEls) {
        const sourceId = el.data.id;
        for (const edge of el.data.flowEdges || []) {
          const targetId = `${owner}::${edge.target}`;
          if (!visibleNodeIds.has(sourceId) || !visibleNodeIds.has(targetId)) {
            continue;
          }
          const edgeKind = edge.kind || "flow";
          const edgeLabel = edge.label || "";
          const dedupeKey = `${sourceId}->${targetId}:${edgeKind}:${edgeLabel}`;
          if (seenEdges.has(dedupeKey)) {
            continue;
          }
          seenEdges.add(dedupeKey);
          edges.push({
            data: {
              id: `flow_${owner}_${edgeIdx}`,
              source: sourceId,
              target: targetId,
              confidence: "confirmed",
              call_count: 1,
              label: edgeLabel,
              kind: "flow",
              flowEdgeKind: edgeKind,
            },
          });
          edgeIdx += 1;
        }
      }
      continue;
    }

    for (let i = 0; i < stepEls.length - 1; i += 1) {
      edges.push({
        data: {
          id: `flow_${owner}_${i}`,
          source: stepEls[i].data.id,
          target: stepEls[i + 1].data.id,
          confidence: "confirmed",
          call_count: 1,
          label: "",
          kind: "flow",
          flowEdgeKind: "flow",
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
    if (state.suppressNextTap) {
      return;
    }
    const data = event.target.data();
    const targetId = data.ownerFunctionId || data.id;
    const stepId = data.type === "flow" ? (data.stepId || null) : null;
    selectNode(targetId, stepId);
    if (state.traceMode) {
      applyTraceHighlight();
    }
  });

  state.cy.on("tap", (event) => {
    if (state.suppressNextTap) {
      return;
    }
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

  bindCanvasPanControls();
  state.cy.on("zoom", updateZoomIndicator);
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
    const effectiveRole = entry.custom_role || (raw && raw.role) || (raw && raw.type);
    item.data("pinned", "true");
    item.data("label", buildDisplayLabel(raw, item.data("collapsed") === "true", entry, effectiveRole));
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
      selector: 'node[type = "function"]',
      style: {
        "label": "data(label)",
        "color": "#f8fafc",
        "font-size": 11,
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "wrap",
        "text-max-width": 175,
        "border-width": 2,
        "width": "label",
        "height": "label",
        "padding": 12,
      },
    },
    {
      selector: 'node[type = "flow"]',
      style: {
        "label": "data(label)",
        "color": "#f8fafc",
        "font-size": 11,
        "line-height": 1.28,
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "wrap",
        "text-max-width": 265,
        "border-width": 2,
      },
    },
    {
      selector: 'node[type = "flow"][flowContainer != "true"]',
      style: {
        "width": "label",
        "height": "label",
        "padding": 12,
      },
    },
    {
      selector: 'node[type = "flow"].selected-step',
      style: {
        "border-width": 3,
        "border-color": "#38bdf8",
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
        "padding": 22,
      },
    },
    {
      selector: 'node[role = "entry"]',
      style: { "shape": "ellipse", "background-color": "#0d3b2e", "border-color": "#10b981", "border-width": 2.5 },
    },
    {
      selector: 'node[role = "transform"]',
      style: { "shape": "round-rectangle", "background-color": "#172b4d", "border-color": "#3b82f6" },
    },
    {
      selector: 'node[role = "decision"]',
      style: { "shape": "round-diamond", "background-color": "#452a08", "border-color": "#f59e0b", "padding": 22 },
    },
    {
      selector: 'node[role = "io"]',
      style: { "shape": "barrel", "background-color": "#33184d", "border-color": "#a855f7" },
    },
    {
      selector: 'node[type = "flow"][role = "decision"][flowContainer != "true"]',
      style: {
        "shape": "round-diamond",
        "width": "data(nodeWidth)",
        "height": "data(nodeHeight)",
        "text-max-width": 195,
        "padding": 22,
      },
    },
    {
      selector: 'node[type = "flow"][flowKind = "merge"]',
      style: {
        "shape": "round-rectangle",
        "width": 58,
        "height": 26,
        "padding": 4,
        "font-size": 10,
        "background-color": "#1e293b",
        "border-color": "#64748b",
        "border-style": "dashed",
        "border-width": 1.5,
        "color": "#94a3b8",
      },
    },
    {
      selector: 'node[type = "flow"][flowKind = "except"]',
      style: {
        "background-color": "#2b121b",
        "border-color": "#f43f5e",
      },
    },
    {
      selector: 'node[type = "flow"][flowContainer = "true"]',
      style: {
        "shape": "round-rectangle",
        "background-color": "#101b2d",
        "background-opacity": 0.92,
        "border-color": "#38bdf8",
        "border-style": "dashed",
        "border-width": 1.8,
        "color": "#7dd3fc",
        "font-size": 11,
        "font-weight": "bold",
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": -6,
        "text-wrap": "wrap",
        "text-max-width": 340,
        "compound-sizing-wrt-labels": "include",
        "padding": 22,
      },
    },
    {
      selector: 'node[terminal = "true"]',
      style: { "border-color": "#f43f5e", "border-width": 2.5 },
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
    {
      selector: 'edge[flowEdgeKind = "branch_yes"]',
      style: {
        "width": 1.8,
        "line-style": "solid",
        "line-color": "#10b981",
        "target-arrow-color": "#10b981",
        "color": "#6ee7b7",
        "font-weight": "bold",
      },
    },
    {
      selector: 'edge[flowEdgeKind = "branch_no"]',
      style: {
        "width": 1.8,
        "line-style": "dashed",
        "line-color": "#f59e0b",
        "target-arrow-color": "#f59e0b",
        "color": "#fcd34d",
        "font-weight": "bold",
      },
    },
    {
      selector: 'edge[flowEdgeKind = "exception"]',
      style: {
        "width": 1.8,
        "line-style": "dashed",
        "line-color": "#f43f5e",
        "target-arrow-color": "#f43f5e",
        "color": "#fda4af",
        "font-weight": "bold",
      },
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
  updateZoomIndicator();
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
  const dataById = new Map();
  for (const item of visibleNodes) {
    dataById.set(item.data.id, item.data);
    const size = estimateNodeSize(item.data);
    const isFlowBox = item.data.expandedFn === "true" || item.data.flowContainer === "true";
    elkNodes.set(item.data.id, {
      id: item.data.id,
      width: size.width,
      height: size.height,
      children: [],
      layoutOptions: isFlowBox
        ? {
            "elk.direction": "DOWN",
            "elk.layered.spacing.nodeNodeBetweenLayers": "30",
            "elk.spacing.nodeNode": "26",
            "elk.padding": item.data.flowContainer === "true"
              ? "[top=38,left=24,bottom=22,right=24]"
              : "[top=44,left=24,bottom=22,right=24]",
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

  for (const rootChild of rootChildren) {
    computeElkSubtreeWidth(rootChild, dataById);
  }

  const elkEdges = visibleEdges.map((edge) => {
    const elkEdge = {
      id: edge.data.id,
      sources: [edge.data.source],
      targets: [edge.data.target],
    };
    const labelText = String(edge.data.label || "").trim();
    if (labelText) {
      elkEdge.labels = [
        {
          text: labelText,
          width: Math.max(24, Math.round(labelText.length * 6.8 + 10)),
          height: 16,
        },
      ];
    }
    return elkEdge;
  });

  return {
    id: "root",
    layoutOptions: ELK_LAYOUT_OPTIONS,
    children: rootChildren,
    edges: elkEdges,
  };
}

function estimateCompoundHeaderWidth(data) {
  if (!data) {
    return 0;
  }
  if (data.flowContainer === "true") {
    const { longestLine } = estimateWrappedTextMetrics(data.label, 42);
    return Math.min(360, Math.round(longestLine * 7.2 + 36));
  }
  if (data.expandedFn === "true") {
    const { longestLine } = estimateWrappedTextMetrics(data.label, 36);
    return Math.min(300, Math.round(longestLine * 7.5 + 32));
  }
  return 0;
}

function computeElkSubtreeWidth(elkNode, dataById) {
  if (!elkNode.children || elkNode.children.length === 0) {
    return elkNode.width || 140;
  }
  let maxChildWidth = 0;
  for (const child of elkNode.children) {
    maxChildWidth = Math.max(maxChildWidth, computeElkSubtreeWidth(child, dataById));
  }
  const data = dataById.get(elkNode.id);
  const isFlowBox = data && (data.flowContainer === "true" || data.expandedFn === "true");
  if (!isFlowBox) {
    return maxChildWidth + 40;
  }
  const baseTop = data.flowContainer === "true" ? 38 : 44;
  let sidePad = 24;
  const headerWidth = estimateCompoundHeaderWidth(data);
  if (headerWidth > maxChildWidth + sidePad * 2) {
    sidePad = Math.min(180, Math.ceil((headerWidth - maxChildWidth) / 2) + 12);
  }
  elkNode.layoutOptions = {
    ...(elkNode.layoutOptions || {}),
    "elk.padding": `[top=${baseTop},left=${sidePad},bottom=22,right=${sidePad}]`,
  };
  return Math.max(headerWidth, maxChildWidth + sidePad * 2);
}

function estimateWrappedTextMetrics(text, maxCharsPerLine) {
  let lineCount = 0;
  let longestLine = 0;
  for (const segment of String(text || "").split("\n")) {
    const trimmed = segment.trim();
    if (!trimmed) {
      lineCount += 1;
      continue;
    }
    const wrapped = Math.max(1, Math.ceil(trimmed.length / maxCharsPerLine));
    lineCount += wrapped;
    longestLine = Math.max(longestLine, Math.min(maxCharsPerLine, trimmed.length));
  }
  return { lineCount: Math.max(1, lineCount), longestLine };
}

function estimateNodeSize(data) {
  if (data.collapsed === "true") {
    return { width: 185, height: 54 };
  }
  if (typeof data.nodeWidth === "number" && typeof data.nodeHeight === "number") {
    return { width: data.nodeWidth, height: data.nodeHeight };
  }
  if (data.type === "flow") {
    return estimateFlowStepSize(data.role, data.flowKind || "step", data.label);
  }
  const { lineCount, longestLine } = estimateWrappedTextMetrics(data.label, 25);
  const width = Math.max(125, Math.min(245, longestLine * 7.5 + 36));
  const baseHeight = data.role === "decision" ? 68 : 44;
  const height = Math.max(baseHeight, lineCount * 15 + 24);
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
  state.activeFlowStepId = null;
  syncFlowStepHighlight(null, null);
  document.getElementById("details-empty").classList.remove("hidden");
  document.getElementById("details-content").classList.add("hidden");
}

function selectNode(nodeId, stepId = undefined) {
  const node = state.nodesById.get(nodeId);
  if (!node) {
    return;
  }
  const changedNode = state.selectedNodeId !== nodeId;
  state.selectedNodeId = nodeId;
  if (stepId !== undefined) {
    state.activeFlowStepId = stepId;
  } else if (changedNode) {
    state.activeFlowStepId = null;
  }
  const noteEntry = getNoteEntry(nodeId);

  document.getElementById("details-empty").classList.add("hidden");
  document.getElementById("details-content").classList.remove("hidden");

  const effectiveRole = noteEntry.custom_role || node.role || node.type;
  const badge = document.getElementById("detail-badge");
  badge.textContent = ROLE_LABELS[effectiveRole] || effectiveRole;
  badge.className = `role-badge role-${effectiveRole}`;
  updateFlowBadges(node, effectiveRole);

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
  updateInternalCallsBlock(node);
  updateExternalCallsBlock(node);
  updateOptionalBlock("detail-fingerprint-block", "detail-fingerprint", node.fingerprint);
  updateFlowBlock(node);
}

function updateFlowBadges(node, effectiveRole) {
  const container = document.getElementById("detail-flow-badges");
  container.innerHTML = "";
  if (node.type !== "function") {
    return;
  }
  if (effectiveRole === "entry") {
    const startBadge = document.createElement("span");
    startBadge.className = "flow-badge flow-badge-start";
    startBadge.textContent = "INICIO";
    container.appendChild(startBadge);
  }
  if (node.is_terminal) {
    const endBadge = document.createElement("span");
    endBadge.className = "flow-badge flow-badge-end";
    endBadge.textContent = "FIN";
    container.appendChild(endBadge);
  }
}

function resolveNodeFilePath(node) {
  if (node.file_path) {
    return node.file_path;
  }
  if (node.type === "function" && node.parent) {
    const fileNode = state.nodesById.get(node.parent);
    return fileNode ? fileNode.file_path : null;
  }
  return null;
}

function buildVsCodeHref(node) {
  const filePath = resolveNodeFilePath(node);
  if (!filePath) {
    return null;
  }
  return `vscode://file/${filePath}:${node.line || 1}`;
}

function updateVsCodeLink(node) {
  const link = document.getElementById("detail-vscode");
  const href = buildVsCodeHref(node);

  if (href) {
    link.href = href;
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

function syncFlowStepHighlight(fnId, stepId) {
  if (!state.cy || typeof state.cy.nodes !== "function") {
    return;
  }
  state.cy.nodes('node[type = "flow"]').removeClass("selected-step");
  if (fnId && stepId) {
    const stepCy = state.cy.getElementById(`${fnId}::${stepId}`);
    if (stepCy && stepCy.length > 0) {
      stepCy.addClass("selected-step");
    }
  }
}

function renderSelectedFlowStepCode(node, step) {
  const codeBlock = document.getElementById("detail-flow-step-code-block");
  const titleEl = document.getElementById("detail-flow-step-title");
  const codeEl = document.getElementById("detail-flow-step-code");
  if (!node || !step) {
    codeBlock.classList.add("hidden");
    codeEl.textContent = "";
    return;
  }
  titleEl.textContent = `Código del paso ${step.id}`;
  codeEl.textContent = step.code || step.label;
  codeBlock.classList.remove("hidden");
}

function selectFlowStep(node, stepId) {
  state.activeFlowStepId = stepId;
  updateFlowBlock(node);
}

function updateFlowBlock(node) {
  const block = document.getElementById("detail-flow-block");
  const list = document.getElementById("detail-flow-list");
  list.innerHTML = "";

  if (!node.internal_flow || node.internal_flow.length === 0) {
    renderSelectedFlowStepCode(null, null);
    syncFlowStepHighlight(null, null);
    block.classList.add("hidden");
    return;
  }

  const stepById = new Map(node.internal_flow.map((step) => [step.id, step]));
  const getStepDepth = (step) => {
    let depth = 0;
    let cursor = step.parent_id;
    const seen = new Set([step.id]);
    while (cursor && stepById.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = stepById.get(cursor).parent_id;
    }
    return depth;
  };

  let selectedStep = null;
  for (const step of node.internal_flow) {
    if (step.kind === "merge") {
      continue;
    }
    const li = document.createElement("li");
    const isActive = state.activeFlowStepId === step.id;
    const stepKind = step.kind || "step";
    li.className = `flow-step role-${step.role} kind-${stepKind}${isActive ? " active" : ""}`;
    const depth = getStepDepth(step);
    if (depth > 0) {
      li.style.marginLeft = `${depth * 14}px`;
    }
    if (step.role === "entry") {
      const tag = document.createElement("span");
      tag.className = "flow-step-entry-tag";
      tag.textContent = "ENTRADA";
      li.appendChild(tag);
    }
    const text = document.createElement("span");
    text.className = "flow-step-text";
    text.textContent = step.label;
    li.appendChild(text);

    li.addEventListener("click", () => selectFlowStep(node, step.id));
    list.appendChild(li);
    if (isActive) {
      selectedStep = step;
    }
  }

  syncFlowStepHighlight(node.id, selectedStep ? selectedStep.id : null);
  renderSelectedFlowStepCode(node, selectedStep);
  block.classList.remove("hidden");
}

function createInternalCallCard(targetNode) {
  const li = document.createElement("li");
  li.className = "call-card";

  const header = document.createElement("div");
  header.className = "call-card-header";

  const name = document.createElement("span");
  name.className = "call-name";
  name.textContent = targetNode.label;
  header.appendChild(name);

  const fileNode = targetNode.parent ? state.nodesById.get(targetNode.parent) : null;
  const origin = document.createElement("span");
  origin.className = "call-origin";
  origin.textContent = fileNode ? fileNode.id : targetNode.parent || "";
  header.appendChild(origin);
  li.appendChild(header);

  if (targetNode.signature) {
    const sig = document.createElement("pre");
    sig.className = "call-signature";
    sig.textContent = targetNode.signature;
    li.appendChild(sig);
  }

  if (targetNode.docstring) {
    const doc = document.createElement("p");
    doc.className = "call-doc";
    doc.textContent = targetNode.docstring;
    li.appendChild(doc);
  }

  const actions = document.createElement("div");
  actions.className = "call-card-actions";

  const goBtn = document.createElement("button");
  goBtn.type = "button";
  goBtn.className = "call-action-btn";
  goBtn.textContent = "Ir al nodo";
  goBtn.addEventListener("click", () => navigateToNode(targetNode.id));
  actions.appendChild(goBtn);

  const href = buildVsCodeHref(targetNode);
  if (href) {
    const vsLink = document.createElement("a");
    vsLink.className = "call-link";
    vsLink.href = href;
    vsLink.textContent = targetNode.line ? `VS Code (línea ${targetNode.line})` : "VS Code";
    actions.appendChild(vsLink);
  }

  li.appendChild(actions);
  return li;
}

function updateInternalCallsBlock(node) {
  const block = document.getElementById("detail-internal-calls-block");
  const list = document.getElementById("detail-internal-calls-list");
  list.innerHTML = "";

  if (node.type !== "function" || !state.rawGraph || !Array.isArray(state.rawGraph.edges)) {
    block.classList.add("hidden");
    return;
  }

  const seenTargets = new Set();
  const callees = [];
  for (const edge of state.rawGraph.edges) {
    if (edge.source !== node.id || edge.target === node.id || seenTargets.has(edge.target)) {
      continue;
    }
    const targetNode = state.nodesById.get(edge.target);
    if (targetNode && targetNode.type === "function") {
      seenTargets.add(edge.target);
      callees.push(targetNode);
    }
  }

  if (callees.length === 0) {
    block.classList.add("hidden");
    return;
  }

  for (const targetNode of callees) {
    list.appendChild(createInternalCallCard(targetNode));
  }
  block.classList.remove("hidden");
}

const EXTERNAL_KIND_LABELS = {
  stdlib: "Stdlib",
  native: "Nativo JS",
  method: "Método",
  package: "Paquete",
};

function getApiKey(apiItem) {
  return (apiItem && (apiItem.api_id || apiItem.symbol)) || "";
}

function isApiKnown(apiId) {
  return Boolean(apiId && state.knownApis && state.knownApis.known && state.knownApis.known[apiId]);
}

function getProjectExternalApisMap() {
  const map = new Map();
  if (!state.rawGraph || !Array.isArray(state.rawGraph.nodes)) {
    return map;
  }
  for (const node of state.rawGraph.nodes) {
    if (node.type !== "function" || !Array.isArray(node.external_calls)) {
      continue;
    }
    for (const ext of node.external_calls) {
      const key = getApiKey(ext);
      if (!key) {
        continue;
      }
      if (!map.has(key)) {
        map.set(key, {
          ...ext,
          api_id: key,
          usageCount: 1,
          nodeIds: [node.id],
        });
      } else {
        const current = map.get(key);
        current.usageCount += 1;
        if (current.nodeIds.length < 5 && !current.nodeIds.includes(node.id)) {
          current.nodeIds.push(node.id);
        }
      }
    }
  }
  return map;
}

function updateKnownApisButton() {
  const btn = document.getElementById("btn-known-apis");
  if (!btn) {
    return;
  }
  const projectApis = getProjectExternalApisMap();
  let pendingCount = 0;
  for (const apiId of projectApis.keys()) {
    if (!isApiKnown(apiId)) {
      pendingCount += 1;
    }
  }
  const knownCount = Object.keys((state.knownApis && state.knownApis.known) || {}).length;
  const labelEl = document.getElementById("apis-label-text");
  const badgeEl = document.getElementById("apis-count-badge");
  if (labelEl) {
    labelEl.textContent = `APIs (${pendingCount} / ${knownCount})`;
  }
  if (badgeEl) {
    badgeEl.textContent = pendingCount > 0 ? String(pendingCount) : "";
    badgeEl.classList.toggle("hidden", pendingCount === 0);
  }
  btn.title = `APIs (${pendingCount} pendientes / ${knownCount} aprendidas)`;
}

function applyKnownApisState(newKnownApis) {
  state.knownApis = newKnownApis || { version: 1, known: {} };
  updateKnownApisButton();
  if (state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
    updateExternalCallsBlock(state.nodesById.get(state.selectedNodeId));
  }
  const modal = document.getElementById("apis-modal");
  if (modal && !modal.classList.contains("hidden")) {
    renderApisModal();
  }
}

async function setApiKnownStatus(apiItem, markKnown) {
  const apiId = getApiKey(apiItem);
  if (!apiId) {
    return;
  }
  const payload = markKnown
    ? {
        action: "mark",
        api: {
          api_id: apiId,
          symbol: apiItem.symbol,
          module: apiItem.module || "",
          kind: apiItem.kind || "external",
          docs_url: apiItem.docs_url || "",
        },
      }
    : { action: "unmark", api_id: apiId };

  const response = await fetch("/known-apis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.ok) {
    const updated = await response.json();
    applyKnownApisState(updated);
  }
}

function updateExternalCallsBlock(node) {
  const block = document.getElementById("detail-external-calls-block");
  const list = document.getElementById("detail-external-calls-list");
  list.innerHTML = "";

  if (node.type !== "function" || !Array.isArray(node.external_calls) || node.external_calls.length === 0) {
    block.classList.add("hidden");
    return;
  }

  const pendingCalls = node.external_calls.filter((ext) => !isApiKnown(getApiKey(ext)));
  if (pendingCalls.length === 0) {
    const li = document.createElement("li");
    li.className = "apis-empty-known-note";
    const text = document.createElement("span");
    text.textContent = `Todas las APIs de este nodo (${node.external_calls.length}) ya están marcadas como aprendidas.`;
    li.appendChild(text);

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "call-action-btn";
    openBtn.textContent = "Ver inventario";
    openBtn.addEventListener("click", openApisModal);
    li.appendChild(openBtn);
    list.appendChild(li);
    block.classList.remove("hidden");
    return;
  }

  for (const ext of pendingCalls) {
    const li = document.createElement("li");
    li.className = "call-card";

    const header = document.createElement("div");
    header.className = "call-card-header";

    const symbol = document.createElement("span");
    symbol.className = "call-name";
    symbol.textContent = `${ext.symbol}()`;
    header.appendChild(symbol);

    const origin = document.createElement("span");
    origin.className = "call-origin";
    origin.textContent = ext.module || "";
    header.appendChild(origin);
    li.appendChild(header);

    if (ext.call_expr && ext.call_expr !== ext.symbol) {
      const sub = document.createElement("div");
      sub.className = "call-expr-sub";
      sub.textContent = `Invocación: ${ext.call_expr}()`;
      li.appendChild(sub);
    }

    const actions = document.createElement("div");
    actions.className = "call-card-actions";

    const kindTag = document.createElement("span");
    kindTag.className = "call-kind-tag";
    kindTag.textContent = EXTERNAL_KIND_LABELS[ext.kind] || ext.kind || "externo";
    actions.appendChild(kindTag);

    if (ext.docs_url) {
      const docsLink = document.createElement("a");
      docsLink.className = "call-link docs-link";
      docsLink.href = ext.docs_url;
      docsLink.target = "_blank";
      docsLink.rel = "noopener noreferrer";
      docsLink.textContent = "Docs ↗";
      actions.appendChild(docsLink);
    }

    const knowBtn = document.createElement("button");
    knowBtn.type = "button";
    knowBtn.className = "call-action-btn known-api-btn";
    knowBtn.textContent = "✓ Ya lo sé";
    knowBtn.title = "Guardar en ~/.codemap/known_apis.json";
    knowBtn.addEventListener("click", () => setApiKnownStatus(ext, true));
    actions.appendChild(knowBtn);

    li.appendChild(actions);
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
  const effectiveRole = entry.custom_role || raw.role || raw.type;
  cyNode.data("role", effectiveRole);
  cyNode.data("terminal", raw.type === "function" && raw.is_terminal ? "true" : "false");
  cyNode.data("pinned", entry.pinned ? "true" : "false");
  cyNode.data("label", buildDisplayLabel(raw, cyNode.data("collapsed") === "true", entry, effectiveRole));
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

async function navigateToNode(nodeId) {
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

async function focusSearchResult(nodeId) {
  closeSearchModal();
  await navigateToNode(nodeId);
}

function updateOrphansBadge() {
  const count = (state.notes.orphans || []).length;
  const btn = document.getElementById("btn-orphans");
  const labelEl = document.getElementById("orphans-label-text");
  const badgeEl = document.getElementById("orphans-count-badge");
  if (labelEl) {
    labelEl.textContent = `Huérfanas (${count})`;
  }
  if (badgeEl) {
    badgeEl.textContent = count > 0 ? String(count) : "";
    badgeEl.classList.toggle("hidden", count === 0);
  }
  if (btn) {
    btn.classList.toggle("has-orphans", count > 0);
    btn.title = `Notas huérfanas (${count})`;
  }
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
// Inventario global de aprendizaje (~/.codemap/known_apis.json) y ayuda (?)
// ---------------------------------------------------------------------------

function openApisModal() {
  const modal = document.getElementById("apis-modal");
  const searchInput = document.getElementById("apis-search-input");
  searchInput.value = state.apisSearchQuery || "";
  renderApisModal();
  modal.classList.remove("hidden");
  searchInput.focus();
}

function closeApisModal() {
  document.getElementById("apis-modal").classList.add("hidden");
}

function switchApisTab(tabName) {
  state.apisModalTab = tabName === "known" ? "known" : "pending";
  renderApisModal();
}

function renderApisModal() {
  const projectMap = getProjectExternalApisMap();
  const knownMap = (state.knownApis && state.knownApis.known) || {};

  const pendingItems = [];
  for (const item of projectMap.values()) {
    if (!knownMap[item.api_id]) {
      pendingItems.push(item);
    }
  }
  pendingItems.sort((a, b) => (b.usageCount - a.usageCount) || a.symbol.localeCompare(b.symbol));

  const knownItems = Object.values(knownMap).map((entry) => ({
    ...entry,
    inCurrentProject: projectMap.has(entry.api_id),
    usageCount: projectMap.has(entry.api_id) ? projectMap.get(entry.api_id).usageCount : 0,
  }));
  knownItems.sort((a, b) => Number(b.inCurrentProject) - Number(a.inCurrentProject) || a.symbol.localeCompare(b.symbol));

  document.getElementById("tab-apis-pending").textContent = `Por aprender (${pendingItems.length})`;
  document.getElementById("tab-apis-known").textContent = `Aprendidas (${knownItems.length})`;
  document.getElementById("tab-apis-pending").classList.toggle("active", state.apisModalTab === "pending");
  document.getElementById("tab-apis-known").classList.toggle("active", state.apisModalTab === "known");

  const query = (state.apisSearchQuery || "").trim().toLowerCase();
  const sourceList = state.apisModalTab === "pending" ? pendingItems : knownItems;
  const filtered = sourceList.filter((item) => {
    if (!query) {
      return true;
    }
    const haystack = `${item.symbol} ${item.module || ""} ${item.kind || ""} ${item.call_expr || ""}`.toLowerCase();
    return haystack.includes(query);
  });

  const hint = document.getElementById("apis-summary-hint");
  if (state.apisModalTab === "pending") {
    hint.textContent = pendingItems.length === 0
      ? "No quedan APIs o métodos pendientes en este proyecto."
      : `Mostrando ${filtered.length} de ${pendingItems.length} APIs pendientes en este proyecto.`;
  } else {
    hint.textContent = knownItems.length === 0
      ? "Aún no has marcado ninguna API en ~/.codemap/known_apis.json."
      : `Inventario global compartido (~/.codemap/known_apis.json): ${filtered.length} de ${knownItems.length} aprendidas.`;
  }

  const list = document.getElementById("apis-list");
  list.innerHTML = "";

  for (const item of filtered) {
    const li = document.createElement("li");
    li.className = "orphan-card";

    const header = document.createElement("div");
    header.className = "call-card-header";

    const name = document.createElement("span");
    name.className = "call-name";
    name.textContent = `${item.symbol}()`;
    header.appendChild(name);

    const origin = document.createElement("span");
    origin.className = "call-origin";
    origin.textContent = item.module || "";
    header.appendChild(origin);
    li.appendChild(header);

    const meta = document.createElement("div");
    meta.className = "orphan-meta";
    meta.textContent = state.apisModalTab === "pending"
      ? `Detectada en ${item.usageCount} ${item.usageCount === 1 ? "función" : "funciones"}`
      : `Marcada el ${(item.marked_at || "").slice(0, 10) || "—"}${item.inCurrentProject ? ` · ${item.usageCount} usos en este proyecto` : ""}`;
    li.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "call-card-actions";

    const kindTag = document.createElement("span");
    kindTag.className = "call-kind-tag";
    kindTag.textContent = EXTERNAL_KIND_LABELS[item.kind] || item.kind || "externo";
    actions.appendChild(kindTag);

    if (state.apisModalTab === "known" && item.inCurrentProject) {
      const badge = document.createElement("span");
      badge.className = "api-project-badge";
      badge.textContent = "En este proyecto";
      actions.appendChild(badge);
    }

    if (item.docs_url) {
      const docsLink = document.createElement("a");
      docsLink.className = "call-link docs-link";
      docsLink.href = item.docs_url;
      docsLink.target = "_blank";
      docsLink.rel = "noopener noreferrer";
      docsLink.textContent = "Docs ↗";
      actions.appendChild(docsLink);
    }

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    if (state.apisModalTab === "pending") {
      toggleBtn.className = "call-action-btn known-api-btn";
      toggleBtn.textContent = "✓ Marcar como aprendida";
      toggleBtn.addEventListener("click", () => setApiKnownStatus(item, true));
    } else {
      toggleBtn.className = "call-action-btn api-unmark-btn";
      toggleBtn.textContent = "↩ Por aprender";
      toggleBtn.addEventListener("click", () => setApiKnownStatus(item, false));
    }
    actions.appendChild(toggleBtn);

    li.appendChild(actions);
    list.appendChild(li);
  }
}

function openHelpModal() {
  document.getElementById("help-modal").classList.remove("hidden");
}

function closeHelpModal() {
  document.getElementById("help-modal").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Navegación ergonómica (Modo Mano, Zoom, Ajustar) y panel colapsable
// ---------------------------------------------------------------------------

function setSpacePanMode(enabled) {
  const active = Boolean(enabled);
  if (state.spacePanning === active) {
    return;
  }
  state.spacePanning = active;
  const area = document.getElementById("canvas-area");
  if (area) {
    area.classList.toggle("pan-mode", active);
    if (!active) {
      area.classList.remove("panning-active");
    }
  }
  if (state.cy) {
    if (typeof state.cy.autoungrabify === "function") {
      state.cy.autoungrabify(active);
    }
    if (typeof state.cy.boxSelectionEnabled === "function") {
      state.cy.boxSelectionEnabled(!active);
    }
  }
}

function bindCanvasPanControls() {
  const container = document.getElementById("cy");
  const area = document.getElementById("canvas-area");
  if (!container || !area) {
    return;
  }

  let panDrag = null;

  container.addEventListener("mousedown", (event) => {
    const isMiddlePan = event.button === 1;
    const isSpaceLeftPan = event.button === 0 && state.spacePanning;
    if (!isMiddlePan && !isSpaceLeftPan) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const currentPan = state.cy.pan();
    panDrag = {
      startX: event.clientX,
      startY: event.clientY,
      startPanX: currentPan.x,
      startPanY: currentPan.y,
      didMove: false,
    };
    area.classList.add("panning-active");
  }, true);

  window.addEventListener("mousemove", (event) => {
    if (!panDrag || !state.cy) {
      return;
    }
    const dx = event.clientX - panDrag.startX;
    const dy = event.clientY - panDrag.startY;
    if (!panDrag.didMove && Math.hypot(dx, dy) > 3) {
      panDrag.didMove = true;
    }
    state.cy.pan({ x: panDrag.startPanX + dx, y: panDrag.startPanY + dy });
  });

  const finishPanDrag = () => {
    if (!panDrag) {
      return;
    }
    if (panDrag.didMove) {
      state.suppressNextTap = true;
      setTimeout(() => {
        state.suppressNextTap = false;
      }, 60);
    }
    panDrag = null;
    area.classList.remove("panning-active");
  };

  window.addEventListener("mouseup", finishPanDrag);
  window.addEventListener("blur", () => {
    finishPanDrag();
    setSpacePanMode(false);
  });
}

function fitGraphToScreen() {
  if (state.cy) {
    state.cy.fit(undefined, 40);
    updateZoomIndicator();
  }
}

function zoomByFactor(factor) {
  if (!state.cy) {
    return;
  }
  const container = state.cy.container();
  const renderedPosition = container
    ? { x: container.clientWidth / 2, y: container.clientHeight / 2 }
    : undefined;
  const minZoom = typeof state.cy.minZoom === "function" ? state.cy.minZoom() : 0.15;
  const maxZoom = typeof state.cy.maxZoom === "function" ? state.cy.maxZoom() : 3;
  const nextZoom = Math.min(maxZoom, Math.max(minZoom, state.cy.zoom() * factor));
  state.cy.zoom({ level: nextZoom, renderedPosition });
  updateZoomIndicator();
}

function updateZoomIndicator() {
  const el = document.getElementById("zoom-indicator");
  if (!el || !state.cy) {
    return;
  }
  const pct = Math.round(state.cy.zoom() * 100);
  el.textContent = `${pct}%`;
}

function scheduleCanvasResize(panelEl) {
  let resized = false;
  const syncCanvasSize = () => {
    if (resized || !state.cy) {
      return;
    }
    resized = true;
    state.cy.resize();
  };

  const onTransitionEnd = (event) => {
    if (event.propertyName === "width") {
      panelEl.removeEventListener("transitionend", onTransitionEnd);
      syncCanvasSize();
    }
  };
  panelEl.addEventListener("transitionend", onTransitionEnd);
  setTimeout(() => {
    panelEl.removeEventListener("transitionend", onTransitionEnd);
    syncCanvasSize();
  }, 260);
}

function toggleLeftSidebar(forceExpanded = null) {
  const sidebar = document.getElementById("left-sidebar");
  const toggleBtn = document.getElementById("btn-toggle-sidebar");
  if (!sidebar || !toggleBtn) {
    return;
  }
  const shouldCollapse = forceExpanded === null ? !state.leftSidebarCollapsed : !forceExpanded;
  state.leftSidebarCollapsed = shouldCollapse;
  sidebar.classList.toggle("collapsed", shouldCollapse);
  toggleBtn.textContent = shouldCollapse ? "»" : "«";
  toggleBtn.setAttribute("aria-expanded", String(!shouldCollapse));
  toggleBtn.title = shouldCollapse ? "Expandir barra lateral" : "Colapsar barra lateral";
  scheduleCanvasResize(sidebar);
}

function toggleLegend(forceCollapsed = null) {
  const legend = document.getElementById("graph-legend");
  const toggleBtn = document.getElementById("btn-toggle-legend");
  const body = document.getElementById("legend-body");
  if (!legend || !toggleBtn) {
    return;
  }
  const shouldCollapse = forceCollapsed === null ? !state.legendCollapsed : Boolean(forceCollapsed);
  state.legendCollapsed = shouldCollapse;
  legend.classList.toggle("collapsed", shouldCollapse);
  if (body) {
    body.classList.toggle("hidden", shouldCollapse);
  }
  toggleBtn.textContent = shouldCollapse ? "Leyenda ▴" : "Leyenda ▾";
  toggleBtn.setAttribute("aria-expanded", String(!shouldCollapse));
}

function toggleInspectorPanel(forceOpen = null) {
  const panel = document.getElementById("details-panel");
  const showBtn = document.getElementById("btn-show-panel");
  const topbarBtn = document.getElementById("btn-topbar-inspector");
  if (!panel || !showBtn) {
    return;
  }
  const shouldCollapse = forceOpen === null ? !state.panelCollapsed : !forceOpen;
  state.panelCollapsed = shouldCollapse;
  panel.classList.toggle("collapsed", shouldCollapse);
  showBtn.classList.toggle("hidden", !shouldCollapse);
  if (topbarBtn) {
    topbarBtn.classList.toggle("active", !shouldCollapse);
    topbarBtn.setAttribute("aria-expanded", String(!shouldCollapse));
    topbarBtn.title = shouldCollapse ? "Mostrar inspector (])" : "Ocultar inspector (])";
  }
  scheduleCanvasResize(panel);
}

// ---------------------------------------------------------------------------
// Eventos de barra, panel lateral y atajos de teclado
// ---------------------------------------------------------------------------

function bindControls() {
  for (const btn of document.querySelectorAll(".level-btn")) {
    btn.addEventListener("click", () => applyLevel(Number(btn.dataset.level)));
  }

  const toggleSidebarBtn = document.getElementById("btn-toggle-sidebar");
  if (toggleSidebarBtn) {
    toggleSidebarBtn.addEventListener("click", () => toggleLeftSidebar());
  }
  const toggleLegendBtn = document.getElementById("btn-toggle-legend");
  if (toggleLegendBtn) {
    toggleLegendBtn.addEventListener("click", () => {
      state.legendUserToggled = true;
      toggleLegend();
    });
  }
  const topbarInspectorBtn = document.getElementById("btn-topbar-inspector");
  if (topbarInspectorBtn) {
    topbarInspectorBtn.classList.toggle("active", !state.panelCollapsed);
    topbarInspectorBtn.setAttribute("aria-expanded", String(!state.panelCollapsed));
    topbarInspectorBtn.addEventListener("click", () => toggleInspectorPanel());
  }
  const zoomInBtn = document.getElementById("btn-zoom-in");
  if (zoomInBtn) {
    zoomInBtn.addEventListener("click", () => zoomByFactor(1.2));
  }
  const zoomOutBtn = document.getElementById("btn-zoom-out");
  if (zoomOutBtn) {
    zoomOutBtn.addEventListener("click", () => zoomByFactor(1 / 1.2));
  }
  const zoomIndicator = document.getElementById("zoom-indicator");
  if (zoomIndicator) {
    zoomIndicator.addEventListener("click", fitGraphToScreen);
  }

  document.getElementById("btn-relayout").addEventListener("click", () => {
    refreshGraphView({ fit: false });
  });
  document.getElementById("btn-fit").addEventListener("click", fitGraphToScreen);
  document.getElementById("btn-trace").addEventListener("click", toggleTraceMode);
  document.getElementById("btn-search").addEventListener("click", openSearchModal);
  document.getElementById("btn-orphans").addEventListener("click", openOrphansModal);
  document.getElementById("btn-close-orphans").addEventListener("click", closeOrphansModal);
  document.getElementById("btn-known-apis").addEventListener("click", openApisModal);
  document.getElementById("btn-close-apis").addEventListener("click", closeApisModal);
  document.getElementById("btn-help").addEventListener("click", openHelpModal);
  document.getElementById("btn-close-help").addEventListener("click", closeHelpModal);
  document.getElementById("btn-collapse-panel").addEventListener("click", () => toggleInspectorPanel(false));
  document.getElementById("btn-show-panel").addEventListener("click", () => toggleInspectorPanel(true));

  document.getElementById("tab-apis-pending").addEventListener("click", () => switchApisTab("pending"));
  document.getElementById("tab-apis-known").addEventListener("click", () => switchApisTab("known"));
  document.getElementById("apis-search-input").addEventListener("input", (event) => {
    state.apisSearchQuery = event.target.value || "";
    renderApisModal();
  });

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
  document.getElementById("apis-modal").addEventListener("click", (event) => {
    if (event.target.id === "apis-modal") {
      closeApisModal();
    }
  });
  document.getElementById("help-modal").addEventListener("click", (event) => {
    if (event.target.id === "help-modal") {
      closeHelpModal();
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
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function hasOpenModal() {
  return ["search-modal", "orphans-modal", "apis-modal", "help-modal"].some((id) => {
    const el = document.getElementById(id);
    return el && !el.classList.contains("hidden");
  });
}

function closeOpenModals() {
  const wasOpen = hasOpenModal();
  closeSearchModal();
  closeOrphansModal();
  closeApisModal();
  closeHelpModal();
  return wasOpen;
}

function bindGlobalShortcuts() {
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearchModal();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "0") {
      event.preventDefault();
      fitGraphToScreen();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === "\\" || event.code === "Backslash")) {
      event.preventDefault();
      toggleInspectorPanel();
      return;
    }
    if (event.key === "Escape") {
      if (closeOpenModals()) {
        return;
      }
      if (state.traceMode) {
        toggleTraceMode();
        return;
      }
      if (state.selectedNodeId) {
        if (state.cy && typeof state.cy.nodes === "function") {
          state.cy.nodes().unselect();
        }
        clearSelectionPanel();
      }
      return;
    }

    if (isTypingInField(event.target)) {
      return;
    }

    if (event.code === "Space" && !hasOpenModal()) {
      event.preventDefault();
      if (!event.repeat) {
        setSpacePanMode(true);
      }
      return;
    }

    if (hasOpenModal()) {
      return;
    }

    const key = event.key.toLowerCase();
    if (key === "r" && !event.ctrlKey && !event.metaKey) {
      refreshGraphView({ fit: false });
    } else if (key === "t" && !event.ctrlKey && !event.metaKey) {
      toggleTraceMode();
    } else if (key === "f" && !event.ctrlKey && !event.metaKey) {
      fitGraphToScreen();
    } else if (event.key === "]" && !event.ctrlKey && !event.metaKey) {
      toggleInspectorPanel();
    } else if (event.key === "?" && !event.ctrlKey && !event.metaKey) {
      openHelpModal();
    } else if (
      (event.key === "+" || event.key === "=" || event.code === "NumpadAdd")
      && !event.ctrlKey
      && !event.metaKey
    ) {
      event.preventDefault();
      zoomByFactor(1.2);
    } else if (
      (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract")
      && !event.ctrlKey
      && !event.metaKey
    ) {
      event.preventDefault();
      zoomByFactor(1 / 1.2);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      stepTrace("forward");
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepTrace("backward");
    }
  });

  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      setSpacePanMode(false);
    }
  });
}

initViewer().catch((error) => {
  document.getElementById("project-title").textContent = "Error al iniciar CodeMap";
  console.error(error);
});
