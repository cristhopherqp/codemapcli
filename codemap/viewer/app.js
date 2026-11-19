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

const EDGE_TYPE_META = {
  direct_call: { label: "Llamada directa", short: "directa", icon: "→" },
  event_listener: { label: "Listener de evento / ruta", short: "evento", icon: "⚡" },
  callback_ref: { label: "Callback por referencia", short: "callback", icon: "🔗" },
  reactive_subscribe: { label: "Suscripción reactiva", short: "suscripción", icon: "📡" },
  reactive_trigger: { label: "Disparo reactivo", short: "reactivo", icon: "↻" },
  serves_html: { label: "Sirve documento HTML", short: "HTML", icon: "🌐" },
  loads_script: { label: "Carga script", short: "script", icon: "📜" },
};

const EDGE_TYPE_PRIORITY = {
  direct_call: 1,
  serves_html: 2,
  loads_script: 2,
  event_listener: 3,
  reactive_subscribe: 4,
  callback_ref: 5,
  reactive_trigger: 6,
};

const ENTRY_KIND_LABELS = {
  main: "Inicio principal",
  route_handler: "Ruta HTTP",
  event_handler: "Handler de evento",
  unreferenced: "Sin referencias",
};

const NOTE_AUTOSAVE_MS = 500;

const state = {
  rawGraph: null,
  notes: { nodes: {}, orphans: [] },
  knownApis: { version: 1, known: {} },
  nodesById: new Map(),
  childrenByParent: new Map(),
  flowsById: new Map(),
  activeFlowId: null,
  preFlowCollapsedContainers: null,
  utilityNodeIds: new Set(),
  utilityDetectionMode: "strict",
  hideUtilities: false,
  utilityCalleesByNode: new Map(),
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
  traceDirection: "forward",
  traceBranchCandidates: [],
  traceBranchIndex: 0,
  noteSaveTimer: null,
  searchMatches: [],
  searchActiveIndex: 0,
  apisModalTab: "pending",
  apisSearchQuery: "",
  floatingWindows: new Map(),
  floatingWindowByTarget: new Map(),
  windowFocusOrder: [],
  activeWindowId: null,
  windowIdCounter: 0,
  windowZCounter: 30,
  bridgeRenderRaf: null,
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
  populateFlowSelector();
  updateUtilitiesButton();
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
  populateFlowSelector();
  updateUtilitiesButton();
  updateOrphansBadge();
  updateKnownApisButton();

  await refreshGraphView({ fit: false });
  state.cy.viewport({ zoom, pan });
  await reconcileFloatingWindowsOnLiveUpdate();

  if (state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
    state.cy.getElementById(state.selectedNodeId).select();
    selectNode(state.selectedNodeId, state.activeFlowStepId);
  } else {
    clearSelectionPanel();
  }
  renderActiveFlowPanel();
  if (!document.getElementById("apis-modal").classList.contains("hidden")) {
    renderApisModal();
  }
  applyCanvasHighlights();
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
  if (state.activeFlowId && !state.flowsById.has(state.activeFlowId)) {
    state.activeFlowId = null;
    state.preFlowCollapsedContainers = null;
  }
}

function indexGraph(graph) {
  state.nodesById.clear();
  state.childrenByParent.clear();
  state.flowsById.clear();
  for (const node of graph.nodes) {
    state.nodesById.set(node.id, node);
    const parentKey = node.parent || null;
    if (!state.childrenByParent.has(parentKey)) {
      state.childrenByParent.set(parentKey, []);
    }
    state.childrenByParent.get(parentKey).push(node);
  }
  for (const flow of graph.execution_flows || []) {
    if (flow && flow.id) {
      state.flowsById.set(flow.id, flow);
    }
  }
  computeUtilityNodes(graph);
}

function computeUtilityNodes(graph) {
  state.utilityNodeIds.clear();
  state.utilityCalleesByNode.clear();
  state.utilityDetectionMode = "strict";

  const callerFns = new Map();
  const callerFiles = new Map();
  const outFns = new Map();

  for (const edge of graph.edges || []) {
    if (edge.source === edge.target) {
      continue;
    }
    const srcNode = state.nodesById.get(edge.source);
    const dstNode = state.nodesById.get(edge.target);
    if (!srcNode || !dstNode || srcNode.type !== "function" || dstNode.type !== "function") {
      continue;
    }
    if (!callerFns.has(edge.target)) {
      callerFns.set(edge.target, new Set());
      callerFiles.set(edge.target, new Set());
    }
    callerFns.get(edge.target).add(edge.source);
    callerFiles.get(edge.target).add(srcNode.parent || edge.source.split("::")[0]);
    if (!outFns.has(edge.source)) {
      outFns.set(edge.source, new Set());
    }
    outFns.get(edge.source).add(edge.target);
  }

  const isEligibleUtility = (node) => {
    if (node.type !== "function") {
      return false;
    }
    if (
      node.is_main_entry
      || node.entry_kind === "main"
      || node.entry_kind === "route_handler"
      || node.role === "entry"
    ) {
      return false;
    }
    return true;
  };

  const strictSet = new Set();
  const compactSet = new Set();
  for (const node of graph.nodes || []) {
    if (!isEligibleUtility(node)) {
      continue;
    }
    const fnCallers = callerFns.get(node.id);
    const fileCallers = callerFiles.get(node.id);
    const callees = outFns.get(node.id);
    if (!fnCallers || !fileCallers) {
      continue;
    }
    const outCount = callees ? callees.size : 0;
    const isLeafLike = Boolean(node.is_terminal) || outCount <= 1;
    if (isLeafLike && (fileCallers.size >= 3 || fnCallers.size >= 5)) {
      strictSet.add(node.id);
    } else if (Boolean(node.is_terminal) && fileCallers.size >= 2 && fnCallers.size >= 2) {
      compactSet.add(node.id);
    }
  }

  const totalFuncs = (graph.meta && graph.meta.total_functions) || 0;
  let chosen = strictSet;
  if (strictSet.size === 0 && totalFuncs <= 25 && compactSet.size > 0) {
    chosen = compactSet;
    state.utilityDetectionMode = "compact";
  }

  for (const id of chosen) {
    state.utilityNodeIds.add(id);
  }

  for (const edge of graph.edges || []) {
    if (edge.source === edge.target || !state.utilityNodeIds.has(edge.target)) {
      continue;
    }
    const targetNode = state.nodesById.get(edge.target);
    if (!targetNode) {
      continue;
    }
    if (!state.utilityCalleesByNode.has(edge.source)) {
      state.utilityCalleesByNode.set(edge.source, []);
    }
    const list = state.utilityCalleesByNode.get(edge.source);
    if (!list.some((item) => item.node.id === targetNode.id)) {
      list.push({ node: targetNode, edge });
    }
  }
}

function updateUtilitiesButton() {
  const btn = document.getElementById("btn-hide-utilities");
  const labelEl = document.getElementById("utilities-label-text");
  const badgeEl = document.getElementById("utilities-count-badge");
  if (!btn) {
    return;
  }
  const count = state.utilityNodeIds.size;
  if (labelEl) {
    labelEl.textContent = state.hideUtilities
      ? `Mostrando sin utilitarios (${count})`
      : `Ocultar utilitarios (${count})`;
  }
  if (badgeEl) {
    badgeEl.textContent = count > 0 ? String(count) : "";
    badgeEl.classList.toggle("hidden", count === 0);
  }
  btn.classList.toggle("active", state.hideUtilities);
  btn.disabled = count === 0 && !state.hideUtilities;
  const criterion = state.utilityDetectionMode === "compact"
    ? "funciones hoja transversales (≥2 archivos)"
    : "funciones hoja/utilitarias de alto fan-in (≥3 archivos o ≥5 llamadores)";
  btn.title = count > 0
    ? `${state.hideUtilities ? "Mostrar" : "Ocultar"} ${count} utilitarios detectados (${criterion})`
    : `No se detectaron utilitarios transversales en este proyecto`;
}

async function toggleHideUtilities() {
  if (state.utilityNodeIds.size === 0 && !state.hideUtilities) {
    return;
  }
  state.hideUtilities = !state.hideUtilities;
  updateUtilitiesButton();
  await refreshGraphView({ fit: false });
  if (state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
    selectNode(state.selectedNodeId, state.activeFlowStepId);
  }
}

// ---------------------------------------------------------------------------
// Hilos de ejecución deterministas (`execution_flows`)
// ---------------------------------------------------------------------------

function getActiveFlow() {
  return state.activeFlowId ? (state.flowsById.get(state.activeFlowId) || null) : null;
}

function getActiveFlowStepMaps() {
  const flow = getActiveFlow();
  const nodeOrder = new Map();
  const edgeOrder = new Map();
  if (!flow) {
    return { flow: null, nodeOrder, edgeOrder };
  }
  for (const step of flow.steps || []) {
    if (step.node_id && !nodeOrder.has(step.node_id)) {
      nodeOrder.set(step.node_id, step.order);
    }
    if (step.edge_id && !edgeOrder.has(step.edge_id)) {
      edgeOrder.set(step.edge_id, step.order);
    }
  }
  return { flow, nodeOrder, edgeOrder };
}

function populateFlowSelector() {
  const select = document.getElementById("flow-select");
  const clearBtn = document.getElementById("btn-clear-flow");
  if (!select) {
    return;
  }
  const flows = (state.rawGraph && state.rawGraph.execution_flows) || [];
  select.innerHTML = "";

  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = flows.length > 0 ? `Hilo: Todos (${flows.length})` : "Hilo: Todos";
  select.appendChild(allOpt);

  const mainFlows = flows.filter((f) => f.kind === "main");
  const featureFlows = flows.filter((f) => f.kind === "feature");

  if (mainFlows.length > 0) {
    const grp = document.createElement("optgroup");
    grp.label = "Hilos Principales (Arranque)";
    for (const fl of mainFlows) {
      const opt = document.createElement("option");
      opt.value = fl.id;
      opt.textContent = `▶ ${fl.label} (${(fl.node_ids || []).length})`;
      grp.appendChild(opt);
    }
    select.appendChild(grp);
  }

  if (featureFlows.length > 0) {
    const grp = document.createElement("optgroup");
    grp.label = "Hilos por Feature / Evento / Ruta";
    for (const fl of featureFlows) {
      const opt = document.createElement("option");
      opt.value = fl.id;
      opt.textContent = `⚡ ${fl.label} (${(fl.node_ids || []).length})`;
      grp.appendChild(opt);
    }
    select.appendChild(grp);
  }

  const validActive = state.activeFlowId && state.flowsById.has(state.activeFlowId);
  select.value = validActive ? state.activeFlowId : "";
  select.classList.toggle("has-active-flow", Boolean(validActive));
  select.disabled = flows.length === 0;
  if (clearBtn) {
    clearBtn.classList.toggle("hidden", !validActive);
  }
}

async function applyExecutionFlow(flowId, { fit = true } = {}) {
  const cleanId = flowId && state.flowsById.has(flowId) ? flowId : null;

  if (cleanId && state.traceMode) {
    state.traceMode = false;
    state.traceHistory = [];
    document.getElementById("btn-trace").classList.remove("active");
    hideTraceBranchHud();
  }

  if (!cleanId) {
    state.activeFlowId = null;
    if (state.preFlowCollapsedContainers) {
      state.collapsedContainers = new Set(state.preFlowCollapsedContainers);
      state.preFlowCollapsedContainers = null;
    }
    populateFlowSelector();
    renderActiveFlowPanel();
    await refreshGraphView({ fit });
    return;
  }

  if (!state.activeFlowId) {
    state.preFlowCollapsedContainers = new Set(state.collapsedContainers);
  }
  state.activeFlowId = cleanId;
  const flow = state.flowsById.get(cleanId);

  // Expandir automáticamente contenedores ancestros para que todos los pasos sean visibles.
  for (const nodeId of flow.node_ids || []) {
    let cursor = state.nodesById.get(nodeId);
    while (cursor && cursor.parent) {
      state.collapsedContainers.delete(cursor.parent);
      cursor = state.nodesById.get(cursor.parent);
    }
  }

  populateFlowSelector();
  await refreshGraphView({ fit: false });
  renderActiveFlowPanel();

  if (fit && state.cy) {
    const activeEles = state.cy.elements(".flow-active, .flow-root, .flow-active-edge");
    if (activeEles.length > 0) {
      state.cy.animate({ fit: { eles: activeEles, padding: 54 }, duration: 220 });
    }
  }
}

function renderActiveFlowPanel() {
  const panel = document.getElementById("active-flow-panel");
  const badge = document.getElementById("active-flow-kind-badge");
  const titleEl = document.getElementById("active-flow-title");
  const subEl = document.getElementById("active-flow-sub");
  const listEl = document.getElementById("active-flow-steps");
  if (!panel || !listEl) {
    return;
  }
  const flow = getActiveFlow();
  if (!flow) {
    panel.classList.add("hidden");
    listEl.innerHTML = "";
    return;
  }

  panel.classList.remove("hidden");
  const isMain = flow.kind === "main";
  badge.textContent = isMain ? "Hilo Principal" : "Hilo Feature";
  badge.className = `flow-badge ${isMain ? "flow-badge-start" : "flow-badge-event"}`;
  titleEl.textContent = flow.label;

  const subParts = [`${(flow.steps || []).length} pasos`];
  if (flow.trigger) {
    subParts.push(`disparador: ${flow.trigger}`);
  }
  if (flow.registered_by) {
    subParts.push(`registrado por: ${flow.registered_by}`);
  }
  subEl.textContent = subParts.join(" · ");

  listEl.innerHTML = "";
  for (const step of flow.steps || []) {
    const li = document.createElement("li");
    const isCurrent = state.selectedNodeId === step.node_id;
    li.className = `active-flow-step${isCurrent ? " current" : ""}`;
    const indentPx = Math.min(4, step.depth || 0) * 12;
    if (indentPx > 0) {
      li.style.marginLeft = `${indentPx}px`;
    }

    const orderPill = document.createElement("span");
    orderPill.className = "step-order-pill";
    orderPill.textContent = String(step.order);
    li.appendChild(orderPill);

    const rawNode = state.nodesById.get(step.node_id);
    const labelSpan = document.createElement("span");
    labelSpan.className = "step-node-label";
    labelSpan.textContent = rawNode ? rawNode.label : step.node_id;
    labelSpan.title = step.node_id;
    li.appendChild(labelSpan);

    if (step.edge_type) {
      const meta = EDGE_TYPE_META[step.edge_type] || { short: step.edge_type, icon: "→" };
      const tag = document.createElement("span");
      tag.className = `edge-type-pill edge-type-${step.edge_type}`;
      tag.textContent = `${meta.icon} ${meta.short}`;
      li.appendChild(tag);
    }

    li.addEventListener("click", () => navigateToNode(step.node_id));
    listEl.appendChild(li);
  }
}

function renderHeader(meta, edgeCount) {
  document.getElementById("project-title").textContent = meta.project_name;
  document.getElementById("project-stats").textContent =
    `${meta.total_functions} funciones · ${edgeCount} aristas`;
}

// ---------------------------------------------------------------------------
// Persistencia de notes.json y aislamiento de nodos pinned por nivel
// ---------------------------------------------------------------------------

function getCurrentLayoutContextKey() {
  if (state.expandedFunctions.size > 0 || state.activeLevel === 4) {
    return "level_4";
  }
  if (state.activeLevel === 1) {
    return "level_1";
  }
  if (state.activeLevel === 3) {
    return "level_3";
  }
  return "level_2";
}

function getPinnedPositionForContext(noteEntry, contextKey = getCurrentLayoutContextKey()) {
  if (!noteEntry) {
    return null;
  }
  const byLevel = noteEntry.pinned_positions && noteEntry.pinned_positions[contextKey];
  if (byLevel && typeof byLevel.x === "number" && typeof byLevel.y === "number") {
    return { x: byLevel.x, y: byLevel.y };
  }
  // Retrocompatibilidad con notes.json antiguos: x/y planos solo aplican en Nivel 2 sin funciones expandidas.
  if (
    contextKey === "level_2"
    && state.expandedFunctions.size === 0
    && noteEntry.pinned
    && typeof noteEntry.x === "number"
    && typeof noteEntry.y === "number"
  ) {
    return { x: noteEntry.x, y: noteEntry.y };
  }
  return null;
}

function isPinnedInCurrentContext(noteEntry) {
  return getPinnedPositionForContext(noteEntry, getCurrentLayoutContextKey()) !== null;
}

function getNoteEntry(nodeId) {
  const existing = state.notes.nodes[nodeId];
  if (existing) {
    return {
      pinned_positions: {},
      ...existing,
    };
  }
  return {
    note: "",
    pinned: false,
    x: null,
    y: null,
    pinned_positions: {},
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
  state.preFlowCollapsedContainers = null;
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

  // Si hay un hilo activo, aseguramos que sus contenedores ancestros queden abiertos.
  const activeFlow = getActiveFlow();
  if (activeFlow) {
    for (const nodeId of activeFlow.node_ids || []) {
      let cursor = state.nodesById.get(nodeId);
      while (cursor && cursor.parent) {
        state.collapsedContainers.delete(cursor.parent);
        cursor = state.nodesById.get(cursor.parent);
      }
    }
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

function isUtilityNodeHidden(nodeId, activeFlowNodeSet = null) {
  if (!state.hideUtilities || !state.utilityNodeIds.has(nodeId)) {
    return false;
  }
  if (state.selectedNodeId === nodeId) {
    return false;
  }
  if (activeFlowNodeSet && activeFlowNodeSet.has(nodeId)) {
    return false;
  }
  return true;
}

function countHiddenUtilityCallees(nodeId, activeFlowNodeSet = null) {
  if (!state.hideUtilities) {
    return 0;
  }
  const items = state.utilityCalleesByNode.get(nodeId);
  if (!items || items.length === 0) {
    return 0;
  }
  let hidden = 0;
  for (const item of items) {
    if (isUtilityNodeHidden(item.node.id, activeFlowNodeSet)) {
      hidden += 1;
    }
  }
  return hidden;
}

function buildDisplayLabel(
  rawNode,
  isCollapsed,
  noteEntry,
  effectiveRole = null,
  flowStepOrder = null,
  activeFlowNodeSet = null,
) {
  let label = rawNode.label;
  if (rawNode.type === "file") {
    if (rawNode.language === "html") {
      label = `🌐 ${label}`;
    } else if (rawNode.is_main_entry) {
      label = `★ ${label}`;
    }
  }
  if (flowStepOrder) {
    label = `[${flowStepOrder}] ${label}`;
  }
  if (isCollapsed) {
    const childCount = countDescendantFunctions(rawNode.id);
    if (childCount > 0) {
      label = `${label} [+ ${childCount}]`;
    }
  }
  const tags = [];
  if (rawNode.type === "function") {
    const role = effectiveRole || noteEntry.custom_role || rawNode.role;
    const eKind = rawNode.entry_kind || null;
    if (role === "entry") {
      tags.push(eKind === "route_handler" ? "RUTA" : "INICIO");
    } else if (eKind === "route_handler") {
      tags.push("RUTA");
    } else if (eKind === "event_handler") {
      tags.push("⚡");
    } else if (eKind === "unreferenced") {
      tags.push("sin ref");
    }
    if (rawNode.is_terminal) {
      tags.push("FIN");
    }
    const hiddenUtils = countHiddenUtilityCallees(rawNode.id, activeFlowNodeSet);
    if (hiddenUtils > 0) {
      tags.push(`⚙×${hiddenUtils}`);
    }
  }
  if (noteEntry.note && noteEntry.note.trim()) {
    tags.push("📝");
  }
  if (isPinnedInCurrentContext(noteEntry)) {
    tags.push("📌");
  }
  return tags.length > 0 ? `${label} [${tags.join(" · ")}]` : label;
}

function buildVisibleElements() {
  const visibleNodeIds = new Set();
  const hiddenNodeIds = new Set();
  const nodes = [];

  const { flow: activeFlow, nodeOrder: flowNodeOrder, edgeOrder: flowEdgeOrder } = getActiveFlowStepMaps();
  const activeFlowNodeSet = activeFlow ? new Set(activeFlow.node_ids || []) : null;

  for (const rawNode of state.rawGraph.nodes) {
    if (hasCollapsedAncestor(rawNode)) {
      continue;
    }
    if (isUtilityNodeHidden(rawNode.id, activeFlowNodeSet)) {
      hiddenNodeIds.add(rawNode.id);
      continue;
    }
    visibleNodeIds.add(rawNode.id);

    const noteEntry = getNoteEntry(rawNode.id);
    const isCollapsed = state.collapsedContainers.has(rawNode.id);
    const isExpandedFn = rawNode.type === "function" && state.expandedFunctions.has(rawNode.id);
    const effectiveRole = noteEntry.custom_role || rawNode.role || rawNode.type;
    const stepOrder = flowNodeOrder.get(rawNode.id) || null;
    const isPinnedHere = isPinnedInCurrentContext(noteEntry);

    nodes.push({
      data: {
        id: rawNode.id,
        parent: rawNode.parent || undefined,
        label: buildDisplayLabel(
          rawNode,
          isCollapsed,
          noteEntry,
          effectiveRole,
          stepOrder,
          activeFlowNodeSet,
        ),
        type: rawNode.type,
        role: effectiveRole,
        entryKind: rawNode.entry_kind || "",
        fileLang: rawNode.language || "",
        mainEntry: rawNode.is_main_entry ? "true" : "false",
        terminal: rawNode.type === "function" && rawNode.is_terminal ? "true" : "false",
        pinned: isPinnedHere ? "true" : "false",
        hasNote: noteEntry.note && noteEntry.note.trim() ? "true" : "false",
        collapsed: isCollapsed ? "true" : "false",
        expandedFn: isExpandedFn ? "true" : "false",
        flowStepOrder: stepOrder || 0,
      },
    });

    if (isExpandedFn) {
      appendInternalFlowElements(rawNode, nodes, visibleNodeIds);
    }
  }

  const edges = projectEdges(visibleNodeIds, hiddenNodeIds, flowEdgeOrder);
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

function pickHigherPriorityEdgeType(currentType, candidateType) {
  const curPrio = EDGE_TYPE_PRIORITY[currentType] || 99;
  const candPrio = EDGE_TYPE_PRIORITY[candidateType] || 99;
  return candPrio < curPrio ? candidateType : currentType;
}

function buildProjectedEdgeLabel(item, flowStepOrder) {
  const parts = [];
  if (flowStepOrder) {
    parts.push(`#${flowStepOrder}`);
  }
  if (item.edgeType === "event_listener" && item.edgeEvent) {
    parts.push(`⚡ ${item.edgeEvent}`);
  } else if (item.edgeType === "reactive_trigger") {
    parts.push("↻ reactivo");
  } else if (item.edgeType === "reactive_subscribe") {
    parts.push("📡 sub");
  } else if (item.edgeType === "serves_html") {
    parts.push("HTML");
  } else if (item.edgeType === "loads_script") {
    parts.push("script");
  }
  if (item.call_count > 1) {
    parts.push(`×${item.call_count}`);
  }
  return parts.join(" · ");
}

function projectEdges(visibleNodeIds, hiddenNodeIds = new Set(), flowEdgeOrder = new Map()) {
  const grouped = new Map();

  for (const edge of state.rawGraph.edges) {
    if (hiddenNodeIds.has(edge.source) || hiddenNodeIds.has(edge.target)) {
      continue;
    }
    const source = resolveVisibleEndpoint(edge.source, visibleNodeIds);
    const target = resolveVisibleEndpoint(edge.target, visibleNodeIds);
    if (!source || !target) {
      continue;
    }
    if (source === target && (source !== edge.source || target !== edge.target)) {
      continue;
    }

    const edgeType = edge.edge_type || "direct_call";
    const edgeEvent = edge.event || "";
    const edgeLine = typeof edge.line === "number" ? edge.line : 0;
    const key = `${source}->${target}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        source,
        target,
        confidence: edge.confidence,
        call_count: edge.call_count || 1,
        edgeType,
        edgeEvent,
        line: edgeLine,
        rawEdgeIds: [edge.id],
      });
    } else {
      existing.call_count += edge.call_count || 1;
      if (edge.confidence === "confirmed") {
        existing.confidence = "confirmed";
      }
      existing.edgeType = pickHigherPriorityEdgeType(existing.edgeType, edgeType);
      if (edgeEvent && !existing.edgeEvent) {
        existing.edgeEvent = edgeEvent;
      }
      if (edgeLine > 0 && (existing.line === 0 || edgeLine < existing.line)) {
        existing.line = edgeLine;
      }
      existing.rawEdgeIds.push(edge.id);
    }
  }

  const projected = [];
  let idx = 1;
  for (const item of grouped.values()) {
    let stepOrder = null;
    for (const rawId of item.rawEdgeIds) {
      const ord = flowEdgeOrder.get(rawId);
      if (ord && (stepOrder === null || ord < stepOrder)) {
        stepOrder = ord;
      }
    }
    projected.push({
      data: {
        id: `pe_${idx++}`,
        source: item.source,
        target: item.target,
        confidence: item.confidence,
        call_count: item.call_count,
        edgeType: item.edgeType,
        edgeEvent: item.edgeEvent,
        line: item.line,
        rawEdgeIds: item.rawEdgeIds,
        flowStepOrder: stepOrder || 0,
        label: buildProjectedEdgeLabel(item, stepOrder),
        kind: "call",
      },
    });
  }
  return projected;
}

// ---------------------------------------------------------------------------
// Cytoscape.js + ELKjs layout híbrido (respetando nodos pinned por nivel)
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
    clearActiveFloatingWindowFocus();
    const data = event.target.data();
    const targetId = data.ownerFunctionId || data.id;
    const stepId = data.type === "flow" ? (data.stepId || null) : null;
    selectNode(targetId, stepId);
    if (state.traceMode) {
      state.traceDirection = "forward";
      state.traceBranchIndex = 0;
    }
    applyCanvasHighlights();
  });

  state.cy.on("tap", (event) => {
    if (state.suppressNextTap) {
      return;
    }
    if (event.target === state.cy) {
      clearActiveFloatingWindowFocus();
      hideEdgeTooltip();
      if (state.traceMode || state.activeFlowId) {
        applyCanvasHighlights();
      }
    }
  });

  state.cy.on("dbltap", "node", async (event) => {
    const data = event.target.data();
    const nodeId = data.ownerFunctionId || data.id;
    const isAlt = Boolean(event.originalEvent && event.originalEvent.altKey);
    if (isAlt && canOpenInFloatingWindow(state.nodesById.get(nodeId))) {
      await openFloatingWindow(nodeId, { parentWindowId: null });
      return;
    }
    await toggleNodeExpansion(nodeId);
  });

  // Anclaje híbrido por nivel: arrastrar un nodo fija su posición en el nivel actual.
  state.cy.on("dragfree", "node", async (event) => {
    await handleNodeDragFree(event.target);
  });

  bindEdgeTooltipEvents();
  bindCanvasPanControls();
  state.cy.on("zoom", updateZoomIndicator);
}

function hideEdgeTooltip() {
  const tip = document.getElementById("edge-tooltip");
  if (tip) {
    tip.classList.add("hidden");
  }
}

function showEdgeTooltip(cyEdge, renderedPos, containerEl = null) {
  const tip = document.getElementById("edge-tooltip");
  const area = document.getElementById("canvas-area");
  if (!tip || !area) {
    return;
  }
  const data = cyEdge.data();
  if (data.kind !== "call") {
    hideEdgeTooltip();
    return;
  }
  const eType = data.edgeType || "direct_call";
  const meta = EDGE_TYPE_META[eType] || { label: eType, icon: "→" };
  const eventStr = data.edgeEvent ? ` (${data.edgeEvent})` : "";
  const confLabel = data.confidence === "confirmed" ? "confirmada" : "inferida";
  const metaParts = [confLabel];
  if (data.call_count > 1) {
    metaParts.push(`${data.call_count} llamadas`);
  }
  if (data.line) {
    metaParts.push(`línea ${data.line}`);
  }
  if (data.flowStepOrder) {
    metaParts.push(`paso #${data.flowStepOrder} del hilo`);
  }

  const displaySource = data.rawSource || data.source;
  const displayTarget = data.rawTarget || data.target;
  tip.innerHTML = `
    <div class="edge-tooltip-title"><span>${escapeHtml(meta.icon)}</span><span>${escapeHtml(meta.label + eventStr)}</span></div>
    <div class="edge-tooltip-route">${escapeHtml(displaySource)} → ${escapeHtml(displayTarget)}</div>
    <div class="edge-tooltip-meta">${escapeHtml(metaParts.join(" · "))}</div>
  `;
  tip.classList.remove("hidden");

  let offsetX = 0;
  let offsetY = 0;
  if (containerEl && containerEl !== area) {
    const areaRect = area.getBoundingClientRect();
    const boxRect = containerEl.getBoundingClientRect();
    offsetX = boxRect.left - areaRect.left;
    offsetY = boxRect.top - areaRect.top;
  }

  const maxX = Math.max(12, area.clientWidth - tip.offsetWidth - 14);
  const maxY = Math.max(12, area.clientHeight - tip.offsetHeight - 14);
  const rawX = offsetX + (renderedPos ? renderedPos.x : 20) + 14;
  const rawY = offsetY + (renderedPos ? renderedPos.y : 20) + 14;
  const left = Math.min(maxX, Math.max(12, Math.round(rawX)));
  const top = Math.min(maxY, Math.max(12, Math.round(rawY)));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function bindEdgeTooltipEvents() {
  if (!state.cy) {
    return;
  }
  state.cy.on("mouseover", "edge", (event) => {
    showEdgeTooltip(event.target, event.renderedPosition);
  });
  state.cy.on("mousemove", "edge", (event) => {
    showEdgeTooltip(event.target, event.renderedPosition);
  });
  state.cy.on("mouseout", "edge", () => {
    hideEdgeTooltip();
  });
  state.cy.on("pan zoom drag", () => {
    hideEdgeTooltip();
  });
}

async function handleNodeDragFree(cyNode) {
  const leafNodes = cyNode.isParent()
    ? cyNode.descendants().filter((item) => !item.isParent() && item.data("type") !== "flow")
    : [cyNode];

  const contextKey = getCurrentLayoutContextKey();
  const { flow: activeFlow, nodeOrder: flowNodeOrder } = getActiveFlowStepMaps();
  const activeFlowNodeSet = activeFlow ? new Set(activeFlow.node_ids || []) : null;

  const patchNodes = {};
  for (const item of leafNodes) {
    const id = item.id();
    if (!state.nodesById.has(id)) {
      continue;
    }
    const pos = item.position();
    const x = Math.round(pos.x * 10) / 10;
    const y = Math.round(pos.y * 10) / 10;
    const existing = getNoteEntry(id);
    const raw = state.nodesById.get(id);
    const nextPositions = {
      ...(existing.pinned_positions || {}),
      [contextKey]: { x, y },
    };
    const entry = {
      ...existing,
      pinned: true,
      x: contextKey === "level_2" ? x : existing.x,
      y: contextKey === "level_2" ? y : existing.y,
      pinned_positions: nextPositions,
      last_fingerprint: (raw && raw.fingerprint) || existing.last_fingerprint || "",
    };
    state.notes.nodes[id] = entry;
    patchNodes[id] = entry;
    const effectiveRole = entry.custom_role || (raw && raw.role) || (raw && raw.type);
    item.data("pinned", "true");
    item.data(
      "label",
      buildDisplayLabel(
        raw,
        item.data("collapsed") === "true",
        entry,
        effectiveRole,
        flowNodeOrder.get(id) || null,
        activeFlowNodeSet,
      ),
    );
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
    updatePinButton(isPinnedInCurrentContext(getNoteEntry(state.selectedNodeId)));
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
      selector: 'node[type = "file"][mainEntry = "true"][fileLang != "html"]',
      style: {
        "border-color": "#10b981",
        "border-width": 2,
      },
    },
    {
      selector: 'node[type = "file"][fileLang = "html"]',
      style: {
        "shape": "cut-rectangle",
        "background-color": "#2c1810",
        "background-opacity": 0.92,
        "border-color": "#fb923c",
        "border-width": 2.2,
        "color": "#fed7aa",
        "text-valign": "center",
        "text-margin-y": 0,
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
      selector: 'node[type = "flow"][flowKind = "event"][flowContainer != "true"]',
      style: {
        "shape": "round-rectangle",
        "background-color": "#291c0a",
        "border-color": "#f59e0b",
        "border-width": 2,
        "color": "#fde68a",
      },
    },
    {
      selector: 'node[type = "flow"][flowKind = "event"][flowContainer = "true"]',
      style: {
        "background-color": "#23190b",
        "border-color": "#f59e0b",
        "color": "#fcd34d",
      },
    },
    {
      selector: 'node[type = "function"][entryKind = "route_handler"]',
      style: { "border-color": "#2dd4bf", "border-width": 2.5 },
    },
    {
      selector: 'node[type = "function"][entryKind = "event_handler"]',
      style: { "border-style": "dashed", "border-color": "#f59e0b", "border-width": 2.2 },
    },
    {
      selector: 'node[type = "function"][entryKind = "unreferenced"]',
      style: { "border-style": "dashed", "border-color": "#64748b", "opacity": 0.82 },
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
    // Semántica diferenciada por edge_type (Fase 2)
    {
      selector: 'edge[kind = "call"][edgeType = "event_listener"]',
      style: {
        "width": 2.1,
        "line-style": "dashed",
        "line-dash-pattern": [6, 4],
        "line-color": "#f59e0b",
        "target-arrow-color": "#f59e0b",
        "target-arrow-shape": "triangle",
        "color": "#fde68a",
      },
    },
    {
      selector: 'edge[kind = "call"][edgeType = "callback_ref"]',
      style: {
        "width": 2.0,
        "line-style": "dotted",
        "line-color": "#c084fc",
        "target-arrow-color": "#c084fc",
        "target-arrow-shape": "vee",
        "color": "#e9d5ff",
      },
    },
    {
      selector: 'edge[kind = "call"][edgeType = "reactive_subscribe"]',
      style: {
        "width": 2.0,
        "line-style": "dashed",
        "line-dash-pattern": [3, 4],
        "line-color": "#e879f9",
        "target-arrow-color": "#e879f9",
        "target-arrow-shape": "diamond",
        "color": "#f5d0fe",
      },
    },
    {
      selector: 'edge[kind = "call"][edgeType = "reactive_trigger"]',
      style: {
        "width": 2.5,
        "line-style": "dashed",
        "line-dash-pattern": [8, 3, 2, 3],
        "line-color": "#f472b6",
        "target-arrow-color": "#f472b6",
        "target-arrow-shape": "triangle",
        "arrow-scale": 1.15,
        "color": "#fbcfe8",
        "font-weight": "bold",
      },
    },
    {
      selector: 'edge[kind = "call"][edgeType = "serves_html"], edge[kind = "call"][edgeType = "loads_script"]',
      style: {
        "width": 2.4,
        "line-style": "solid",
        "line-color": "#34d399",
        "target-arrow-color": "#34d399",
        "target-arrow-shape": "chevron",
        "color": "#a7f3d0",
        "font-weight": "bold",
      },
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
    // Clases de aislamiento, Hilos de Ejecución y Modo Foco multi-rama
    {
      selector: ".dimmed",
      style: { "opacity": 0.15 },
    },
    {
      selector: ".export-hidden",
      style: { "display": "none" },
    },
    {
      selector: "node.flow-active",
      style: { "opacity": 1, "border-width": 3.2, "border-color": "#38bdf8" },
    },
    {
      selector: "node.flow-root",
      style: { "opacity": 1, "border-width": 4, "border-color": "#10b981" },
    },
    {
      selector: "edge.flow-active-edge",
      style: { "opacity": 1, "width": 3.2, "z-index": 20 },
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
    {
      selector: "edge.trace-branch-active",
      style: {
        "opacity": 1,
        "width": 4.2,
        "line-color": "#facc15",
        "target-arrow-color": "#facc15",
        "z-index": 30,
      },
    },
    {
      selector: "node.trace-branch-active",
      style: {
        "opacity": 1,
        "border-width": 4,
        "border-color": "#facc15",
      },
    },
    // Fase 3: Puertos de Frontera (Cross-Modal Connectors) en ventanas flotantes
    {
      selector: 'node[type = "port"]',
      style: {
        "shape": "round-rectangle",
        "label": "data(label)",
        "font-size": 10.5,
        "font-weight": "bold",
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "ellipsis",
        "text-max-width": 235,
        "width": "label",
        "height": "label",
        "padding": 8,
        "border-width": 1.8,
        "border-style": "dashed",
      },
    },
    {
      selector: 'node[type = "port"][portDir = "in"]',
      style: {
        "background-color": "#0d2a38",
        "border-color": "#22d3ee",
        "color": "#cffafe",
      },
    },
    {
      selector: 'node[type = "port"][portDir = "out"]',
      style: {
        "background-color": "#2b1b3d",
        "border-color": "#c084fc",
        "color": "#f3e8ff",
      },
    },
    {
      selector: "node.port-linked-highlight",
      style: {
        "border-width": 3.5,
        "border-color": "#facc15",
        "border-style": "solid",
        "background-color": "#332a0c",
        "color": "#fef08a",
      },
    },
  ];
}

async function refreshGraphView({ fit = true } = {}) {
  hideEdgeTooltip();
  const { nodes, edges } = buildVisibleElements();
  state.cy.elements().remove();
  state.cy.add([...nodes, ...edges]);
  await runElkLayout(nodes, edges);
  if (fit) {
    state.cy.fit(undefined, 36);
  }
  updateZoomIndicator();
  applyCanvasHighlights();
}

async function runElkLayout(visibleNodes, visibleEdges) {
  const elkGraph = buildElkInput(visibleNodes, visibleEdges);
  const layouted = await state.elk.layout(elkGraph);

  const elkPositions = new Map();
  collectAbsolutePositions(layouted, 0, 0, elkPositions);

  const contextKey = getCurrentLayoutContextKey();

  state.cy.batch(() => {
    state.cy.nodes().forEach((cyNode) => {
      if (cyNode.isParent()) {
        return;
      }
      // Restauramos únicamente coordenadas pinned del nivel/contexto activo
      // para evitar que anclajes de Nivel 2 distorsionen contenedores en Nivel 3+.
      const noteEntry = getNoteEntry(cyNode.id());
      const pinnedPos = getPinnedPositionForContext(noteEntry, contextKey);
      if (pinnedPos) {
        cyNode.position(pinnedPos);
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
  if (data.type === "port") {
    const textLen = String(data.label || "").length;
    return { width: Math.max(135, Math.min(265, Math.round(textLen * 6.8 + 28))), height: 34 };
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
// Modo Foco multi-rama (Tecla T, ↑/↓ elegir rama, →/Enter saltar, ← volver)
// y Resaltado de Hilos de Ejecución
// ---------------------------------------------------------------------------

function applyCanvasHighlights() {
  if (!state.cy) {
    return;
  }
  const all = state.cy.elements();
  all.removeClass(
    "dimmed trace-focus trace-caller trace-callee trace-branch-active flow-active flow-root flow-active-edge",
  );

  if (state.traceMode) {
    applyTraceHighlight();
    return;
  }
  hideTraceBranchHud();
  if (state.activeFlowId) {
    applyExecutionFlowHighlight();
  }
}

function applyExecutionFlowHighlight() {
  const flow = getActiveFlow();
  if (!flow || !state.cy) {
    return;
  }
  const flowNodeSet = new Set(flow.node_ids || []);
  const flowEdgeSet = new Set(flow.edge_ids || []);
  const all = state.cy.elements();
  all.addClass("dimmed");

  for (const nodeId of flowNodeSet) {
    const cyNode = state.cy.getElementById(nodeId);
    if (cyNode && cyNode.length > 0) {
      cyNode.removeClass("dimmed").addClass(nodeId === flow.root_id ? "flow-root" : "flow-active");
      cyNode.ancestors().removeClass("dimmed");
      cyNode.descendants().removeClass("dimmed");
    }
  }

  state.cy.edges('edge[kind = "call"]').forEach((cyEdge) => {
    const rawIds = cyEdge.data("rawEdgeIds") || [];
    if (rawIds.some((rid) => flowEdgeSet.has(rid))) {
      cyEdge.removeClass("dimmed").addClass("flow-active-edge");
      cyEdge.source().removeClass("dimmed");
      cyEdge.target().removeClass("dimmed");
      cyEdge.source().ancestors().removeClass("dimmed");
      cyEdge.target().ancestors().removeClass("dimmed");
    }
  });
}

function toggleTraceMode() {
  state.traceMode = !state.traceMode;
  state.traceDirection = "forward";
  state.traceBranchIndex = 0;
  if (!state.traceMode) {
    state.traceHistory = [];
    state.traceBranchCandidates = [];
  }
  document.getElementById("btn-trace").classList.toggle("active", state.traceMode);

  if (state.traceMode && !state.selectedNodeId) {
    const activeFlow = getActiveFlow();
    let fallback = activeFlow ? state.cy.getElementById(activeFlow.root_id) : null;
    if (!fallback || fallback.length === 0) {
      fallback = state.cy.nodes('node[role = "entry"]').first();
    }
    if (!fallback || fallback.length === 0) {
      fallback = state.cy.nodes('node[type = "function"]').first();
    }
    if (fallback && fallback.length > 0) {
      fallback.select();
      selectNode(fallback.id());
    }
  }

  applyCanvasHighlights();
}

function hideTraceBranchHud() {
  const hud = document.getElementById("trace-branch-hud");
  if (hud) {
    hud.classList.add("hidden");
  }
}

function collectTraceCandidates(focus, direction) {
  const edgeList = direction === "backward"
    ? focus.incomers('edge[kind = "call"]')
    : focus.outgoers('edge[kind = "call"]');
  const seen = new Set();
  const candidates = [];

  edgeList.forEach((cyEdge) => {
    const other = direction === "backward" ? cyEdge.source() : cyEdge.target();
    if (!other || other.length === 0) {
      return;
    }
    const nodeId = other.id();
    if (nodeId === focus.id() || seen.has(nodeId)) {
      return;
    }
    seen.add(nodeId);
    const raw = state.nodesById.get(nodeId);
    candidates.push({
      nodeId,
      edgeId: cyEdge.id(),
      label: raw ? raw.label : nodeId,
      edgeType: cyEdge.data("edgeType") || "direct_call",
      edgeEvent: cyEdge.data("edgeEvent") || "",
      line: cyEdge.data("line") || 0,
    });
  });

  candidates.sort((a, b) => (a.line - b.line) || a.nodeId.localeCompare(b.nodeId));
  return candidates;
}

function updateTraceBranchHud(candidates) {
  const hud = document.getElementById("trace-branch-hud");
  const labelEl = document.getElementById("trace-branch-label");
  const prevBtn = document.getElementById("btn-trace-prev");
  const nextBtn = document.getElementById("btn-trace-next");
  const goBtn = document.getElementById("btn-trace-go");
  if (!hud || !labelEl) {
    return;
  }
  if (!state.traceMode || !state.selectedNodeId) {
    hud.classList.add("hidden");
    return;
  }

  const isBackward = state.traceDirection === "backward";
  const count = candidates.length;
  if (count === 0) {
    labelEl.textContent = isBackward
      ? "Sin llamadores directos"
      : "Nodo final · ← para volver o elegir llamadores";
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    if (goBtn) goBtn.disabled = true;
    hud.classList.remove("hidden");
    return;
  }

  const idx = Math.max(0, Math.min(state.traceBranchIndex, count - 1));
  const picked = candidates[idx];
  const prefix = isBackward ? "Llamador" : "Rama";
  const eventTag = picked.edgeEvent ? ` [${picked.edgeEvent}]` : "";
  labelEl.textContent = `${prefix} ${idx + 1}/${count}: ${picked.label}${eventTag}`;
  if (prevBtn) prevBtn.disabled = count <= 1;
  if (nextBtn) nextBtn.disabled = count <= 1;
  if (goBtn) {
    goBtn.disabled = false;
    goBtn.textContent = isBackward ? "← Ir" : "Ir →";
  }
  hud.classList.remove("hidden");
}

function applyTraceCandidateHighlight() {
  if (!state.cy || !state.traceMode) {
    return;
  }
  state.cy.elements().removeClass("trace-branch-active");
  const candidates = state.traceBranchCandidates;
  if (!candidates || candidates.length === 0) {
    updateTraceBranchHud([]);
    return;
  }
  const idx = Math.max(0, Math.min(state.traceBranchIndex, candidates.length - 1));
  state.traceBranchIndex = idx;
  const picked = candidates[idx];
  const edge = state.cy.getElementById(picked.edgeId);
  const target = state.cy.getElementById(picked.nodeId);
  if (edge && edge.length > 0) {
    edge.addClass("trace-branch-active");
  }
  if (target && target.length > 0) {
    target.addClass("trace-branch-active");
  }
  updateTraceBranchHud(candidates);
}

function applyTraceHighlight() {
  if (!state.cy) {
    return;
  }
  const all = state.cy.elements();
  all.removeClass("dimmed trace-focus trace-caller trace-callee trace-branch-active");

  if (!state.traceMode || !state.selectedNodeId) {
    hideTraceBranchHud();
    return;
  }

  const focus = state.cy.getElementById(state.selectedNodeId);
  if (!focus || focus.length === 0) {
    hideTraceBranchHud();
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

  state.traceBranchCandidates = collectTraceCandidates(focus, state.traceDirection);
  if (state.traceBranchIndex >= state.traceBranchCandidates.length) {
    state.traceBranchIndex = 0;
  }
  applyTraceCandidateHighlight();
}

function cycleTraceBranch(delta) {
  if (!state.traceMode || !state.selectedNodeId) {
    return;
  }
  const count = state.traceBranchCandidates.length;
  if (count <= 1) {
    return;
  }
  state.traceBranchIndex = (state.traceBranchIndex + delta + count) % count;
  applyTraceCandidateHighlight();
}

function jumpTraceToNode(targetNode, pushHistory) {
  if (!targetNode || targetNode.length === 0) {
    return;
  }
  if (pushHistory && state.selectedNodeId) {
    state.traceHistory.push(state.selectedNodeId);
  }
  state.traceDirection = "forward";
  state.traceBranchIndex = 0;
  state.cy.nodes().unselect();
  targetNode.select();
  selectNode(targetNode.id());
  applyCanvasHighlights();
  state.cy.animate({ center: { eles: targetNode }, duration: 180 });
}

function confirmTraceBranch() {
  if (!state.traceMode || !state.selectedNodeId) {
    return;
  }
  const picked = state.traceBranchCandidates[state.traceBranchIndex];
  if (!picked) {
    return;
  }
  const target = state.cy.getElementById(picked.nodeId);
  jumpTraceToNode(target, state.traceDirection === "forward");
}

function stepTrace(direction) {
  if (!state.traceMode || !state.selectedNodeId) {
    return;
  }
  const focus = state.cy.getElementById(state.selectedNodeId);
  if (!focus || focus.length === 0) {
    return;
  }

  if (direction === "forward") {
    if (state.traceDirection !== "forward") {
      state.traceDirection = "forward";
      state.traceBranchIndex = 0;
      applyTraceHighlight();
    }
    confirmTraceBranch();
    return;
  }

  if (direction === "backward") {
    if (state.traceDirection === "backward" && state.traceBranchCandidates.length > 0) {
      confirmTraceBranch();
      return;
    }
    if (state.traceHistory.length > 0) {
      const prevId = state.traceHistory.pop();
      const candidate = state.cy.getElementById(prevId);
      if (candidate && candidate.length > 0) {
        jumpTraceToNode(candidate, false);
        return;
      }
    }
    const callers = collectTraceCandidates(focus, "backward");
    if (callers.length === 1) {
      jumpTraceToNode(state.cy.getElementById(callers[0].nodeId), false);
    } else if (callers.length > 1) {
      state.traceDirection = "backward";
      state.traceBranchIndex = 0;
      applyTraceHighlight();
    }
  }
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
  updatePinButton(isPinnedInCurrentContext(noteEntry));
  updateToggleButton(node);
  updateFloatingOpenButton(node);
  updateRoleSelector(node, noteEntry);

  document.getElementById("detail-note-input").value = noteEntry.note || "";
  document.getElementById("note-save-status").textContent = "";

  updateOptionalBlock("detail-signature-block", "detail-signature", node.signature);
  updateOptionalBlock("detail-docstring-block", "detail-docstring", node.docstring);
  updateInternalCallsBlock(node);
  updateExternalCallsBlock(node);
  updateOptionalBlock("detail-fingerprint-block", "detail-fingerprint", node.fingerprint);
  updateFlowBlock(node);
  if (state.activeFlowId) {
    renderActiveFlowPanel();
  }
}

function updateFlowBadges(node, effectiveRole) {
  const container = document.getElementById("detail-flow-badges");
  container.innerHTML = "";
  const appendBadge = (text, cssClass) => {
    const span = document.createElement("span");
    span.className = `flow-badge ${cssClass}`;
    span.textContent = text;
    container.appendChild(span);
  };

  if (node.type === "file") {
    if (node.language === "html") {
      appendBadge("HTML", "flow-badge-html");
    }
    if (node.is_main_entry) {
      appendBadge("GESTOR / ENTRADA", "flow-badge-main-file");
    }
    return;
  }
  if (node.type !== "function") {
    return;
  }

  const eKind = node.entry_kind || null;
  if (effectiveRole === "entry" && eKind !== "route_handler") {
    appendBadge("INICIO", "flow-badge-start");
  }
  if (eKind === "route_handler") {
    appendBadge("RUTA HTTP", "flow-badge-route");
  } else if (eKind === "event_handler") {
    appendBadge("EVENTO", "flow-badge-event");
  } else if (eKind === "unreferenced") {
    appendBadge("SIN REF", "flow-badge-unreferenced");
  }
  if (node.is_terminal) {
    appendBadge("FIN", "flow-badge-end");
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
  const applyToCy = (cyInst) => {
    if (!cyInst || typeof cyInst.nodes !== "function") {
      return;
    }
    cyInst.nodes('node[type = "flow"]').removeClass("selected-step");
    if (fnId && stepId) {
      const stepCy = cyInst.getElementById(`${fnId}::${stepId}`);
      if (stepCy && stepCy.length > 0) {
        stepCy.addClass("selected-step");
      }
    }
  };
  applyToCy(state.cy);
  for (const win of state.floatingWindows.values()) {
    applyToCy(win.cy);
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
      tag.className = stepKind === "event" ? "flow-step-hook-tag" : "flow-step-entry-tag";
      tag.textContent = stepKind === "event" ? "DISPARADOR" : "ENTRADA";
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

function createInternalCallCard(targetNode, edge = null) {
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
  origin.textContent = fileNode ? fileNode.id : targetNode.parent || targetNode.id;
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

  if (edge) {
    const eType = edge.edge_type || "direct_call";
    const meta = EDGE_TYPE_META[eType] || { short: eType, icon: "→" };
    const pill = document.createElement("span");
    pill.className = `edge-type-pill edge-type-${eType}`;
    pill.textContent = edge.event ? `${meta.icon} ${meta.short}: ${edge.event}` : `${meta.icon} ${meta.short}`;
    actions.appendChild(pill);
  }

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
  const hiddenBox = document.getElementById("detail-hidden-utilities");
  const hiddenChips = document.getElementById("detail-hidden-utilities-chips");
  list.innerHTML = "";
  if (hiddenChips) {
    hiddenChips.innerHTML = "";
  }
  if (hiddenBox) {
    hiddenBox.classList.add("hidden");
  }

  const canHaveOutgoing = node.type === "function" || node.type === "file";
  if (!canHaveOutgoing || !state.rawGraph || !Array.isArray(state.rawGraph.edges)) {
    block.classList.add("hidden");
    return;
  }

  const activeFlow = getActiveFlow();
  const activeFlowNodeSet = activeFlow ? new Set(activeFlow.node_ids || []) : null;

  const seenTargets = new Set();
  const visibleItems = [];
  const hiddenUtilityItems = [];
  for (const edge of state.rawGraph.edges) {
    if (edge.source !== node.id || edge.target === node.id || seenTargets.has(edge.target)) {
      continue;
    }
    const targetNode = state.nodesById.get(edge.target);
    if (!targetNode || (targetNode.type !== "function" && targetNode.type !== "file")) {
      continue;
    }
    seenTargets.add(edge.target);
    if (isUtilityNodeHidden(targetNode.id, activeFlowNodeSet)) {
      hiddenUtilityItems.push({ targetNode, edge });
    } else {
      visibleItems.push({ targetNode, edge });
    }
  }

  if (visibleItems.length === 0 && hiddenUtilityItems.length === 0) {
    block.classList.add("hidden");
    return;
  }

  if (hiddenUtilityItems.length > 0 && hiddenBox && hiddenChips) {
    for (const { targetNode, edge } of hiddenUtilityItems) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "utility-chip";
      const fileLabel = targetNode.parent || "";
      chip.textContent = `⚙ ${targetNode.label}`;
      chip.title = `${targetNode.id}${edge.line ? ` (línea ${edge.line})` : ""} — clic para inspeccionar`;
      chip.addEventListener("click", () => navigateToNode(targetNode.id));
      if (fileLabel) {
        chip.dataset.origin = fileLabel;
      }
      hiddenChips.appendChild(chip);
    }
    hiddenBox.classList.remove("hidden");
  }

  for (const { targetNode, edge } of visibleItems) {
    list.appendChild(createInternalCallCard(targetNode, edge));
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
  if (!raw) {
    return;
  }
  const entry = getNoteEntry(nodeId);
  const effectiveRole = entry.custom_role || raw.role || raw.type;
  const { flow: activeFlow, nodeOrder: flowNodeOrder } = getActiveFlowStepMaps();
  const activeFlowNodeSet = activeFlow ? new Set(activeFlow.node_ids || []) : null;

  const updateInCy = (cyInst, includePin) => {
    if (!cyInst) {
      return;
    }
    const cyNode = cyInst.getElementById(nodeId);
    if (!cyNode || cyNode.length === 0) {
      return;
    }
    cyNode.data("role", effectiveRole);
    cyNode.data("terminal", raw.type === "function" && raw.is_terminal ? "true" : "false");
    if (includePin) {
      cyNode.data("pinned", isPinnedInCurrentContext(entry) ? "true" : "false");
    }
    cyNode.data(
      "label",
      buildDisplayLabel(
        raw,
        cyNode.data("collapsed") === "true",
        entry,
        effectiveRole,
        includePin ? (flowNodeOrder.get(nodeId) || null) : null,
        includePin ? activeFlowNodeSet : null,
      ),
    );
  };

  updateInCy(state.cy, true);
  for (const win of state.floatingWindows.values()) {
    updateInCy(win.cy, false);
  }
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

  // Si el destino era un utilitario oculto, al seleccionarlo queda visible temporalmente.
  const wasMissingFromCanvas = state.cy.getElementById(nodeId).length === 0;
  if (wasMissingFromCanvas) {
    state.selectedNodeId = nodeId;
    changed = true;
  }

  if (changed) {
    await refreshGraphView({ fit: false });
  }

  const cyNode = state.cy.getElementById(nodeId);
  if (cyNode && cyNode.length > 0) {
    state.cy.nodes().unselect();
    cyNode.select();
    selectNode(nodeId);
    if (state.traceMode) {
      state.traceDirection = "forward";
      state.traceBranchIndex = 0;
    }
    applyCanvasHighlights();
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
// Exportación de capturas del grafo (PNG / JPG)
// ---------------------------------------------------------------------------

function hasActiveFocusOrFlow() {
  if (!state.cy) {
    return false;
  }
  return Boolean(state.traceMode || state.activeFlowId) && state.cy.elements(".dimmed").length > 0;
}

function openExportModal() {
  const modal = document.getElementById("export-modal");
  const focusRow = document.getElementById("export-focus-row");
  const focusHint = document.getElementById("export-focus-hint");
  const focusPngBtn = document.getElementById("btn-export-focus-png");
  const focusJpgBtn = document.getElementById("btn-export-focus-jpg");
  const statusEl = document.getElementById("export-status");
  if (!modal) {
    return;
  }

  const canExportFocus = hasActiveFocusOrFlow();
  if (focusRow) {
    focusRow.classList.toggle("disabled", !canExportFocus);
  }
  if (focusPngBtn) {
    focusPngBtn.disabled = !canExportFocus;
  }
  if (focusJpgBtn) {
    focusJpgBtn.disabled = !canExportFocus;
  }
  if (focusHint) {
    if (canExportFocus) {
      const flow = getActiveFlow();
      focusHint.textContent = state.traceMode
        ? "Exporta únicamente el subgrafo iluminado en el Modo Foco actual."
        : `Exporta únicamente los nodos y aristas del hilo activo (${flow ? flow.label : "Hilo"}).`;
    } else {
      focusHint.textContent = "Activa Modo Foco (T) o selecciona un Hilo de Ejecución para aislarlo.";
    }
  }
  if (statusEl) {
    statusEl.classList.add("hidden");
    statusEl.textContent = "";
  }
  modal.classList.remove("hidden");
}

function closeExportModal() {
  const modal = document.getElementById("export-modal");
  if (modal) {
    modal.classList.add("hidden");
  }
}

function sanitizeFilenameSegment(raw) {
  return String(raw || "codemap")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "codemap";
}

function exportGraphImage(scope, format) {
  if (!state.cy) {
    return null;
  }
  const fmt = format === "jpg" ? "jpg" : "png";
  const isFocus = scope === "focus";
  if (isFocus && !hasActiveFocusOrFlow()) {
    return null;
  }

  const options = {
    full: scope !== "view",
    scale: 2,
    bg: "#0f141b",
  };
  if (fmt === "jpg") {
    options.quality = 0.92;
  }

  let dataUrl = "";
  const dimmed = isFocus ? state.cy.elements(".dimmed") : null;
  try {
    if (dimmed && dimmed.length > 0) {
      state.cy.batch(() => {
        dimmed.addClass("export-hidden");
      });
    }
    dataUrl = fmt === "jpg" ? state.cy.jpg(options) : state.cy.png(options);
  } finally {
    if (dimmed && dimmed.length > 0) {
      state.cy.batch(() => {
        dimmed.removeClass("export-hidden");
      });
    }
  }

  if (!dataUrl || !dataUrl.startsWith("data:image/")) {
    return null;
  }

  const projectSlug = sanitizeFilenameSegment(state.rawGraph && state.rawGraph.meta && state.rawGraph.meta.project_name);
  const scopeLabel = scope === "full" ? "completo" : (scope === "view" ? "vista" : "foco");
  const filename = `${projectSlug}-${scopeLabel}.${fmt}`;

  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  const statusEl = document.getElementById("export-status");
  if (statusEl) {
    const approxKb = Math.max(1, Math.round((dataUrl.length * 3) / 4 / 1024));
    statusEl.textContent = `✓ Descargado: ${filename} (~${approxKb} KB)`;
    statusEl.classList.remove("hidden");
  }
  return { filename, dataUrl };
}

function setExportStatus(message) {
  const statusEl = document.getElementById("export-status");
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message;
  statusEl.classList.remove("hidden");
}

function getAiExportIncludeFlow() {
  const checkbox = document.getElementById("export-ai-include-flow");
  return Boolean(checkbox && checkbox.checked);
}

function triggerTextDownload(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_error) {
      // Fallback con textarea temporal en contextos no HTTPS.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (_error) {
    copied = false;
  }
  document.body.removeChild(textarea);
  return copied;
}

function formatByteSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function exportAiGraphJson() {
  const includeFlow = getAiExportIncludeFlow();
  const query = includeFlow ? "?include_flow=1" : "";
  setExportStatus("Generando JSON compacto para IA…");
  try {
    const response = await fetch(`/export.ai.json${query}`, { cache: "no-store" });
    if (!response.ok) {
      setExportStatus(`Error al exportar JSON IA (HTTP ${response.status}).`);
      return null;
    }
    const text = await response.text();
    const rawBytes = Number(response.headers.get("X-CodeMap-Raw-Bytes") || "0");
    const exportBytes = new TextEncoder().encode(text).length;
    const projectSlug = sanitizeFilenameSegment(
      state.rawGraph && state.rawGraph.meta && state.rawGraph.meta.project_name
    );
    const filename = `${projectSlug}.ai.json`;
    triggerTextDownload(text, filename, "application/json;charset=utf-8");

    const pct = rawBytes > 0 ? Math.max(0, (1 - exportBytes / rawBytes) * 100).toFixed(1) : null;
    const reductionText = pct !== null ? `, -${pct}%` : "";
    setExportStatus(`✓ Descargado: ${filename} (${formatByteSize(exportBytes)}${reductionText})`);
    return { filename, bytes: exportBytes };
  } catch (error) {
    setExportStatus(`Error al exportar JSON IA: ${error.message || error}`);
    return null;
  }
}

async function exportAiMarkdown(mode = "copy") {
  const includeFlow = getAiExportIncludeFlow();
  const query = includeFlow ? "?include_flow=1" : "";
  setExportStatus("Generando resumen Markdown para IA…");
  try {
    const response = await fetch(`/export.ai.md${query}`, { cache: "no-store" });
    if (!response.ok) {
      setExportStatus(`Error al generar Markdown IA (HTTP ${response.status}).`);
      return null;
    }
    const markdown = await response.text();
    const bytes = new TextEncoder().encode(markdown).length;
    const projectSlug = sanitizeFilenameSegment(
      state.rawGraph && state.rawGraph.meta && state.rawGraph.meta.project_name
    );

    if (mode === "download") {
      const filename = `${projectSlug}.ai.md`;
      triggerTextDownload(markdown, filename, "text/markdown;charset=utf-8");
      setExportStatus(`✓ Descargado: ${filename} (${formatByteSize(bytes)})`);
      return { filename, bytes };
    }

    const copied = await copyTextToClipboard(markdown);
    if (copied) {
      setExportStatus(`✓ Resumen Markdown copiado al portapapeles (${formatByteSize(bytes)})`);
    } else {
      const filename = `${projectSlug}.ai.md`;
      triggerTextDownload(markdown, filename, "text/markdown;charset=utf-8");
      setExportStatus(`Portapapeles no disponible; descargado como ${filename} (${formatByteSize(bytes)})`);
    }
    return { copied, bytes };
  } catch (error) {
    setExportStatus(`Error al generar Markdown IA: ${error.message || error}`);
    return null;
  }
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
    scheduleBridgeRender();
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
  document.getElementById("btn-hide-utilities").addEventListener("click", toggleHideUtilities);
  document.getElementById("btn-search").addEventListener("click", openSearchModal);
  document.getElementById("btn-orphans").addEventListener("click", openOrphansModal);
  document.getElementById("btn-close-orphans").addEventListener("click", closeOrphansModal);
  document.getElementById("btn-known-apis").addEventListener("click", openApisModal);
  document.getElementById("btn-close-apis").addEventListener("click", closeApisModal);
  document.getElementById("btn-export-image").addEventListener("click", openExportModal);
  document.getElementById("btn-close-export").addEventListener("click", closeExportModal);
  document.getElementById("btn-help").addEventListener("click", openHelpModal);
  document.getElementById("btn-close-help").addEventListener("click", closeHelpModal);
  document.getElementById("btn-collapse-panel").addEventListener("click", () => toggleInspectorPanel(false));
  document.getElementById("btn-show-panel").addEventListener("click", () => toggleInspectorPanel(true));

  const flowSelect = document.getElementById("flow-select");
  if (flowSelect) {
    flowSelect.addEventListener("change", (event) => {
      applyExecutionFlow(event.target.value || null);
    });
  }
  const clearFlowBtn = document.getElementById("btn-clear-flow");
  if (clearFlowBtn) {
    clearFlowBtn.addEventListener("click", () => applyExecutionFlow(null));
  }
  const inspectorClearFlowBtn = document.getElementById("btn-inspector-clear-flow");
  if (inspectorClearFlowBtn) {
    inspectorClearFlowBtn.addEventListener("click", () => applyExecutionFlow(null));
  }

  const tracePrevBtn = document.getElementById("btn-trace-prev");
  if (tracePrevBtn) {
    tracePrevBtn.addEventListener("click", () => cycleTraceBranch(-1));
  }
  const traceNextBtn = document.getElementById("btn-trace-next");
  if (traceNextBtn) {
    traceNextBtn.addEventListener("click", () => cycleTraceBranch(1));
  }
  const traceGoBtn = document.getElementById("btn-trace-go");
  if (traceGoBtn) {
    traceGoBtn.addEventListener("click", () => confirmTraceBranch());
  }

  document.getElementById("btn-export-full-png").addEventListener("click", () => exportGraphImage("full", "png"));
  document.getElementById("btn-export-full-jpg").addEventListener("click", () => exportGraphImage("full", "jpg"));
  document.getElementById("btn-export-view-png").addEventListener("click", () => exportGraphImage("view", "png"));
  document.getElementById("btn-export-view-jpg").addEventListener("click", () => exportGraphImage("view", "jpg"));
  document.getElementById("btn-export-focus-png").addEventListener("click", () => exportGraphImage("focus", "png"));
  document.getElementById("btn-export-focus-jpg").addEventListener("click", () => exportGraphImage("focus", "jpg"));
  const exportAiJsonBtn = document.getElementById("btn-export-ai-json");
  if (exportAiJsonBtn) {
    exportAiJsonBtn.addEventListener("click", () => exportAiGraphJson());
  }
  const copyAiMdBtn = document.getElementById("btn-copy-ai-md");
  if (copyAiMdBtn) {
    copyAiMdBtn.addEventListener("click", () => exportAiMarkdown("copy"));
  }
  const downloadAiMdBtn = document.getElementById("btn-export-ai-md");
  if (downloadAiMdBtn) {
    downloadAiMdBtn.addEventListener("click", () => exportAiMarkdown("download"));
  }

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

  const openFloatingBtn = document.getElementById("btn-open-floating");
  if (openFloatingBtn) {
    openFloatingBtn.addEventListener("click", () => {
      if (state.selectedNodeId) {
        openFloatingWindow(state.selectedNodeId);
      }
    });
  }

  window.addEventListener("resize", () => {
    scheduleBridgeRender();
  });

  document.getElementById("btn-pin-node").addEventListener("click", async () => {
    if (!state.selectedNodeId) {
      return;
    }
    const contextKey = getCurrentLayoutContextKey();
    const entry = getNoteEntry(state.selectedNodeId);
    const cyNode = state.cy.getElementById(state.selectedNodeId);
    if (isPinnedInCurrentContext(entry)) {
      const nextPositions = { ...(entry.pinned_positions || {}) };
      delete nextPositions[contextKey];
      const stillHasOtherPins = Object.keys(nextPositions).length > 0;
      await saveNotePatch(state.selectedNodeId, {
        pinned: stillHasOtherPins,
        x: contextKey === "level_2" ? null : entry.x,
        y: contextKey === "level_2" ? null : entry.y,
        pinned_positions: nextPositions,
      });
      refreshCyNodeMetadata(state.selectedNodeId);
      updatePinButton(false);
      await refreshGraphView({ fit: false });
    } else if (cyNode && cyNode.length > 0 && !cyNode.isParent()) {
      const pos = cyNode.position();
      const x = Math.round(pos.x * 10) / 10;
      const y = Math.round(pos.y * 10) / 10;
      const nextPositions = {
        ...(entry.pinned_positions || {}),
        [contextKey]: { x, y },
      };
      await saveNotePatch(state.selectedNodeId, {
        pinned: true,
        x: contextKey === "level_2" ? x : entry.x,
        y: contextKey === "level_2" ? y : entry.y,
        pinned_positions: nextPositions,
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
  document.getElementById("export-modal").addEventListener("click", (event) => {
    if (event.target.id === "export-modal") {
      closeExportModal();
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
  return ["search-modal", "orphans-modal", "apis-modal", "export-modal", "help-modal"].some((id) => {
    const el = document.getElementById(id);
    return el && !el.classList.contains("hidden");
  });
}

function closeOpenModals() {
  const wasOpen = hasOpenModal();
  closeSearchModal();
  closeOrphansModal();
  closeApisModal();
  closeExportModal();
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
      if (closeMostRecentLeafFloatingWindow()) {
        return;
      }
      if (state.traceMode) {
        toggleTraceMode();
        return;
      }
      if (state.activeFlowId) {
        applyExecutionFlow(null);
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
    } else if (event.key === "ArrowDown" && state.traceMode) {
      event.preventDefault();
      cycleTraceBranch(1);
    } else if (event.key === "ArrowUp" && state.traceMode) {
      event.preventDefault();
      cycleTraceBranch(-1);
    } else if (event.key === "Enter" && state.traceMode) {
      event.preventDefault();
      confirmTraceBranch();
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

// ---------------------------------------------------------------------------
// Fase 3: Ventanas Flotantes Anidadas, Puertos de Frontera y Líneas Puente SVG
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

function canOpenInFloatingWindow(node) {
  if (!node) {
    return false;
  }
  if (node.type === "module" || node.type === "file") {
    return true;
  }
  if (node.type === "function" && Array.isArray(node.internal_flow) && node.internal_flow.length > 0) {
    return true;
  }
  return false;
}

function updateFloatingOpenButton(node) {
  const btn = document.getElementById("btn-open-floating");
  if (!btn) {
    return;
  }
  if (!canOpenInFloatingWindow(node)) {
    btn.classList.add("hidden");
    return;
  }
  const alreadyOpen = state.floatingWindowByTarget.has(node.id);
  if (alreadyOpen) {
    btn.textContent = "↗ Enfocar ventana flotante";
  } else if (node.type === "function") {
    btn.textContent = "↗ Abrir flujo (3+) en ventana flotante";
  } else {
    btn.textContent = "↗ Abrir en ventana flotante";
  }
  btn.classList.remove("hidden");
}

function getFloatingWindowIcon(node) {
  if (!node) {
    return "📄";
  }
  if (node.type === "module") {
    return "📦";
  }
  if (node.type === "file") {
    if (node.language === "html") {
      return "🌐";
    }
    if (node.is_main_entry) {
      return "★";
    }
    return "📄";
  }
  if (node.type === "function") {
    return "ƒ";
  }
  return "📄";
}

function isDescendantNode(nodeId, ancestorId) {
  if (!nodeId || !ancestorId || nodeId === ancestorId) {
    return false;
  }
  let cursor = state.nodesById.get(nodeId);
  const visited = new Set([nodeId]);
  while (cursor && cursor.parent) {
    if (cursor.parent === ancestorId) {
      return true;
    }
    if (visited.has(cursor.parent)) {
      break;
    }
    visited.add(cursor.parent);
    cursor = state.nodesById.get(cursor.parent);
  }
  return false;
}

function isWindowAncestor(possibleAncestorId, winId) {
  if (!possibleAncestorId || !winId) {
    return false;
  }
  let current = state.floatingWindows.get(winId);
  const visited = new Set([winId]);
  while (current && current.parentWindowId) {
    if (current.parentWindowId === possibleAncestorId) {
      return true;
    }
    if (visited.has(current.parentWindowId)) {
      break;
    }
    visited.add(current.parentWindowId);
    current = state.floatingWindows.get(current.parentWindowId);
  }
  return false;
}

function inferParentWindowId(targetId, explicitParentId) {
  if (explicitParentId !== undefined) {
    return explicitParentId && state.floatingWindows.has(explicitParentId) ? explicitParentId : null;
  }
  if (state.activeWindowId && state.floatingWindows.has(state.activeWindowId)) {
    const activeWin = state.floatingWindows.get(state.activeWindowId);
    if (activeWin && targetId !== activeWin.targetId && isDescendantNode(targetId, activeWin.targetId)) {
      return activeWin.id;
    }
  }
  return null;
}

function collectSubtreeNodeIds(rootId) {
  const result = new Set([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const currentId = stack.pop();
    const children = state.childrenByParent.get(currentId) || [];
    for (const child of children) {
      if (!result.has(child.id)) {
        result.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return result;
}

function resolveExternalContainerId(externalNode) {
  if (!externalNode) {
    return null;
  }
  if (externalNode.type === "file" || externalNode.type === "module") {
    return externalNode.id;
  }
  if (externalNode.type === "function") {
    if (externalNode.parent && state.nodesById.has(externalNode.parent)) {
      return externalNode.parent;
    }
    if (canOpenInFloatingWindow(externalNode)) {
      return externalNode.id;
    }
  }
  return null;
}

function formatPortLabel(direction, externalNode) {
  const arrow = direction === "in" ? "⇠" : "⇢";
  if (!externalNode) {
    return arrow;
  }
  if (externalNode.type === "function") {
    const parentFile = externalNode.parent ? state.nodesById.get(externalNode.parent) : null;
    const rawFn = String(externalNode.label || externalNode.id);
    const fnName = rawFn.endsWith(")") ? rawFn : `${rawFn}()`;
    if (parentFile && parentFile.label) {
      return `${arrow} ${parentFile.label} :: ${fnName}`;
    }
    return `${arrow} ${fnName}`;
  }
  return `${arrow} ${externalNode.label || externalNode.id}`;
}

function buildFloatingSubgraph(targetNode) {
  const nodes = [];
  const edges = [];
  const portsMeta = new Map();

  // Caso 1: Función (Nivel 3+) — flujo interno aislado sin caja externa redundante.
  if (targetNode.type === "function") {
    const visibleIds = new Set();
    appendInternalFlowElements(targetNode, nodes, visibleIds);
    for (const item of nodes) {
      if (item.data.parent === targetNode.id) {
        item.data.parent = undefined;
      }
    }
    appendInternalFlowEdges(nodes, edges, visibleIds);
    return {
      nodes,
      edges,
      portsMeta,
      internalNodeIds: new Set([targetNode.id]),
      isFunctionFlow: true,
      internalCount: nodes.length,
      inPortCount: 0,
      outPortCount: 0,
    };
  }

  // Caso 2: Archivo o Módulo — nodos internos + Puertos de Frontera (.port-in / .port-out).
  const internalNodeIds = collectSubtreeNodeIds(targetNode.id);
  const descendants = [];
  for (const rawNode of state.rawGraph.nodes) {
    if (rawNode.id !== targetNode.id && internalNodeIds.has(rawNode.id)) {
      descendants.push(rawNode);
    }
  }

  // Detectar si alguna arista toca directamente al contenedor raíz (p. ej. script HTML o llamadas top-level).
  const rootHasDirectEdges = state.rawGraph.edges.some(
    (edge) => edge.source === targetNode.id || edge.target === targetNode.id,
  );
  const includeRootLeaf = descendants.length === 0 || rootHasDirectEdges;

  const renderedIds = new Set();
  const pushInternalNode = (rawNode, parentIdOverride, labelOverride = null) => {
    renderedIds.add(rawNode.id);
    const noteEntry = getNoteEntry(rawNode.id);
    const effectiveRole = noteEntry.custom_role || rawNode.role || rawNode.type;
    const baseLabel = labelOverride
      || buildDisplayLabel(rawNode, false, { ...noteEntry, pinned: false, pinned_positions: {} }, effectiveRole, null, null);
    nodes.push({
      data: {
        id: rawNode.id,
        parent: parentIdOverride || undefined,
        label: baseLabel,
        type: rawNode.type,
        role: effectiveRole,
        entryKind: rawNode.entry_kind || "",
        fileLang: rawNode.language || "",
        mainEntry: rawNode.is_main_entry ? "true" : "false",
        terminal: rawNode.type === "function" && rawNode.is_terminal ? "true" : "false",
        pinned: "false",
        hasNote: noteEntry.note && noteEntry.note.trim() ? "true" : "false",
        collapsed: "false",
        expandedFn: "false",
        flowStepOrder: 0,
      },
    });
  };

  if (includeRootLeaf) {
    const rootSuffix = descendants.length > 0 ? " (módulo)" : "";
    const noteEntry = getNoteEntry(targetNode.id);
    const effectiveRole = noteEntry.custom_role || targetNode.role || targetNode.type;
    const rootLabel = `${buildDisplayLabel(
      targetNode,
      false,
      { ...noteEntry, pinned: false, pinned_positions: {} },
      effectiveRole,
      null,
      null,
    )}${rootSuffix}`;
    pushInternalNode(targetNode, undefined, rootLabel);
  }

  for (const rawNode of descendants) {
    const parentId = rawNode.parent === targetNode.id
      ? undefined
      : (internalNodeIds.has(rawNode.parent) ? rawNode.parent : undefined);
    pushInternalNode(rawNode, parentId);
  }

  const resolveInternalAnchor = (endpointId) => {
    let cur = endpointId;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      if (renderedIds.has(cur)) {
        return cur;
      }
      seen.add(cur);
      const nodeObj = state.nodesById.get(cur);
      cur = nodeObj ? nodeObj.parent : null;
    }
    return null;
  };

  const groupedEdges = new Map();
  const accumulateEdge = (source, target, rawEdge, rawSource, rawTarget) => {
    const edgeType = rawEdge.edge_type || "direct_call";
    const edgeEvent = rawEdge.event || "";
    const edgeLine = typeof rawEdge.line === "number" ? rawEdge.line : 0;
    const key = `${source}->${target}`;
    const existing = groupedEdges.get(key);
    if (!existing) {
      groupedEdges.set(key, {
        source,
        target,
        rawSource,
        rawTarget,
        confidence: rawEdge.confidence || "confirmed",
        call_count: rawEdge.call_count || 1,
        edgeType,
        edgeEvent,
        line: edgeLine,
        rawEdgeIds: [rawEdge.id],
      });
    } else {
      existing.call_count += rawEdge.call_count || 1;
      if (rawEdge.confidence === "confirmed") {
        existing.confidence = "confirmed";
      }
      existing.edgeType = pickHigherPriorityEdgeType(existing.edgeType, edgeType);
      if (edgeEvent && !existing.edgeEvent) {
        existing.edgeEvent = edgeEvent;
      }
      if (edgeLine > 0 && (existing.line === 0 || edgeLine < existing.line)) {
        existing.line = edgeLine;
      }
      existing.rawEdgeIds.push(rawEdge.id);
    }
  };

  let inPortCount = 0;
  let outPortCount = 0;

  const ensurePortNode = (direction, externalNode, internalAnchorId, edgeType) => {
    const portId = `port_${direction}::${externalNode.id}`;
    let meta = portsMeta.get(portId);
    if (!meta) {
      const label = formatPortLabel(direction, externalNode);
      meta = {
        portId,
        direction,
        externalNodeId: externalNode.id,
        externalContainerId: resolveExternalContainerId(externalNode),
        label,
        edgeType: edgeType || "direct_call",
        internalEndpoints: new Set([internalAnchorId]),
      };
      portsMeta.set(portId, meta);
      if (direction === "in") {
        inPortCount += 1;
      } else {
        outPortCount += 1;
      }
      nodes.push({
        data: {
          id: portId,
          parent: undefined,
          label,
          type: "port",
          portDir: direction,
          externalNodeId: externalNode.id,
          externalContainerId: meta.externalContainerId || "",
          role: "port",
          collapsed: "false",
          expandedFn: "false",
        },
      });
    } else {
      meta.internalEndpoints.add(internalAnchorId);
      meta.edgeType = pickHigherPriorityEdgeType(meta.edgeType, edgeType || "direct_call");
    }
    return portId;
  };

  for (const rawEdge of state.rawGraph.edges) {
    const srcInside = internalNodeIds.has(rawEdge.source);
    const tgtInside = internalNodeIds.has(rawEdge.target);

    if (srcInside && tgtInside) {
      const src = resolveInternalAnchor(rawEdge.source);
      const tgt = resolveInternalAnchor(rawEdge.target);
      if (!src || !tgt) {
        continue;
      }
      if (src === tgt && (src !== rawEdge.source || tgt !== rawEdge.target)) {
        continue;
      }
      accumulateEdge(src, tgt, rawEdge, rawEdge.source, rawEdge.target);
    } else if (!srcInside && tgtInside) {
      const tgt = resolveInternalAnchor(rawEdge.target);
      const extNode = state.nodesById.get(rawEdge.source);
      if (!tgt || !extNode) {
        continue;
      }
      const portId = ensurePortNode("in", extNode, tgt, rawEdge.edge_type);
      accumulateEdge(portId, tgt, rawEdge, rawEdge.source, rawEdge.target);
    } else if (srcInside && !tgtInside) {
      const src = resolveInternalAnchor(rawEdge.source);
      const extNode = state.nodesById.get(rawEdge.target);
      if (!src || !extNode) {
        continue;
      }
      const portId = ensurePortNode("out", extNode, src, rawEdge.edge_type);
      accumulateEdge(src, portId, rawEdge, rawEdge.source, rawEdge.target);
    }
  }

  let edgeIdx = 1;
  for (const item of groupedEdges.values()) {
    edges.push({
      data: {
        id: `fw_e_${edgeIdx++}`,
        source: item.source,
        target: item.target,
        rawSource: item.rawSource,
        rawTarget: item.rawTarget,
        confidence: item.confidence,
        call_count: item.call_count,
        edgeType: item.edgeType,
        edgeEvent: item.edgeEvent,
        line: item.line,
        rawEdgeIds: item.rawEdgeIds,
        flowStepOrder: 0,
        label: buildProjectedEdgeLabel(item, null),
        kind: "call",
      },
    });
  }

  return {
    nodes,
    edges,
    portsMeta,
    internalNodeIds,
    isFunctionFlow: false,
    internalCount: renderedIds.size,
    inPortCount,
    outPortCount,
  };
}

async function runSubElkLayout(subCy, visibleNodes, visibleEdges, isFunctionFlow) {
  if (!subCy || visibleNodes.length === 0) {
    return;
  }
  const elkGraph = buildElkInput(visibleNodes, visibleEdges);
  elkGraph.layoutOptions = isFunctionFlow
    ? {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.hierarchyHandling": "INCLUDE_CHILDREN",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.spacing.nodeNodeBetweenLayers": "32",
        "elk.spacing.nodeNode": "26",
        "elk.padding": "[top=20,left=20,bottom=20,right=20]",
      }
    : {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.hierarchyHandling": "INCLUDE_CHILDREN",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.spacing.nodeNodeBetweenLayers": "58",
        "elk.spacing.nodeNode": "26",
        "elk.spacing.edgeNode": "20",
        "elk.padding": "[top=18,left=18,bottom=18,right=18]",
      };

  const layouted = await state.elk.layout(elkGraph);
  const elkPositions = new Map();
  collectAbsolutePositions(layouted, 0, 0, elkPositions);

  subCy.batch(() => {
    subCy.nodes().forEach((cyNode) => {
      if (cyNode.isParent()) {
        return;
      }
      const pos = elkPositions.get(cyNode.id());
      if (pos) {
        cyNode.position(pos);
      }
    });
  });
  subCy.resize();
  subCy.fit(undefined, 22);
}

function computeFloatingWindowPosition(parentWindowId) {
  const area = document.getElementById("canvas-area");
  const areaW = area ? area.clientWidth : 960;
  const areaH = area ? area.clientHeight : 640;
  const winW = Math.min(460, Math.max(320, Math.round(areaW * 0.44)));
  const winH = Math.min(360, Math.max(250, Math.round(areaH * 0.52)));

  let left = 24;
  let top = 24;
  const parentWin = parentWindowId ? state.floatingWindows.get(parentWindowId) : null;
  if (parentWin && parentWin.el) {
    const siblingIndex = parentWin.childWindowIds.size;
    const pLeft = parseFloat(parentWin.el.style.left) || 24;
    const pTop = parseFloat(parentWin.el.style.top) || 24;
    const pWidth = parentWin.el.offsetWidth || winW;
    const tryRight = pLeft + pWidth + 36;
    if (tryRight + winW <= areaW - 12) {
      left = tryRight;
      top = pTop + siblingIndex * 34;
    } else {
      left = Math.max(16, pLeft + 46 + siblingIndex * 26);
      top = pTop + 44 + siblingIndex * 30;
    }
  } else {
    const rootOffset = state.floatingWindows.size;
    left = 24 + (rootOffset % 5) * 34;
    top = 24 + (rootOffset % 4) * 30;
  }

  const maxLeft = Math.max(12, areaW - winW - 12);
  const maxTop = Math.max(12, areaH - winH - 12);
  return {
    left: Math.round(Math.min(maxLeft, Math.max(12, left))),
    top: Math.round(Math.min(maxTop, Math.max(12, top))),
    width: winW,
    height: winH,
  };
}

function formatFloatingFooterStats(subgraph) {
  if (subgraph.isFunctionFlow) {
    return `${subgraph.internalCount} pasos de flujo (3+)`;
  }
  const parts = [`${subgraph.internalCount} internos`];
  if (subgraph.inPortCount > 0) {
    parts.push(`${subgraph.inPortCount} ⇠ in`);
  }
  if (subgraph.outPortCount > 0) {
    parts.push(`${subgraph.outPortCount} ⇢ out`);
  }
  return parts.join(" · ");
}

function createFloatingWindowElement(winId, targetNode, parentWin, initialRect, subgraph) {
  const winEl = document.createElement("section");
  winEl.className = "floating-window";
  winEl.dataset.windowId = winId;
  winEl.dataset.targetId = targetNode.id;
  winEl.style.left = `${initialRect.left}px`;
  winEl.style.top = `${initialRect.top}px`;
  winEl.style.width = `${initialRect.width}px`;
  winEl.style.height = `${initialRect.height}px`;

  const headerEl = document.createElement("header");
  headerEl.className = "fw-header";

  const titleGroup = document.createElement("div");
  titleGroup.className = "fw-title-group";

  const iconSpan = document.createElement("span");
  iconSpan.className = "fw-icon";
  iconSpan.textContent = getFloatingWindowIcon(targetNode);
  titleGroup.appendChild(iconSpan);

  const titleSpan = document.createElement("span");
  titleSpan.className = "fw-title";
  titleSpan.textContent = targetNode.label || targetNode.id;
  titleSpan.title = targetNode.id;
  titleGroup.appendChild(titleSpan);

  const badgeSpan = document.createElement("span");
  badgeSpan.className = "fw-hierarchy-badge";
  if (parentWin) {
    const parentNode = state.nodesById.get(parentWin.targetId);
    const parentLabel = parentNode ? parentNode.label : parentWin.targetId;
    badgeSpan.textContent = `↳ ${parentLabel}`;
    badgeSpan.title = `Ventana hija de ${parentWin.targetId}`;
  } else {
    badgeSpan.classList.add("hidden");
  }
  titleGroup.appendChild(badgeSpan);

  const actionsEl = document.createElement("div");
  actionsEl.className = "fw-header-actions";

  const fitBtn = document.createElement("button");
  fitBtn.type = "button";
  fitBtn.className = "fw-btn";
  fitBtn.textContent = "⛶";
  fitBtn.title = "Centrar sub-grafo";

  const closeChainBtn = document.createElement("button");
  closeChainBtn.type = "button";
  closeChainBtn.className = "fw-btn fw-close-chain-btn hidden";
  closeChainBtn.textContent = "Cerrar cadena";
  closeChainBtn.title = "Cerrar esta ventana y todas sus ventanas hijas";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "fw-btn fw-close-btn";
  closeBtn.textContent = "✕";
  closeBtn.title = "Cerrar ventana (Esc)";

  actionsEl.appendChild(fitBtn);
  actionsEl.appendChild(closeChainBtn);
  actionsEl.appendChild(closeBtn);

  headerEl.appendChild(titleGroup);
  headerEl.appendChild(actionsEl);

  const lockNoticeEl = document.createElement("div");
  lockNoticeEl.className = "fw-lock-notice hidden";
  lockNoticeEl.setAttribute("role", "alert");

  const bodyEl = document.createElement("div");
  bodyEl.className = "fw-body";

  const cyContainer = document.createElement("div");
  cyContainer.className = "fw-cy-container";
  bodyEl.appendChild(cyContainer);

  const footerEl = document.createElement("footer");
  footerEl.className = "fw-footer";

  const statsEl = document.createElement("span");
  statsEl.className = "fw-footer-stats";
  statsEl.textContent = formatFloatingFooterStats(subgraph);

  const hintEl = document.createElement("span");
  hintEl.className = "fw-footer-hint";
  hintEl.textContent = subgraph.isFunctionFlow
    ? "Clic en paso: inspeccionar código"
    : "Clic ⇠/⇢: abrir conectado · Doble clic ƒ: flujo 3+";

  footerEl.appendChild(statsEl);
  footerEl.appendChild(hintEl);

  winEl.appendChild(headerEl);
  winEl.appendChild(lockNoticeEl);
  winEl.appendChild(bodyEl);
  winEl.appendChild(footerEl);

  return {
    winEl,
    headerEl,
    titleSpan,
    badgeSpan,
    fitBtn,
    closeChainBtn,
    closeBtn,
    lockNoticeEl,
    bodyEl,
    cyContainer,
    statsEl,
    hintEl,
  };
}

function bindFloatingWindowDrag(win) {
  const onMouseDown = (event) => {
    if (event.button !== 0) {
      return;
    }
    if (event.target.closest("button")) {
      return;
    }
    event.preventDefault();
    focusFloatingWindow(win.id);

    const startX = event.clientX;
    const startY = event.clientY;
    const origLeft = parseFloat(win.el.style.left) || 0;
    const origTop = parseFloat(win.el.style.top) || 0;
    const area = document.getElementById("canvas-area");

    win.el.classList.add("dragging");

    const onMouseMove = (moveEv) => {
      if (win.destroyed) {
        return;
      }
      const dx = moveEv.clientX - startX;
      const dy = moveEv.clientY - startY;
      const areaW = area ? area.clientWidth : window.innerWidth;
      const areaH = area ? area.clientHeight : window.innerHeight;
      const maxLeft = Math.max(4, areaW - Math.min(win.el.offsetWidth, areaW - 8) - 4);
      const maxTop = Math.max(4, areaH - 44);
      const nextLeft = Math.round(Math.min(maxLeft, Math.max(4, origLeft + dx)));
      const nextTop = Math.round(Math.min(maxTop, Math.max(4, origTop + dy)));
      win.el.style.left = `${nextLeft}px`;
      win.el.style.top = `${nextTop}px`;
      scheduleBridgeRender();
    };

    const onMouseUp = () => {
      win.el.classList.remove("dragging");
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      win.activeDragCleanup = null;
      scheduleBridgeRender();
    };

    win.activeDragCleanup = () => {
      win.el.classList.remove("dragging");
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  win.headerEl.addEventListener("mousedown", onMouseDown);
}

function focusFloatingWindow(winId) {
  const win = state.floatingWindows.get(winId);
  if (!win || win.destroyed) {
    return;
  }
  state.windowZCounter = Math.min(840, state.windowZCounter + 1);
  if (state.windowZCounter >= 835) {
    // Re-normalizar z-index si el usuario interactúa durante horas.
    let base = 32;
    for (const id of state.windowFocusOrder) {
      const item = state.floatingWindows.get(id);
      if (item && !item.destroyed) {
        item.el.style.zIndex = String(base++);
      }
    }
    state.windowZCounter = base + 1;
  }
  win.el.style.zIndex = String(state.windowZCounter);

  for (const item of state.floatingWindows.values()) {
    item.el.classList.toggle("focused", item.id === winId);
  }
  state.activeWindowId = winId;
  state.windowFocusOrder = state.windowFocusOrder.filter((id) => id !== winId);
  state.windowFocusOrder.push(winId);
  scheduleBridgeRender();
}

function clearActiveFloatingWindowFocus() {
  state.activeWindowId = null;
  for (const item of state.floatingWindows.values()) {
    item.el.classList.remove("focused");
  }
}

function highlightInsideFloatingWindow(win, { nodeId = null, portIds = [] } = {}) {
  if (!win || !win.cy || win.destroyed) {
    return;
  }
  win.cy.nodes().removeClass("port-linked-highlight");
  let focusEle = null;
  if (nodeId) {
    const n = win.cy.getElementById(nodeId);
    if (n && n.length > 0) {
      n.addClass("port-linked-highlight");
      focusEle = n;
    }
  }
  for (const pid of portIds) {
    const p = win.cy.getElementById(pid);
    if (p && p.length > 0) {
      p.addClass("port-linked-highlight");
      if (!focusEle) {
        focusEle = p;
      }
    }
  }
  if (focusEle && focusEle.length > 0) {
    win.cy.animate({
      center: { eles: focusEle },
      duration: 180,
      complete: () => scheduleBridgeRender(),
    });
  }
}

function updateFloatingWindowHeaderState(win) {
  if (!win || win.destroyed) {
    return;
  }
  const childCount = win.childWindowIds.size;
  const isLocked = childCount > 0;
  win.closeBtn.classList.toggle("locked", isLocked);
  win.closeBtn.textContent = isLocked ? "🔒" : "✕";
  win.closeBtn.title = isLocked
    ? `Bloqueada: cierra primero ${childCount === 1 ? "la ventana hija" : `las ${childCount} ventanas hijas`}`
    : "Cerrar ventana (Esc)";
  win.closeChainBtn.classList.toggle("hidden", !isLocked);

  if (!isLocked) {
    win.lockNoticeEl.classList.add("hidden");
    win.lockNoticeEl.textContent = "";
    if (win.lockNoticeTimer) {
      clearTimeout(win.lockNoticeTimer);
      win.lockNoticeTimer = null;
    }
  }

  if (win.parentWindowId && state.floatingWindows.has(win.parentWindowId)) {
    const parentWin = state.floatingWindows.get(win.parentWindowId);
    const parentNode = state.nodesById.get(parentWin.targetId);
    win.badgeSpan.textContent = `↳ ${parentNode ? parentNode.label : parentWin.targetId}`;
    win.badgeSpan.classList.remove("hidden");
  } else {
    win.badgeSpan.classList.add("hidden");
  }
}

function collectDescendantWindowIds(winId) {
  const result = [];
  const win = state.floatingWindows.get(winId);
  if (!win) {
    return result;
  }
  for (const childId of win.childWindowIds) {
    result.push(childId);
    result.push(...collectDescendantWindowIds(childId));
  }
  return result;
}

function triggerFloatingLockWarning(win) {
  const directCount = win.childWindowIds.size;
  const totalDesc = collectDescendantWindowIds(win.id);
  const countLabel = directCount === 1
    ? "1 ventana hija"
    : `${directCount} ventanas hijas`;
  win.lockNoticeEl.textContent = `🔒 Cierra primero ${countLabel} antes de cerrar esta ventana (o usa «Cerrar cadena»).`;
  win.lockNoticeEl.classList.remove("hidden");

  if (win.lockNoticeTimer) {
    clearTimeout(win.lockNoticeTimer);
  }
  win.lockNoticeTimer = setTimeout(() => {
    if (!win.destroyed) {
      win.lockNoticeEl.classList.add("hidden");
    }
    win.lockNoticeTimer = null;
  }, 3400);

  for (const descId of totalDesc) {
    const childWin = state.floatingWindows.get(descId);
    if (!childWin || childWin.destroyed) {
      continue;
    }
    childWin.el.classList.remove("pulse-child");
    void childWin.el.offsetWidth;
    childWin.el.classList.add("pulse-child");
    if (childWin.pulseTimer) {
      clearTimeout(childWin.pulseTimer);
    }
    childWin.pulseTimer = setTimeout(() => {
      if (!childWin.destroyed) {
        childWin.el.classList.remove("pulse-child");
      }
      childWin.pulseTimer = null;
    }, 1500);
  }
}

async function openFloatingWindow(
  targetId,
  {
    parentWindowId = undefined,
    highlightNodeId = null,
    highlightPortIds = [],
  } = {},
) {
  const targetNode = state.nodesById.get(targetId);
  if (!canOpenInFloatingWindow(targetNode)) {
    return null;
  }

  // Si la ventana ya está abierta, enfocarla sin crear ciclos padre-hijo.
  if (state.floatingWindowByTarget.has(targetId)) {
    const existingId = state.floatingWindowByTarget.get(targetId);
    const existingWin = state.floatingWindows.get(existingId);
    if (existingWin && !existingWin.destroyed) {
      focusFloatingWindow(existingWin.id);
      if (highlightNodeId || (highlightPortIds && highlightPortIds.length > 0)) {
        highlightInsideFloatingWindow(existingWin, {
          nodeId: highlightNodeId,
          portIds: highlightPortIds,
        });
      }
      updateFloatingOpenButton(state.nodesById.get(state.selectedNodeId));
      scheduleBridgeRender();
      return existingWin;
    }
  }

  const layer = document.getElementById("floating-windows-layer");
  if (!layer) {
    return null;
  }

  let resolvedParentId = inferParentWindowId(targetId, parentWindowId);
  const winId = `fw_${++state.windowIdCounter}`;
  if (resolvedParentId && (resolvedParentId === winId || isWindowAncestor(winId, resolvedParentId))) {
    resolvedParentId = null;
  }
  const parentWin = resolvedParentId ? state.floatingWindows.get(resolvedParentId) : null;

  const subgraph = buildFloatingSubgraph(targetNode);
  const initialRect = computeFloatingWindowPosition(resolvedParentId);
  const dom = createFloatingWindowElement(winId, targetNode, parentWin, initialRect, subgraph);
  layer.appendChild(dom.winEl);

  const subCy = cytoscape({
    container: dom.cyContainer,
    elements: [...subgraph.nodes, ...subgraph.edges],
    style: buildStylesheet(),
    wheelSensitivity: 0.25,
    minZoom: 0.2,
    maxZoom: 3,
  });

  const win = {
    id: winId,
    targetId,
    targetType: targetNode.type,
    parentWindowId: parentWin ? parentWin.id : null,
    childWindowIds: new Set(),
    el: dom.winEl,
    headerEl: dom.headerEl,
    titleSpan: dom.titleSpan,
    badgeSpan: dom.badgeSpan,
    closeChainBtn: dom.closeChainBtn,
    closeBtn: dom.closeBtn,
    lockNoticeEl: dom.lockNoticeEl,
    bodyEl: dom.bodyEl,
    cyContainer: dom.cyContainer,
    statsEl: dom.statsEl,
    hintEl: dom.hintEl,
    cy: subCy,
    portsMeta: subgraph.portsMeta,
    internalNodeIds: subgraph.internalNodeIds,
    isFunctionFlow: subgraph.isFunctionFlow,
    resizeObserver: null,
    lockNoticeTimer: null,
    pulseTimer: null,
    activeDragCleanup: null,
    destroyed: false,
  };

  state.floatingWindows.set(winId, win);
  state.floatingWindowByTarget.set(targetId, winId);
  if (parentWin) {
    parentWin.childWindowIds.add(winId);
    updateFloatingWindowHeaderState(parentWin);
  }
  updateFloatingWindowHeaderState(win);

  dom.winEl.addEventListener("mousedown", () => {
    focusFloatingWindow(win.id);
  });

  bindFloatingWindowDrag(win);

  dom.fitBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    focusFloatingWindow(win.id);
    if (win.cy && !win.destroyed) {
      win.cy.fit(undefined, 22);
      scheduleBridgeRender();
    }
  });

  dom.closeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    closeFloatingWindow(win.id, { forceCascade: false });
  });

  dom.closeChainBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    closeFloatingWindow(win.id, { forceCascade: true });
  });

  // Eventos de Cytoscape aislado dentro de la ventana flotante.
  subCy.on("tap", "node", async (event) => {
    focusFloatingWindow(win.id);
    const data = event.target.data();
    if (data.type === "port") {
      await handlePortClick(win, data.id);
      return;
    }
    const selTargetId = data.ownerFunctionId || data.id;
    const stepId = data.type === "flow" ? (data.stepId || null) : null;
    selectNode(selTargetId, stepId);
  });

  subCy.on("dbltap", "node", async (event) => {
    const data = event.target.data();
    if (data.type === "port") {
      return;
    }
    const selTargetId = data.ownerFunctionId || data.id;
    if (selTargetId === win.targetId) {
      return;
    }
    const rawTarget = state.nodesById.get(selTargetId);
    if (canOpenInFloatingWindow(rawTarget)) {
      await openFloatingWindow(selTargetId, { parentWindowId: win.id });
    }
  });

  subCy.on("mouseover", "edge", (event) => {
    showEdgeTooltip(event.target, event.renderedPosition, win.bodyEl);
  });
  subCy.on("mousemove", "edge", (event) => {
    showEdgeTooltip(event.target, event.renderedPosition, win.bodyEl);
  });
  subCy.on("mouseout", "edge", () => {
    hideEdgeTooltip();
  });
  subCy.on("pan zoom position", () => {
    hideEdgeTooltip();
    scheduleBridgeRender();
  });

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      if (win.destroyed || !win.cy) {
        return;
      }
      win.cy.resize();
      scheduleBridgeRender();
    });
    ro.observe(dom.winEl);
    win.resizeObserver = ro;
  }

  focusFloatingWindow(win.id);
  await runSubElkLayout(subCy, subgraph.nodes, subgraph.edges, subgraph.isFunctionFlow);

  if (!win.destroyed) {
    if (highlightNodeId || (highlightPortIds && highlightPortIds.length > 0)) {
      highlightInsideFloatingWindow(win, {
        nodeId: highlightNodeId,
        portIds: highlightPortIds,
      });
    }
    if (state.selectedNodeId === targetId && state.activeFlowStepId) {
      syncFlowStepHighlight(state.selectedNodeId, state.activeFlowStepId);
    }
    updateFloatingOpenButton(state.nodesById.get(state.selectedNodeId));
    scheduleBridgeRender();
  }

  return win;
}

async function handlePortClick(sourceWin, portId) {
  if (!sourceWin || sourceWin.destroyed) {
    return;
  }
  const portInfo = sourceWin.portsMeta.get(portId);
  if (!portInfo) {
    return;
  }

  highlightInsideFloatingWindow(sourceWin, { portIds: [portId] });

  const externalContainerId = portInfo.externalContainerId;
  const externalContainerNode = externalContainerId ? state.nodesById.get(externalContainerId) : null;
  if (!externalContainerNode || !canOpenInFloatingWindow(externalContainerNode)) {
    selectNode(portInfo.externalNodeId);
    return;
  }

  const reciprocalDir = portInfo.direction === "out" ? "in" : "out";
  const reciprocalPortIds = Array.from(portInfo.internalEndpoints || []).map(
    (epId) => `port_${reciprocalDir}::${epId}`,
  );

  // Si la ventana conectada ya está abierta, enfocarla sin modificar su parentWindowId (evita ciclos).
  if (state.floatingWindowByTarget.has(externalContainerId)) {
    const existingWinId = state.floatingWindowByTarget.get(externalContainerId);
    const existingWin = state.floatingWindows.get(existingWinId);
    if (existingWin && !existingWin.destroyed) {
      focusFloatingWindow(existingWin.id);
      highlightInsideFloatingWindow(existingWin, {
        nodeId: portInfo.externalNodeId,
        portIds: reciprocalPortIds,
      });
      selectNode(portInfo.externalNodeId);
      scheduleBridgeRender();
      return;
    }
  }

  await openFloatingWindow(externalContainerId, {
    parentWindowId: sourceWin.id,
    highlightNodeId: portInfo.externalNodeId,
    highlightPortIds: reciprocalPortIds,
  });
  selectNode(portInfo.externalNodeId);
}

function closeFloatingWindow(winId, { forceCascade = false } = {}) {
  const win = state.floatingWindows.get(winId);
  if (!win || win.destroyed) {
    return false;
  }

  if (win.childWindowIds.size > 0) {
    if (!forceCascade) {
      focusFloatingWindow(win.id);
      triggerFloatingLockWarning(win);
      return false;
    }
    // Cerrar primero los descendientes en orden hoja -> raíz.
    for (const childId of Array.from(win.childWindowIds)) {
      closeFloatingWindow(childId, { forceCascade: true });
    }
  }

  win.destroyed = true;
  hideEdgeTooltip();

  if (win.lockNoticeTimer) {
    clearTimeout(win.lockNoticeTimer);
    win.lockNoticeTimer = null;
  }
  if (win.pulseTimer) {
    clearTimeout(win.pulseTimer);
    win.pulseTimer = null;
  }
  if (win.activeDragCleanup) {
    win.activeDragCleanup();
    win.activeDragCleanup = null;
  }
  if (win.resizeObserver) {
    try {
      win.resizeObserver.disconnect();
    } catch (_err) {
      // Ignorar errores de observador ya desconectado.
    }
    win.resizeObserver = null;
  }
  if (win.cy) {
    try {
      win.cy.destroy();
    } catch (_err) {
      // Ignorar errores si el contenedor ya fue desmontado.
    }
    win.cy = null;
  }
  if (win.el && win.el.parentNode) {
    win.el.parentNode.removeChild(win.el);
  }

  state.floatingWindows.delete(win.id);
  if (state.floatingWindowByTarget.get(win.targetId) === win.id) {
    state.floatingWindowByTarget.delete(win.targetId);
  }
  state.windowFocusOrder = state.windowFocusOrder.filter((id) => id !== win.id);

  if (win.parentWindowId && state.floatingWindows.has(win.parentWindowId)) {
    const parentWin = state.floatingWindows.get(win.parentWindowId);
    parentWin.childWindowIds.delete(win.id);
    updateFloatingWindowHeaderState(parentWin);
  }

  if (state.activeWindowId === win.id) {
    state.activeWindowId = null;
    const nextTopId = state.windowFocusOrder[state.windowFocusOrder.length - 1];
    if (nextTopId && state.floatingWindows.has(nextTopId)) {
      focusFloatingWindow(nextTopId);
    }
  }

  if (state.selectedNodeId) {
    updateFloatingOpenButton(state.nodesById.get(state.selectedNodeId));
  }
  scheduleBridgeRender();
  return true;
}

function closeMostRecentLeafFloatingWindow() {
  if (state.floatingWindows.size === 0) {
    return false;
  }
  for (let i = state.windowFocusOrder.length - 1; i >= 0; i -= 1) {
    const candidateId = state.windowFocusOrder[i];
    const win = state.floatingWindows.get(candidateId);
    if (win && !win.destroyed && win.childWindowIds.size === 0) {
      return closeFloatingWindow(win.id, { forceCascade: false });
    }
  }
  return false;
}

async function reconcileFloatingWindowsOnLiveUpdate() {
  if (state.floatingWindows.size === 0) {
    return;
  }

  // 1. Cerrar ventanas cuyo nodo objetivo fue eliminado o dejó de ser elegible (hojas primero).
  const invalidIds = [];
  for (const win of state.floatingWindows.values()) {
    const rawNode = state.nodesById.get(win.targetId);
    if (!canOpenInFloatingWindow(rawNode)) {
      invalidIds.push(win.id);
    }
  }

  // Re-parentar hijas sobrevivientes si su padre desapareció en el código fuente.
  for (const invalidId of invalidIds) {
    const win = state.floatingWindows.get(invalidId);
    if (!win) {
      continue;
    }
    const grandParentId = win.parentWindowId && !invalidIds.includes(win.parentWindowId)
      ? win.parentWindowId
      : null;
    for (const childId of Array.from(win.childWindowIds)) {
      if (invalidIds.includes(childId)) {
        continue;
      }
      const childWin = state.floatingWindows.get(childId);
      if (childWin) {
        win.childWindowIds.delete(childId);
        childWin.parentWindowId = grandParentId;
        if (grandParentId && state.floatingWindows.has(grandParentId)) {
          state.floatingWindows.get(grandParentId).childWindowIds.add(childId);
          updateFloatingWindowHeaderState(state.floatingWindows.get(grandParentId));
        }
        updateFloatingWindowHeaderState(childWin);
      }
    }
  }

  // Cerrar las ventanas inválidas en orden hoja -> raíz.
  let remaining = invalidIds.filter((id) => state.floatingWindows.has(id));
  let guard = remaining.length + 2;
  while (remaining.length > 0 && guard > 0) {
    guard -= 1;
    let closedAny = false;
    for (const id of [...remaining]) {
      const win = state.floatingWindows.get(id);
      if (win && win.childWindowIds.size === 0) {
        closeFloatingWindow(id, { forceCascade: false });
        closedAny = true;
      }
    }
    remaining = remaining.filter((id) => state.floatingWindows.has(id));
    if (!closedAny && remaining.length > 0) {
      closeFloatingWindow(remaining[0], { forceCascade: true });
      remaining = remaining.filter((id) => state.floatingWindows.has(id));
    }
  }

  // 2. Re-renderizar sub-grafos de ventanas sobrevivientes.
  for (const win of Array.from(state.floatingWindows.values())) {
    if (win.destroyed || !win.cy) {
      continue;
    }
    const rawNode = state.nodesById.get(win.targetId);
    if (!rawNode) {
      continue;
    }
    const subgraph = buildFloatingSubgraph(rawNode);
    win.portsMeta = subgraph.portsMeta;
    win.internalNodeIds = subgraph.internalNodeIds;
    win.isFunctionFlow = subgraph.isFunctionFlow;
    win.titleSpan.textContent = rawNode.label || rawNode.id;
    win.statsEl.textContent = formatFloatingFooterStats(subgraph);

    win.cy.elements().remove();
    win.cy.add([...subgraph.nodes, ...subgraph.edges]);
    await runSubElkLayout(win.cy, subgraph.nodes, subgraph.edges, subgraph.isFunctionFlow);
    updateFloatingWindowHeaderState(win);
  }

  scheduleBridgeRender();
}

function scheduleBridgeRender() {
  if (state.bridgeRenderRaf !== null) {
    return;
  }
  state.bridgeRenderRaf = window.requestAnimationFrame(() => {
    state.bridgeRenderRaf = null;
    renderFloatingBridges();
  });
}

function clampNumber(value, minVal, maxVal) {
  return Math.max(minVal, Math.min(maxVal, value));
}

function getFloatingWindowRectInArea(win, areaRect) {
  const rect = win.el.getBoundingClientRect();
  return {
    left: rect.left - areaRect.left,
    top: rect.top - areaRect.top,
    right: rect.right - areaRect.left,
    bottom: rect.bottom - areaRect.top,
    cx: (rect.left + rect.right) / 2 - areaRect.left,
    cy: (rect.top + rect.bottom) / 2 - areaRect.top,
  };
}

function getNodeAnchorInArea(win, cyNodeId, sideHint, areaRect) {
  const bodyRect = win.bodyEl.getBoundingClientRect();
  const bLeft = bodyRect.left - areaRect.left;
  const bTop = bodyRect.top - areaRect.top;
  const bRight = bodyRect.right - areaRect.left;
  const bBottom = bodyRect.bottom - areaRect.top;

  if (cyNodeId && win.cy && !win.destroyed) {
    const cyNode = win.cy.getElementById(cyNodeId);
    if (cyNode && cyNode.length > 0) {
      const rp = cyNode.renderedPosition();
      const bb = cyNode.renderedBoundingBox();
      let localX = rp.x;
      if (sideHint === "right") {
        localX = bb.x2;
      } else if (sideHint === "left") {
        localX = bb.x1;
      }
      return {
        x: clampNumber(bLeft + localX, bLeft + 2, bRight - 2),
        y: clampNumber(bTop + rp.y, bTop + 2, bBottom - 2),
      };
    }
  }

  return {
    x: sideHint === "left" ? bLeft : bRight,
    y: (bTop + bBottom) / 2,
  };
}

function appendSvgBridgeCurve(svg, p1, p2, edgeType, fromSide, toSide) {
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const offset = clampNumber(dist * 0.38, 44, 175);
  const c1x = p1.x + (fromSide === "left" ? -offset : offset);
  const c1y = p1.y;
  const c2x = p2.x + (toSide === "left" ? -offset : offset);
  const c2y = p2.y;

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("class", `fw-bridge-path bridge-${edgeType || "direct_call"}`);
  path.setAttribute(
    "d",
    `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
  );
  svg.appendChild(path);

  for (const pt of [p1, p2]) {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("class", "fw-bridge-dot");
    dot.setAttribute("cx", pt.x.toFixed(1));
    dot.setAttribute("cy", pt.y.toFixed(1));
    dot.setAttribute("r", "3.4");
    svg.appendChild(dot);
  }
}

function renderFloatingBridges() {
  const svg = document.getElementById("floating-bridges-svg");
  const area = document.getElementById("canvas-area");
  if (!svg || !area) {
    return;
  }
  svg.innerHTML = "";

  const openWins = Array.from(state.floatingWindows.values()).filter((w) => !w.destroyed);
  if (openWins.length < 2) {
    return;
  }

  const areaRect = area.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${Math.max(1, areaRect.width)} ${Math.max(1, areaRect.height)}`);
  svg.style.zIndex = String(Math.min(850, state.windowZCounter + 1));

  const rects = new Map();
  for (const win of openWins) {
    rects.set(win.id, getFloatingWindowRectInArea(win, areaRect));
  }

  const drawnKeys = new Set();

  // 1. Puentes puerto-a-puerto (salidas de winA conectadas con nodos/puertos dentro de winB).
  for (const winA of openWins) {
    const rectA = rects.get(winA.id);
    for (const portInfo of winA.portsMeta.values()) {
      if (portInfo.direction !== "out") {
        continue;
      }
      for (const winB of openWins) {
        if (winB.id === winA.id) {
          continue;
        }
        if (!winB.internalNodeIds.has(portInfo.externalNodeId)) {
          continue;
        }
        const rectB = rects.get(winB.id);
        const fromSide = rectB.cx >= rectA.cx ? "right" : "left";
        const toSide = rectB.cx >= rectA.cx ? "left" : "right";

        let targetAnchorNodeId = null;
        for (const srcInternalId of portInfo.internalEndpoints) {
          const candidatePort = `port_in::${srcInternalId}`;
          if (winB.portsMeta.has(candidatePort)) {
            targetAnchorNodeId = candidatePort;
            break;
          }
        }
        if (!targetAnchorNodeId && winB.cy && winB.cy.getElementById(portInfo.externalNodeId).length > 0) {
          targetAnchorNodeId = portInfo.externalNodeId;
        }

        const dedupeKey = `port|${winA.id}|${portInfo.portId}|${winB.id}|${targetAnchorNodeId || "border"}`;
        if (drawnKeys.has(dedupeKey)) {
          continue;
        }
        drawnKeys.add(dedupeKey);

        const p1 = getNodeAnchorInArea(winA, portInfo.portId, fromSide, areaRect);
        const p2 = getNodeAnchorInArea(winB, targetAnchorNodeId, toSide, areaRect);
        appendSvgBridgeCurve(svg, p1, p2, portInfo.edgeType, fromSide, toSide);
      }
    }
  }

  // 2. Puentes Padre -> Hijo para ventanas anidadas (p. ej. archivo -> flujo interno 3+ de función).
  for (const winB of openWins) {
    if (!winB.parentWindowId) {
      continue;
    }
    const winA = state.floatingWindows.get(winB.parentWindowId);
    if (!winA || winA.destroyed || !winA.cy) {
      continue;
    }
    const sourceNodeInParent = winA.cy.getElementById(winB.targetId);
    if (!sourceNodeInParent || sourceNodeInParent.length === 0) {
      continue;
    }
    const dedupeKey = `parent|${winA.id}|${winB.id}`;
    if (drawnKeys.has(dedupeKey)) {
      continue;
    }
    drawnKeys.add(dedupeKey);

    const rectA = rects.get(winA.id);
    const rectB = rects.get(winB.id);
    const fromSide = rectB.cx >= rectA.cx ? "right" : "left";
    const toSide = rectB.cx >= rectA.cx ? "left" : "right";
    const p1 = getNodeAnchorInArea(winA, winB.targetId, fromSide, areaRect);
    const p2 = getNodeAnchorInArea(winB, null, toSide, areaRect);
    appendSvgBridgeCurve(svg, p1, p2, "parent_child", fromSide, toSide);
  }
}

initViewer().catch((error) => {
  document.getElementById("project-title").textContent = "Error al iniciar CodeMap";
  console.error(error);
});
