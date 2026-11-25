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
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "48",
  "elk.layered.spacing.edgeNodeBetweenLayers": "22",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
  "elk.spacing.nodeNode": "32",
  "elk.spacing.edgeNode": "20",
  "elk.spacing.edgeEdge": "14",
  "elk.padding": "[top=38,left=20,bottom=20,right=20]",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
};

const CREATION_FILE_ELK_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.hierarchyHandling": "SEPARATE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.partitioning.activate": "true",
  "elk.separateConnectedComponents": "false",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.spacing.nodeNodeBetweenLayers": "52",
  "elk.layered.spacing.edgeNodeBetweenLayers": "22",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
  "elk.spacing.nodeNode": "32",
  "elk.spacing.edgeNode": "22",
  "elk.spacing.edgeEdge": "14",
  "elk.padding": "[top=42,left=36,bottom=24,right=36]",
};

const CREATION_CONTAINER_ELK_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.hierarchyHandling": "SEPARATE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.partitioning.activate": "true",
  "elk.separateConnectedComponents": "false",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.spacing.nodeNodeBetweenLayers": "60",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "16",
  "elk.spacing.nodeNode": "40",
  "elk.spacing.edgeNode": "24",
  "elk.spacing.edgeEdge": "16",
  "elk.padding": "[top=42,left=28,bottom=24,right=28]",
};

const CREATION_ROW_STAGGER_PX = 14;
const CREATION_MACRO_EDGE_PREFIX = "__creation_macro_";

const ROLE_LABELS = {
  entry: "Entrada",
  transform: "Transformación",
  decision: "Decisión",
  io: "I/O",
  module: "Módulo",
  file: "Archivo",
  variable: "Constante / Variable",
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
  reads_var: { label: "Lectura de variable/constante", short: "lee", icon: "🔖" },
};

const EDGE_TYPE_PRIORITY = {
  direct_call: 1,
  serves_html: 2,
  loads_script: 2,
  event_listener: 3,
  reactive_subscribe: 4,
  callback_ref: 5,
  reactive_trigger: 6,
  reads_var: 7,
};

const ENTRY_KIND_LABELS = {
  main: "Inicio principal",
  route_handler: "Ruta HTTP",
  event_handler: "Handler de evento",
  unreferenced: "Sin referencias",
};

const NOTE_AUTOSAVE_MS = 500;
const LARGE_PROJECT_FUNCTION_LIMIT = 25;
const MAIN_MIN_ZOOM = 0.02;
const MAIN_MAX_ZOOM = 4;
const FW_MIN_ZOOM = 0.05;
const FW_MAX_ZOOM = 4;
const DYNAMIC_MIN_ZOOM_FLOOR = 0.005;

const DEFAULT_ARCH_LAYERS = [
  { index: 0, id: "layer::0", key: "entries", label: "Entradas / UI" },
  { index: 1, id: "layer::1", key: "orchestrators", label: "Orquestadores" },
  { index: 2, id: "layer::2", key: "services", label: "Servicios / Estado" },
  { index: 3, id: "layer::3", key: "utilities", label: "Utilidades / Persistencia" },
];

const LEVEL_METADATA = {
  1: {
    badge: "Nivel 1 · Módulos",
    title: "Arquitectura de Módulos",
    hint: "Carpetas y archivos raíz colapsados. Doble clic para expandir o Alt+Doble clic para ventana flotante.",
  },
  2: {
    badge: "Nivel 2 · Archivos",
    title: "Interconexión de Archivos",
    hint: "Carpetas desplegadas con archivos colapsados para visualizar dependencias limpias entre archivos.",
  },
  3: {
    badge: "Nivel 3 · Funciones",
    title: "Mapa de Funciones",
    hint: "Todas las funciones e invocaciones visibles. Pulsa T para Modo Foco o elige un hilo en la barra superior.",
  },
  4: {
    badge: "Nivel 3+ · Intra-función",
    title: "Flujo Intra-función",
    hint: "Desglose interno de ramas, bucles, eventos y llamadas dentro de las funciones.",
  },
};

const LEGACY_PIN_FALLBACK_KEY = {
  modules: "level_1",
  functions: "level_2",
  intra: "level_4",
};

const state = {
  rawGraph: null,
  notes: { nodes: {}, orphans: [], line_notes: {} },
  knownApis: { version: 1, known: {} },
  vocabDict: { version: 1, entries: {} },
  nodesById: new Map(),
  childrenByParent: new Map(),
  flowsById: new Map(),
  activeFlowId: null,
  preFlowCollapsedContainers: null,
  isolateActiveContext: false,
  onDemandEdges: false,
  hoveredNodeId: null,
  groupingMode: "folders",
  layoutOrderMode: "execution",
  nhops: {
    active: false,
    anchorIds: [],
    forwardDepth: 1,
    backwardDepth: 1,
    autoTriggered: false,
  },
  isolatedFileId: null,
  preIsolateCollapsedContainers: null,
  lastProjectedEdges: [],
  lastVisibleSummaryCounts: { modules: 0, files: 0, functions: 0, edges: 0 },
  utilityNodeIds: new Set(),
  utilityDetectionMode: "strict",
  hideUtilities: false,
  showVariables: false,
  totalVariables: 0,
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
  inspectorWidth: 350,
  spacePanning: false,
  suppressNextTap: false,
  mainPanCleanup: null,
  mainTooltipCleanup: null,
  nodeTooltipTimer: null,
  nodeTooltipTargetId: null,
  nodeTooltipPos: null,
  nodeTooltipContainerEl: null,
  traceMode: false,
  traceHistory: [],
  traceDirection: "forward",
  traceBranchCandidates: [],
  traceBranchIndex: 0,
  noteSaveTimer: null,
  recentLineNoteStatus: null,
  searchMatches: [],
  searchActiveIndex: 0,
  apisModalTab: "pending",
  apisModalCategory: "all",
  apisSearchQuery: "",
  floatingWindows: new Map(),
  floatingWindowByTarget: new Map(),
  windowFocusOrder: [],
  activeWindowId: null,
  windowIdCounter: 0,
  windowZCounter: 30,
  bridgeRenderRaf: null,
  refreshToken: 0,
  zoomEditActive: false,
  mainBgPanCleanup: null,
  walkthroughExpansion: {
    hasSnapshot: false,
    activeLevel: null,
    groupingMode: null,
    preCollapsed: new Set(),
    preExpanded: new Set(),
    tempOpenedContainers: new Set(),
    tempCollapsedContainers: new Set(),
    tempExpandedFunctions: new Set(),
    activeTargetKey: null,
    lastActiveAnchorId: null,
  },
  walkthrough: null,
  ws: null,
  cy: null,
  elk: null,
};

// ---------------------------------------------------------------------------
// Inicialización, carga inicial y WebSocket en vivo
// ---------------------------------------------------------------------------

async function initViewer() {
  state.elk = new ELK();
  const [graphRes, notesRes, apisRes, vocabRes] = await Promise.all([
    fetch("/graph.json", { cache: "no-store" }),
    fetch("/notes.json", { cache: "no-store" }),
    fetch("/known-apis", { cache: "no-store" }),
    fetch("/vocab-dictionary", { cache: "no-store" }),
  ]);
  if (!graphRes.ok) {
    throw new Error(`No se pudo cargar /graph.json (${graphRes.status})`);
  }

  state.rawGraph = await graphRes.json();
  state.notes = notesRes.ok ? await notesRes.json() : { nodes: {}, orphans: [], line_notes: {} };
  if (!state.notes.line_notes || typeof state.notes.line_notes !== "object") {
    state.notes.line_notes = {};
  }
  state.knownApis = apisRes.ok ? await apisRes.json() : { version: 1, known: {} };
  state.vocabDict = vocabRes.ok ? await vocabRes.json() : { version: 1, entries: {} };
  indexGraph(state.rawGraph);

  renderHeader(state.rawGraph.meta, state.rawGraph.edges.length);
  populateFlowSelector();
  updateUtilitiesButton();
  updateVariablesButton();
  updateOrphansBadge();
  updateKnownApisButton();
  updateLayoutOrderButton();
  initCytoscape();
  bindControls();
  initWalkthroughController();
  connectWebSocket();

  const totalFuncs = (state.rawGraph.meta && state.rawGraph.meta.total_functions) || 0;
  const shouldStartCollapsed = !state.legendUserToggled
    && (state.rawGraph.nodes.length > 25 || totalFuncs >= 20);
  toggleLegend(shouldStartCollapsed);

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
      if (!state.notes.line_notes || typeof state.notes.line_notes !== "object") {
        state.notes.line_notes = {};
      }
      updateOrphansBadge();
      refreshAllVocabViews();
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
    if (!state.notes.line_notes || typeof state.notes.line_notes !== "object") {
      state.notes.line_notes = {};
    }
  }
  indexGraph(state.rawGraph);
  pruneStaleExpansionState();

  renderHeader(state.rawGraph.meta, state.rawGraph.edges.length);
  populateFlowSelector();
  updateUtilitiesButton();
  updateVariablesButton();
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
  refreshAllVocabViews();
  applyCanvasHighlights();
  if (state.walkthrough) {
    await state.walkthrough.onLiveGraphUpdated();
  }
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
  if (state.isolatedFileId && !state.nodesById.has(state.isolatedFileId)) {
    state.isolatedFileId = null;
    state.preIsolateCollapsedContainers = null;
    updateFileIsolationHud();
  }
  if (state.nhops.active) {
    state.nhops.anchorIds = state.nhops.anchorIds.filter((id) => state.nodesById.has(id));
    if (state.nhops.anchorIds.length === 0) {
      state.nhops.active = false;
      updateNHopsHud();
    }
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
  state.totalVariables = (graph.nodes || []).filter((n) => n.type === "variable").length;
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

function updateVariablesButton() {
  const btn = document.getElementById("btn-toggle-variables");
  const labelEl = document.getElementById("variables-label-text");
  const badgeEl = document.getElementById("variables-count-badge");
  if (!btn) {
    return;
  }
  const count = state.totalVariables || 0;
  if (labelEl) {
    labelEl.textContent = state.showVariables
      ? `Ocultar constantes (${count})`
      : `Mostrar constantes (${count})`;
  }
  if (badgeEl) {
    badgeEl.textContent = count > 0 ? String(count) : "";
    badgeEl.classList.toggle("hidden", count === 0);
  }
  btn.classList.toggle("active", state.showVariables);
  btn.setAttribute("aria-pressed", state.showVariables ? "true" : "false");
  btn.disabled = count === 0 && !state.showVariables;
  btn.title = count > 0
    ? `${state.showVariables ? "Ocultar" : "Mostrar"} ${count} constantes y variables top-level en el lienzo`
    : "No se detectaron constantes ni variables top-level en este proyecto";
}

async function toggleShowVariables() {
  if ((state.totalVariables || 0) === 0 && !state.showVariables) {
    return;
  }
  state.showVariables = !state.showVariables;
  updateVariablesButton();
  await refreshGraphView({ fit: false });
  if (state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
    const selectedRaw = state.nodesById.get(state.selectedNodeId);
    if (!state.showVariables && selectedRaw && selectedRaw.type === "variable") {
      clearSelectionPanel();
    } else {
      selectNode(state.selectedNodeId, state.activeFlowStepId);
    }
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

  if (cleanId && state.isolatedFileId) {
    state.isolatedFileId = null;
    state.preIsolateCollapsedContainers = null;
    updateFileIsolationHud();
  }
  if (cleanId && state.nhops.active) {
    state.nhops.active = false;
    state.nhops.anchorIds = [];
    state.nhops.autoTriggered = false;
    updateNHopsHud();
  }

  if (cleanId && state.traceMode) {
    state.traceMode = false;
    state.traceHistory = [];
    document.getElementById("btn-trace").classList.remove("active");
    hideTraceBranchHud();
  }

  if (!cleanId) {
    state.activeFlowId = null;
    if (!state.traceMode) {
      state.isolateActiveContext = false;
    }
    if (state.preFlowCollapsedContainers) {
      state.collapsedContainers = new Set(state.preFlowCollapsedContainers);
      state.preFlowCollapsedContainers = null;
    }
    populateFlowSelector();
    updateIsolateContextButtons();
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
  updateIsolateContextButtons();
  await refreshGraphView({ fit: state.isolateActiveContext });
  renderActiveFlowPanel();

  if (fit && !state.isolateActiveContext && state.cy) {
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
  let baseKey = "functions";
  if (state.expandedFunctions.size > 0 || state.activeLevel === 4) {
    baseKey = "intra";
  } else if (state.activeLevel === 1) {
    baseKey = "modules";
  } else if (state.activeLevel === 2) {
    baseKey = "files";
  }
  const groupedKey = state.groupingMode === "layers" ? `layers_${baseKey}` : baseKey;
  return state.layoutOrderMode === "creation" ? `creation_${groupedKey}` : groupedKey;
}

function getPinnedPositionForContext(noteEntry, contextKey = getCurrentLayoutContextKey()) {
  if (!noteEntry) {
    return null;
  }
  const positions = noteEntry.pinned_positions || {};
  const byLevel = positions[contextKey];
  if (byLevel && typeof byLevel.x === "number" && typeof byLevel.y === "number") {
    return { x: byLevel.x, y: byLevel.y };
  }
  // Retrocompatibilidad controlada: "files" es una escala nueva y NUNCA hereda pines de otras escalas.
  const legacyKey = LEGACY_PIN_FALLBACK_KEY[contextKey];
  if (legacyKey) {
    const legacyPos = positions[legacyKey];
    if (legacyPos && typeof legacyPos.x === "number" && typeof legacyPos.y === "number") {
      return { x: legacyPos.x, y: legacyPos.y };
    }
  }
  // Coordenadas planas x/y heredadas corresponden a la vista de funciones (antes Nivel 2).
  if (
    contextKey === "functions"
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
// Niveles multiescala (N1 Módulos -> N2 Archivos -> N3 Funciones -> N3+ Intra)
// y aislamiento puntual de archivo
// ---------------------------------------------------------------------------

function isLayerContainerId(id) {
  return typeof id === "string" && id.startsWith("layer::");
}

function getArchLayers() {
  const fromMeta = state.rawGraph && state.rawGraph.meta && state.rawGraph.meta.architectural_layers;
  if (Array.isArray(fromMeta) && fromMeta.length > 0) {
    return fromMeta;
  }
  return DEFAULT_ARCH_LAYERS;
}

function getNodeArchLayer(rawNode) {
  if (rawNode && typeof rawNode.arch_layer === "number") {
    return rawNode.arch_layer;
  }
  if (rawNode && rawNode.type === "module") {
    return computeModuleArchLayer(rawNode.id);
  }
  return 3;
}

function computeModuleArchLayer(moduleId) {
  if (!moduleId || !state.childrenByParent) {
    return 3;
  }
  const nonEmptyFileLayers = [];
  const allFileLayers = [];
  const walk = (id) => {
    const children = state.childrenByParent.get(id) || [];
    for (const child of children) {
      if (child.type === "file" && typeof child.arch_layer === "number") {
        allFileLayers.push(child.arch_layer);
        const fileChildren = state.childrenByParent.get(child.id) || [];
        if (fileChildren.some((c) => c.type === "function")) {
          nonEmptyFileLayers.push(child.arch_layer);
        }
      } else if (child.type === "module") {
        walk(child.id);
      }
    }
  };
  walk(moduleId);
  const pool = nonEmptyFileLayers.length > 0 ? nonEmptyFileLayers : allFileLayers;
  return pool.length > 0 ? Math.min(...pool) : 3;
}

function getLargeProjectThreshold() {
  const fromMeta = state.rawGraph && state.rawGraph.meta && state.rawGraph.meta.large_project_threshold;
  return typeof fromMeta === "number" && fromMeta > 0 ? fromMeta : LARGE_PROJECT_FUNCTION_LIMIT;
}

function updateGroupingButtons() {
  for (const btn of document.querySelectorAll(".group-btn")) {
    btn.classList.toggle("active", btn.dataset.grouping === state.groupingMode);
  }
}

async function setGroupingMode(mode) {
  const cleanMode = mode === "layers" ? "layers" : "folders";
  if (state.groupingMode === cleanMode) {
    return;
  }
  state.groupingMode = cleanMode;
  updateGroupingButtons();
  await applyLevel(state.activeLevel, { preserveNHops: state.nhops.active });
}

function resolveDefaultNHopsAnchors() {
  if (state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
    const sel = state.nodesById.get(state.selectedNodeId);
    if (sel.type === "function") {
      return [sel.id];
    }
    if (sel.type === "file") {
      const fileFns = (state.childrenByParent.get(sel.id) || [])
        .filter((n) => n.type === "function")
        .map((n) => n.id);
      if (fileFns.length > 0) {
        return fileFns.slice(0, 4);
      }
      return [sel.id];
    }
  }
  const meta = (state.rawGraph && state.rawGraph.meta) || {};
  const mainFns = (meta.main_entry_functions || []).filter((id) => state.nodesById.has(id));
  if (mainFns.length > 0) {
    return mainFns.slice(0, 3);
  }
  const mainFlow = (state.rawGraph && state.rawGraph.execution_flows || []).find((f) => f.kind === "main");
  if (mainFlow && mainFlow.root_id && state.nodesById.has(mainFlow.root_id)) {
    return [mainFlow.root_id];
  }
  const firstFn = (state.rawGraph && state.rawGraph.nodes || []).find((n) => n.type === "function");
  return firstFn ? [firstFn.id] : [];
}

function computeNHopsSubgraph() {
  if (!state.rawGraph || !state.nhops.active || state.nhops.anchorIds.length === 0) {
    return null;
  }
  const anchorSet = new Set(state.nhops.anchorIds.filter((id) => state.nodesById.has(id)));
  if (anchorSet.size === 0) {
    return null;
  }

  const activeFlow = getActiveFlow();
  const activeFlowNodeSet = activeFlow ? new Set(activeFlow.node_ids || []) : null;

  const outAdj = new Map();
  const inAdj = new Map();
  for (const edge of state.rawGraph.edges) {
    const src = edge.source;
    const tgt = edge.target;
    if (src === tgt) {
      continue;
    }
    if (!state.showVariables && edge.edge_type === "reads_var" && !anchorSet.has(src) && !anchorSet.has(tgt)) {
      continue;
    }
    if (!anchorSet.has(src) && isUtilityNodeHidden(src, activeFlowNodeSet)) {
      continue;
    }
    if (!anchorSet.has(tgt) && isUtilityNodeHidden(tgt, activeFlowNodeSet)) {
      continue;
    }
    if (!outAdj.has(src)) outAdj.set(src, new Set());
    if (!inAdj.has(tgt)) inAdj.set(tgt, new Set());
    outAdj.get(src).add(tgt);
    inAdj.get(tgt).add(src);
  }

  const reached = new Set(anchorSet);

  // BFS hacia adelante (callees)
  let frontier = [...anchorSet];
  for (let step = 0; step < state.nhops.forwardDepth && frontier.length > 0; step += 1) {
    const next = [];
    for (const curr of frontier) {
      for (const nb of outAdj.get(curr) || []) {
        if (!reached.has(nb)) {
          reached.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }

  // BFS hacia atrás (callers)
  frontier = [...anchorSet];
  for (let step = 0; step < state.nhops.backwardDepth && frontier.length > 0; step += 1) {
    const next = [];
    for (const curr of frontier) {
      for (const nb of inAdj.get(curr) || []) {
        if (!reached.has(nb)) {
          reached.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }

  const allowedNodeIds = new Set();
  for (const nid of reached) {
    addNodeWithAncestors(allowedNodeIds, nid);
  }

  return { allowedNodeIds, allowedRawEdgeIds: null, reason: "nhops", reachedIds: reached };
}

function updateNHopsHud() {
  const hud = document.getElementById("nhops-hud");
  const label = document.getElementById("nhops-label");
  const showAllBtn = document.getElementById("btn-nhops-show-all");
  const btn1 = document.getElementById("btn-nhops-1");
  const btn2 = document.getElementById("btn-nhops-2");
  if (!hud || !label) {
    return;
  }
  if (!state.nhops.active) {
    hud.classList.add("hidden");
    label.textContent = "";
    return;
  }
  const totalFns = (state.rawGraph && state.rawGraph.meta && state.rawGraph.meta.total_functions) || 0;
  const shownFns = (state.lastVisibleSummaryCounts && state.lastVisibleSummaryCounts.functions) || 0;
  const anchorTitle = state.nhops.anchorIds.length === 1
    ? shortSummaryLabel(state.nhops.anchorIds[0])
    : `${state.nhops.anchorIds.length} anclas`;
  label.textContent = `🔭 Vecindad (${anchorTitle}) · ←${state.nhops.backwardDepth} / ${state.nhops.forwardDepth}→ · ${shownFns}/${totalFns} fns`;
  if (showAllBtn) {
    showAllBtn.textContent = `Mostrar todo (${totalFns})`;
  }
  if (btn1) {
    btn1.classList.toggle("active", state.nhops.forwardDepth === 1 && state.nhops.backwardDepth === 1);
  }
  if (btn2) {
    btn2.classList.toggle("active", state.nhops.forwardDepth === 2 && state.nhops.backwardDepth === 2);
  }
  hud.classList.remove("hidden");
}

function updateExploreNHopsButton(node) {
  const btn = document.getElementById("btn-explore-nhops");
  if (!btn) {
    return;
  }
  if (!node || (node.type !== "function" && node.type !== "file" && node.type !== "variable")) {
    btn.disabled = true;
    btn.textContent = "🔭 Vecindad";
    btn.classList.remove("active");
    return;
  }
  const isAnchor = state.nhops.active && state.nhops.anchorIds.includes(node.id);
  btn.disabled = false;
  btn.textContent = isAnchor
    ? "✕ Salir vecindad"
    : (state.nhops.active ? "🔭 Centrar aquí" : "🔭 Explorar vecindad");
  btn.classList.toggle("active", isAnchor);
}

async function activateNHops(anchorIds, { forwardDepth = 1, backwardDepth = 1, autoTriggered = false } = {}) {
  const validAnchors = (anchorIds || []).filter((id) => state.nodesById.has(id));
  if (validAnchors.length === 0) {
    return;
  }
  if (
    !state.showVariables
    && validAnchors.some((id) => {
      const n = state.nodesById.get(id);
      return n && n.type === "variable";
    })
  ) {
    state.showVariables = true;
    updateVariablesButton();
  }
  state.nhops = {
    active: true,
    anchorIds: validAnchors,
    forwardDepth,
    backwardDepth,
    autoTriggered,
  };
  state.isolatedFileId = null;
  state.preIsolateCollapsedContainers = null;
  updateFileIsolationHud();

  // Aseguramos nivel de funciones (contenedores abiertos) para explorar la vecindad real.
  if (state.activeLevel < 3) {
    state.activeLevel = 3;
    updateLevelButtons(3);
  }
  state.collapsedContainers.clear();
  await refreshGraphView({ fit: true });
  updateNHopsHud();
  if (state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
    updateExploreNHopsButton(state.nodesById.get(state.selectedNodeId));
  }
}

async function exploreNHopsFromSelectedNode() {
  if (!state.selectedNodeId || !state.nodesById.has(state.selectedNodeId)) {
    return;
  }
  const node = state.nodesById.get(state.selectedNodeId);
  if (state.nhops.active && state.nhops.anchorIds.includes(node.id)) {
    await exitNHops();
    return;
  }
  let anchors = [node.id];
  if (node.type === "file") {
    const childFns = (state.childrenByParent.get(node.id) || [])
      .filter((n) => n.type === "function")
      .map((n) => n.id);
    if (childFns.length > 0) {
      anchors = childFns.slice(0, 6);
    }
  }
  await activateNHops(anchors, { forwardDepth: 1, backwardDepth: 1, autoTriggered: false });
}

async function adjustNHopsDepth(direction, delta) {
  if (!state.nhops.active) {
    return;
  }
  if (direction === "forward") {
    state.nhops.forwardDepth = Math.max(0, Math.min(6, state.nhops.forwardDepth + delta));
  } else {
    state.nhops.backwardDepth = Math.max(0, Math.min(6, state.nhops.backwardDepth + delta));
  }
  await refreshGraphView({ fit: true });
  updateNHopsHud();
}

async function setNHopsPreset(depth) {
  if (!state.nhops.active) {
    return;
  }
  state.nhops.forwardDepth = depth;
  state.nhops.backwardDepth = depth;
  await refreshGraphView({ fit: true });
  updateNHopsHud();
}

async function exitNHops({ refresh = true } = {}) {
  if (!state.nhops.active) {
    return;
  }
  state.nhops.active = false;
  state.nhops.anchorIds = [];
  state.nhops.autoTriggered = false;
  updateNHopsHud();
  if (refresh) {
    await refreshGraphView({ fit: true });
  }
  if (state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
    updateExploreNHopsButton(state.nodesById.get(state.selectedNodeId));
  }
}

async function applyLevel(level, { forceShowAll = false, preserveNHops = false } = {}) {
  resetWalkthroughExpansionSnapshot();
  state.activeLevel = level;
  state.preFlowCollapsedContainers = null;
  state.isolatedFileId = null;
  state.preIsolateCollapsedContainers = null;
  updateLevelButtons(level);
  updateFileIsolationHud();

  if (!preserveNHops || level < 3) {
    state.nhops.active = false;
    state.nhops.anchorIds = [];
    state.nhops.autoTriggered = false;
  }

  state.collapsedContainers.clear();
  state.expandedFunctions.clear();

  if (level === 1) {
    if (state.groupingMode === "layers") {
      for (const layer of getArchLayers()) {
        state.collapsedContainers.add(layer.id);
      }
    } else {
      collapseTopContainers();
    }
  } else if (level === 2) {
    collapseAllFiles();
  } else if (level === 3 && !preserveNHops && !forceShowAll && !state.activeFlowId) {
    const totalFns = (state.rawGraph && state.rawGraph.meta && state.rawGraph.meta.total_functions) || 0;
    const largeLimit = getLargeProjectThreshold();
    if (totalFns > largeLimit) {
      const anchors = resolveDefaultNHopsAnchors();
      if (anchors.length > 0) {
        state.nhops = {
          active: true,
          anchorIds: anchors,
          forwardDepth: 1,
          backwardDepth: 1,
          autoTriggered: true,
        };
      }
    }
  } else if (level === 4) {
    expandFunctionFlowsSmart();
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
  updateNHopsHud();
  if (state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
    const sel = state.nodesById.get(state.selectedNodeId);
    updateIsolateFileButton(sel);
    updateExploreNHopsButton(sel);
  }
  if (
    state.walkthrough
    && state.walkthrough.isActive()
    && typeof state.walkthrough.getScope === "function"
    && state.walkthrough.getScope().scope === "main"
    && typeof state.walkthrough.onLevelChanged === "function"
  ) {
    await state.walkthrough.onLevelChanged();
  }
}

function collapseTopContainers() {
  const topNodes = state.childrenByParent.get(null) || [];
  for (const node of topNodes) {
    if ((node.type === "module" || node.type === "file") && countDescendantFunctions(node.id) > 0) {
      state.collapsedContainers.add(node.id);
    }
  }
}

function collapseAllFiles() {
  for (const node of state.rawGraph.nodes) {
    if (node.type === "file" && countDescendantFunctions(node.id) > 0) {
      state.collapsedContainers.add(node.id);
    }
  }
}

function resolveFileIdForNode(nodeId) {
  if (!nodeId) {
    return null;
  }
  const node = state.nodesById.get(nodeId);
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

function resolveSelectedFileId() {
  return resolveFileIdForNode(state.selectedNodeId);
}

function expandFunctionFlowsSmart() {
  const flowFunctions = state.rawGraph.nodes.filter(
    (node) => node.type === "function" && node.internal_flow && node.internal_flow.length > 0
  );
  if (flowFunctions.length <= LARGE_PROJECT_FUNCTION_LIMIT) {
    for (const node of flowFunctions) {
      state.expandedFunctions.add(node.id);
    }
    return;
  }

  // En proyectos grandes evitamos expandir todas las funciones de golpe para no bloquear ELKjs.
  const selected = state.selectedNodeId ? state.nodesById.get(state.selectedNodeId) : null;
  if (selected && selected.type === "function" && selected.internal_flow && selected.internal_flow.length > 0) {
    state.expandedFunctions.add(selected.id);
    return;
  }
  const selectedFileId = resolveSelectedFileId();
  if (selectedFileId) {
    for (const fn of flowFunctions) {
      if (fn.parent === selectedFileId) {
        state.expandedFunctions.add(fn.id);
      }
    }
    if (state.expandedFunctions.size > 0) {
      return;
    }
  }
  const activeFlow = getActiveFlow();
  const priorityIds = activeFlow
    ? (activeFlow.node_ids || [])
    : ((state.rawGraph.meta && state.rawGraph.meta.main_entry_functions) || []);
  for (const id of priorityIds) {
    const fn = state.nodesById.get(id);
    if (fn && fn.type === "function" && fn.internal_flow && fn.internal_flow.length > 0) {
      state.expandedFunctions.add(fn.id);
      if (state.expandedFunctions.size >= 6) {
        break;
      }
    }
  }
  if (state.expandedFunctions.size === 0) {
    for (const fn of flowFunctions.slice(0, 6)) {
      state.expandedFunctions.add(fn.id);
    }
  }
}

function updateFileIsolationHud() {
  const hud = document.getElementById("file-isolation-hud");
  const label = document.getElementById("file-isolation-label");
  if (!hud || !label) {
    return;
  }
  if (!state.isolatedFileId) {
    hud.classList.add("hidden");
    label.textContent = "";
    return;
  }
  label.textContent = `🎯 Archivo aislado: ${state.isolatedFileId}`;
  hud.classList.remove("hidden");
}

function updateIsolateFileButton(node) {
  const btn = document.getElementById("btn-isolate-file");
  if (!btn) {
    return;
  }
  const totalFiles = state.rawGraph
    ? state.rawGraph.nodes.filter((n) => n.type === "file").length
    : 0;
  if (!node || node.type !== "file" || totalFiles <= 1) {
    btn.classList.add("hidden");
    btn.classList.remove("active");
    return;
  }
  const isThisIsolated = state.isolatedFileId === node.id;
  btn.textContent = isThisIsolated ? "✕ Salir aislamiento" : "🎯 Aislar archivo";
  btn.classList.toggle("active", isThisIsolated);
  btn.classList.remove("hidden");
}

async function isolateFileById(fileId) {
  if (!fileId || !state.nodesById.has(fileId)) {
    return;
  }
  if (!state.isolatedFileId) {
    state.preIsolateCollapsedContainers = new Set(state.collapsedContainers);
  }
  state.isolatedFileId = fileId;

  // Abrir el archivo seleccionado y sus carpetas ancestro; colapsar los demás archivos con funciones.
  let cursor = state.nodesById.get(fileId);
  while (cursor) {
    state.collapsedContainers.delete(cursor.id);
    cursor = cursor.parent ? state.nodesById.get(cursor.parent) : null;
  }
  for (const node of state.rawGraph.nodes) {
    if (node.type === "file" && node.id !== fileId && countDescendantFunctions(node.id) > 0) {
      state.collapsedContainers.add(node.id);
    }
  }

  updateFileIsolationHud();
  await refreshGraphView({ fit: false });
  if (state.cy) {
    const targetEle = state.cy.getElementById(fileId);
    if (targetEle && targetEle.length > 0) {
      const focusEles = targetEle.union(targetEle.descendants());
      state.cy.animate({ fit: { eles: focusEles, padding: 52 } }, { duration: 220 });
    }
  }
  if (state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
    updateIsolateFileButton(state.nodesById.get(state.selectedNodeId));
  }
}

async function exitFileIsolation({ refresh = true } = {}) {
  if (!state.isolatedFileId) {
    return;
  }
  state.isolatedFileId = null;
  if (state.preIsolateCollapsedContainers) {
    state.collapsedContainers = new Set(state.preIsolateCollapsedContainers);
    state.preIsolateCollapsedContainers = null;
  } else {
    state.collapsedContainers.clear();
    if (state.activeLevel === 1) {
      collapseTopContainers();
    } else if (state.activeLevel === 2) {
      collapseAllFiles();
    }
  }
  updateFileIsolationHud();
  if (refresh) {
    await refreshGraphView({ fit: true });
  }
  if (state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
    updateIsolateFileButton(state.nodesById.get(state.selectedNodeId));
  }
}

async function toggleIsolateSelectedFile() {
  const fileId = resolveSelectedFileId();
  if (!fileId) {
    return;
  }
  if (state.isolatedFileId === fileId) {
    await exitFileIsolation();
  } else {
    await isolateFileById(fileId);
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

function addNodeWithAncestors(targetSet, nodeId) {
  let cursor = state.nodesById.get(nodeId);
  const guard = new Set();
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    targetSet.add(cursor.id);
    cursor = cursor.parent ? state.nodesById.get(cursor.parent) : null;
  }
}

function addVisibleDescendants(targetSet, containerId) {
  if (state.collapsedContainers.has(containerId)) {
    return;
  }
  const stack = [...(state.childrenByParent.get(containerId) || [])];
  while (stack.length > 0) {
    const child = stack.pop();
    targetSet.add(child.id);
    if (!state.collapsedContainers.has(child.id)) {
      const grandChildren = state.childrenByParent.get(child.id) || [];
      stack.push(...grandChildren);
    }
  }
}

function resolveEndpointByCollapse(nodeId) {
  let cursor = state.nodesById.get(nodeId);
  if (!cursor) {
    return null;
  }
  const chain = [];
  const seen = new Set();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor.id);
    cursor = cursor.parent ? state.nodesById.get(cursor.parent) : null;
  }
  // El ancestro colapsado más externo representa al nodo en la vista actual.
  for (let idx = chain.length - 1; idx >= 0; idx -= 1) {
    if (state.collapsedContainers.has(chain[idx])) {
      return chain[idx];
    }
  }
  return nodeId;
}

function computeSubgraphFilter() {
  if (!state.rawGraph) {
    return null;
  }

  if (state.isolateActiveContext && state.traceMode && state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
    const focusId = resolveEndpointByCollapse(state.selectedNodeId) || state.selectedNodeId;
    const allowedNodeIds = new Set();
    addNodeWithAncestors(allowedNodeIds, focusId);
    addVisibleDescendants(allowedNodeIds, focusId);

    const activeFlow = getActiveFlow();
    const activeFlowNodeSet = activeFlow ? new Set(activeFlow.node_ids || []) : null;

    for (const edge of state.rawGraph.edges) {
      if (
        isUtilityNodeHidden(edge.source, activeFlowNodeSet)
        || isUtilityNodeHidden(edge.target, activeFlowNodeSet)
      ) {
        continue;
      }
      const resolvedSrc = resolveEndpointByCollapse(edge.source);
      const resolvedTgt = resolveEndpointByCollapse(edge.target);
      if (!resolvedSrc || !resolvedTgt || resolvedSrc === resolvedTgt) {
        continue;
      }
      if (resolvedSrc === focusId || allowedNodeIds.has(resolvedSrc)) {
        addNodeWithAncestors(allowedNodeIds, resolvedTgt);
      }
      if (resolvedTgt === focusId || allowedNodeIds.has(resolvedTgt)) {
        addNodeWithAncestors(allowedNodeIds, resolvedSrc);
      }
    }
    return { allowedNodeIds, allowedRawEdgeIds: null, reason: "trace" };
  }

  if (state.isolateActiveContext && state.activeFlowId) {
    const flow = getActiveFlow();
    if (!flow) {
      return null;
    }
    const allowedNodeIds = new Set();
    for (const nodeId of flow.node_ids || []) {
      addNodeWithAncestors(allowedNodeIds, nodeId);
    }
    const allowedRawEdgeIds = new Set(flow.edge_ids || []);
    return { allowedNodeIds, allowedRawEdgeIds, reason: "flow" };
  }

  if (state.nhops.active) {
    return computeNHopsSubgraph();
  }

  return null;
}

function updateIsolateContextButtons() {
  const hasContext = Boolean(state.traceMode || state.activeFlowId);
  const isActive = hasContext && state.isolateActiveContext;

  const toolbarBtn = document.getElementById("btn-isolate-context");
  if (toolbarBtn) {
    toolbarBtn.classList.toggle("hidden", !hasContext);
    toolbarBtn.classList.toggle("active", isActive);
    toolbarBtn.textContent = isActive ? "✓ Aislado en lienzo" : "Aislar en lienzo";
  }

  const inspectorBtn = document.getElementById("btn-inspector-isolate-flow");
  if (inspectorBtn) {
    inspectorBtn.classList.toggle("active", Boolean(state.activeFlowId && state.isolateActiveContext));
    inspectorBtn.textContent = state.activeFlowId && state.isolateActiveContext ? "✓ Aislado" : "Aislar";
  }

  const traceBtn = document.getElementById("btn-trace-isolate");
  if (traceBtn) {
    traceBtn.classList.toggle("active", Boolean(state.traceMode && state.isolateActiveContext));
    traceBtn.textContent = state.traceMode && state.isolateActiveContext ? "✓ Aislado" : "Aislar";
  }
}

async function toggleIsolateActiveContext() {
  if (!state.traceMode && !state.activeFlowId) {
    return;
  }
  state.isolateActiveContext = !state.isolateActiveContext;
  updateIsolateContextButtons();
  await refreshGraphView({ fit: true });
  if (state.selectedNodeId && state.cy) {
    const cyNode = state.cy.getElementById(state.selectedNodeId);
    if (cyNode && cyNode.length > 0) {
      cyNode.select();
    }
  }
}

function toggleOnDemandEdges() {
  state.onDemandEdges = !state.onDemandEdges;
  const btn = document.getElementById("btn-on-demand-edges");
  if (btn) {
    btn.classList.toggle("active", state.onDemandEdges);
  }
  applyCanvasHighlights();
}

function buildLayerModeElements(subgraphFilter, activeFlowNodeSet, flowNodeOrder, flowEdgeOrder) {
  const visibleNodeIds = new Set();
  const hiddenNodeIds = new Set();
  const nodes = [];
  const layers = getArchLayers();
  const layerMap = new Map(layers.map((l) => [l.index, l]));
  const isFileTier = state.activeLevel <= 2;

  const directEdgeFileIds = new Set();
  for (const edge of state.rawGraph.edges) {
    const srcNode = state.nodesById.get(edge.source);
    const tgtNode = state.nodesById.get(edge.target);
    if (srcNode && srcNode.type === "file") directEdgeFileIds.add(srcNode.id);
    if (tgtNode && tgtNode.type === "file") directEdgeFileIds.add(tgtNode.id);
  }

  const membersByLayer = new Map();
  const fnCountByLayer = new Map();
  for (const layer of layers) {
    membersByLayer.set(layer.index, []);
    fnCountByLayer.set(layer.index, 0);
  }

  for (const rawNode of state.rawGraph.nodes) {
    if (rawNode.type === "module") {
      continue;
    }
    if (rawNode.type === "variable" && !state.showVariables) {
      hiddenNodeIds.add(rawNode.id);
      continue;
    }
    if (subgraphFilter && !subgraphFilter.allowedNodeIds.has(rawNode.id)) {
      continue;
    }
    if (isUtilityNodeHidden(rawNode.id, activeFlowNodeSet)) {
      hiddenNodeIds.add(rawNode.id);
      continue;
    }

    const layerIdx = getNodeArchLayer(rawNode);
    if (!membersByLayer.has(layerIdx)) {
      membersByLayer.set(layerIdx, []);
      fnCountByLayer.set(layerIdx, 0);
    }

    if (isFileTier) {
      if (rawNode.type === "file") {
        membersByLayer.get(layerIdx).push(rawNode);
        fnCountByLayer.set(layerIdx, fnCountByLayer.get(layerIdx) + Math.max(1, countDescendantFunctions(rawNode.id)));
      } else if (rawNode.type === "function" || rawNode.type === "variable") {
        // Si el usuario expandió manualmente un archivo en N2, mostramos sus hijos dentro del archivo.
        const parentFile = state.nodesById.get(rawNode.parent);
        if (parentFile && !state.collapsedContainers.has(parentFile.id)) {
          const parentLayer = getNodeArchLayer(parentFile);
          membersByLayer.get(parentLayer).push(rawNode);
        }
      }
    } else if (
      rawNode.type === "function"
      || rawNode.type === "variable"
      || (rawNode.type === "file" && directEdgeFileIds.has(rawNode.id))
    ) {
      membersByLayer.get(layerIdx).push(rawNode);
      if (rawNode.type === "function") {
        fnCountByLayer.set(layerIdx, fnCountByLayer.get(layerIdx) + 1);
      }
    }
  }

  for (const layer of layers) {
    const members = membersByLayer.get(layer.index) || [];
    if (members.length === 0) {
      continue;
    }
    const isLayerCollapsed = state.collapsedContainers.has(layer.id);
    const badgeCount = fnCountByLayer.get(layer.index) || members.length;
    const layerNote = getNoteEntry(layer.id);
    const isLayerPinned = !subgraphFilter && isPinnedInCurrentContext(layerNote);
    const baseLayerLabel = isLayerCollapsed
      ? `${layer.index} · ${layer.label} [+ ${badgeCount}]`
      : `${layer.index} · ${layer.label}`;
    const layerLabel = isLayerPinned ? `${baseLayerLabel} [📌]` : baseLayerLabel;

    visibleNodeIds.add(layer.id);
    nodes.push({
      data: {
        id: layer.id,
        parent: undefined,
        label: layerLabel,
        baseLabel: baseLayerLabel,
        type: "layer",
        role: "layer",
        layerIndex: layer.index,
        collapsed: isLayerCollapsed ? "true" : "false",
        expandedFn: "false",
        pinned: isLayerPinned ? "true" : "false",
        hasNote: layerNote.note && layerNote.note.trim() ? "true" : "false",
      },
    });

    if (isLayerCollapsed) {
      continue;
    }

    for (const rawNode of members) {
      const noteEntry = getNoteEntry(rawNode.id);
      const isCollapsed = rawNode.type === "file" && state.collapsedContainers.has(rawNode.id);
      const isExpandedFn = rawNode.type === "function" && state.expandedFunctions.has(rawNode.id);
      const effectiveRole = noteEntry.custom_role || rawNode.role || rawNode.type;
      const stepOrder = flowNodeOrder.get(rawNode.id) || null;
      const isPinnedHere = !subgraphFilter && isPinnedInCurrentContext(noteEntry);

      let parentId = layer.id;
      if (isFileTier && (rawNode.type === "function" || rawNode.type === "variable") && visibleNodeIds.has(rawNode.parent)) {
        parentId = rawNode.parent;
      }

      let displayLabel = buildDisplayLabel(
        rawNode,
        isCollapsed,
        noteEntry,
        effectiveRole,
        stepOrder,
        activeFlowNodeSet,
      );
      if (!isFileTier && (rawNode.type === "function" || rawNode.type === "variable") && rawNode.parent) {
        const fileBase = rawNode.parent.split("/").pop() || rawNode.parent;
        displayLabel = `${fileBase} :: ${displayLabel}`;
      }

      visibleNodeIds.add(rawNode.id);
      nodes.push({
        data: {
          id: rawNode.id,
          parent: parentId,
          label: displayLabel,
          type: rawNode.type,
          role: effectiveRole,
          varKind: rawNode.var_kind || "constant",
          entryKind: rawNode.entry_kind || "",
          fileLang: rawNode.language || "",
          mainEntry: rawNode.is_main_entry ? "true" : "false",
          terminal: rawNode.type === "function" && rawNode.is_terminal ? "true" : "false",
          pinned: isPinnedHere ? "true" : "false",
          hasNote: noteEntry.note && noteEntry.note.trim() ? "true" : "false",
          collapsed: isCollapsed ? "true" : "false",
          expandedFn: isExpandedFn ? "true" : "false",
          flowStepOrder: stepOrder || 0,
          line: rawNode.line || 0,
          archLayer: getNodeArchLayer(rawNode),
        },
      });

      if (isExpandedFn) {
        appendInternalFlowElements(rawNode, nodes, visibleNodeIds, { ignorePins: Boolean(subgraphFilter) });
      }
    }
  }

  const edges = projectEdges(
    visibleNodeIds,
    hiddenNodeIds,
    flowEdgeOrder,
    subgraphFilter ? subgraphFilter.allowedRawEdgeIds : null,
  );
  appendInternalFlowEdges(nodes, edges, visibleNodeIds);

  return { nodes, edges };
}

function buildVisibleElements() {
  const { flow: activeFlow, nodeOrder: flowNodeOrder, edgeOrder: flowEdgeOrder } = getActiveFlowStepMaps();
  const activeFlowNodeSet = activeFlow ? new Set(activeFlow.node_ids || []) : null;
  const subgraphFilter = computeSubgraphFilter();

  if (state.groupingMode === "layers") {
    return buildLayerModeElements(subgraphFilter, activeFlowNodeSet, flowNodeOrder, flowEdgeOrder);
  }

  const visibleNodeIds = new Set();
  const hiddenNodeIds = new Set();
  const nodes = [];

  for (const rawNode of state.rawGraph.nodes) {
    if (rawNode.type === "variable" && !state.showVariables) {
      hiddenNodeIds.add(rawNode.id);
      continue;
    }
    if (subgraphFilter && !subgraphFilter.allowedNodeIds.has(rawNode.id)) {
      continue;
    }
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
    const isPinnedHere = !subgraphFilter && isPinnedInCurrentContext(noteEntry);

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
        varKind: rawNode.var_kind || "constant",
        entryKind: rawNode.entry_kind || "",
        fileLang: rawNode.language || "",
        mainEntry: rawNode.is_main_entry ? "true" : "false",
        terminal: rawNode.type === "function" && rawNode.is_terminal ? "true" : "false",
        pinned: isPinnedHere ? "true" : "false",
        hasNote: noteEntry.note && noteEntry.note.trim() ? "true" : "false",
        collapsed: isCollapsed ? "true" : "false",
        expandedFn: isExpandedFn ? "true" : "false",
        flowStepOrder: stepOrder || 0,
        line: rawNode.line || 0,
        archLayer: getNodeArchLayer(rawNode),
      },
    });

    if (isExpandedFn) {
      appendInternalFlowElements(rawNode, nodes, visibleNodeIds, { ignorePins: Boolean(subgraphFilter) });
    }
  }

  const edges = projectEdges(
    visibleNodeIds,
    hiddenNodeIds,
    flowEdgeOrder,
    subgraphFilter ? subgraphFilter.allowedRawEdgeIds : null,
  );
  appendInternalFlowEdges(nodes, edges, visibleNodeIds);

  return { nodes, edges };
}

function estimateFlowStepSize(role, kind, label) {
  if (kind === "merge") {
    return { width: 68, height: 36, innerWidth: 58, innerHeight: 26 };
  }

  const maxTextWidth = role === "decision" ? 185 : 265;
  const maxCharsFallback = role === "decision" ? 25 : 35;

  const measureWrapped = (text, maxPx, maxChars) => {
    const rawText = String(text || "");
    if (typeof document !== "undefined" && typeof document.createElement === "function") {
      if (!estimateFlowStepSize._measureCtx) {
        const c = document.createElement("canvas");
        const ctx = c && c.getContext ? c.getContext("2d") : null;
        if (ctx) {
          ctx.font = '11px "Helvetica Neue", Helvetica, Arial, sans-serif';
          estimateFlowStepSize._measureCtx = ctx;
        }
      }
      const ctx = estimateFlowStepSize._measureCtx;
      if (ctx) {
        let lineCount = 0;
        let maxLineW = 0;
        for (const para of rawText.split("\n")) {
          const trimmed = para.trim();
          if (!trimmed) {
            lineCount += 1;
            continue;
          }
          const words = trimmed.split(/\s+/);
          let curLine = "";
          for (const word of words) {
            const candidate = curLine ? `${curLine} ${word}` : word;
            const w = ctx.measureText(candidate).width;
            if (curLine && w > maxPx) {
              maxLineW = Math.max(maxLineW, ctx.measureText(curLine).width);
              lineCount += 1;
              curLine = word;
            } else {
              curLine = candidate;
            }
          }
          if (curLine) {
            const finalW = ctx.measureText(curLine).width;
            if (finalW > maxPx) {
              const chunks = Math.max(1, Math.ceil(finalW / maxPx));
              lineCount += chunks;
              maxLineW = Math.max(maxLineW, maxPx);
            } else {
              lineCount += 1;
              maxLineW = Math.max(maxLineW, finalW);
            }
          }
        }
        return { lineCount: Math.max(1, lineCount), maxLineW };
      }
    }
    const { lineCount, longestLine } = estimateWrappedTextMetrics(rawText, maxChars);
    return { lineCount, maxLineW: Math.min(maxPx, longestLine * 7.2) };
  };

  const { lineCount, maxLineW } = measureWrapped(label, maxTextWidth, maxCharsFallback);

  if (role === "decision") {
    const textW = Math.max(78, Math.min(maxTextWidth, Math.ceil(maxLineW)));
    const textH = Math.max(16, Math.ceil(lineCount * 14.5));
    // En round-diamond el texto cabe dentro del rombo si textW/W + textH/H <= 1.
    // El stylesheet aplica padding 0 y border-width 2, por lo que outer = inner + 2.
    const innerWidth = Math.max(150, Math.min(340, Math.round(textW * 1.85 + 44)));
    const innerHeight = Math.max(76, Math.min(180, Math.round(textH * 1.9 + 38)));
    return {
      width: innerWidth + 2,
      height: innerHeight + 2,
      innerWidth,
      innerHeight,
    };
  }

  const borderW = role === "entry" ? 2.5 : 2;
  const padTotal = 24;
  let innerWidth = Math.max(114, Math.min(272, Math.ceil(maxLineW + 14)));
  let innerHeight = Math.max(24, Math.ceil(lineCount * 15 + 8));
  if (role === "entry") {
    innerWidth = Math.max(128, Math.min(284, Math.ceil(maxLineW * 1.18 + 20)));
    innerHeight = Math.max(30, Math.ceil(lineCount * 15 + 14));
  } else if (role === "io") {
    innerHeight = Math.max(28, Math.ceil(lineCount * 15 + 12));
  }
  return {
    width: Math.ceil(innerWidth + padTotal + borderW),
    height: Math.ceil(innerHeight + padTotal + borderW),
    innerWidth,
    innerHeight,
  };
}

function appendInternalFlowElements(fnNode, nodes, visibleNodeIds, options) {
  const ignorePins = Boolean(options && options.ignorePins);
  const canCheckPins = !ignorePins
    && typeof getNoteEntry === "function"
    && typeof isPinnedInCurrentContext === "function";
  const flowSteps = fnNode.internal_flow || [];
  const stepIds = new Set(flowSteps.map((step) => step.id));
  for (const step of flowSteps) {
    const stepId = `${fnNode.id}::${step.id}`;
    const parentNodeId = step.parent_id && stepIds.has(step.parent_id)
      ? `${fnNode.id}::${step.parent_id}`
      : fnNode.id;
    visibleNodeIds.add(stepId);
    const stepKind = step.kind || "step";
    const baseLabel = stepKind === "merge"
      ? (step.label || "fin")
      : (step.role === "entry" && step.label.startsWith("in:")
          ? `ENTRADA\n${step.label}`
          : step.label);
    const noteEntry = canCheckPins ? getNoteEntry(stepId) : null;
    const isPinnedHere = Boolean(noteEntry && isPinnedInCurrentContext(noteEntry));
    const displayLabel = isPinnedHere ? `${baseLabel} [📌]` : baseLabel;
    const stepSize = estimateFlowStepSize(step.role, stepKind, baseLabel);
    nodes.push({
      data: {
        id: stepId,
        parent: parentNodeId,
        label: displayLabel,
        baseLabel,
        type: "flow",
        role: step.role,
        flowKind: stepKind,
        flowContainer: step.is_container ? "true" : "false",
        nodeWidth: stepSize.innerWidth,
        nodeHeight: stepSize.innerHeight,
        elkWidth: stepSize.width,
        elkHeight: stepSize.height,
        flowEdges: Array.isArray(step.edges) ? step.edges : null,
        pinned: isPinnedHere ? "true" : "false",
        hasNote: noteEntry && noteEntry.note && noteEntry.note.trim() ? "true" : "false",
        collapsed: "false",
        expandedFn: "false",
        ownerFunctionId: fnNode.id,
        stepId: step.id,
        stepCode: step.code || step.label,
        stepLine: step.line || 0,
        stepEndLine: step.end_line || step.line || 0,
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
  if (visibleNodeIds.has(nodeId)) {
    return nodeId;
  }
  if (state.groupingMode === "layers") {
    const raw = state.nodesById.get(nodeId);
    if (!raw) {
      return null;
    }
    if (raw.type === "function" && raw.parent && visibleNodeIds.has(raw.parent)) {
      return raw.parent;
    }
    const ownLayerId = `layer::${getNodeArchLayer(raw)}`;
    if (visibleNodeIds.has(ownLayerId)) {
      return ownLayerId;
    }
    if (raw.type === "function" && raw.parent) {
      const parentFile = state.nodesById.get(raw.parent);
      if (parentFile) {
        const parentLayerId = `layer::${getNodeArchLayer(parentFile)}`;
        if (visibleNodeIds.has(parentLayerId)) {
          return parentLayerId;
        }
      }
    }
    return null;
  }
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

function projectEdges(
  visibleNodeIds,
  hiddenNodeIds = new Set(),
  flowEdgeOrder = new Map(),
  allowedRawEdgeIds = null,
) {
  const grouped = new Map();

  for (const edge of state.rawGraph.edges) {
    if (!state.showVariables && edge.edge_type === "reads_var") {
      continue;
    }
    if (allowedRawEdgeIds && !allowedRawEdgeIds.has(edge.id)) {
      continue;
    }
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
    minZoom: MAIN_MIN_ZOOM,
    maxZoom: MAIN_MAX_ZOOM,
  });

  state.cy.on("tap", "node", async (event) => {
    if (state.suppressNextTap) {
      return;
    }
    clearActiveFloatingWindowFocus();
    const data = event.target.data();
    const targetId = data.ownerFunctionId || data.id;
    const stepId = data.type === "flow" ? (data.stepId || null) : null;
    const prevSelected = state.selectedNodeId;
    selectNode(targetId, stepId);
    if (state.traceMode) {
      state.traceDirection = "forward";
      state.traceBranchIndex = 0;
      if (state.isolateActiveContext && prevSelected !== targetId) {
        await refreshGraphView({ fit: true });
        const reselected = state.cy.getElementById(targetId);
        if (reselected && reselected.length > 0) {
          reselected.select();
        }
        return;
      }
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
      hideNodeTooltip();
      if (!state.traceMode && state.selectedNodeId) {
        state.cy.nodes().unselect();
        clearSelectionPanel();
      }
      if (state.traceMode || state.activeFlowId || state.onDemandEdges) {
        applyCanvasHighlights();
      }
    }
  });

  state.cy.on("mouseover", "node", (event) => {
    const data = event.target.data();
    const anchorId = data.ownerFunctionId || data.id;
    if (state.hoveredNodeId !== anchorId) {
      state.hoveredNodeId = anchorId;
      if (state.onDemandEdges) {
        applyOnDemandEdgeHighlight();
      }
      if (state.expandedFunctions.size >= 2) {
        applyIntraMultiFunctionClarity();
      }
    }
  });

  state.cy.on("mouseout", "node", () => {
    if (state.hoveredNodeId !== null) {
      state.hoveredNodeId = null;
      if (state.onDemandEdges) {
        applyOnDemandEdgeHighlight();
      }
      if (state.expandedFunctions.size >= 2) {
        applyIntraMultiFunctionClarity();
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

  // Anclaje estricto por ámbito: un clic de 0 px nunca suelta `.elk-routed` ni fija el nodo;
  // solo tras desplazamiento real (>= DRAG_MOVE_THRESHOLD_PX) se sueltan y re-enrutan sus aristas externas.
  state.cy.on("grab", "node", (event) => {
    handleNodeGrab(event.target);
  });

  state.cy.on("drag", "node", () => {
    handleNodeDrag();
  });

  state.cy.on("free", "node", (event) => {
    handleNodeFree(event.target);
  });

  state.cy.on("dragfree", "node", (event) => {
    scheduleNodeDragFree(event.target);
  });

  let selectionUpdateScheduled = false;
  state.cy.on("select unselect", "node", () => {
    if (selectionUpdateScheduled) {
      return;
    }
    selectionUpdateScheduled = true;
    queueMicrotask(() => {
      selectionUpdateScheduled = false;
      updateReleasePinnedButton();
    });
  });

  bindEdgeTooltipEvents();
  state.mainTooltipCleanup = bindNodeDocstringTooltip(state.cy, document.getElementById("canvas-area"));
  bindCanvasPanControls();
  if (state.mainBgPanCleanup) {
    state.mainBgPanCleanup();
    state.mainBgPanCleanup = null;
  }
  state.mainBgPanCleanup = attachManualBackgroundPanDetector(state.cy);
  state.cy.on("zoom", () => {
    updateZoomIndicator();
    applyIntraZoomReadability();
  });
  state.cy.on("pan zoom resize", () => {
    if (state.walkthrough) {
      state.walkthrough.onViewportChanged();
    }
  });
}

const NODE_TOOLTIP_DELAY_MS = 1000;

function hideNodeTooltip() {
  if (state.nodeTooltipTimer) {
    clearTimeout(state.nodeTooltipTimer);
    state.nodeTooltipTimer = null;
  }
  state.nodeTooltipTargetId = null;
  state.nodeTooltipPos = null;
  state.nodeTooltipContainerEl = null;
  const tip = document.getElementById("node-tooltip");
  if (tip) {
    tip.classList.add("hidden");
  }
}

function resolveTooltipNode(cyNode) {
  if (!cyNode || typeof cyNode.data !== "function") {
    return null;
  }
  const data = cyNode.data();
  if (data.type !== "function" && data.type !== "file" && data.type !== "variable") {
    return null;
  }
  const raw = state.nodesById.get(data.id);
  if (!raw || (raw.type !== "function" && raw.type !== "file" && raw.type !== "variable")) {
    return null;
  }
  const doc = (raw.docstring || "").trim();
  const preview = raw.type === "variable" ? (raw.value_preview || "").trim() : "";
  if (!doc && !preview) {
    return null;
  }
  return raw;
}

function showNodeTooltip(rawNode, renderedPos, containerEl = null) {
  const tip = document.getElementById("node-tooltip");
  const area = document.getElementById("canvas-area");
  if (!tip || !area || !rawNode) {
    return;
  }
  const doc = (rawNode.docstring || "").trim();
  const preview = rawNode.type === "variable" ? (rawNode.value_preview || "").trim() : "";
  const bodyText = doc && preview
    ? `${doc}\n\n= ${preview}`
    : (doc || (preview ? `= ${preview}` : ""));
  if (!bodyText) {
    hideNodeTooltip();
    return;
  }

  hideEdgeTooltip();
  let kindLabel = "Función";
  if (rawNode.type === "file") {
    kindLabel = "Archivo";
  } else if (rawNode.type === "variable") {
    kindLabel = rawNode.var_kind === "variable" ? "Variable" : "Constante";
  }
  tip.innerHTML = `
    <div class="node-tooltip-header">
      <span class="node-tooltip-kind">${escapeHtml(kindLabel)}</span>
      <span class="node-tooltip-title">${escapeHtml(rawNode.label || rawNode.id)}</span>
    </div>
    <div class="node-tooltip-body">${escapeHtml(bodyText)}</div>
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

function bindNodeDocstringTooltip(cyInst, containerEl) {
  if (!cyInst) {
    return () => {};
  }

  const onNodeMouseOver = (event) => {
    const raw = resolveTooltipNode(event.target);
    if (!raw) {
      hideNodeTooltip();
      return;
    }
    state.nodeTooltipPos = event.renderedPosition || state.nodeTooltipPos;
    state.nodeTooltipContainerEl = containerEl;
    if (state.nodeTooltipTargetId === raw.id) {
      return;
    }
    hideNodeTooltip();
    state.nodeTooltipTargetId = raw.id;
    state.nodeTooltipPos = event.renderedPosition || { x: 20, y: 20 };
    state.nodeTooltipContainerEl = containerEl;
    const expectedId = raw.id;
    state.nodeTooltipTimer = setTimeout(() => {
      state.nodeTooltipTimer = null;
      if (state.nodeTooltipTargetId !== expectedId) {
        return;
      }
      showNodeTooltip(raw, state.nodeTooltipPos, state.nodeTooltipContainerEl);
    }, NODE_TOOLTIP_DELAY_MS);
  };

  const onNodeMouseMove = (event) => {
    if (!state.nodeTooltipTargetId) {
      return;
    }
    const raw = resolveTooltipNode(event.target);
    if (raw && raw.id === state.nodeTooltipTargetId) {
      state.nodeTooltipPos = event.renderedPosition || state.nodeTooltipPos;
    }
  };

  const cancelTooltip = () => {
    hideNodeTooltip();
  };

  cyInst.on("mouseover", "node", onNodeMouseOver);
  cyInst.on("mousemove", "node", onNodeMouseMove);
  cyInst.on("mouseout", "node", cancelTooltip);
  cyInst.on("tap dbltap grab drag pan zoom", cancelTooltip);
  cyInst.on("mouseover", "edge", cancelTooltip);

  const cyDom = typeof cyInst.container === "function" ? cyInst.container() : null;
  if (cyDom) {
    cyDom.addEventListener("mouseleave", cancelTooltip);
    cyDom.addEventListener("mousedown", cancelTooltip, true);
  }

  return () => {
    if (state.nodeTooltipContainerEl === containerEl) {
      hideNodeTooltip();
    }
    if (cyDom) {
      cyDom.removeEventListener("mouseleave", cancelTooltip);
      cyDom.removeEventListener("mousedown", cancelTooltip, true);
    }
    if (cyInst && typeof cyInst.off === "function") {
      try {
        cyInst.off("mouseover", "node", onNodeMouseOver);
        cyInst.off("mousemove", "node", onNodeMouseMove);
        cyInst.off("mouseout", "node", cancelTooltip);
        cyInst.off("tap dbltap grab drag pan zoom", cancelTooltip);
        cyInst.off("mouseover", "edge", cancelTooltip);
      } catch (_err) {
        // Ignorar si Cytoscape ya fue destruido.
      }
    }
  };
}

function hideEdgeTooltip() {
  const tip = document.getElementById("edge-tooltip");
  if (tip) {
    tip.classList.add("hidden");
  }
}

function showEdgeTooltip(cyEdge, renderedPos, containerEl = null) {
  hideNodeTooltip();
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

const DRAG_MOVE_THRESHOLD_PX = 3;
let _activeDragState = null;
let _pendingDragFreeNodes = new Map();
let _dragFreeFlushScheduled = false;

function filterOutermostDraggedNodes(cyNodes) {
  const unique = [];
  const seen = new Set();
  for (const node of cyNodes || []) {
    if (!node || typeof node.id !== "function") {
      continue;
    }
    const id = node.id();
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(node);
    }
  }
  const idSet = new Set(unique.map((n) => n.id()));
  return unique.filter((node) => {
    let cur = typeof node.parent === "function" ? node.parent() : null;
    while (cur && cur.length > 0) {
      if (idSet.has(cur.id())) {
        return false;
      }
      cur = cur.parent();
    }
    return true;
  });
}

function collectScopeAndExternalEdges(cy, outermostNodes) {
  const scopeIds = new Set();
  for (const node of outermostNodes || []) {
    if (!node || node.length === 0) {
      continue;
    }
    scopeIds.add(node.id());
    if (node.isParent()) {
      node.descendants().forEach((desc) => {
        scopeIds.add(desc.id());
      });
    }
  }
  const externalEdges = [];
  if (cy && scopeIds.size > 0) {
    cy.edges().forEach((edge) => {
      if (edge.isLoop()) {
        return;
      }
      const srcIn = scopeIds.has(edge.source().id());
      const tgtIn = scopeIds.has(edge.target().id());
      if (srcIn !== tgtIn) {
        externalEdges.push(edge);
      }
    });
  }
  return { scopeIds, externalEdges };
}

function computeDynamicTaxiDirection(srcPos, tgtPos) {
  if (!srcPos || !tgtPos) {
    return "downward";
  }
  const dx = tgtPos.x - srcPos.x;
  const dy = tgtPos.y - srcPos.y;
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy >= 0 ? "downward" : "upward";
  }
  return dx >= 0 ? "rightward" : "leftward";
}

function captureDragStartPositions(outermost) {
  const positions = new Map();
  const record = (node) => {
    if (!node || node.length === 0 || node.removed()) {
      return;
    }
    const pos = node.position();
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      positions.set(node.id(), { x: pos.x, y: pos.y, isParent: node.isParent() });
    }
  };
  for (const node of outermost || []) {
    record(node);
    if (node && typeof node.isParent === "function" && node.isParent()) {
      node.descendants().forEach((desc) => {
        if (!desc.isParent()) {
          record(desc);
        }
      });
    }
  }
  return positions;
}

function computeMaxDragDisplacement(cy, startPositions) {
  if (!cy || !startPositions || startPositions.size === 0) {
    return 0;
  }
  let maxDisp = 0;
  for (const [id, orig] of startPositions.entries()) {
    const node = cy.getElementById(id);
    if (!node || node.length === 0 || node.removed()) {
      continue;
    }
    const pos = node.position();
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      continue;
    }
    const dist = Math.hypot(pos.x - orig.x, pos.y - orig.y);
    if (dist > maxDisp) {
      maxDisp = dist;
    }
  }
  return maxDisp;
}

function handleNodeGrab(cyNode) {
  if (!state.cy || !cyNode || cyNode.length === 0) {
    _activeDragState = null;
    return;
  }
  const grabbed = state.cy.nodes(":grabbed");
  const candidates = grabbed.length > 0 ? grabbed.union(cyNode).toArray() : [cyNode];
  const outermost = filterOutermostDraggedNodes(candidates);
  const { externalEdges } = collectScopeAndExternalEdges(state.cy, outermost);
  const startPositions = captureDragStartPositions(outermost);

  // Nunca tocar `.elk-routed` ni los endpoints al pulsar `mousedown` (evita degradar aristas en clics de 0 px).
  _activeDragState = {
    outermost,
    externalEdges,
    startPositions,
    detached: false,
  };
}

function handleNodeDrag() {
  if (!state.cy || !_activeDragState) {
    return;
  }
  if (!_activeDragState.detached) {
    const moved = computeMaxDragDisplacement(state.cy, _activeDragState.startPositions);
    if (moved < DRAG_MOVE_THRESHOLD_PX) {
      return;
    }
    _activeDragState.detached = true;
    // Solo tras superar el umbral de arrastre real las aristas externas pasan temporalmente a `taxi`.
    if (_activeDragState.externalEdges.length > 0) {
      state.cy.batch(() => {
        for (const edge of _activeDragState.externalEdges) {
          if (!edge || edge.removed()) {
            continue;
          }
          edge.removeClass("elk-routed");
          edge.removeData("srcEndpoint tgtEndpoint");
          edge.data("taxiDir", computeDynamicTaxiDirection(edge.source().position(), edge.target().position()));
        }
      });
    }
  }

  for (const edge of _activeDragState.externalEdges) {
    if (!edge || edge.removed()) {
      continue;
    }
    const src = edge.source();
    const tgt = edge.target();
    if (src.isParent() && typeof src.updateCompoundBounds === "function") {
      src.updateCompoundBounds(true);
    }
    if (tgt.isParent() && typeof tgt.updateCompoundBounds === "function") {
      tgt.updateCompoundBounds(true);
    }
    edge.data("taxiDir", computeDynamicTaxiDirection(src.position(), tgt.position()));
  }
}

function handleNodeFree(_cyNode) {
  // En clics de 0 px Cytoscape emite `grab` -> `free` -> `tap` sin `dragfree`.
  if (_activeDragState && !_activeDragState.detached) {
    const dragRef = _activeDragState;
    queueMicrotask(() => {
      if (_activeDragState === dragRef && !_dragFreeFlushScheduled && !dragRef.detached) {
        _activeDragState = null;
      }
    });
  }
}

function scheduleNodeDragFree(cyNode) {
  if (!cyNode || cyNode.length === 0) {
    return;
  }
  _pendingDragFreeNodes.set(cyNode.id(), cyNode);
  if (_dragFreeFlushScheduled) {
    return;
  }
  _dragFreeFlushScheduled = true;
  queueMicrotask(async () => {
    _dragFreeFlushScheduled = false;
    const batchNodes = Array.from(_pendingDragFreeNodes.values());
    _pendingDragFreeNodes.clear();
    await handleNodeDragFreeBatch(batchNodes);
  });
}

function rerouteExternalEdgesLocally(cy, edges) {
  if (!cy || !edges) {
    return 0;
  }
  const edgeList = Array.isArray(edges) ? edges : edges.toArray();
  if (edgeList.length === 0) {
    return 0;
  }

  const parentNodes = cy.nodes(":parent");
  if (parentNodes.length > 0 && typeof parentNodes.updateCompoundBounds === "function") {
    parentNodes.updateCompoundBounds(true);
  }

  // Obstáculos reales en Niveles 1, 2, 3 y 3+: hojas visibles + contenedores compuestos hermanos.
  const obstacleBoxes = [];
  cy.nodes().forEach((n) => {
    if (!n.visible()) {
      return;
    }
    const pos = n.position();
    const ow = n.outerWidth();
    const oh = n.outerHeight();
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      return;
    }
    const hw = (Number.isFinite(ow) && ow > 2 ? ow : 140) / 2;
    const hh = (Number.isFinite(oh) && oh > 2 ? oh : 44) / 2;
    obstacleBoxes.push({
      id: n.id(),
      isParent: n.isParent(),
      left: pos.x - hw,
      right: pos.x + hw,
      top: pos.y - hh,
      bottom: pos.y + hh,
      cx: pos.x,
      cy: pos.y,
      hw,
      hh,
    });
  });

  const getNodeGeom = (cyNode) => {
    if (!cyNode || cyNode.length === 0) {
      return null;
    }
    const pos = cyNode.position();
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      return null;
    }
    const ow = cyNode.outerWidth();
    const oh = cyNode.outerHeight();
    const hw = (Number.isFinite(ow) && ow > 2 ? ow : 140) / 2;
    const hh = (Number.isFinite(oh) && oh > 2 ? oh : 44) / 2;
    return {
      id: cyNode.id(),
      cx: pos.x,
      cy: pos.y,
      hw,
      hh,
      left: pos.x - hw,
      right: pos.x + hw,
      top: pos.y - hh,
      bottom: pos.y + hh,
      shape: String(cyNode.style("shape") || "round-rectangle"),
      isParent: cyNode.isParent(),
    };
  };

  const clampVal = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round1 = (v) => Math.round(v * 10) / 10;

  const projectBorder = (pt, refPt, geom) => {
    const segDx = refPt.x - pt.x;
    const segDy = refPt.y - pt.y;
    let dx = 0;
    let dy = 0;
    if (Math.abs(segDx) <= 1.5 && Math.abs(segDy) > 0.5) {
      const dirY = segDy >= 0 ? 1 : -1;
      dx = clampVal(pt.x - geom.cx, -geom.hw + 1, geom.hw - 1);
      if (geom.shape === "round-diamond" || geom.shape === "diamond") {
        const frac = Math.min(0.96, Math.abs(dx) / Math.max(1, geom.hw));
        dy = dirY * geom.hh * (1 - frac);
      } else if (geom.shape === "ellipse") {
        const frac = Math.min(0.98, Math.abs(dx) / Math.max(1, geom.hw));
        dy = dirY * geom.hh * Math.sqrt(Math.max(0.04, 1 - frac * frac));
      } else {
        dy = dirY * geom.hh;
      }
    } else if (Math.abs(segDy) <= 1.5 && Math.abs(segDx) > 0.5) {
      const dirX = segDx >= 0 ? 1 : -1;
      dy = clampVal(pt.y - geom.cy, -geom.hh + 1, geom.hh - 1);
      if (geom.shape === "round-diamond" || geom.shape === "diamond") {
        const frac = Math.min(0.96, Math.abs(dy) / Math.max(1, geom.hh));
        dx = dirX * geom.hw * (1 - frac);
      } else if (geom.shape === "ellipse") {
        const frac = Math.min(0.98, Math.abs(dy) / Math.max(1, geom.hh));
        dx = dirX * geom.hw * Math.sqrt(Math.max(0.04, 1 - frac * frac));
      } else {
        dx = dirX * geom.hw;
      }
    } else {
      const rx = refPt.x - geom.cx;
      const ry = refPt.y - geom.cy;
      const denom = Math.max(Math.abs(rx) / Math.max(1, geom.hw), Math.abs(ry) / Math.max(1, geom.hh));
      const t = denom > 0 ? 1 / denom : 0;
      dx = rx * t;
      dy = ry * t;
    }
    const rdx = round1(dx);
    const rdy = round1(dy);
    return { x: geom.cx + rdx, y: geom.cy + rdy, endpointStr: `${rdx}px ${rdy}px` };
  };

  const buildIgnoreSet = (srcNode, tgtNode) => {
    const ignore = new Set([srcNode.id(), tgtNode.id()]);
    if (srcNode.isParent()) {
      srcNode.descendants().forEach((d) => ignore.add(d.id()));
    }
    if (tgtNode.isParent()) {
      tgtNode.descendants().forEach((d) => ignore.add(d.id()));
    }
    srcNode.ancestors().forEach((a) => ignore.add(a.id()));
    tgtNode.ancestors().forEach((a) => ignore.add(a.id()));
    return ignore;
  };

  const vSegBlocked = (x, y1, y2, ignore, pad = 6) => {
    const top = Math.min(y1, y2);
    const bot = Math.max(y1, y2);
    if (bot - top < 1) {
      return false;
    }
    return obstacleBoxes.some(
      (b) => !ignore.has(b.id)
        && x > b.left - pad
        && x < b.right + pad
        && bot > b.top - pad
        && top < b.bottom + pad,
    );
  };

  const hSegBlocked = (y, x1, x2, ignore, pad = 6) => {
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    if (right - left < 1) {
      return false;
    }
    return obstacleBoxes.some(
      (b) => !ignore.has(b.id)
        && y > b.top - pad
        && y < b.bottom + pad
        && right > b.left - pad
        && left < b.right + pad,
    );
  };

  const clearRoute = (cyEdge) => {
    cyEdge.removeClass("elk-routed");
    cyEdge.removeData("srcEndpoint tgtEndpoint");
  };

  // Pasada 1: clasificar cada arista y preparar distribución ordenada de puertos en origen y destino.
  const specs = [];
  const portGroups = new Map();
  const addToPortGroup = (nodeId, side, entry) => {
    const key = `${nodeId}::${side}`;
    if (!portGroups.has(key)) {
      portGroups.set(key, []);
    }
    portGroups.get(key).push(entry);
  };

  for (const cyEdge of edgeList) {
    if (!cyEdge || cyEdge.removed()) {
      continue;
    }
    const srcNode = cyEdge.source();
    const tgtNode = cyEdge.target();
    if (
      cyEdge.isLoop()
      || srcNode.ancestors().anySame(tgtNode)
      || tgtNode.ancestors().anySame(srcNode)
    ) {
      specs.push({ cyEdge, skip: true });
      continue;
    }
    const srcG = getNodeGeom(srcNode);
    const tgtG = getNodeGeom(tgtNode);
    if (!srcG || !tgtG) {
      specs.push({ cyEdge, skip: true });
      continue;
    }
    const vGap = Math.max(tgtG.top - srcG.bottom, srcG.top - tgtG.bottom);
    const hGap = Math.max(tgtG.left - srcG.right, srcG.left - tgtG.right);
    if (vGap < 4 && hGap < 4) {
      specs.push({ cyEdge, skip: true, srcG, tgtG });
      continue;
    }

    const dxCenter = tgtG.cx - srcG.cx;
    const dyCenter = tgtG.cy - srcG.cy;
    const useVertical = vGap >= 12 && (hGap < 12 || Math.abs(dyCenter) >= Math.abs(dxCenter) * 0.65);
    const exitSide = useVertical
      ? (dyCenter >= 0 ? "bottom" : "top")
      : (dxCenter >= 0 ? "right" : "left");
    const entrySide = useVertical
      ? (dyCenter >= 0 ? "top" : "bottom")
      : (dxCenter >= 0 ? "left" : "right");

    const spec = {
      cyEdge,
      skip: false,
      srcNode,
      tgtNode,
      srcG,
      tgtG,
      vGap,
      hGap,
      dxCenter,
      dyCenter,
      useVertical,
      exitSide,
      entrySide,
      srcPortOffset: 0,
      tgtPortOffset: 0,
      laneIndex: 0,
    };
    specs.push(spec);
    addToPortGroup(srcG.id, exitSide, {
      spec,
      isSource: true,
      sortCoord: useVertical ? tgtG.cx : tgtG.cy,
      otherId: tgtG.id,
      halfSpan: useVertical ? srcG.hw : srcG.hh,
    });
    addToPortGroup(tgtG.id, entrySide, {
      spec,
      isSource: false,
      sortCoord: useVertical ? srcG.cx : srcG.cy,
      otherId: srcG.id,
      halfSpan: useVertical ? tgtG.hw : tgtG.hh,
    });
  }

  // Distribuir los puertos de cada cara en orden espacial para evitar cruces locales al salir/entrar.
  for (const group of portGroups.values()) {
    group.sort((a, b) => (a.sortCoord - b.sortCoord) || a.otherId.localeCompare(b.otherId));
    const count = group.length;
    if (count <= 1) {
      continue;
    }
    for (let i = 0; i < count; i += 1) {
      const item = group[i];
      const maxSpread = Math.max(0, item.halfSpan * 0.72 - 6);
      const step = Math.min(16, (2 * maxSpread) / Math.max(1, count - 1));
      const offset = (i - (count - 1) / 2) * step;
      if (item.isSource) {
        item.spec.srcPortOffset = offset;
        item.spec.laneIndex = i - (count - 1) / 2;
      } else {
        item.spec.tgtPortOffset = offset;
      }
    }
  }

  // Canales usados para separar corredores paralelos sin solapamiento.
  const usedHChannels = [];
  const usedVChannels = [];
  const CHANNEL_SEP = 12;

  const hChannelBusy = (y, x1, x2) => {
    const lo = Math.min(x1, x2);
    const hi = Math.max(x1, x2);
    return usedHChannels.some((ch) => Math.abs(ch.y - y) < CHANNEL_SEP && hi > ch.x1 - 4 && lo < ch.x2 + 4);
  };
  const vChannelBusy = (x, y1, y2) => {
    const lo = Math.min(y1, y2);
    const hi = Math.max(y1, y2);
    return usedVChannels.some((ch) => Math.abs(ch.x - x) < CHANNEL_SEP && hi > ch.y1 - 4 && lo < ch.y2 + 4);
  };
  const registerPathChannels = (pts) => {
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      if (Math.abs(a.y - b.y) <= 1 && Math.abs(a.x - b.x) > 4) {
        usedHChannels.push({ y: (a.y + b.y) / 2, x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x) });
      } else if (Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) > 4) {
        usedVChannels.push({ x: (a.x + b.x) / 2, y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y) });
      }
    }
  };

  let routedCount = 0;

  cy.batch(() => {
    for (const spec of specs) {
      const { cyEdge, srcG, tgtG } = spec;
      if (spec.skip) {
        if (srcG && tgtG) {
          cyEdge.data("taxiDir", computeDynamicTaxiDirection({ x: srcG.cx, y: srcG.cy }, { x: tgtG.cx, y: tgtG.cy }));
        }
        clearRoute(cyEdge);
        continue;
      }

      const { srcNode, tgtNode, vGap, hGap, dxCenter, dyCenter, useVertical } = spec;
      if (srcNode.isParent() || tgtNode.isParent()) {
        cyEdge.addClass("compound-incident");
      }
      cyEdge.data("taxiDir", computeDynamicTaxiDirection({ x: srcG.cx, y: srcG.cy }, { x: tgtG.cx, y: tgtG.cy }));

      const ignore = buildIgnoreSet(srcNode, tgtNode);
      let pts = null;

      if (useVertical && vGap >= 12) {
        const goingDown = dyCenter >= 0;
        const sx = srcG.cx + spec.srcPortOffset;
        const tx = tgtG.cx + spec.tgtPortOffset;
        const sy = goingDown ? srcG.bottom : srcG.top;
        const ty = goingDown ? tgtG.top : tgtG.bottom;

        if (Math.abs(sx - tx) <= 2 && !vSegBlocked(sx, sy, ty, ignore, 5)) {
          pts = [{ x: sx, y: sy }, { x: sx, y: ty }];
        } else {
          const loY = Math.min(sy, ty) + 10;
          const hiY = Math.max(sy, ty) - 10;
          const baseMidY = clampVal((sy + ty) / 2 + spec.laneIndex * 10, loY, hiY);
          const candidateYs = [baseMidY];
          for (let step = 12; step <= Math.max(96, vGap * 0.48); step += 12) {
            if (baseMidY + step <= hiY) candidateYs.push(baseMidY + step);
            if (baseMidY - step >= loY) candidateYs.push(baseMidY - step);
          }
          // Candidatos exactos justo arriba/abajo de cajas intermedias en el rango.
          const bandTop = Math.min(sy, ty);
          const bandBot = Math.max(sy, ty);
          const bandLeft = Math.min(sx, tx) - 10;
          const bandRight = Math.max(sx, tx) + 10;
          for (const b of obstacleBoxes) {
            if (ignore.has(b.id) || b.bottom < bandTop || b.top > bandBot || b.right < bandLeft || b.left > bandRight) {
              continue;
            }
            if (b.top - 14 >= loY && b.top - 14 <= hiY) candidateYs.push(b.top - 14);
            if (b.bottom + 14 >= loY && b.bottom + 14 <= hiY) candidateYs.push(b.bottom + 14);
          }

          let chosenMidY = null;
          let fallbackMidY = null;
          for (const candY of candidateYs) {
            const clear = !vSegBlocked(sx, sy, candY, ignore, 5)
              && !hSegBlocked(candY, sx, tx, ignore, 5)
              && !vSegBlocked(tx, candY, ty, ignore, 5);
            if (!clear) {
              continue;
            }
            if (!hChannelBusy(candY, sx, tx)) {
              chosenMidY = candY;
              break;
            }
            if (fallbackMidY === null) {
              fallbackMidY = candY;
            }
          }
          const finalMidY = chosenMidY !== null ? chosenMidY : fallbackMidY;

          if (finalMidY !== null) {
            pts = [
              { x: sx, y: sy },
              { x: sx, y: finalMidY },
              { x: tx, y: finalMidY },
              { x: tx, y: ty },
            ];
          } else {
            // Pasillo lateral limpio rodeando cajas y contenedores intermedios en el corredor vertical.
            let minLeft = Math.min(srcG.left, tgtG.left);
            let maxRight = Math.max(srcG.right, tgtG.right);
            for (const b of obstacleBoxes) {
              if (ignore.has(b.id) || b.bottom < bandTop - 16 || b.top > bandBot + 16) {
                continue;
              }
              if (b.left < minLeft) minLeft = b.left;
              if (b.right > maxRight) maxRight = b.right;
            }
            const dir = goingDown ? 1 : -1;
            const pickStubY = (anchorY, sign, targetX) => {
              const offsets = [14, 22, 30, 10, 38];
              for (const d of offsets) {
                const cyStub = anchorY + sign * d;
                if (!vSegBlocked(anchorY === sy ? sx : tx, anchorY, cyStub, ignore, 4)
                  && !hSegBlocked(cyStub, anchorY === sy ? sx : tx, targetX, ignore, 4)) {
                  return cyStub;
                }
              }
              return anchorY + sign * Math.min(18, Math.max(10, vGap * 0.22));
            };

            const avgX = (sx + tx) / 2;
            const leftBase = minLeft - 22;
            const rightBase = maxRight + 22;
            const preferLeft = Math.abs(avgX - leftBase) <= Math.abs(avgX - rightBase);
            const sides = preferLeft ? [-1, 1] : [1, -1];
            let bestBypass = null;
            for (const s of sides) {
              let bx = s < 0 ? leftBase : rightBase;
              for (let k = 0; k < 8; k += 1) {
                const candX = bx + s * k * 14;
                if (!vSegBlocked(candX, bandTop - 24, bandBot + 24, ignore, 5)
                  && !vChannelBusy(candX, bandTop, bandBot)) {
                  bx = candX;
                  break;
                }
              }
              const exitY = pickStubY(sy, dir, bx);
              const entryY = pickStubY(ty, -dir, bx);
              const stubClear = !hSegBlocked(exitY, sx, bx, ignore, 4)
                && !hSegBlocked(entryY, bx, tx, ignore, 4)
                && !vSegBlocked(bx, exitY, entryY, ignore, 5);
              bestBypass = [
                { x: sx, y: sy },
                { x: sx, y: exitY },
                { x: bx, y: exitY },
                { x: bx, y: entryY },
                { x: tx, y: entryY },
                { x: tx, y: ty },
              ];
              if (stubClear) {
                break;
              }
            }
            pts = bestBypass;
          }
        }
      } else if (hGap >= 12) {
        const goingRight = dxCenter >= 0;
        const sy = srcG.cy + spec.srcPortOffset;
        const ty = tgtG.cy + spec.tgtPortOffset;
        const sx = goingRight ? srcG.right : srcG.left;
        const tx = goingRight ? tgtG.left : tgtG.right;

        if (Math.abs(sy - ty) <= 2 && !hSegBlocked(sy, sx, tx, ignore, 5)) {
          pts = [{ x: sx, y: sy }, { x: tx, y: sy }];
        } else {
          const loX = Math.min(sx, tx) + 10;
          const hiX = Math.max(sx, tx) - 10;
          const baseMidX = clampVal((sx + tx) / 2 + spec.laneIndex * 10, loX, hiX);
          const candidateXs = [baseMidX];
          for (let step = 12; step <= Math.max(96, hGap * 0.48); step += 12) {
            if (baseMidX + step <= hiX) candidateXs.push(baseMidX + step);
            if (baseMidX - step >= loX) candidateXs.push(baseMidX - step);
          }
          const bandLeft = Math.min(sx, tx);
          const bandRight = Math.max(sx, tx);
          const bandTop = Math.min(sy, ty) - 10;
          const bandBot = Math.max(sy, ty) + 10;
          for (const b of obstacleBoxes) {
            if (ignore.has(b.id) || b.right < bandLeft || b.left > bandRight || b.bottom < bandTop || b.top > bandBot) {
              continue;
            }
            if (b.left - 14 >= loX && b.left - 14 <= hiX) candidateXs.push(b.left - 14);
            if (b.right + 14 >= loX && b.right + 14 <= hiX) candidateXs.push(b.right + 14);
          }

          let chosenMidX = null;
          let fallbackMidX = null;
          for (const candX of candidateXs) {
            const clear = !hSegBlocked(sy, sx, candX, ignore, 5)
              && !vSegBlocked(candX, sy, ty, ignore, 5)
              && !hSegBlocked(ty, candX, tx, ignore, 5);
            if (!clear) {
              continue;
            }
            if (!vChannelBusy(candX, sy, ty)) {
              chosenMidX = candX;
              break;
            }
            if (fallbackMidX === null) {
              fallbackMidX = candX;
            }
          }
          const finalMidX = chosenMidX !== null ? chosenMidX : fallbackMidX;

          if (finalMidX !== null) {
            pts = [
              { x: sx, y: sy },
              { x: finalMidX, y: sy },
              { x: finalMidX, y: ty },
              { x: tx, y: ty },
            ];
          } else {
            let minTop = Math.min(srcG.top, tgtG.top);
            let maxBot = Math.max(srcG.bottom, tgtG.bottom);
            for (const b of obstacleBoxes) {
              if (ignore.has(b.id) || b.right < bandLeft - 16 || b.left > bandRight + 16) {
                continue;
              }
              if (b.top < minTop) minTop = b.top;
              if (b.bottom > maxBot) maxBot = b.bottom;
            }
            const dir = goingRight ? 1 : -1;
            const pickStubX = (anchorX, sign, targetY) => {
              const offsets = [14, 22, 30, 10, 38];
              for (const d of offsets) {
                const cxStub = anchorX + sign * d;
                if (!hSegBlocked(anchorX === sx ? sy : ty, anchorX, cxStub, ignore, 4)
                  && !vSegBlocked(cxStub, anchorX === sx ? sy : ty, targetY, ignore, 4)) {
                  return cxStub;
                }
              }
              return anchorX + sign * Math.min(18, Math.max(10, hGap * 0.22));
            };

            const avgY = (sy + ty) / 2;
            const topBase = minTop - 22;
            const botBase = maxBot + 22;
            const preferTop = Math.abs(avgY - topBase) <= Math.abs(avgY - botBase);
            const sides = preferTop ? [-1, 1] : [1, -1];
            let bestBypass = null;
            for (const s of sides) {
              let by = s < 0 ? topBase : botBase;
              for (let k = 0; k < 8; k += 1) {
                const candY = by + s * k * 14;
                if (!hSegBlocked(candY, bandLeft - 24, bandRight + 24, ignore, 5)
                  && !hChannelBusy(candY, bandLeft, bandRight)) {
                  by = candY;
                  break;
                }
              }
              const exitX = pickStubX(sx, dir, by);
              const entryX = pickStubX(tx, -dir, by);
              const stubClear = !vSegBlocked(exitX, sy, by, ignore, 4)
                && !vSegBlocked(entryX, by, ty, ignore, 4)
                && !hSegBlocked(by, exitX, entryX, ignore, 5);
              bestBypass = [
                { x: sx, y: sy },
                { x: exitX, y: sy },
                { x: exitX, y: by },
                { x: entryX, y: by },
                { x: entryX, y: ty },
                { x: tx, y: ty },
              ];
              if (stubClear) {
                break;
              }
            }
            pts = bestBypass;
          }
        }
      } else {
        // Brecha estrecha (4..12px): segmento directo o codo limpio.
        if (vGap >= hGap) {
          const goingDown = dyCenter >= 0;
          const sx = srcG.cx + spec.srcPortOffset;
          const tx = tgtG.cx + spec.tgtPortOffset;
          const sy = goingDown ? srcG.bottom : srcG.top;
          const ty = goingDown ? tgtG.top : tgtG.bottom;
          const midY = (sy + ty) / 2;
          pts = Math.abs(sx - tx) <= 2
            ? [{ x: sx, y: sy }, { x: sx, y: ty }]
            : [{ x: sx, y: sy }, { x: sx, y: midY }, { x: tx, y: midY }, { x: tx, y: ty }];
        } else {
          const goingRight = dxCenter >= 0;
          const sy = srcG.cy + spec.srcPortOffset;
          const ty = tgtG.cy + spec.tgtPortOffset;
          const sx = goingRight ? srcG.right : srcG.left;
          const tx = goingRight ? tgtG.left : tgtG.right;
          const midX = (sx + tx) / 2;
          pts = Math.abs(sy - ty) <= 2
            ? [{ x: sx, y: sy }, { x: tx, y: sy }]
            : [{ x: sx, y: sy }, { x: midX, y: sy }, { x: midX, y: ty }, { x: tx, y: ty }];
        }
      }

      if (!pts || pts.length < 2) {
        clearRoute(cyEdge);
        continue;
      }

      const srcEnd = projectBorder(pts[0], pts[1], srcG);
      const tgtEnd = projectBorder(pts[pts.length - 1], pts[pts.length - 2], tgtG);
      if (
        !Number.isFinite(srcEnd.x)
        || !Number.isFinite(srcEnd.y)
        || !Number.isFinite(tgtEnd.x)
        || !Number.isFinite(tgtEnd.y)
        || Math.hypot(tgtEnd.x - srcEnd.x, tgtEnd.y - srcEnd.y) < 2
      ) {
        clearRoute(cyEdge);
        continue;
      }

      let interior = [];
      for (let i = 1; i < pts.length - 1; i += 1) {
        const p = pts[i];
        if (Math.hypot(p.x - srcEnd.x, p.y - srcEnd.y) < 1.5 || Math.hypot(p.x - tgtEnd.x, p.y - tgtEnd.y) < 1.5) {
          continue;
        }
        interior.push(p);
      }
      if (interior.length === 0) {
        interior = [{ x: (srcEnd.x + tgtEnd.x) / 2, y: (srcEnd.y + tgtEnd.y) / 2 }];
      }

      const segments = convertElkPointsToCytoscapeSegments(interior, srcEnd, tgtEnd);
      if (!segments) {
        clearRoute(cyEdge);
        continue;
      }

      registerPathChannels([srcEnd, ...interior, tgtEnd]);
      cyEdge.data("srcEndpoint", srcEnd.endpointStr);
      cyEdge.data("tgtEndpoint", tgtEnd.endpointStr);
      cyEdge.data("segWeights", segments.weights);
      cyEdge.data("segDistances", segments.distances);
      cyEdge.addClass("elk-routed");
      routedCount += 1;
    }
  });

  return routedCount;
}

async function handleNodeDragFreeBatch(cyNodes) {
  const dragSnapshot = typeof _activeDragState !== "undefined" ? _activeDragState : null;
  if (typeof _activeDragState !== "undefined") {
    _activeDragState = null;
  }

  if (!state.cy || !Array.isArray(cyNodes) || cyNodes.length === 0) {
    return;
  }

  const outermost = filterOutermostDraggedNodes(cyNodes);
  if (outermost.length === 0) {
    return;
  }

  // Si hubo `grab` interactivo pero el desplazamiento fue nulo o micro-temblor (< umbral),
  // restaurar la posición exacta sin re-enrutar ni marcar el nodo como `pinned`.
  const thresholdPx = typeof DRAG_MOVE_THRESHOLD_PX !== "undefined" ? DRAG_MOVE_THRESHOLD_PX : 3;
  if (dragSnapshot && dragSnapshot.startPositions && !dragSnapshot.detached) {
    const maxDisp = computeMaxDragDisplacement(state.cy, dragSnapshot.startPositions);
    if (maxDisp < thresholdPx) {
      state.cy.batch(() => {
        for (const [id, orig] of dragSnapshot.startPositions.entries()) {
          if (orig.isParent) {
            continue;
          }
          const n = state.cy.getElementById(id);
          if (n && n.length > 0 && !n.removed()) {
            n.position({ x: orig.x, y: orig.y });
          }
        }
      });
      return;
    }
  }

  const parentNodes = state.cy.nodes(":parent");
  if (parentNodes.length > 0 && typeof parentNodes.updateCompoundBounds === "function") {
    parentNodes.updateCompoundBounds(true);
  }

  const { externalEdges } = collectScopeAndExternalEdges(state.cy, outermost);

  // Re-enrutar localmente únicamente las aristas externas; las internas conservan su `.elk-routed` intacto.
  if (externalEdges.length > 0) {
    rerouteExternalEdgesLocally(state.cy, externalEdges);
  }

  const contextKey = getCurrentLayoutContextKey();
  const patchNodes = {};

  for (const item of outermost) {
    if (!item || item.removed()) {
      continue;
    }
    const id = item.id();
    const nodeType = item.data("type");
    const isPersistable = state.nodesById.has(id) || nodeType === "flow" || nodeType === "layer";
    if (!isPersistable) {
      continue;
    }
    if (item.isParent() && typeof item.updateCompoundBounds === "function") {
      item.updateCompoundBounds(true);
    }
    const pos = item.position();
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      continue;
    }
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
      x: contextKey === "functions" ? x : existing.x,
      y: contextKey === "functions" ? y : existing.y,
      pinned_positions: nextPositions,
      last_fingerprint: (raw && raw.fingerprint) || existing.last_fingerprint || "",
    };
    state.notes.nodes[id] = entry;
    patchNodes[id] = entry;
    refreshCyNodeMetadata(id);
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
  if (typeof updateReleasePinnedButton === "function") {
    updateReleasePinnedButton();
  }
}

async function handleNodeDragFree(cyNode) {
  await handleNodeDragFreeBatch(cyNode ? [cyNode] : []);
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
    // Etapa 4: Contenedores de Capas Topológicas (Architectural Slicing)
    {
      selector: 'node[type = "layer"]',
      style: {
        "shape": "round-rectangle",
        "background-color": "#131b26",
        "background-opacity": 0.78,
        "border-width": 2,
        "border-style": "solid",
        "border-color": "#64748b",
        "padding": 22,
        "label": "data(label)",
        "color": "#e2e8f0",
        "font-size": 12.5,
        "font-weight": "bold",
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": -6,
      },
    },
    {
      selector: 'node[type = "layer"][layerIndex = 0]',
      style: { "border-color": "#10b981", "background-color": "#0d221c", "color": "#a7f3d0" },
    },
    {
      selector: 'node[type = "layer"][layerIndex = 1]',
      style: { "border-color": "#38bdf8", "background-color": "#0e2030", "color": "#bae6fd" },
    },
    {
      selector: 'node[type = "layer"][layerIndex = 2]',
      style: { "border-color": "#a855f7", "background-color": "#1d142c", "color": "#e9d5ff" },
    },
    {
      selector: 'node[type = "layer"][layerIndex = 3]',
      style: { "border-color": "#f59e0b", "background-color": "#231a0d", "color": "#fde68a" },
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
      selector: 'node[type = "variable"]',
      style: {
        "shape": "round-rectangle",
        "label": "data(label)",
        "color": "#a5f3fc",
        "font-size": 10.5,
        "font-family": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "wrap",
        "text-max-width": 165,
        "background-color": "#0e2230",
        "border-color": "#06b6d4",
        "border-style": "dashed",
        "border-width": 1.6,
        "width": "label",
        "height": "label",
        "padding": 7,
      },
    },
    {
      selector: 'node[type = "variable"][varKind = "variable"]',
      style: {
        "color": "#fef08a",
        "background-color": "#231e0d",
        "border-color": "#eab308",
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
      selector: 'node[type = "flow"][flowContainer != "true"][nodeWidth][nodeHeight]',
      style: {
        "width": "data(nodeWidth)",
        "height": "data(nodeHeight)",
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
        "text-max-width": 185,
        "padding": 0,
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
    // Aristas (enrutamiento ortogonal ELKjs -> segments, con fallback taxi y bezier para auto-lazos)
    {
      selector: "edge",
      style: {
        "width": 1.8,
        "line-color": "#64748b",
        "target-arrow-color": "#64748b",
        "target-arrow-shape": "triangle",
        "curve-style": "taxi",
        "taxi-direction": "downward",
        "taxi-turn": "50%",
        "taxi-turn-min-distance": 14,
        "taxi-radius": 6,
        "label": "data(label)",
        "font-size": 10,
        "color": "#cbd5e1",
        "text-background-color": "#0f141b",
        "text-background-opacity": 0.85,
        "text-background-padding": 2,
      },
    },
    {
      selector: 'edge[taxiDir = "rightward"]',
      style: {
        "taxi-direction": "rightward",
      },
    },
    {
      selector: 'edge[taxiDir = "leftward"]',
      style: {
        "taxi-direction": "leftward",
      },
    },
    {
      selector: 'edge[taxiDir = "upward"]',
      style: {
        "taxi-direction": "upward",
      },
    },
    {
      selector: "edge.elk-routed",
      style: {
        "curve-style": "segments",
        "edge-distances": "node-position",
        "segment-weights": "data(segWeights)",
        "segment-distances": "data(segDistances)",
        "segment-radii": 6,
      },
    },
    {
      selector: "edge.elk-routed[srcEndpoint][tgtEndpoint]",
      style: {
        "edge-distances": "endpoints",
        "source-endpoint": "data(srcEndpoint)",
        "target-endpoint": "data(tgtEndpoint)",
      },
    },
    {
      selector: "edge.compound-incident",
      style: {
        "z-compound-depth": "top",
      },
    },
    {
      selector: "edge:loop",
      style: {
        "curve-style": "bezier",
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
      selector: 'edge[kind = "call"][edgeType = "reads_var"]',
      style: {
        "width": 1.3,
        "line-style": "dotted",
        "line-color": "#22d3ee",
        "target-arrow-color": "#22d3ee",
        "target-arrow-shape": "vee",
        "arrow-scale": 0.78,
        "opacity": 0.58,
        "color": "#a5f3fc",
      },
    },
    {
      selector: 'edge[kind = "call"][edgeType = "reads_var"]:selected',
      style: {
        "opacity": 1,
        "width": 2.2,
        "z-index": 25,
      },
    },
    {
      selector: 'edge[kind = "flow"]',
      style: {
        "width": 1.8,
        "line-color": "#94a3b8",
        "target-arrow-color": "#94a3b8",
        "arrow-scale": 0.95,
        "z-compound-depth": "top",
      },
    },
    {
      selector: 'edge[kind = "flow"].zoom-compact-label',
      style: {
        "text-opacity": 0,
      },
    },
    {
      selector: 'edge[kind = "flow"].flow-bg-muted',
      style: {
        "opacity": 0.28,
        "text-opacity": 0,
      },
    },
    {
      selector: 'edge[kind = "flow"].flow-focus-active',
      style: {
        "opacity": 1,
        "text-opacity": 1,
        "width": 2.35,
        "z-index": 26,
      },
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
    // Atenuación suave de aristas inter-archivo en modo Creación (1→N), restaurada al 100% al interactuar
    {
      selector: "edge.creation-cross-edge",
      style: {
        "opacity": 0.48,
        "text-opacity": 0.65,
        "width": 1.5,
        "z-index": 2,
      },
    },
    {
      selector: "edge.creation-cross-edge:selected",
      style: {
        "opacity": 1,
        "text-opacity": 1,
        "width": 2.4,
        "z-index": 25,
      },
    },
    // Clases de aislamiento, Hilos de Ejecución y Modo Foco multi-rama
    {
      selector: ".dimmed",
      style: { "opacity": 0.15 },
    },
    {
      selector: "edge.creation-cross-edge.dimmed",
      style: { "opacity": 0.15, "text-opacity": 0 },
    },
    // Etapa 3: Modo "Aristas bajo demanda" (Hover / Selection Reveal)
    {
      selector: 'edge[kind = "call"].edge-muted',
      style: {
        "opacity": 0.1,
        "text-opacity": 0,
        "z-index": 1,
      },
    },
    {
      selector: 'edge[kind = "call"].edge-reveal-in',
      style: {
        "opacity": 1,
        "text-opacity": 1,
        "width": 2.8,
        "line-color": "#22d3ee",
        "target-arrow-color": "#22d3ee",
        "color": "#cffafe",
        "z-index": 35,
      },
    },
    {
      selector: 'edge[kind = "call"].edge-reveal-out',
      style: {
        "opacity": 1,
        "text-opacity": 1,
        "width": 2.8,
        "line-color": "#f59e0b",
        "target-arrow-color": "#f59e0b",
        "color": "#fde68a",
        "z-index": 35,
      },
    },
    {
      selector: 'edge[kind = "call"].edge-reveal-internal',
      style: {
        "opacity": 0.9,
        "text-opacity": 1,
        "width": 2.4,
        "z-index": 25,
      },
    },
    {
      selector: "edge.creation-cross-edge.edge-reveal-internal",
      style: {
        "opacity": 1,
        "text-opacity": 1,
        "width": 2.4,
        "z-index": 25,
      },
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
      style: { "opacity": 1, "text-opacity": 1, "width": 3.2, "z-index": 20 },
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
      style: { "opacity": 1, "text-opacity": 1, "width": 3 },
    },
    {
      selector: 'edge[edgeType = "direct_call"].trace-caller',
      style: { "line-color": "#22d3ee", "target-arrow-color": "#22d3ee" },
    },
    {
      selector: "node.trace-callee",
      style: { "opacity": 1, "border-width": 3, "border-color": "#fbbf24" },
    },
    {
      selector: "edge.trace-callee",
      style: { "opacity": 1, "text-opacity": 1, "width": 3 },
    },
    {
      selector: 'edge[edgeType = "direct_call"].trace-callee',
      style: { "line-color": "#fbbf24", "target-arrow-color": "#fbbf24" },
    },
    {
      selector: "edge.trace-branch-active",
      style: {
        "opacity": 1,
        "text-opacity": 1,
        "width": 4,
        "arrow-scale": 1.3,
        "underlay-color": "#f8fafc",
        "underlay-opacity": 0.42,
        "underlay-padding": 5,
        "z-index": 40,
      },
    },
    {
      selector: "node.trace-branch-active",
      style: {
        "opacity": 1,
        "border-width": 4,
        "border-color": "#f8fafc",
        "underlay-color": "#f8fafc",
        "underlay-opacity": 0.24,
        "underlay-padding": 6,
        "z-index": 40,
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

function computeAnchoredPanForLayoutSwap(anchorScreenBefore, anchorModelAfter, zoom) {
  if (!anchorScreenBefore || !anchorModelAfter || !Number.isFinite(zoom) || zoom <= 0) {
    return null;
  }
  if (
    !Number.isFinite(anchorScreenBefore.x) || !Number.isFinite(anchorScreenBefore.y)
    || !Number.isFinite(anchorModelAfter.x) || !Number.isFinite(anchorModelAfter.y)
  ) {
    return null;
  }
  return {
    x: anchorScreenBefore.x - anchorModelAfter.x * zoom,
    y: anchorScreenBefore.y - anchorModelAfter.y * zoom,
  };
}

function resolveVisibleCyIdForAnchor(cy, rawId) {
  if (!cy || !rawId || typeof cy.getElementById !== "function") {
    return null;
  }
  const direct = cy.getElementById(rawId);
  if (direct && direct.length > 0 && typeof direct.isNode === "function" && direct.isNode()) {
    return rawId;
  }
  let candidate = rawId;
  const parts = String(candidate).split("::");
  if (parts.length >= 3) {
    const fnCandidate = parts.slice(0, -1).join("::");
    const fnEl = cy.getElementById(fnCandidate);
    if (fnEl && fnEl.length > 0 && fnEl.isNode()) {
      return fnCandidate;
    }
    candidate = fnCandidate;
  }
  let cur = state.nodesById.get(candidate);
  const seen = new Set();
  while (cur && cur.parent && !seen.has(cur.parent)) {
    seen.add(cur.parent);
    const pEl = cy.getElementById(cur.parent);
    if (pEl && pEl.length > 0 && pEl.isNode()) {
      return cur.parent;
    }
    cur = state.nodesById.get(cur.parent);
  }
  const layerFallback = resolveVisibleFallbackLayerId(candidate);
  if (layerFallback) {
    const fbEl = cy.getElementById(layerFallback);
    if (fbEl && fbEl.length > 0 && fbEl.isNode()) {
      return layerFallback;
    }
  }
  return null;
}

function readAnchorModelPoint(cyNode, mode = "top") {
  if (!cyNode || cyNode.length === 0) {
    return null;
  }
  if (typeof cyNode.boundingBox === "function") {
    const bb = cyNode.boundingBox({ includeLabels: false });
    if (bb && Number.isFinite(bb.x1) && Number.isFinite(bb.y1) && bb.w > 0 && bb.h > 0) {
      return mode === "center"
        ? { x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 }
        : { x: (bb.x1 + bb.x2) / 2, y: bb.y1 };
    }
  }
  if (typeof cyNode.position === "function") {
    const pos = cyNode.position();
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      return { x: pos.x, y: pos.y };
    }
  }
  return null;
}

function captureViewportAnchorBeforeSwap(cy, anchorSpec) {
  if (!cy || !anchorSpec) {
    return null;
  }
  const candidates = Array.isArray(anchorSpec.candidateIds)
    ? anchorSpec.candidateIds
    : (anchorSpec.nodeId ? [anchorSpec.nodeId] : []);
  const mode = anchorSpec.mode === "center" ? "center" : "top";
  const prevZoom = typeof cy.zoom === "function" ? cy.zoom() : null;
  const prevPan = typeof cy.pan === "function" ? cy.pan() : null;
  if (!Number.isFinite(prevZoom) || prevZoom <= 0 || !prevPan) {
    return null;
  }
  for (const candId of candidates) {
    if (!candId) {
      continue;
    }
    const visId = resolveVisibleCyIdForAnchor(cy, candId);
    if (!visId) {
      continue;
    }
    const cyNode = cy.getElementById(visId);
    const modelPt = readAnchorModelPoint(cyNode, mode);
    if (modelPt) {
      return {
        candidateId: candId,
        mode,
        beforeScreen: {
          x: modelPt.x * prevZoom + prevPan.x,
          y: modelPt.y * prevZoom + prevPan.y,
        },
        prevZoom,
        prevPan: { x: prevPan.x, y: prevPan.y },
      };
    }
  }
  return null;
}

function applyViewportAnchorAfterSwap(cy, captured) {
  if (!cy || !captured) {
    return false;
  }
  const visId = resolveVisibleCyIdForAnchor(cy, captured.candidateId);
  const afterNode = visId ? cy.getElementById(visId) : null;
  const afterModel = afterNode ? readAnchorModelPoint(afterNode, captured.mode) : null;
  const nextPan = afterModel
    ? computeAnchoredPanForLayoutSwap(captured.beforeScreen, afterModel, captured.prevZoom)
    : captured.prevPan;

  const applyVp = () => {
    if (Number.isFinite(captured.prevZoom)) {
      cy.zoom(captured.prevZoom);
    }
    if (nextPan) {
      cy.pan(nextPan);
    }
  };
  if (state.walkthrough && typeof state.walkthrough.runProgrammaticPan === "function") {
    state.walkthrough.runProgrammaticPan(cy, applyVp);
  } else {
    applyVp();
  }
  return Boolean(afterModel && nextPan);
}

async function refreshGraphView({ fit = true, viewportAnchor = null, preserveViewport = false } = {}) {
  const myToken = ++state.refreshToken;
  hideEdgeTooltip();
  hideNodeTooltip();
  state.hoveredNodeId = null;
  const { nodes, edges } = buildVisibleElements();
  const callEdges = edges.filter((e) => e.data && e.data.kind === "call");
  state.lastProjectedEdges = callEdges.map((e) => e.data);
  state.lastVisibleSummaryCounts = {
    layers: nodes.filter((n) => n.data && n.data.type === "layer").length,
    modules: nodes.filter((n) => n.data && n.data.type === "module").length,
    files: nodes.filter((n) => n.data && n.data.type === "file").length,
    functions: nodes.filter((n) => n.data && n.data.type === "function").length,
    edges: callEdges.length,
  };

  // Calcular ELK antes de modificar Cytoscape para realizar un intercambio atómico
  // sin frames en blanco, sin apilado temporal en (0, 0) y con rutas ortogonales intactas.
  const computedLayout = await computeElkLayoutResult(nodes, edges);
  if (myToken !== state.refreshToken) {
    return;
  }

  const prevZoom = state.cy ? state.cy.zoom() : null;
  const prevPan = state.cy ? { ...state.cy.pan() } : null;
  const capturedAnchor = (!fit && viewportAnchor)
    ? captureViewportAnchorBeforeSwap(state.cy, viewportAnchor)
    : null;

  state.cy.batch(() => {
    state.cy.elements().remove();
    state.cy.add([...nodes, ...edges]);
  });
  applyComputedElkLayout(computedLayout, nodes);

  if (fit) {
    fitCyWithDynamicMinZoom(state.cy, undefined, 36, MAIN_MIN_ZOOM);
  } else if (capturedAnchor) {
    applyViewportAnchorAfterSwap(state.cy, capturedAnchor);
  } else if (preserveViewport && state.cy && Number.isFinite(prevZoom)) {
    const restoreVp = () => {
      state.cy.zoom(prevZoom);
      if (prevPan) {
        state.cy.pan(prevPan);
      }
    };
    if (state.walkthrough && typeof state.walkthrough.runProgrammaticPan === "function") {
      state.walkthrough.runProgrammaticPan(state.cy, restoreVp);
    } else {
      restoreVp();
    }
  }
  updateZoomIndicator();
  updateNHopsHud();
  applyCanvasHighlights();
  if (state.selectedNodeId) {
    updateReleasePinnedButton();
  } else {
    renderEmptyInspectorSummary();
  }
}

function shiftElkSubtreeY(
  elkNode,
  deltaY,
  elkPositions,
  pinnedNodeIds,
  shiftedNodeIds,
  nodeDeltaY = null,
  containerBaseShiftY = null,
) {
  if (!elkNode || !deltaY) {
    return;
  }
  if (elkNode.children && elkNode.children.length > 0) {
    if (containerBaseShiftY) {
      containerBaseShiftY.set(elkNode.id, (containerBaseShiftY.get(elkNode.id) || 0) + deltaY);
    }
    for (const child of elkNode.children) {
      shiftElkSubtreeY(
        child,
        deltaY,
        elkPositions,
        pinnedNodeIds,
        shiftedNodeIds,
        nodeDeltaY,
        containerBaseShiftY,
      );
    }
    return;
  }
  if (pinnedNodeIds && pinnedNodeIds.has(elkNode.id)) {
    return;
  }
  const pos = elkPositions.get(elkNode.id);
  if (pos) {
    pos.y += deltaY;
    shiftedNodeIds.add(elkNode.id);
    if (nodeDeltaY) {
      nodeDeltaY.set(elkNode.id, (nodeDeltaY.get(elkNode.id) || 0) + deltaY);
    }
  }
}

function applyCreationRowStagger(
  layouted,
  elkPositions,
  pinnedNodeIds,
  dataById,
  stepPx = CREATION_ROW_STAGGER_PX,
) {
  const shiftedNodeIds = new Set();
  const nodeDeltaY = new Map();
  const containerBaseShiftY = new Map([["root", 0]]);
  const containerRowBreaks = new Map();
  shiftedNodeIds.staggerMeta = { nodeDeltaY, containerBaseShiftY, containerRowBreaks };

  if (!layouted || !Array.isArray(layouted.children) || stepPx <= 0) {
    return shiftedNodeIds;
  }

  const processContainer = (container) => {
    if (!container || !Array.isArray(container.children) || container.children.length === 0) {
      return 0;
    }
    const containerData = dataById.get(container.id);
    if (containerData && (containerData.expandedFn === "true" || containerData.flowContainer === "true")) {
      return 0;
    }

    const childExtraHeight = new Map();
    for (const child of container.children) {
      if (child.children && child.children.length > 0) {
        childExtraHeight.set(child.id, processContainer(child));
      } else {
        childExtraHeight.set(child.id, 0);
      }
    }

    const sortedByY = [...container.children].sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0));
    const rows = [];
    for (const child of sortedByY) {
      const top = child.y || 0;
      const bottom = top + (child.height || 44);
      const lastRow = rows[rows.length - 1];
      if (!lastRow || top >= lastRow.maxBottom) {
        rows.push({ items: [child], maxBottom: bottom });
      } else {
        lastRow.items.push(child);
        if (bottom > lastRow.maxBottom) {
          lastRow.maxBottom = bottom;
        }
      }
    }

    let cumulativeDownShift = 0;
    const rowBreaks = [];
    for (const row of rows) {
      const rowShift = cumulativeDownShift;
      const staggerCandidates = row.items.filter((child) => {
        if (child.children && child.children.length > 0) {
          return false;
        }
        if (pinnedNodeIds && pinnedNodeIds.has(child.id)) {
          return false;
        }
        const d = dataById.get(child.id);
        return Boolean(d && (d.type === "function" || d.type === "variable"));
      });

      const staggerById = new Map();
      if (staggerCandidates.length > 1) {
        staggerCandidates.sort((a, b) => {
          const da = dataById.get(a.id) || {};
          const db = dataById.get(b.id) || {};
          const lineA = typeof da.line === "number" ? da.line : 0;
          const lineB = typeof db.line === "number" ? db.line : 0;
          if (lineA !== lineB) {
            return lineA - lineB;
          }
          return (a.x || 0) - (b.x || 0) || String(a.id).localeCompare(String(b.id));
        });
        staggerCandidates.forEach((child, idx) => {
          staggerById.set(child.id, idx * stepPx);
        });
      }

      let newRowMaxBottom = row.maxBottom + rowShift;
      for (const child of row.items) {
        const staggerDelta = staggerById.get(child.id) || 0;
        const totalShift = rowShift + staggerDelta;
        if (totalShift > 0) {
          shiftElkSubtreeY(
            child,
            totalShift,
            elkPositions,
            pinnedNodeIds,
            shiftedNodeIds,
            nodeDeltaY,
            containerBaseShiftY,
          );
        }
        const childNewBottom = (child.y || 0)
          + totalShift
          + (child.height || 44)
          + (childExtraHeight.get(child.id) || 0);
        if (childNewBottom > newRowMaxBottom) {
          newRowMaxBottom = childNewBottom;
        }
      }

      const rowExtraPush = Math.max(0, newRowMaxBottom - (row.maxBottom + rowShift));
      if (rowExtraPush > 0) {
        rowBreaks.push({ origBottom: row.maxBottom, extraPush: rowExtraPush });
      }
      cumulativeDownShift += rowExtraPush;
    }

    if (rowBreaks.length > 0) {
      containerRowBreaks.set(container.id, rowBreaks);
    }
    return cumulativeDownShift;
  };

  processContainer(layouted);
  return shiftedNodeIds;
}

function computeStaggeredChannelShiftY(containerId, localY, staggerMeta) {
  if (!staggerMeta) {
    return 0;
  }
  let shift = (staggerMeta.containerBaseShiftY && staggerMeta.containerBaseShiftY.get(containerId)) || 0;
  const breaks = staggerMeta.containerRowBreaks && staggerMeta.containerRowBreaks.get(containerId);
  if (breaks && breaks.length > 0) {
    for (const brk of breaks) {
      if (localY >= brk.origBottom - 0.5) {
        shift += brk.extraPush;
      }
    }
  }
  return shift;
}

function adjustElkSectionPoints(
  section,
  edgeContainer,
  origOffset,
  srcId,
  tgtId,
  staggerMeta,
  useChannelShiftForEndpoints = false,
) {
  const resolveEndpointDeltaY = (nodeId) => {
    if (!staggerMeta) {
      return 0;
    }
    if (staggerMeta.nodeDeltaY && staggerMeta.nodeDeltaY.has(nodeId)) {
      return staggerMeta.nodeDeltaY.get(nodeId) || 0;
    }
    if (staggerMeta.containerBaseShiftY && staggerMeta.containerBaseShiftY.has(nodeId)) {
      return staggerMeta.containerBaseShiftY.get(nodeId) || 0;
    }
    return 0;
  };
  const srcDy = useChannelShiftForEndpoints && section && section.startPoint
    ? computeStaggeredChannelShiftY(edgeContainer, section.startPoint.y, staggerMeta)
    : resolveEndpointDeltaY(srcId);
  const tgtDy = useChannelShiftForEndpoints && section && section.endPoint
    ? computeStaggeredChannelShiftY(edgeContainer, section.endPoint.y, staggerMeta)
    : resolveEndpointDeltaY(tgtId);
  const rawBends = section && Array.isArray(section.bendPoints) ? section.bendPoints : [];
  const absPoints = [];

  if (section && section.startPoint) {
    absPoints.push({
      x: section.startPoint.x + origOffset.x,
      y: section.startPoint.y + origOffset.y + srcDy,
    });
  }
  for (const bp of rawBends) {
    const channelDy = computeStaggeredChannelShiftY(edgeContainer, bp.y, staggerMeta);
    absPoints.push({
      x: bp.x + origOffset.x,
      y: bp.y + origOffset.y + channelDy,
    });
  }
  if (section && section.endPoint) {
    absPoints.push({
      x: section.endPoint.x + origOffset.x,
      y: section.endPoint.y + origOffset.y + tgtDy,
    });
  }
  return absPoints;
}

function assignCreationBands(fnElkNodes, intraEdges, maxPerBand = null) {
  if (!Array.isArray(fnElkNodes) || fnElkNodes.length === 0) {
    return [];
  }
  const bandCap = typeof maxPerBand === "number" && maxPerBand > 0
    ? maxPerBand
    : (fnElkNodes.length <= 4 ? 2 : 3);
  const fnIdSet = new Set(fnElkNodes.map((n) => n.id));
  const neighbors = new Map(fnElkNodes.map((n) => [n.id, new Set()]));
  for (const edge of intraEdges || []) {
    const src = edge.sources ? edge.sources[0] : (edge.data && edge.data.source);
    const tgt = edge.targets ? edge.targets[0] : (edge.data && edge.data.target);
    if (fnIdSet.has(src) && fnIdSet.has(tgt) && src !== tgt) {
      neighbors.get(src).add(tgt);
      neighbors.get(tgt).add(src);
    }
  }
  const bands = [];
  let currentBand = [];
  for (const fnNode of fnElkNodes) {
    const conflictsWithBand = currentBand.some((prev) => neighbors.get(fnNode.id).has(prev.id));
    if (currentBand.length >= bandCap || conflictsWithBand) {
      if (currentBand.length > 0) {
        bands.push(currentBand);
      }
      currentBand = [fnNode];
    } else {
      currentBand.push(fnNode);
    }
  }
  if (currentBand.length > 0) {
    bands.push(currentBand);
  }
  return bands;
}

function computeCreationPartition(nodeId, dataById, childrenByParent = null) {
  const data = dataById.get(nodeId);
  if (!data) {
    return 0;
  }
  if (data.type === "layer" && typeof data.layerIndex === "number") {
    return Math.max(0, 3 - data.layerIndex);
  }
  if (typeof data.archLayer === "number") {
    return Math.max(0, 3 - data.archLayer);
  }
  if (childrenByParent) {
    const nonEmptyFileLayers = [];
    const allFileLayers = [];
    const walk = (id) => {
      for (const child of childrenByParent.get(id) || []) {
        const childData = dataById.get(child.id);
        if (childData && childData.type === "file" && typeof childData.archLayer === "number") {
          allFileLayers.push(childData.archLayer);
          const fileKids = childrenByParent.get(child.id) || [];
          if (fileKids.some((k) => {
            const t = (dataById.get(k.id) || {}).type;
            return t === "function" || t === "variable";
          })) {
            nonEmptyFileLayers.push(childData.archLayer);
          }
        } else {
          walk(child.id);
        }
      }
    };
    walk(nodeId);
    const pool = nonEmptyFileLayers.length > 0 ? nonEmptyFileLayers : allFileLayers;
    if (pool.length > 0) {
      return Math.max(0, 3 - Math.min(...pool));
    }
  }
  return 0;
}

function computeIntraTierFoundationDepths(siblingIds, callEdges, basePartitionById) {
  const depthById = new Map();
  const byTier = new Map();
  for (const id of siblingIds) {
    const tier = basePartitionById.get(id) ?? 0;
    if (!byTier.has(tier)) {
      byTier.set(tier, []);
    }
    byTier.get(tier).push(id);
    depthById.set(id, 0);
  }

  for (const [, tierIds] of byTier.entries()) {
    if (tierIds.length <= 1) {
      continue;
    }
    const tierSet = new Set(tierIds);
    // Aristas reales son caller -> callee; las bases (callees sin dependencias dentro del tier) tienen depth = 0.
    const calleesOf = new Map(tierIds.map((id) => [id, new Set()]));
    for (const e of callEdges) {
      const s = e.source;
      const t = e.target;
      if (tierSet.has(s) && tierSet.has(t) && s !== t) {
        calleesOf.get(s).add(t);
      }
    }
    // Relajación acotada (segura ante ciclos).
    const maxSteps = Math.min(8, tierIds.length - 1);
    for (let iter = 0; iter < maxSteps; iter += 1) {
      let changed = false;
      for (const id of tierIds) {
        let best = depthById.get(id) || 0;
        for (const callee of calleesOf.get(id)) {
          const cand = (depthById.get(callee) || 0) + 1;
          if (cand > best && cand <= maxSteps) {
            best = cand;
          }
        }
        if (best !== depthById.get(id)) {
          depthById.set(id, best);
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }
  }
  return depthById;
}

function buildCreationElkInput(visibleNodes, visibleEdges, options) {
  const floatingPorts = Boolean(options && options.floatingPorts);
  const elkNodes = new Map();
  const dataById = new Map();
  const orderIndexById = new Map();
  const parentOf = new Map();
  const childrenByParent = new Map();

  visibleNodes.forEach((item, idx) => {
    const d = item.data;
    dataById.set(d.id, d);
    orderIndexById.set(d.id, idx);
    const size = estimateNodeSize(d);
    const isFlowBox = d.expandedFn === "true" || d.flowContainer === "true";
    let nodeLayoutOptions = undefined;
    if (isFlowBox) {
      nodeLayoutOptions = {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.hierarchyHandling": "INCLUDE_CHILDREN",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.spacing.nodeNodeBetweenLayers": "56",
        "elk.layered.spacing.edgeNodeBetweenLayers": "28",
        "elk.layered.spacing.edgeEdgeBetweenLayers": "22",
        "elk.spacing.nodeNode": "40",
        "elk.spacing.edgeNode": "26",
        "elk.spacing.edgeEdge": "22",
        "elk.padding": d.flowContainer === "true"
          ? "[top=44,left=28,bottom=28,right=28]"
          : "[top=52,left=30,bottom=28,right=30]",
      };
    }
    elkNodes.set(d.id, {
      id: d.id,
      width: size.width,
      height: size.height,
      children: [],
      edges: [],
      layoutOptions: nodeLayoutOptions,
    });
  });

  const rootChildren = [];
  for (const item of visibleNodes) {
    const d = item.data;
    const elkNode = elkNodes.get(d.id);
    const parentId = d.parent && elkNodes.has(d.parent) ? d.parent : null;
    parentOf.set(d.id, parentId);
    const parentKey = parentId || "__root__";
    if (!childrenByParent.has(parentKey)) {
      childrenByParent.set(parentKey, []);
    }
    childrenByParent.get(parentKey).push(elkNode);
    if (parentId) {
      elkNodes.get(parentId).children.push(elkNode);
    } else {
      rootChildren.push(elkNode);
    }
  }

  const compareByCreationLine = (a, b) => {
    const da = dataById.get(a.id) || {};
    const db = dataById.get(b.id) || {};
    if (da.type === "flow" || db.type === "flow") {
      return (orderIndexById.get(a.id) ?? 0) - (orderIndexById.get(b.id) ?? 0);
    }
    const lineA = typeof da.line === "number" ? da.line : 0;
    const lineB = typeof db.line === "number" ? db.line : 0;
    if (lineA !== lineB) {
      return lineA - lineB;
    }
    return (orderIndexById.get(a.id) ?? 0) - (orderIndexById.get(b.id) ?? 0);
  };

  const compareLayerFunctions = (a, b) => {
    const da = dataById.get(a.id) || {};
    const db = dataById.get(b.id) || {};
    const fileA = String(a.id).split("::")[0];
    const fileB = String(b.id).split("::")[0];
    if (fileA !== fileB) {
      return fileA.localeCompare(fileB);
    }
    return compareByCreationLine(a, b);
  };

  const makeElkEdge = (edge) => {
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
  };

  const getAncestorsFromRoot = (id) => {
    const chain = [];
    let cur = id;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = parentOf.get(cur) || null;
    }
    return chain.reverse();
  };

  const findEnclosingFlowFn = (nodeId) => {
    let cur = nodeId;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const d = dataById.get(cur);
      if (d && d.expandedFn === "true") {
        return cur;
      }
      cur = parentOf.get(cur) || null;
    }
    return null;
  };

  const findEnclosingContainerId = (nodeId) => {
    let cur = parentOf.get(nodeId) || null;
    while (cur) {
      const d = dataById.get(cur);
      if (d && (d.type === "file" || d.type === "layer" || d.type === "module")) {
        return cur;
      }
      cur = parentOf.get(cur) || null;
    }
    return "root";
  };

  const findFlowEdgeContainer = (srcId, tgtId) => {
    const sParent = parentOf.get(srcId) || null;
    const tParent = parentOf.get(tgtId) || null;
    if (sParent && sParent === tParent) {
      return sParent;
    }
    const sAnc = sParent ? getAncestorsFromRoot(sParent) : [];
    const tAnc = tParent ? getAncestorsFromRoot(tParent) : [];
    let lca = null;
    for (let i = 0; i < sAnc.length && i < tAnc.length; i += 1) {
      if (sAnc[i] === tAnc[i]) {
        lca = sAnc[i];
      } else {
        break;
      }
    }
    return lca || findEnclosingFlowFn(srcId) || findEnclosingFlowFn(tgtId) || "root";
  };

  // Pre-agrupar aristas directas entre hermanos de cada contenedor y aristas de flujo intra-función por LCA exacto.
  const directEdgesByContainer = new Map();
  const flowEdgesByContainer = new Map();
  const crossEdges = [];

  for (const edge of visibleEdges) {
    const src = edge.data.source;
    const tgt = edge.data.target;
    if (!elkNodes.has(src) || !elkNodes.has(tgt) || src === tgt) {
      continue;
    }
    if (edge.data.kind === "flow") {
      const ownerContainer = findFlowEdgeContainer(src, tgt);
      if (!flowEdgesByContainer.has(ownerContainer)) {
        flowEdgesByContainer.set(ownerContainer, []);
      }
      flowEdgesByContainer.get(ownerContainer).push(edge);
      continue;
    }
    const pSrc = parentOf.get(src) || "root";
    const pTgt = parentOf.get(tgt) || "root";
    if (pSrc === pTgt) {
      if (!directEdgesByContainer.has(pSrc)) {
        directEdgesByContainer.set(pSrc, []);
      }
      directEdgesByContainer.get(pSrc).push(edge);
    } else {
      crossEdges.push(edge);
    }
  }

  // Calcular particiones base para todos los contenedores (módulos, archivos, capas) y sus hermanos.
  const partitionById = new Map();
  const assignSiblingContainerPartitions = (containerId, childElkNodes) => {
    const nonPortChildren = childElkNodes.filter((c) => {
      const d = dataById.get(c.id);
      return d && d.type !== "port";
    });
    const basePartById = new Map();
    for (const c of nonPortChildren) {
      basePartById.set(c.id, computeCreationPartition(c.id, dataById, childrenByParent));
    }
    // Proyectar aristas de llamada entre descendientes de estos hermanos para ordenar bases dentro del mismo tier.
    const siblingIdSet = new Set(nonPortChildren.map((c) => c.id));
    const projectedCalls = [];
    const resolveToSibling = (id) => {
      let cur = id;
      while (cur) {
        if (siblingIdSet.has(cur)) {
          return cur;
        }
        cur = parentOf.get(cur) || null;
      }
      return null;
    };
    for (const edge of visibleEdges) {
      if (edge.data.kind === "flow") {
        continue;
      }
      const sSib = resolveToSibling(edge.data.source);
      const tSib = resolveToSibling(edge.data.target);
      if (sSib && tSib && sSib !== tSib) {
        projectedCalls.push({ source: sSib, target: tSib });
      }
    }
    const subDepths = computeIntraTierFoundationDepths(
      nonPortChildren.map((c) => c.id),
      projectedCalls,
      basePartById,
    );
    const outPorts = childElkNodes.filter((c) => {
      const d = dataById.get(c.id);
      return d && d.type === "port" && d.portDir === "out";
    });
    const inPorts = childElkNodes.filter((c) => {
      const d = dataById.get(c.id);
      return d && d.type === "port" && d.portDir === "in";
    });
    const portOffset = floatingPorts && outPorts.length > 0 ? 1 : 0;
    let maxAssigned = portOffset;
    for (const c of nonPortChildren) {
      const tier = basePartById.get(c.id) ?? 0;
      const depth = subDepths.get(c.id) ?? 0;
      const pVal = tier * 10 + depth + portOffset;
      partitionById.set(c.id, pVal);
      if (pVal > maxAssigned) {
        maxAssigned = pVal;
      }
    }
    if (floatingPorts) {
      for (const p of outPorts) {
        partitionById.set(p.id, 0);
      }
      for (const p of inPorts) {
        partitionById.set(p.id, maxAssigned + 1);
      }
    }
    childElkNodes.sort((a, b) => {
      const pa = partitionById.get(a.id) ?? 0;
      const pb = partitionById.get(b.id) ?? 0;
      if (pa !== pb) {
        return pa - pb;
      }
      return compareByCreationLine(a, b);
    });
  };

  // Configurar contenedores que agrupan funciones en bandas 1 -> N (archivos, capas con funciones, o root plano).
  const configureFunctionContainer = (containerId, containerChildren, maxPerBand = null) => {
    const outPorts = containerChildren.filter((c) => {
      const d = dataById.get(c.id);
      return d && d.type === "port" && d.portDir === "out";
    });
    const inPorts = containerChildren.filter((c) => {
      const d = dataById.get(c.id);
      return d && d.type === "port" && d.portDir === "in";
    });
    const internalChildren = containerChildren.filter((c) => {
      const d = dataById.get(c.id);
      return !d || d.type !== "port";
    });
    const containerData = dataById.get(containerId);
    const sortFn = containerData && containerData.type === "layer" ? compareLayerFunctions : compareByCreationLine;
    internalChildren.sort(sortFn);

    const directEdges = directEdgesByContainer.get(containerId) || [];
    const bands = assignCreationBands(internalChildren, directEdges, maxPerBand);
    const portOffset = floatingPorts && outPorts.length > 0 ? 1 : 0;
    bands.forEach((band, bandIdx) => {
      for (const fnNode of band) {
        const partVal = bandIdx + portOffset;
        partitionById.set(fnNode.id, partVal);
        fnNode.layoutOptions = {
          ...(fnNode.layoutOptions || {}),
          "elk.partitioning.partition": String(partVal),
        };
      }
    });
    if (floatingPorts) {
      for (const p of outPorts) {
        partitionById.set(p.id, 0);
        p.layoutOptions = { ...(p.layoutOptions || {}), "elk.partitioning.partition": "0" };
      }
      const inPart = bands.length + portOffset;
      for (const p of inPorts) {
        partitionById.set(p.id, inPart);
        p.layoutOptions = { ...(p.layoutOptions || {}), "elk.partitioning.partition": String(inPart) };
      }
    }
    // Ordenar array de hijos para que `forceNodeModelOrder` coincida exactamente con 1 -> N.
    containerChildren.length = 0;
    containerChildren.push(...outPorts, ...internalChildren, ...inPorts);
  };

  // Configurar contenedores jerárquicos (root, module, layer, file, expandedFn).
  const rootNonPort = rootChildren.filter((c) => (dataById.get(c.id) || {}).type !== "port");
  const rootHasOnlyFunctions = rootNonPort.length > 0
    && rootNonPort.every((c) => {
      const t = (dataById.get(c.id) || {}).type;
      return t === "function" || t === "variable";
    });

  if (rootHasOnlyFunctions) {
    configureFunctionContainer("root", rootChildren, null);
  } else {
    assignSiblingContainerPartitions("root", rootChildren);
  }

  for (const [id, elkNode] of elkNodes.entries()) {
    const d = dataById.get(id);
    if (!d) {
      continue;
    }
    const isFlowBox = d.expandedFn === "true" || d.flowContainer === "true";
    if (isFlowBox) {
      const fEdges = flowEdgesByContainer.get(id) || [];
      if (fEdges.length > 0 && elkNode.children.length > 0) {
        elkNode.edges = fEdges.map(makeElkEdge);
      } else {
        delete elkNode.edges;
      }
      if (elkNode.children.length > 0) {
        delete elkNode.width;
        delete elkNode.height;
      } else {
        delete elkNode.children;
      }
      continue;
    }

    if (elkNode.children.length > 0) {
      const childTypes = elkNode.children.map((c) => (dataById.get(c.id) || {}).type);
      const isFileOrFnLayer = d.type === "file"
        || (d.type === "layer" && childTypes.some((t) => t === "function" || t === "variable"));
      if (isFileOrFnLayer) {
        configureFunctionContainer(id, elkNode.children, d.type === "layer" ? 4 : null);
        const directEdges = directEdgesByContainer.get(id) || [];
        elkNode.edges = directEdges.map(makeElkEdge);
        const selfPart = partitionById.get(id);
        elkNode.layoutOptions = {
          ...CREATION_FILE_ELK_OPTIONS,
          ...(selfPart !== undefined ? { "elk.partitioning.partition": String(selfPart) } : {}),
        };
      } else {
        assignSiblingContainerPartitions(id, elkNode.children);
        const directEdges = directEdgesByContainer.get(id) || [];
        elkNode.edges = directEdges.map(makeElkEdge);
        const selfPart = partitionById.get(id);
        elkNode.layoutOptions = {
          ...CREATION_CONTAINER_ELK_OPTIONS,
          ...(selfPart !== undefined ? { "elk.partitioning.partition": String(selfPart) } : {}),
        };
      }
      delete elkNode.width;
      delete elkNode.height;
    } else {
      const selfPart = partitionById.get(id);
      if (selfPart !== undefined && d.type !== "flow") {
        elkNode.layoutOptions = {
          ...(elkNode.layoutOptions || {}),
          "elk.partitioning.partition": String(selfPart),
        };
      }
      delete elkNode.children;
      delete elkNode.edges;
    }
  }

  for (const rootChild of rootChildren) {
    computeElkSubtreeWidth(rootChild, dataById);
  }

  const rootElkEdges = [
    ...(directEdgesByContainer.get("root") || []),
    ...(flowEdgesByContainer.get("root") || []),
  ].map(makeElkEdge);
  const rootLayoutOptions = rootHasOnlyFunctions
    ? {
        ...CREATION_FILE_ELK_OPTIONS,
        ...(floatingPorts ? { "elk.padding": "[top=24,left=36,bottom=24,right=36]" } : {}),
      }
    : {
        ...CREATION_CONTAINER_ELK_OPTIONS,
        ...(floatingPorts ? { "elk.padding": "[top=24,left=28,bottom=24,right=28]" } : {}),
      };

  const elkGraph = {
    id: "root",
    layoutOptions: rootLayoutOptions,
    children: rootChildren,
    edges: rootElkEdges,
  };

  // Proyectar aristas inter-contenedor como aristas macro ortogonales en su ancestro común (LCA).
  const macroByKey = new Map();
  const crossEdgeMeta = new Map();
  let macroCounter = 0;

  for (const edge of crossEdges) {
    const src = edge.data.source;
    const tgt = edge.data.target;
    const sAnc = getAncestorsFromRoot(src);
    const tAnc = getAncestorsFromRoot(tgt);
    let lcaIdx = -1;
    while (
      lcaIdx + 1 < sAnc.length
      && lcaIdx + 1 < tAnc.length
      && sAnc[lcaIdx + 1] === tAnc[lcaIdx + 1]
    ) {
      lcaIdx += 1;
    }
    const lcaId = lcaIdx >= 0 ? sAnc[lcaIdx] : "root";
    const lcaNode = lcaId === "root" ? elkGraph : elkNodes.get(lcaId);
    const cS = sAnc[lcaIdx + 1];
    const cT = tAnc[lcaIdx + 1];
    if (!lcaNode || !cS || !cT || cS === cT) {
      continue;
    }

    const partS = partitionById.get(cS) ?? 0;
    const partT = partitionById.get(cT) ?? 0;
    // Orientar la arista macro en el sentido descendente de particiones (cimiento -> consumidor) para alinearla con DOWN.
    const reverseMacro = partT <= partS;
    const fromContainer = reverseMacro ? cT : cS;
    const toContainer = reverseMacro ? cS : cT;
    const macroKey = `${lcaId}:${fromContainer}->${toContainer}`;

    crossEdgeMeta.set(edge.data.id, {
      macroKey,
      lcaId,
      srcContainer: cS,
      tgtContainer: cT,
      reverseMacro,
      srcEnclosing: findEnclosingContainerId(src),
      tgtEnclosing: findEnclosingContainerId(tgt),
    });

    if (!macroByKey.has(macroKey)) {
      macroCounter += 1;
      const macroId = `${CREATION_MACRO_EDGE_PREFIX}${macroCounter}`;
      macroByKey.set(macroKey, {
        id: macroId,
        lcaId,
        fromContainer,
        toContainer,
      });
      if (!Array.isArray(lcaNode.edges)) {
        lcaNode.edges = [];
      }
      lcaNode.edges.push({
        id: macroId,
        sources: [fromContainer],
        targets: [toContainer],
      });
    }
  }

  return {
    elkGraph,
    creationMeta: {
      isCreationStrict: true,
      markCrossEdges: !floatingPorts,
      macroByKey,
      crossEdgeMeta,
      parentOf,
      dataById,
    },
  };
}

function buildPostStaggerBoxes(layouted, elkPositions, dataById) {
  const boxOf = new Map();
  const leafBoxes = [];
  const containerBoxes = [];

  const walk = (node) => {
    if (!node) {
      return null;
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const child of node.children) {
        const cb = walk(child);
        if (!cb) {
          continue;
        }
        if (cb.left < minX) minX = cb.left;
        if (cb.top < minY) minY = cb.top;
        if (cb.right > maxX) maxX = cb.right;
        if (cb.bottom > maxY) maxY = cb.bottom;
      }
      if (!Number.isFinite(minX)) {
        return null;
      }
      const d = dataById ? dataById.get(node.id) : null;
      const padLR = d && (d.type === "file" || d.type === "layer") ? 36 : 28;
      const padT = 42;
      const padB = 24;
      const box = {
        id: node.id,
        isContainer: true,
        left: minX - padLR,
        right: maxX + padLR,
        top: minY - padT,
        bottom: maxY + padB,
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        w: (maxX - minX) + padLR * 2,
        h: (maxY - minY) + padT + padB,
      };
      boxOf.set(node.id, box);
      if (node.id !== "root") {
        containerBoxes.push(box);
      }
      return box;
    }
    if (node.id === "root") {
      return null;
    }
    const pos = elkPositions.get(node.id);
    if (!pos) {
      return null;
    }
    const w = node.width || 140;
    const h = node.height || 44;
    const box = {
      id: node.id,
      isContainer: false,
      left: pos.x - w / 2,
      right: pos.x + w / 2,
      top: pos.y - h / 2,
      bottom: pos.y + h / 2,
      cx: pos.x,
      cy: pos.y,
      w,
      h,
    };
    boxOf.set(node.id, box);
    leafBoxes.push(box);
    return box;
  };

  walk(layouted);
  return { boxOf, leafBoxes, containerBoxes };
}

function stitchCrossFileEdgeOntoMacroCorridor(
  srcId,
  tgtId,
  macroPts,
  reverseMacro,
  laneIdx,
  totalLanes,
  boxes,
  srcEnclosingId,
  tgtEnclosingId,
) {
  if (!macroPts || macroPts.length < 2 || !boxes || !boxes.boxOf) {
    return null;
  }
  const { boxOf, leafBoxes, containerBoxes } = boxes;
  const srcB = boxOf.get(srcId);
  const tgtB = boxOf.get(tgtId);
  if (!srcB || !tgtB) {
    return null;
  }
  const srcFileB = boxOf.get(srcEnclosingId) || srcB;
  const tgtFileB = boxOf.get(tgtEnclosingId) || tgtB;
  const ignoreLeaves = new Set([srcId, tgtId]);

  const Q = reverseMacro ? [...macroPts].reverse() : [...macroPts];
  const centered = totalLanes > 1 ? laneIdx - (totalLanes - 1) / 2 : 0;

  const vSegBlocked = (x, y1, y2) => {
    const top = Math.min(y1, y2);
    const bot = Math.max(y1, y2);
    return leafBoxes.some(
      (b) => !ignoreLeaves.has(b.id)
        && x > b.left + 1
        && x < b.right - 1
        && bot > b.top + 1
        && top < b.bottom - 1,
    );
  };

  const hSegBlocked = (y, x1, x2) => {
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    return leafBoxes.some(
      (b) => !ignoreLeaves.has(b.id)
        && y > b.top + 1
        && y < b.bottom - 1
        && right > b.left + 1
        && left < b.right - 1,
    );
  };

  // Medir holgura real alrededor de un corredor vertical para acotar `±7px` sin invadir cajas vecinas.
  const computeClampedVerticalOffset = (baseX, y1, y2, maxCap = 24) => {
    if (centered === 0) {
      return 0;
    }
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);
    let leftClear = maxCap;
    let rightClear = maxCap;
    const obstacles = [...leafBoxes, ...containerBoxes];
    for (const b of obstacles) {
      if (b.id === srcId || b.id === tgtId || b.id === srcEnclosingId || b.id === tgtEnclosingId) {
        continue;
      }
      if (maxY <= b.top + 1 || minY >= b.bottom - 1) {
        continue;
      }
      if (b.right <= baseX + 1) {
        leftClear = Math.min(leftClear, Math.max(0, baseX - b.right - 5));
      } else if (b.left >= baseX - 1) {
        rightClear = Math.min(rightClear, Math.max(0, b.left - baseX - 5));
      }
    }
    const maxHalf = Math.max(0, Math.min(leftClear, rightClear, maxCap));
    if (maxHalf < 1) {
      return 0;
    }
    const safeStep = Math.min(7, (2 * maxHalf) / Math.max(1, totalLanes - 1));
    return Math.max(-maxHalf, Math.min(maxHalf, centered * safeStep));
  };

  // Medir holgura real alrededor de un pasillo horizontal para acotar el offset vertical sin pisar cajas.
  const computeClampedHorizontalOffset = (baseY, x1, x2, maxCap = 16) => {
    if (centered === 0) {
      return 0;
    }
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    let topClear = maxCap;
    let bottomClear = maxCap;
    for (const b of leafBoxes) {
      if (ignoreLeaves.has(b.id)) {
        continue;
      }
      if (maxX <= b.left + 1 || minX >= b.right - 1) {
        continue;
      }
      if (b.bottom <= baseY + 1) {
        topClear = Math.min(topClear, Math.max(0, baseY - b.bottom - 5));
      } else if (b.top >= baseY - 1) {
        bottomClear = Math.min(bottomClear, Math.max(0, b.top - baseY - 5));
      }
    }
    const maxHalf = Math.max(0, Math.min(topClear, bottomClear, maxCap));
    if (maxHalf < 1) {
      return 0;
    }
    const safeStep = Math.min(6, (2 * maxHalf) / Math.max(1, totalLanes - 1));
    return Math.max(-maxHalf, Math.min(maxHalf, centered * safeStep));
  };

  // Offset acotado dentro del margen lateral del archivo (padding 36px -> franja segura ±9px alrededor del centro del gutter).
  const gutterHalf = 9;
  const gutterStep = totalLanes > 1 ? Math.min(5, (2 * gutterHalf) / (totalLanes - 1)) : 0;
  const gutterOff = Math.max(-gutterHalf, Math.min(gutterHalf, centered * gutterStep));

  const findClearHorizontalY = (nodeB, preferBelow, x1, x2) => {
    const step = preferBelow ? 10 : -10;
    const base = preferBelow ? nodeB.bottom + 14 : nodeB.top - 14;
    for (let k = 0; k < 6; k += 1) {
      const candidateY = base + k * step;
      if (!hSegBlocked(candidateY, x1, x2)) {
        return candidateY + computeClampedHorizontalOffset(candidateY, x1, x2, 6);
      }
    }
    return base;
  };

  let entryY;
  let exitY;
  let spinePts = [];

  if (Q.length === 2) {
    const gap = Math.abs(Q[1].y - Q[0].y);
    if (gap > 90) {
      const dir = Q[1].y < Q[0].y ? -1 : 1;
      const baseEntryY = Q[0].y + dir * 16;
      const baseExitY = Q[1].y - dir * 16;
      const spineOff = computeClampedVerticalOffset(Q[0].x, baseEntryY, baseExitY, 22);
      const spineX = Q[0].x + spineOff;
      entryY = baseEntryY + computeClampedHorizontalOffset(baseEntryY, srcB.cx, spineX, 8);
      exitY = baseExitY + computeClampedHorizontalOffset(baseExitY, spineX, tgtB.cx, 8);
      spinePts = [{ x: spineX, y: entryY }, { x: spineX, y: exitY }];
    } else {
      const baseMidY = (Q[0].y + Q[1].y) / 2;
      const yOff = computeClampedHorizontalOffset(baseMidY, srcB.cx, tgtB.cx, Math.max(4, gap * 0.32));
      entryY = baseMidY + yOff;
      exitY = entryY;
    }
  } else if (Q.length === 4) {
    if (Math.abs(Q[0].x - Q[1].x) < 1 && Math.abs(Q[1].y - Q[2].y) < 1) {
      const vGap = Math.abs(Q[1].y - Q[0].y);
      if (vGap > 90) {
        const dir = Q[1].y < Q[0].y ? -1 : 1;
        const baseEntryY = Q[0].y + dir * 16;
        const baseExitY = Q[1].y;
        const spineOff = computeClampedVerticalOffset(Q[0].x, baseEntryY, baseExitY, 22);
        const spineX = Q[0].x + spineOff;
        entryY = baseEntryY + computeClampedHorizontalOffset(baseEntryY, srcB.cx, spineX, 8);
        exitY = baseExitY + computeClampedHorizontalOffset(baseExitY, spineX, tgtB.cx, 12);
        spinePts = [{ x: spineX, y: entryY }, { x: spineX, y: exitY }];
      } else {
        const yOff = computeClampedHorizontalOffset(Q[1].y, srcB.cx, tgtB.cx, 14);
        entryY = Q[1].y + yOff;
        exitY = entryY;
      }
    } else {
      const spineOff = computeClampedVerticalOffset(Q[1].x, Q[1].y, Q[2].y, 22);
      entryY = Q[1].y + computeClampedHorizontalOffset(Q[1].y, srcB.cx, Q[1].x + spineOff, 10);
      exitY = Q[2].y + computeClampedHorizontalOffset(Q[2].y, Q[2].x + spineOff, tgtB.cx, 10);
      spinePts = [
        { x: Q[1].x + spineOff, y: entryY },
        { x: Q[2].x + spineOff, y: exitY },
      ];
    }
  } else {
    const interior = Q.slice(1, -1);
    const spineRefX = interior.length >= 2 ? interior[1].x : interior[0].x;
    const minIntY = Math.min(...interior.map((p) => p.y));
    const maxIntY = Math.max(...interior.map((p) => p.y));
    const spineOff = computeClampedVerticalOffset(spineRefX, minIntY, maxIntY, 22);
    entryY = interior[0].y + computeClampedHorizontalOffset(interior[0].y, srcB.cx, spineRefX + spineOff, 10);
    exitY = interior[interior.length - 1].y
      + computeClampedHorizontalOffset(interior[interior.length - 1].y, spineRefX + spineOff, tgtB.cx, 10);
    spinePts = interior.map((p, idx, arr) => ({
      x: p.x + spineOff,
      y: idx === 0
        ? entryY
        : (idx === arr.length - 1 ? exitY : p.y + (idx === 1 ? (entryY - interior[0].y) : (exitY - interior[arr.length - 1].y))),
    }));
  }

  const pts = [];
  const targetRefX = spinePts.length > 0 ? spinePts[0].x : tgtB.cx;

  // 1. Conectar nodo origen -> pasillo de entrada `entryY`.
  const goingUpFromSrc = entryY < srcB.cy;
  const srcPortY = goingUpFromSrc ? srcB.top : srcB.bottom;
  if (!vSegBlocked(srcB.cx, srcPortY, entryY)) {
    pts.push({ x: srcB.cx, y: srcPortY });
    pts.push({ x: srcB.cx, y: entryY });
  } else {
    const useLeft = targetRefX <= srcB.cx;
    const gutterX = useLeft ? (srcFileB.left + 18 + gutterOff) : (srcFileB.right - 18 + gutterOff);
    const localY = findClearHorizontalY(srcB, !goingUpFromSrc, srcB.cx, gutterX);
    pts.push({ x: srcB.cx, y: srcPortY });
    pts.push({ x: srcB.cx, y: localY });
    pts.push({ x: gutterX, y: localY });
    pts.push({ x: gutterX, y: entryY });
  }

  // 2. Recorrer el tronco ortogonal calculado por ELK.
  if (spinePts.length > 0) {
    for (const sp of spinePts) {
      pts.push(sp);
    }
  }

  // 3. Conectar pasillo de salida `exitY` -> nodo destino.
  const enteringFromBelow = exitY > tgtB.cy;
  const tgtPortY = enteringFromBelow ? tgtB.bottom : tgtB.top;
  if (!vSegBlocked(tgtB.cx, exitY, tgtPortY)) {
    pts.push({ x: tgtB.cx, y: exitY });
    pts.push({ x: tgtB.cx, y: tgtPortY });
  } else {
    const lastX = pts[pts.length - 1].x;
    const useLeft = lastX <= tgtB.cx;
    const gutterX = useLeft ? (tgtFileB.left + 18 + gutterOff) : (tgtFileB.right - 18 + gutterOff);
    const localY = findClearHorizontalY(tgtB, enteringFromBelow, gutterX, tgtB.cx);
    pts.push({ x: gutterX, y: exitY });
    pts.push({ x: gutterX, y: localY });
    pts.push({ x: tgtB.cx, y: localY });
    pts.push({ x: tgtB.cx, y: tgtPortY });
  }

  // Limpiar puntos duplicados o colineales redundantes.
  const dedup = [];
  for (const p of pts) {
    if (dedup.length > 0 && Math.hypot(p.x - dedup[dedup.length - 1].x, p.y - dedup[dedup.length - 1].y) < 0.5) {
      continue;
    }
    dedup.push(p);
  }
  const clean = [];
  for (const p of dedup) {
    while (clean.length >= 2) {
      const a = clean[clean.length - 2];
      const b = clean[clean.length - 1];
      const sameX = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - p.x) < 0.5;
      const sameY = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - p.y) < 0.5;
      if (sameX || sameY) {
        clean.pop();
      } else {
        break;
      }
    }
    clean.push(p);
  }
  return clean.length >= 2 ? clean : null;
}

function applyScopedPinsToLayout(cy, elkPositions, containerOffsets, pinnedPositionsById) {
  const rigidShiftByNodeId = new Map();
  const individuallyPinnedIds = new Set();
  if (!cy || !pinnedPositionsById || pinnedPositionsById.size === 0) {
    return { rigidShiftByNodeId, individuallyPinnedIds };
  }

  const parentNodes = cy.nodes(":parent");
  if (parentNodes.length > 0 && typeof parentNodes.updateCompoundBounds === "function") {
    parentNodes.updateCompoundBounds(true);
  }

  const pinnedContainers = [];
  const pinnedLeaves = [];
  for (const [nodeId, pinnedPos] of pinnedPositionsById.entries()) {
    const cyNode = cy.getElementById(nodeId);
    if (!cyNode || cyNode.length === 0 || !pinnedPos) {
      continue;
    }
    if (cyNode.isParent()) {
      pinnedContainers.push({ node: cyNode, pos: pinnedPos, depth: cyNode.ancestors().length });
    } else {
      pinnedLeaves.push({ node: cyNode, pos: pinnedPos });
    }
  }

  // Fase 1: Contenedores fijados en orden top-down (layer -> module -> file -> expandedFn -> flowContainer).
  // Cada contenedor se traslada como bloque rígido (dx, dy) sin contaminar ni fijar a sus hijos.
  pinnedContainers.sort((a, b) => a.depth - b.depth);
  const addRigidShift = (id, dx, dy) => {
    const prev = rigidShiftByNodeId.get(id);
    if (prev) {
      prev.dx += dx;
      prev.dy += dy;
    } else {
      rigidShiftByNodeId.set(id, { dx, dy });
    }
  };

  for (const { node: containerNode, pos: targetPos } of pinnedContainers) {
    if (typeof containerNode.updateCompoundBounds === "function") {
      containerNode.updateCompoundBounds(true);
    }
    const curCenter = containerNode.position();
    if (!curCenter || !Number.isFinite(curCenter.x) || !Number.isFinite(curCenter.y)) {
      continue;
    }
    const dx = targetPos.x - curCenter.x;
    const dy = targetPos.y - curCenter.y;
    if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
      continue;
    }

    const cId = containerNode.id();
    addRigidShift(cId, dx, dy);
    if (containerOffsets && containerOffsets.has(cId)) {
      const off = containerOffsets.get(cId);
      off.x += dx;
      off.y += dy;
    }

    containerNode.descendants().forEach((desc) => {
      const dId = desc.id();
      addRigidShift(dId, dx, dy);
      if (desc.isParent()) {
        if (containerOffsets && containerOffsets.has(dId)) {
          const off = containerOffsets.get(dId);
          off.x += dx;
          off.y += dy;
        }
      } else {
        const curPos = desc.position();
        const nextPos = { x: curPos.x + dx, y: curPos.y + dy };
        desc.position(nextPos);
        if (elkPositions) {
          elkPositions.set(dId, nextPos);
        }
      }
    });
  }

  // Fase 2: Hojas fijadas individualmente (funciones, archivos/módulos colapsados, pasos flow hoja).
  for (const { node: leafNode, pos: targetPos } of pinnedLeaves) {
    const id = leafNode.id();
    leafNode.position({ x: targetPos.x, y: targetPos.y });
    if (elkPositions) {
      elkPositions.set(id, { x: targetPos.x, y: targetPos.y });
    }
    individuallyPinnedIds.add(id);
  }

  if (parentNodes.length > 0 && typeof parentNodes.updateCompoundBounds === "function") {
    parentNodes.updateCompoundBounds(true);
  }

  return { rigidShiftByNodeId, individuallyPinnedIds };
}

async function computeElkLayoutResult(visibleNodes, visibleEdges) {
  const isCreationOrder = state.layoutOrderMode === "creation";
  let elkGraph;
  let creationMeta = null;
  if (isCreationOrder) {
    const built = buildCreationElkInput(visibleNodes, visibleEdges);
    elkGraph = built.elkGraph;
    creationMeta = built.creationMeta;
  } else {
    elkGraph = buildElkInput(visibleNodes, visibleEdges);
  }
  const layouted = await state.elk.layout(elkGraph);

  const elkPositions = new Map();
  const containerOffsets = new Map([["root", { x: 0, y: 0 }]]);
  collectAbsolutePositions(layouted, 0, 0, elkPositions, containerOffsets);
  return { layouted, elkPositions, containerOffsets, isCreationOrder, creationMeta };
}

function applyComputedElkLayout(computed, visibleNodes) {
  const { layouted, elkPositions, containerOffsets, isCreationOrder, creationMeta } = computed;

  const contextKey = getCurrentLayoutContextKey();
  const ignorePins = Boolean(computeSubgraphFilter());
  const pinnedPositionsById = new Map();
  const leafPinnedIds = new Set();

  if (!ignorePins) {
    state.cy.nodes().forEach((cyNode) => {
      const noteEntry = getNoteEntry(cyNode.id());
      const pinnedPos = getPinnedPositionForContext(noteEntry, contextKey);
      if (pinnedPos) {
        pinnedPositionsById.set(cyNode.id(), pinnedPos);
        if (!cyNode.isParent()) {
          leafPinnedIds.add(cyNode.id());
        }
      }
    });
  }

  let staggerMeta = null;
  if (isCreationOrder) {
    const dataById = new Map(visibleNodes.map((item) => [item.data.id, item.data]));
    const shiftedNodeIds = applyCreationRowStagger(
      layouted,
      elkPositions,
      leafPinnedIds,
      dataById,
      CREATION_ROW_STAGGER_PX,
    );
    staggerMeta = shiftedNodeIds.staggerMeta || null;
  }

  const defaultDirection = "downward";
  let pinResult = { rigidShiftByNodeId: new Map(), individuallyPinnedIds: new Set() };

  state.cy.batch(() => {
    state.cy.nodes().forEach((cyNode) => {
      if (cyNode.isParent()) {
        return;
      }
      const pos = elkPositions.get(cyNode.id());
      if (pos) {
        cyNode.position(pos);
      }
    });
    if (pinnedPositionsById.size > 0) {
      pinResult = applyScopedPinsToLayout(state.cy, elkPositions, containerOffsets, pinnedPositionsById);
    }
  });

  // Enrutar preservando `.elk-routed` en todas las aristas internas de contenedores movidos en bloque,
  // y re-enrutar localmente únicamente las aristas externas incidentes a nodos/contenedores fijados.
  const externalEdgesToReroute = [];
  state.cy.batch(() => {
    applyElkEdgeRoutes(
      state.cy,
      layouted,
      elkPositions,
      containerOffsets,
      pinResult.individuallyPinnedIds,
      defaultDirection,
      staggerMeta,
      creationMeta,
      pinResult.rigidShiftByNodeId,
      externalEdgesToReroute,
    );
  });
  if (externalEdgesToReroute.length > 0) {
    rerouteExternalEdgesLocally(state.cy, externalEdgesToReroute);
  }
}

async function runElkLayout(visibleNodes, visibleEdges) {
  const computed = await computeElkLayoutResult(visibleNodes, visibleEdges);
  applyComputedElkLayout(computed, visibleNodes);
}

function buildElkInput(visibleNodes, visibleEdges, options) {
  const forceExecution = Boolean(options && options.forceExecution);
  if (!forceExecution && state.layoutOrderMode === "creation") {
    return buildCreationElkInput(visibleNodes, visibleEdges).elkGraph;
  }

  const elkNodes = new Map();
  const dataById = new Map();
  const orderIndexById = new Map();
  const parentOf = new Map();
  let hasLayerContainers = false;
  let expandedFnCount = 0;

  visibleNodes.forEach((item, idx) => {
    dataById.set(item.data.id, item.data);
    orderIndexById.set(item.data.id, idx);
    const size = estimateNodeSize(item.data);
    const isFlowBox = item.data.expandedFn === "true" || item.data.flowContainer === "true";
    if (item.data.expandedFn === "true") {
      expandedFnCount += 1;
    }
    const isLayerBox = item.data.type === "layer";
    let nodeLayoutOptions = undefined;
    if (isLayerBox) {
      hasLayerContainers = true;
      nodeLayoutOptions = {
        "elk.partitioning.partition": String(item.data.layerIndex ?? 3),
        "elk.padding": "[top=40,left=22,bottom=20,right=22]",
      };
    } else if (isFlowBox) {
      nodeLayoutOptions = {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.hierarchyHandling": "INCLUDE_CHILDREN",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.spacing.nodeNodeBetweenLayers": "56",
        "elk.layered.spacing.edgeNodeBetweenLayers": "28",
        "elk.layered.spacing.edgeEdgeBetweenLayers": "22",
        "elk.spacing.nodeNode": "40",
        "elk.spacing.edgeNode": "26",
        "elk.spacing.edgeEdge": "22",
        "elk.padding": item.data.flowContainer === "true"
          ? "[top=44,left=28,bottom=28,right=28]"
          : "[top=52,left=30,bottom=28,right=30]",
      };
    }
    elkNodes.set(item.data.id, {
      id: item.data.id,
      width: size.width,
      height: size.height,
      children: [],
      layoutOptions: nodeLayoutOptions,
    });
  });

  const rootChildren = [];
  for (const item of visibleNodes) {
    const elkNode = elkNodes.get(item.data.id);
    const parentId = item.data.parent && elkNodes.has(item.data.parent) ? item.data.parent : null;
    parentOf.set(item.data.id, parentId);
    if (parentId) {
      elkNodes.get(parentId).children.push(elkNode);
    } else {
      rootChildren.push(elkNode);
    }
  }

  const compareElkChildren = (a, b) => {
    const da = dataById.get(a.id) || {};
    const db = dataById.get(b.id) || {};
    if (da.type === "flow" || db.type === "flow") {
      return (orderIndexById.get(a.id) ?? 0) - (orderIndexById.get(b.id) ?? 0);
    }
    const lineA = typeof da.line === "number" ? da.line : 0;
    const lineB = typeof db.line === "number" ? db.line : 0;
    if (lineA !== lineB) {
      return lineA - lineB;
    }
    return (orderIndexById.get(a.id) ?? 0) - (orderIndexById.get(b.id) ?? 0);
  };

  rootChildren.sort(compareElkChildren);
  for (const elkNode of elkNodes.values()) {
    if (elkNode.children.length > 0) {
      if (elkNode.children.length > 1) {
        elkNode.children.sort(compareElkChildren);
      }
      delete elkNode.width;
      delete elkNode.height;
    } else {
      delete elkNode.children;
    }
  }

  for (const rootChild of rootChildren) {
    computeElkSubtreeWidth(rootChild, dataById);
  }

  const getAncestorsFromRoot = (id) => {
    const chain = [];
    let cur = id;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = parentOf.get(cur) || null;
    }
    return chain.reverse();
  };

  const findFlowEdgeContainer = (srcId, tgtId) => {
    const sParent = parentOf.get(srcId) || null;
    const tParent = parentOf.get(tgtId) || null;
    if (sParent && sParent === tParent) {
      return sParent;
    }
    const sAnc = sParent ? getAncestorsFromRoot(sParent) : [];
    const tAnc = tParent ? getAncestorsFromRoot(tParent) : [];
    let lca = null;
    for (let i = 0; i < sAnc.length && i < tAnc.length; i += 1) {
      if (sAnc[i] === tAnc[i]) {
        lca = sAnc[i];
      } else {
        break;
      }
    }
    return lca || "root";
  };

  const makeElkEdge = (edge) => {
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
  };

  const elkEdges = [];
  for (const edge of visibleEdges) {
    const src = edge.data.source;
    const tgt = edge.data.target;
    if (edge.data.kind === "flow" && elkNodes.has(src) && elkNodes.has(tgt) && src !== tgt) {
      const ownerId = findFlowEdgeContainer(src, tgt);
      const ownerNode = ownerId !== "root" ? elkNodes.get(ownerId) : null;
      if (ownerNode && Array.isArray(ownerNode.children) && ownerNode.children.length > 0) {
        if (!Array.isArray(ownerNode.edges)) {
          ownerNode.edges = [];
        }
        ownerNode.edges.push(makeElkEdge(edge));
        continue;
      }
    }
    elkEdges.push(makeElkEdge(edge));
  }

  const multiIntraBoost = expandedFnCount >= 2
    ? {
        "elk.layered.spacing.nodeNodeBetweenLayers": "64",
        "elk.layered.spacing.edgeNodeBetweenLayers": "28",
        "elk.layered.spacing.edgeEdgeBetweenLayers": "22",
        "elk.spacing.nodeNode": "48",
        "elk.spacing.edgeNode": "28",
        "elk.spacing.edgeEdge": "22",
      }
    : {};
  const rootLayoutOptions = hasLayerContainers
    ? {
        ...ELK_LAYOUT_OPTIONS,
        ...multiIntraBoost,
        "elk.direction": "DOWN",
        "elk.partitioning.activate": "true",
      }
    : {
        ...ELK_LAYOUT_OPTIONS,
        ...multiIntraBoost,
        "elk.direction": "DOWN",
      };

  return {
    id: "root",
    layoutOptions: rootLayoutOptions,
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
  if (typeof data.elkWidth === "number" && typeof data.elkHeight === "number") {
    return { width: data.elkWidth, height: data.elkHeight };
  }
  if (typeof data.nodeWidth === "number" && typeof data.nodeHeight === "number") {
    return { width: data.nodeWidth, height: data.nodeHeight };
  }
  if (data.type === "flow") {
    return estimateFlowStepSize(data.role, data.flowKind || "step", data.label);
  }
  if (data.type === "variable") {
    const textLen = String(data.label || "").length;
    return {
      width: Math.max(94, Math.min(200, Math.round(textLen * 7 + 28))),
      height: 30,
    };
  }
  const { lineCount, longestLine } = estimateWrappedTextMetrics(data.label, 25);
  const width = Math.max(125, Math.min(245, longestLine * 7.5 + 36));
  const baseHeight = data.role === "decision" ? 68 : 44;
  const height = Math.max(baseHeight, lineCount * 15 + 24);
  return { width, height };
}

function collectAbsolutePositions(elkNode, offsetX, offsetY, outMap, containerOffsets = null) {
  if (!elkNode.children) {
    return;
  }
  for (const child of elkNode.children) {
    const absX = offsetX + (child.x || 0);
    const absY = offsetY + (child.y || 0);
    if (child.children && child.children.length > 0) {
      if (containerOffsets) {
        containerOffsets.set(child.id, { x: absX, y: absY });
      }
      collectAbsolutePositions(child, absX, absY, outMap, containerOffsets);
    } else {
      outMap.set(child.id, {
        x: absX + (child.width || 125) / 2,
        y: absY + (child.height || 44) / 2,
      });
    }
  }
}

function convertElkPointsToCytoscapeSegments(points, srcPos, tgtPos) {
  const dx = tgtPos.x - srcPos.x;
  const dy = tgtPos.y - srcPos.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 4) {
    return null;
  }
  const len = Math.sqrt(lenSq);
  const weights = [];
  const distances = [];
  let prev = null;

  for (const pt of points) {
    if (!pt || typeof pt.x !== "number" || typeof pt.y !== "number") {
      continue;
    }
    if (prev && Math.hypot(pt.x - prev.x, pt.y - prev.y) < 1.5) {
      continue;
    }
    const vx = pt.x - srcPos.x;
    const vy = pt.y - srcPos.y;
    const w = (vx * dx + vy * dy) / lenSq;
    // Inversa exacta del vector normal en Cytoscape (`vectorNormInverse = { x: -dy/len, y: dx/len }`).
    const d = (vx * (-dy) + vy * dx) / len;
    if (!Number.isFinite(w) || !Number.isFinite(d)) {
      continue;
    }
    weights.push(Math.round(w * 10000) / 10000);
    distances.push(Math.round(d * 100) / 100);
    prev = pt;
    if (weights.length >= 16) {
      break;
    }
  }
  if (weights.length === 0) {
    return null;
  }
  return { weights, distances };
}

function collectAllLayoutedEdges(elkNode, outList) {
  const ownerContainerId = elkNode && elkNode.id ? elkNode.id : "root";
  if (Array.isArray(elkNode.edges)) {
    for (const edge of elkNode.edges) {
      if (!edge.container) {
        edge.container = ownerContainerId;
      }
      outList.push(edge);
    }
  }
  if (Array.isArray(elkNode.children)) {
    for (const child of elkNode.children) {
      collectAllLayoutedEdges(child, outList);
    }
  }
}

function applyElkEdgeRoutes(
  cy,
  layouted,
  elkPositions,
  containerOffsets,
  pinnedNodeIds = new Set(),
  defaultDirection = "downward",
  staggerMeta = null,
  creationMeta = null,
  rigidShiftByNodeId = null,
  outExternalEdges = null,
) {
  if (!cy || !layouted) {
    return;
  }
  cy.edges().removeClass("creation-cross-edge compound-incident");
  // Forzar recálculo inmediato de cajas compuestas (flowContainer / expandedFn) incluso dentro de cy.batch().
  const parentNodes = cy.nodes(":parent");
  if (parentNodes.length > 0 && typeof parentNodes.updateCompoundBounds === "function") {
    parentNodes.updateCompoundBounds(true);
  }

  const getRigidShift = (id) => {
    if (!rigidShiftByNodeId) {
      return { dx: 0, dy: 0 };
    }
    return rigidShiftByNodeId.get(id) || { dx: 0, dy: 0 };
  };

  const hasRelativeShift = (srcId, tgtId) => {
    if (!rigidShiftByNodeId || rigidShiftByNodeId.size === 0) {
      return false;
    }
    const s = getRigidShift(srcId);
    const t = getRigidShift(tgtId);
    return Math.abs(s.dx - t.dx) > 0.1 || Math.abs(s.dy - t.dy) > 0.1;
  };

  const allElkEdges = [];
  collectAllLayoutedEdges(layouted, allElkEdges);

  const isCreationStrict = Boolean(creationMeta && creationMeta.isCreationStrict);
  const macroPtsByKey = new Map();
  const macroKeyByEdgeId = new Map();
  if (isCreationStrict && creationMeta.macroByKey) {
    for (const [mKey, mInfo] of creationMeta.macroByKey.entries()) {
      macroKeyByEdgeId.set(mInfo.id, { key: mKey, info: mInfo });
    }
  }

  const clearElkRoute = (cyEdge) => {
    cyEdge.removeClass("elk-routed");
    cyEdge.removeData("srcEndpoint tgtEndpoint");
  };

  const isContainmentPair = (a, b) => {
    if (!a || !b || a.length === 0 || b.length === 0) {
      return false;
    }
    return a.ancestors().anySame(b) || b.ancestors().anySame(a);
  };

  const getNodeGeom = (cyNode) => {
    if (!cyNode || cyNode.length === 0) {
      return null;
    }
    const id = cyNode.id();
    const isParent = cyNode.isParent();
    const rawPos = isParent ? cyNode.position() : (elkPositions.get(id) || cyNode.position());
    if (!rawPos || !Number.isFinite(rawPos.x) || !Number.isFinite(rawPos.y)) {
      return null;
    }
    const ow = cyNode.outerWidth();
    const oh = cyNode.outerHeight();
    const width = Number.isFinite(ow) && ow > 2 ? ow : 140;
    const height = Number.isFinite(oh) && oh > 2 ? oh : 44;
    const shape = String(cyNode.style("shape") || "round-rectangle");
    return {
      cx: rawPos.x,
      cy: rawPos.y,
      hw: width / 2,
      hh: height / 2,
      shape,
      isParent,
    };
  };

  const clampVal = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round1 = (v) => Math.round(v * 10) / 10;

  const projectPointOntoNodeBorder = (pt, refPt, geom) => {
    const segDx = refPt.x - pt.x;
    const segDy = refPt.y - pt.y;
    let dx = 0;
    let dy = 0;

    if (Math.abs(segDx) <= 1.5 && Math.abs(segDy) > 0.5) {
      const dirY = segDy >= 0 ? 1 : -1;
      dx = clampVal(pt.x - geom.cx, -geom.hw + 1, geom.hw - 1);
      if (geom.shape === "round-diamond" || geom.shape === "diamond") {
        const frac = Math.min(0.96, Math.abs(dx) / Math.max(1, geom.hw));
        dy = dirY * geom.hh * (1 - frac);
      } else if (geom.shape === "ellipse") {
        const frac = Math.min(0.98, Math.abs(dx) / Math.max(1, geom.hw));
        dy = dirY * geom.hh * Math.sqrt(Math.max(0.04, 1 - frac * frac));
      } else {
        dy = dirY * geom.hh;
      }
    } else if (Math.abs(segDy) <= 1.5 && Math.abs(segDx) > 0.5) {
      const dirX = segDx >= 0 ? 1 : -1;
      dy = clampVal(pt.y - geom.cy, -geom.hh + 1, geom.hh - 1);
      if (geom.shape === "round-diamond" || geom.shape === "diamond") {
        const frac = Math.min(0.96, Math.abs(dy) / Math.max(1, geom.hh));
        dx = dirX * geom.hw * (1 - frac);
      } else if (geom.shape === "ellipse") {
        const frac = Math.min(0.98, Math.abs(dy) / Math.max(1, geom.hh));
        dx = dirX * geom.hw * Math.sqrt(Math.max(0.04, 1 - frac * frac));
      } else {
        dx = dirX * geom.hw;
      }
    } else {
      const rx = refPt.x - geom.cx;
      const ry = refPt.y - geom.cy;
      if (Math.abs(rx) < 0.001 && Math.abs(ry) < 0.001) {
        dx = 0;
        dy = geom.hh;
      } else if (geom.shape === "round-diamond" || geom.shape === "diamond") {
        const denom = Math.abs(rx) / Math.max(1, geom.hw) + Math.abs(ry) / Math.max(1, geom.hh);
        const t = denom > 0 ? 1 / denom : 0;
        dx = rx * t;
        dy = ry * t;
      } else if (geom.shape === "ellipse") {
        const denom = Math.hypot(rx / Math.max(1, geom.hw), ry / Math.max(1, geom.hh));
        const t = denom > 0 ? 1 / denom : 0;
        dx = rx * t;
        dy = ry * t;
      } else {
        const denom = Math.max(Math.abs(rx) / Math.max(1, geom.hw), Math.abs(ry) / Math.max(1, geom.hh));
        const t = denom > 0 ? 1 / denom : 0;
        dx = rx * t;
        dy = ry * t;
      }
    }

    const rdx = round1(dx);
    const rdy = round1(dy);
    return {
      x: geom.cx + rdx,
      y: geom.cy + rdy,
      dx: rdx,
      dy: rdy,
      endpointStr: `${rdx}px ${rdy}px`,
    };
  };

  const applySafeElkSegments = (cyEdge, absPoints, srcGeom, tgtGeom) => {
    if (!absPoints || absPoints.length < 2 || !srcGeom || !tgtGeom) {
      return false;
    }
    const firstPt = absPoints[0];
    const lastPt = absPoints[absPoints.length - 1];
    const srcRef = absPoints[1];
    const tgtRef = absPoints[absPoints.length - 2];

    const srcEnd = projectPointOntoNodeBorder(firstPt, srcRef, srcGeom);
    const tgtEnd = projectPointOntoNodeBorder(lastPt, tgtRef, tgtGeom);

    if (
      !Number.isFinite(srcEnd.x)
      || !Number.isFinite(srcEnd.y)
      || !Number.isFinite(tgtEnd.x)
      || !Number.isFinite(tgtEnd.y)
      || Math.hypot(tgtEnd.x - srcEnd.x, tgtEnd.y - srcEnd.y) < 2
    ) {
      return false;
    }

    // Pasar únicamente puntos estrictamente interiores para evitar colapso de endpoints en Cytoscape 3.30 (`badLine`).
    let interior = [];
    for (let i = 1; i < absPoints.length - 1; i += 1) {
      const pt = absPoints[i];
      if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
        continue;
      }
      if (Math.hypot(pt.x - srcEnd.x, pt.y - srcEnd.y) < 1.5) {
        continue;
      }
      if (Math.hypot(pt.x - tgtEnd.x, pt.y - tgtEnd.y) < 1.5) {
        continue;
      }
      interior.push(pt);
    }

    if (interior.length === 0) {
      interior = [
        {
          x: (srcEnd.x + tgtEnd.x) / 2,
          y: (srcEnd.y + tgtEnd.y) / 2,
        },
      ];
    }

    const segments = convertElkPointsToCytoscapeSegments(interior, srcEnd, tgtEnd);
    if (!segments) {
      return false;
    }

    cyEdge.data("srcEndpoint", srcEnd.endpointStr);
    cyEdge.data("tgtEndpoint", tgtEnd.endpointStr);
    cyEdge.data("segWeights", segments.weights);
    cyEdge.data("segDistances", segments.distances);
    cyEdge.addClass("elk-routed");
    return true;
  };

  const resolveEdgeTaxiDir = (srcPos, tgtPos) => {
    if (isCreationStrict && srcPos && tgtPos) {
      return tgtPos.y < srcPos.y ? "upward" : "downward";
    }
    return defaultDirection;
  };

  for (const elkEdge of allElkEdges) {
    // Recolectar los corredores macro sintéticos calculados por ELK en modo Creación (1 -> N).
    if (macroKeyByEdgeId.has(elkEdge.id)) {
      const { key, info } = macroKeyByEdgeId.get(elkEdge.id);
      const section = Array.isArray(elkEdge.sections) ? elkEdge.sections[0] : null;
      if (section) {
        const edgeContainer = elkEdge.container || info.lcaId || "root";
        const offset = (containerOffsets && containerOffsets.get(edgeContainer)) || { x: 0, y: 0 };
        const pts = adjustElkSectionPoints(
          section,
          edgeContainer,
          offset,
          info.fromContainer,
          info.toContainer,
          staggerMeta,
          true,
        );
        if (pts.length >= 2) {
          macroPtsByKey.set(key, pts);
        }
      }
      continue;
    }

    const cyEdge = cy.getElementById(elkEdge.id);
    if (!cyEdge || cyEdge.length === 0) {
      continue;
    }
    const srcNode = cyEdge.source();
    const tgtNode = cyEdge.target();
    const srcId = srcNode.id();
    const tgtId = tgtNode.id();
    const srcGeom = getNodeGeom(srcNode);
    const tgtGeom = getNodeGeom(tgtNode);
    const srcPos = srcGeom ? { x: srcGeom.cx, y: srcGeom.cy } : null;
    const tgtPos = tgtGeom ? { x: tgtGeom.cx, y: tgtGeom.cy } : null;

    if (srcNode.isParent() || tgtNode.isParent()) {
      cyEdge.addClass("compound-incident");
    }

    cyEdge.data("taxiDir", resolveEdgeTaxiDir(srcPos, tgtPos));
    if (cyEdge.isLoop()) {
      clearElkRoute(cyEdge);
      continue;
    }

    if (isContainmentPair(srcNode, tgtNode)) {
      clearElkRoute(cyEdge);
      continue;
    }

    const endpointPinned = Boolean(pinnedNodeIds && (pinnedNodeIds.has(srcId) || pinnedNodeIds.has(tgtId)));
    const endpointShiftedRel = hasRelativeShift(srcId, tgtId);
    if (endpointPinned || endpointShiftedRel) {
      clearElkRoute(cyEdge);
      if (Array.isArray(outExternalEdges)) {
        outExternalEdges.push(cyEdge);
      }
      continue;
    }

    const section = Array.isArray(elkEdge.sections) ? elkEdge.sections[0] : null;
    if (!section || !srcGeom || !tgtGeom) {
      clearElkRoute(cyEdge);
      continue;
    }

    const edgeContainer = elkEdge.container || "root";
    const offset = (containerOffsets && containerOffsets.get(edgeContainer)) || { x: 0, y: 0 };
    let absPoints = adjustElkSectionPoints(section, edgeContainer, offset, srcId, tgtId, staggerMeta);
    if (rigidShiftByNodeId && rigidShiftByNodeId.size > 0) {
      const endShift = getRigidShift(srcId);
      const contShift = getRigidShift(edgeContainer);
      const extraDx = endShift.dx - contShift.dx;
      const extraDy = endShift.dy - contShift.dy;
      if (Math.abs(extraDx) > 0.05 || Math.abs(extraDy) > 0.05) {
        absPoints = absPoints.map((pt) => ({ x: pt.x + extraDx, y: pt.y + extraDy }));
      }
    }

    if (!applySafeElkSegments(cyEdge, absPoints, srcGeom, tgtGeom)) {
      clearElkRoute(cyEdge);
    }
  }

  // En modo Creación estricto, coser las aristas inter-archivo sobre los corredores macro ortogonales de ELK.
  if (isCreationStrict && creationMeta.crossEdgeMeta && creationMeta.crossEdgeMeta.size > 0) {
    const boxes = buildPostStaggerBoxes(layouted, elkPositions, creationMeta.dataById);
    const macroTotalCounts = new Map();
    for (const meta of creationMeta.crossEdgeMeta.values()) {
      macroTotalCounts.set(meta.macroKey, (macroTotalCounts.get(meta.macroKey) || 0) + 1);
    }
    const macroLaneCursor = new Map();

    for (const [edgeId, meta] of creationMeta.crossEdgeMeta.entries()) {
      const cyEdge = cy.getElementById(edgeId);
      if (!cyEdge || cyEdge.length === 0) {
        continue;
      }
      if (creationMeta.markCrossEdges && cyEdge.data("kind") === "call") {
        cyEdge.addClass("creation-cross-edge");
      }

      const srcNode = cyEdge.source();
      const tgtNode = cyEdge.target();
      const srcId = srcNode.id();
      const tgtId = tgtNode.id();
      const srcGeom = getNodeGeom(srcNode);
      const tgtGeom = getNodeGeom(tgtNode);
      const srcPos = srcGeom ? { x: srcGeom.cx, y: srcGeom.cy } : null;
      const tgtPos = tgtGeom ? { x: tgtGeom.cx, y: tgtGeom.cy } : null;

      if (srcNode.isParent() || tgtNode.isParent()) {
        cyEdge.addClass("compound-incident");
      }

      cyEdge.data("taxiDir", resolveEdgeTaxiDir(srcPos, tgtPos));
      if (cyEdge.isLoop() || isContainmentPair(srcNode, tgtNode) || !srcGeom || !tgtGeom) {
        clearElkRoute(cyEdge);
        continue;
      }

      const endpointPinned = Boolean(pinnedNodeIds && (pinnedNodeIds.has(srcId) || pinnedNodeIds.has(tgtId)));
      const endpointShiftedRel = hasRelativeShift(srcId, tgtId);
      if (endpointPinned || endpointShiftedRel) {
        clearElkRoute(cyEdge);
        if (Array.isArray(outExternalEdges)) {
          outExternalEdges.push(cyEdge);
        }
        continue;
      }

      const macroPts = macroPtsByKey.get(meta.macroKey);
      const laneIdx = macroLaneCursor.get(meta.macroKey) || 0;
      macroLaneCursor.set(meta.macroKey, laneIdx + 1);
      const totalLanes = macroTotalCounts.get(meta.macroKey) || 1;

      const absPoints = stitchCrossFileEdgeOntoMacroCorridor(
        srcId,
        tgtId,
        macroPts,
        meta.reverseMacro,
        laneIdx,
        totalLanes,
        boxes,
        meta.srcEnclosing,
        meta.tgtEnclosing,
      );
      if (!absPoints || absPoints.length < 2) {
        clearElkRoute(cyEdge);
        continue;
      }

      if (!applySafeElkSegments(cyEdge, absPoints, srcGeom, tgtGeom)) {
        clearElkRoute(cyEdge);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Modo Foco multi-rama (Tecla T, ↑/↓ elegir rama, →/Enter saltar, ← volver)
// y Resaltado de Hilos de Ejecución
// ---------------------------------------------------------------------------

function applyIntraZoomReadability() {
  if (!state.cy) {
    return;
  }
  const flowEdges = state.cy.edges('edge[kind = "flow"]');
  if (flowEdges.length === 0) {
    return;
  }
  const compactLabels = state.expandedFunctions.size >= 2 && state.cy.zoom() < 0.62;
  flowEdges.toggleClass("zoom-compact-label", compactLabels);
}

function applyIntraMultiFunctionClarity() {
  if (!state.cy) {
    return;
  }
  const flowEdges = state.cy.edges('edge[kind = "flow"]');
  flowEdges.removeClass("flow-bg-muted flow-focus-active");
  applyIntraZoomReadability();

  if (state.expandedFunctions.size < 2 || state.traceMode || state.activeFlowId) {
    return;
  }
  const focusFnId = (state.hoveredNodeId && state.expandedFunctions.has(state.hoveredNodeId))
    ? state.hoveredNodeId
    : (state.selectedNodeId && state.expandedFunctions.has(state.selectedNodeId) ? state.selectedNodeId : null);
  if (!focusFnId) {
    return;
  }
  flowEdges.forEach((edge) => {
    const srcOwner = edge.source().data("ownerFunctionId") || edge.source().id();
    const tgtOwner = edge.target().data("ownerFunctionId") || edge.target().id();
    if (srcOwner === focusFnId || tgtOwner === focusFnId) {
      edge.addClass("flow-focus-active");
    } else {
      edge.addClass("flow-bg-muted");
    }
  });
}

function applyCanvasHighlights() {
  if (!state.cy) {
    return;
  }
  const all = state.cy.elements();
  all.removeClass(
    "dimmed trace-focus trace-caller trace-callee trace-branch-active flow-active flow-root flow-active-edge edge-muted edge-reveal-in edge-reveal-out edge-reveal-internal flow-bg-muted flow-focus-active",
  );

  updateIsolateContextButtons();

  if (state.traceMode) {
    applyTraceHighlight();
    return;
  }
  hideTraceBranchHud();
  if (state.activeFlowId) {
    applyExecutionFlowHighlight();
  }
  if (state.onDemandEdges) {
    applyOnDemandEdgeHighlight();
  }
  applyIntraMultiFunctionClarity();
}

function applyOnDemandEdgeHighlight() {
  if (!state.cy) {
    return;
  }
  const callEdges = state.cy.edges('edge[kind = "call"]');
  callEdges.removeClass("edge-muted edge-reveal-in edge-reveal-out edge-reveal-internal");
  if (!state.onDemandEdges || state.traceMode) {
    return;
  }

  // Atenuar aristas no prioritarias (respetando las de un hilo activo si lo hay).
  callEdges.forEach((edge) => {
    if (!edge.hasClass("flow-active-edge")) {
      edge.addClass("edge-muted");
    }
  });

  const anchorIds = [];
  if (state.selectedNodeId) {
    anchorIds.push(state.selectedNodeId);
  }
  if (state.hoveredNodeId && state.hoveredNodeId !== state.selectedNodeId) {
    anchorIds.push(state.hoveredNodeId);
  }

  for (const anchorId of anchorIds) {
    const anchor = state.cy.getElementById(anchorId);
    if (!anchor || anchor.length === 0) {
      continue;
    }
    const scope = anchor.isParent() ? anchor.union(anchor.descendants()) : anchor;
    const scopeIds = new Set();
    scope.forEach((n) => scopeIds.add(n.id()));

    scope.connectedEdges('edge[kind = "call"]').forEach((edge) => {
      const srcIn = scopeIds.has(edge.source().id());
      const tgtIn = scopeIds.has(edge.target().id());
      edge.removeClass("edge-muted");
      if (!state.activeFlowId) {
        edge.removeClass("dimmed");
      }
      if (srcIn && tgtIn) {
        edge.addClass("edge-reveal-internal");
      } else if (tgtIn) {
        edge.addClass("edge-reveal-in");
      } else if (srcIn) {
        edge.addClass("edge-reveal-out");
      }
    });
  }
}

function applyExecutionFlowHighlight() {
  const flow = getActiveFlow();
  if (!flow || !state.cy) {
    return;
  }
  const isIsolated = Boolean(state.isolateActiveContext);
  const flowNodeSet = new Set(flow.node_ids || []);
  const flowEdgeSet = new Set(flow.edge_ids || []);
  const all = state.cy.elements();
  if (!isIsolated) {
    all.addClass("dimmed");
  }

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

async function toggleTraceMode() {
  const wasIsolated = state.isolateActiveContext;
  state.traceMode = !state.traceMode;
  state.traceDirection = "forward";
  state.traceBranchIndex = 0;
  if (!state.traceMode) {
    state.traceHistory = [];
    state.traceBranchCandidates = [];
    if (!state.activeFlowId) {
      state.isolateActiveContext = false;
    }
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
    if (!fallback || fallback.length === 0) {
      fallback = state.cy.nodes('node[type = "file"]').first();
    }
    if (fallback && fallback.length > 0) {
      fallback.select();
      selectNode(fallback.id());
    }
  }

  updateIsolateContextButtons();
  if (wasIsolated || state.isolateActiveContext) {
    await refreshGraphView({ fit: true });
    if (state.selectedNodeId && state.cy) {
      const sel = state.cy.getElementById(state.selectedNodeId);
      if (sel && sel.length > 0) {
        sel.select();
      }
    }
    return;
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

  if (!state.isolateActiveContext) {
    all.addClass("dimmed");
  }
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

async function jumpTraceToNode(targetNodeOrId, pushHistory) {
  const targetId = typeof targetNodeOrId === "string"
    ? targetNodeOrId
    : (targetNodeOrId && targetNodeOrId.length > 0 ? targetNodeOrId.id() : null);
  if (!targetId || !state.nodesById.has(targetId)) {
    return;
  }
  if (pushHistory && state.selectedNodeId) {
    state.traceHistory.push(state.selectedNodeId);
  }
  state.traceDirection = "forward";
  state.traceBranchIndex = 0;
  selectNode(targetId);

  if (state.isolateActiveContext) {
    await refreshGraphView({ fit: true });
    const isolatedTarget = state.cy.getElementById(targetId);
    if (isolatedTarget && isolatedTarget.length > 0) {
      isolatedTarget.select();
    }
    return;
  }

  const targetNode = state.cy.getElementById(targetId);
  if (!targetNode || targetNode.length === 0) {
    return;
  }
  state.cy.nodes().unselect();
  targetNode.select();
  applyCanvasHighlights();
  state.cy.animate({ center: { eles: targetNode }, duration: 180 });
}

async function confirmTraceBranch() {
  if (!state.traceMode || !state.selectedNodeId) {
    return;
  }
  const picked = state.traceBranchCandidates[state.traceBranchIndex];
  if (!picked) {
    return;
  }
  await jumpTraceToNode(picked.nodeId, state.traceDirection === "forward");
}

async function stepTrace(direction) {
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
    await confirmTraceBranch();
    return;
  }

  if (direction === "backward") {
    if (state.traceDirection === "backward" && state.traceBranchCandidates.length > 0) {
      await confirmTraceBranch();
      return;
    }
    if (state.traceHistory.length > 0) {
      const prevId = state.traceHistory.pop();
      if (prevId && state.nodesById.has(prevId)) {
        await jumpTraceToNode(prevId, false);
        return;
      }
    }
    const callers = collectTraceCandidates(focus, "backward");
    if (callers.length === 1) {
      await jumpTraceToNode(callers[0].nodeId, false);
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
  if (isLayerContainerId(nodeId)) {
    if (state.collapsedContainers.has(nodeId)) {
      state.collapsedContainers.delete(nodeId);
    } else {
      state.collapsedContainers.add(nodeId);
    }
    await refreshGraphView({ fit: true });
    return;
  }
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

function shortSummaryLabel(nodeId) {
  const node = state.nodesById.get(nodeId);
  if (!node) {
    return nodeId;
  }
  if (node.type === "function" && nodeId.includes("::")) {
    const [filePart, fnPart] = nodeId.split("::");
    const fileName = filePart.split("/").pop() || filePart;
    return `${fileName}::${fnPart}()`;
  }
  return node.id;
}

function renderEmptyInspectorSummary() {
  const container = document.getElementById("details-empty");
  if (!container || !state.rawGraph) {
    return;
  }

  const levelMeta = LEVEL_METADATA[state.activeLevel] || LEVEL_METADATA[2];
  const badgeEl = document.getElementById("summary-level-badge");
  const titleEl = document.getElementById("summary-title");
  const hintEl = document.getElementById("summary-hint");
  const statsEl = document.getElementById("summary-stats");

  if (badgeEl) {
    const modeTag = state.groupingMode === "layers" ? " · Capas" : "";
    const isoTag = state.isolatedFileId ? " · Archivo aislado" : (state.nhops.active ? " · N-hops" : "");
    badgeEl.textContent = `${levelMeta.badge}${modeTag}${isoTag}`;
  }
  if (titleEl) {
    titleEl.textContent = state.isolatedFileId
      ? `Foco en ${state.isolatedFileId}`
      : (state.groupingMode === "layers" ? `${levelMeta.title} (Capas de Flujo)` : levelMeta.title);
  }
  if (hintEl) {
    hintEl.textContent = state.groupingMode === "layers"
      ? "Flujo estratificado de arriba hacia abajo: Entradas/UI → Orquestadores → Servicios/Estado → Utilidades."
      : levelMeta.hint;
  }

  if (statsEl) {
    statsEl.innerHTML = "";
    const counts = state.lastVisibleSummaryCounts || { layers: 0, modules: 0, files: 0, functions: 0, edges: 0 };
    const pills = [];
    if (counts.layers > 0) {
      pills.push(`${counts.layers} capas`);
    }
    if (counts.modules > 0) {
      pills.push(`${counts.modules} mód.`);
    }
    if (counts.files > 0) {
      pills.push(`${counts.files} arch.`);
    }
    if (counts.functions > 0) {
      pills.push(`${counts.functions} fns`);
    }
    pills.push(`${counts.edges} conex.`);
    for (const text of pills) {
      const span = document.createElement("span");
      span.className = "summary-stat-pill";
      span.textContent = text;
      statsEl.appendChild(span);
    }
  }

  // 1. Puntos de entrada adaptados al nivel activo (archivos en N1/N2; funciones en N3/N3+).
  const entriesBlock = document.getElementById("summary-entries-block");
  const entriesList = document.getElementById("summary-entries-list");
  if (entriesBlock && entriesList) {
    entriesList.innerHTML = "";
    const meta = state.rawGraph.meta || {};
    const entryFiles = meta.main_entry_files || [];
    const entryFns = meta.main_entry_functions || [];
    let entryIds = state.activeLevel <= 2
      ? (entryFiles.length > 0 ? entryFiles : entryFns)
      : (entryFns.length > 0 ? entryFns : entryFiles);
    entryIds = entryIds.filter((id) => state.nodesById.has(id)).slice(0, 6);

    if (entryIds.length === 0) {
      entriesBlock.classList.add("hidden");
    } else {
      for (const id of entryIds) {
        const node = state.nodesById.get(id);
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "summary-item-btn";
        const mainSpan = document.createElement("span");
        mainSpan.className = "summary-item-main";
        mainSpan.textContent = shortSummaryLabel(id);
        mainSpan.title = id;
        const metaSpan = document.createElement("span");
        metaSpan.className = "summary-item-meta main";
        metaSpan.textContent = node && node.type === "file"
          ? (node.language === "html" ? "HTML" : "★ Entrada")
          : "INICIO";
        btn.appendChild(mainSpan);
        btn.appendChild(metaSpan);
        btn.addEventListener("click", () => navigateToNode(id));
        li.appendChild(btn);
        entriesList.appendChild(li);
      }
      entriesBlock.classList.remove("hidden");
    }
  }

  // 2. Conexiones principales visibles (ordenadas por peso de llamadas y prioridad semántica).
  const connBlock = document.getElementById("summary-connections-block");
  const connList = document.getElementById("summary-connections-list");
  if (connBlock && connList) {
    connList.innerHTML = "";
    const topEdges = [...(state.lastProjectedEdges || [])]
      .sort((a, b) => {
        const countDiff = (b.call_count || 1) - (a.call_count || 1);
        if (countDiff !== 0) {
          return countDiff;
        }
        const prioA = EDGE_TYPE_PRIORITY[a.edgeType] || 99;
        const prioB = EDGE_TYPE_PRIORITY[b.edgeType] || 99;
        return prioA - prioB;
      })
      .slice(0, 6);

    if (topEdges.length === 0) {
      connBlock.classList.add("hidden");
    } else {
      for (const edge of topEdges) {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "summary-item-btn";
        const srcName = shortSummaryLabel(edge.source);
        const tgtName = shortSummaryLabel(edge.target);
        const mainSpan = document.createElement("span");
        mainSpan.className = "summary-item-main";
        mainSpan.textContent = `${srcName} → ${tgtName}`;
        mainSpan.title = `${edge.source} → ${edge.target}`;

        const metaSpan = document.createElement("span");
        metaSpan.className = "summary-item-meta conn";
        const edgeMeta = EDGE_TYPE_META[edge.edgeType] || { icon: "→" };
        const badgeParts = [];
        if (edge.edgeType && edge.edgeType !== "direct_call") {
          badgeParts.push(edgeMeta.icon);
        }
        if ((edge.call_count || 1) > 1) {
          badgeParts.push(`×${edge.call_count}`);
        }
        metaSpan.textContent = badgeParts.length > 0 ? badgeParts.join(" ") : "→";

        btn.appendChild(mainSpan);
        btn.appendChild(metaSpan);
        btn.addEventListener("click", () => navigateToNode(edge.source));
        li.appendChild(btn);
        connList.appendChild(li);
      }
      connBlock.classList.remove("hidden");
    }
  }

  // 3. Hilos de ejecución clicables (se ocultan si #active-flow-panel ya está activo arriba).
  const flowsBlock = document.getElementById("summary-flows-block");
  const flowsList = document.getElementById("summary-flows-list");
  if (flowsBlock && flowsList) {
    flowsList.innerHTML = "";
    const allFlows = (state.rawGraph.execution_flows || []);
    if (state.activeFlowId || allFlows.length === 0) {
      flowsBlock.classList.add("hidden");
    } else {
      const mainFlows = allFlows.filter((f) => f.kind === "main");
      const featureFlows = allFlows.filter((f) => f.kind !== "main").slice(0, 6);
      const selectedFlows = [...mainFlows, ...featureFlows];
      for (const flow of selectedFlows) {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "summary-item-btn";
        const mainSpan = document.createElement("span");
        mainSpan.className = "summary-item-main";
        mainSpan.textContent = flow.label;
        mainSpan.title = flow.label;
        const metaSpan = document.createElement("span");
        const isMain = flow.kind === "main";
        metaSpan.className = `summary-item-meta ${isMain ? "main" : "feature"}`;
        metaSpan.textContent = `${(flow.steps || []).length} pasos`;
        btn.appendChild(mainSpan);
        btn.appendChild(metaSpan);
        btn.addEventListener("click", () => applyExecutionFlow(flow.id));
        li.appendChild(btn);
        flowsList.appendChild(li);
      }
      flowsBlock.classList.remove("hidden");
    }
  }
}

function clearSelectionPanel() {
  state.selectedNodeId = null;
  state.activeFlowStepId = null;
  syncFlowStepHighlight(null, null);
  hideNodeTooltip();
  document.getElementById("details-empty").classList.remove("hidden");
  const detailsContent = document.getElementById("details-content");
  detailsContent.classList.add("hidden");
  detailsContent.classList.remove("node-type-file");
  renderEmptyInspectorSummary();
}

function updateFileFunctionsBlock(node) {
  const block = document.getElementById("detail-file-functions-block");
  const titleEl = document.getElementById("detail-file-functions-title");
  const list = document.getElementById("detail-file-functions-list");
  if (!block || !list) {
    return;
  }
  list.innerHTML = "";
  if (!node || node.type !== "file" || !state.rawGraph) {
    block.classList.add("hidden");
    return;
  }

  const fileFunctions = (state.rawGraph.nodes || [])
    .filter((item) => item.type === "function" && item.parent === node.id)
    .sort((a, b) => (a.line || 0) - (b.line || 0) || a.id.localeCompare(b.id));

  if (titleEl) {
    titleEl.textContent = `Funciones en "${node.label}" (${fileFunctions.length})`;
  }

  if (fileFunctions.length === 0) {
    const emptyLi = document.createElement("li");
    emptyLi.className = "file-fn-empty";
    emptyLi.textContent = "Este archivo no declara funciones visibles.";
    list.appendChild(emptyLi);
    block.classList.remove("hidden");
    return;
  }

  fileFunctions.forEach((fn, idx) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "file-fn-item";
    btn.title = fn.signature || fn.id;

    const indexSpan = document.createElement("span");
    indexSpan.className = "file-fn-index";
    indexSpan.textContent = `${idx + 1}.`;

    const noteEntry = getNoteEntry(fn.id);
    const effectiveRole = noteEntry.custom_role || fn.role || "transform";
    const roleDot = document.createElement("span");
    roleDot.className = `file-fn-role-dot role-${effectiveRole}`;
    roleDot.setAttribute("aria-hidden", "true");

    const nameSpan = document.createElement("span");
    nameSpan.className = "file-fn-name";
    nameSpan.textContent = fn.label || fn.id;

    const lineSpan = document.createElement("span");
    lineSpan.className = "file-fn-line";
    lineSpan.textContent = fn.line ? `L${fn.line}` : "";

    btn.appendChild(indexSpan);
    btn.appendChild(roleDot);
    btn.appendChild(nameSpan);
    if (fn.line) {
      btn.appendChild(lineSpan);
    }
    btn.addEventListener("click", () => {
      navigateToNode(fn.id);
    });
    li.appendChild(btn);
    list.appendChild(li);
  });

  block.classList.remove("hidden");
}

function updateFileVariablesBlock(node) {
  const block = document.getElementById("detail-file-variables-block");
  const titleEl = document.getElementById("detail-file-variables-title");
  const list = document.getElementById("detail-file-variables-list");
  if (!block || !list) {
    return;
  }
  list.innerHTML = "";
  if (!node || node.type !== "file" || !state.rawGraph) {
    block.classList.add("hidden");
    return;
  }

  const fileVars = (state.rawGraph.nodes || [])
    .filter((item) => item.type === "variable" && item.parent === node.id)
    .sort((a, b) => (a.line || 0) - (b.line || 0) || a.id.localeCompare(b.id));

  if (fileVars.length === 0) {
    block.classList.add("hidden");
    return;
  }

  if (titleEl) {
    titleEl.textContent = `Constantes / Variables en "${node.label}" (${fileVars.length})`;
  }

  fileVars.forEach((varNode, idx) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "file-fn-item";
    btn.title = varNode.value_preview
      ? `${varNode.label} = ${varNode.value_preview}`
      : varNode.id;

    const indexSpan = document.createElement("span");
    indexSpan.className = "file-fn-index";
    indexSpan.textContent = `${idx + 1}.`;

    const roleDot = document.createElement("span");
    roleDot.className = `file-fn-role-dot role-${varNode.var_kind === "variable" ? "variable" : "constant"}`;
    roleDot.setAttribute("aria-hidden", "true");

    const nameSpan = document.createElement("span");
    nameSpan.className = "file-fn-name";
    nameSpan.textContent = varNode.label || varNode.id;

    const lineSpan = document.createElement("span");
    lineSpan.className = "file-fn-line";
    lineSpan.textContent = varNode.line ? `L${varNode.line}` : "";

    btn.appendChild(indexSpan);
    btn.appendChild(roleDot);
    btn.appendChild(nameSpan);
    if (varNode.line) {
      btn.appendChild(lineSpan);
    }
    btn.addEventListener("click", () => {
      navigateToNode(varNode.id);
    });
    li.appendChild(btn);
    list.appendChild(li);
  });

  block.classList.remove("hidden");
}

function updateVarPreviewBlock(node) {
  const block = document.getElementById("detail-var-preview-block");
  const titleEl = document.getElementById("detail-var-preview-title");
  const previewEl = document.getElementById("detail-var-preview");
  const btn = document.getElementById("btn-var-load-source");
  const sourceWrap = document.getElementById("detail-var-source-wrap");
  const sourceEl = document.getElementById("detail-var-source");
  if (!block || !previewEl) {
    return;
  }
  if (!node || node.type !== "variable") {
    block.classList.add("hidden");
    if (sourceWrap) {
      sourceWrap.classList.add("hidden");
    }
    if (sourceEl) {
      sourceEl.textContent = "";
    }
    if (btn) {
      btn.dataset.loadedNodeId = "";
      btn.textContent = "Ver código";
    }
    return;
  }

  if (titleEl) {
    const lineRange = node.line
      ? (node.end_line && node.end_line > node.line ? `L${node.line}–L${node.end_line}` : `L${node.line}`)
      : "";
    titleEl.textContent = lineRange ? `Valor / Declaración (${lineRange})` : "Valor / Declaración";
  }

  const typeSuffix = node.type_annotation ? `: ${node.type_annotation}` : "";
  const valuePart = node.value_preview ? ` = ${node.value_preview}` : "";
  previewEl.textContent = `${node.label}${typeSuffix}${valuePart}`;

  if (btn && btn.dataset.loadedNodeId !== node.id) {
    btn.dataset.loadedNodeId = "";
    btn.textContent = "Ver código";
    btn.disabled = false;
    if (sourceWrap) {
      sourceWrap.classList.add("hidden");
    }
    if (sourceEl) {
      sourceEl.textContent = "";
    }
  }
  block.classList.remove("hidden");
}

async function toggleSelectedVariableSource() {
  const nodeId = state.selectedNodeId;
  const node = nodeId ? state.nodesById.get(nodeId) : null;
  const btn = document.getElementById("btn-var-load-source");
  const sourceWrap = document.getElementById("detail-var-source-wrap");
  const sourceEl = document.getElementById("detail-var-source");
  if (!node || node.type !== "variable" || !btn || !sourceWrap || !sourceEl) {
    return;
  }

  if (btn.dataset.loadedNodeId === node.id) {
    const isNowHidden = sourceWrap.classList.toggle("hidden");
    btn.textContent = isNowHidden ? "Ver código" : "Ocultar código";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Cargando…";
  try {
    const response = await fetch(`/source?node_id=${encodeURIComponent(node.id)}`, { cache: "no-store" });
    if (state.selectedNodeId !== node.id) {
      return;
    }
    if (!response.ok) {
      sourceEl.textContent = `No se pudo cargar el código (HTTP ${response.status}).`;
      sourceWrap.classList.remove("hidden");
      btn.textContent = "Reintentar";
      return;
    }
    const payload = await response.json();
    if (state.selectedNodeId !== node.id) {
      return;
    }
    const startLine = Number(payload.start_line || node.line || 1);
    const lines = String(payload.code || "").replace(/\r\n/g, "\n").split("\n");
    const padWidth = String(startLine + Math.max(0, lines.length - 1)).length;
    sourceEl.textContent = lines
      .map((lineText, idx) => `${String(startLine + idx).padStart(padWidth, " ")} │ ${lineText}`)
      .join("\n");
    sourceWrap.classList.remove("hidden");
    btn.dataset.loadedNodeId = node.id;
    btn.textContent = "Ocultar código";
  } catch (err) {
    if (state.selectedNodeId !== node.id) {
      return;
    }
    sourceEl.textContent = `Error al cargar el código: ${err.message || err}`;
    sourceWrap.classList.remove("hidden");
    btn.textContent = "Reintentar";
  } finally {
    if (state.selectedNodeId === node.id) {
      btn.disabled = false;
    }
  }
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
  const detailsContent = document.getElementById("details-content");
  detailsContent.classList.remove("hidden");
  detailsContent.classList.toggle("node-type-file", node.type === "file");

  const effectiveRole = noteEntry.custom_role || node.role || node.type;
  const badge = document.getElementById("detail-badge");
  badge.textContent = ROLE_LABELS[effectiveRole] || effectiveRole;
  badge.className = `role-badge role-${effectiveRole}`;
  updateFlowBadges(node, effectiveRole);

  document.getElementById("detail-title").textContent = node.label;
  document.getElementById("detail-id").textContent = node.id;

  updateClassContext(node);
  updateVsCodeLink(node);
  updatePinButton(isPinnedInCurrentContext(noteEntry));
  updateReleasePinnedButton();
  updateToggleButton(node);
  updateFloatingOpenButton(node);
  updateIsolateFileButton(node);
  updateExploreNHopsButton(node);
  updateRoleSelector(node, noteEntry);

  document.getElementById("detail-note-input").value = noteEntry.note || "";
  document.getElementById("note-save-status").textContent = "";

  const docstringTitle = document.getElementById("detail-docstring-title");
  if (docstringTitle) {
    docstringTitle.textContent = node.type === "file" ? `Docstring "${node.label}"` : "Docstring";
  }

  updateVarPreviewBlock(node);
  updateOptionalBlock("detail-signature-block", "detail-signature", node.signature);
  updateOptionalBlock("detail-docstring-block", "detail-docstring", node.docstring);
  updateFileFunctionsBlock(node);
  updateFileVariablesBlock(node);
  updateInternalCallsBlock(node);
  updateExternalCallsBlock(node);
  updateOptionalBlock("detail-fingerprint-block", "detail-fingerprint", node.fingerprint);
  updateFlowBlock(node);
  if (state.activeFlowId) {
    renderActiveFlowPanel();
  }
}

function getClassInfoForFunction(node) {
  if (!node || node.type !== "function" || !node.class_name || !node.parent) {
    return null;
  }
  const fileNode = state.nodesById.get(node.parent);
  if (!fileNode || !fileNode.classes || typeof fileNode.classes !== "object") {
    return null;
  }
  return fileNode.classes[node.class_name] || null;
}

function formatClassDeclaration(clsInfo, language) {
  if (!clsInfo || !clsInfo.qualname) {
    return "";
  }
  const prefix = clsInfo.is_abstract ? "abstract class " : "class ";
  const bases = Array.isArray(clsInfo.bases) ? clsInfo.bases.filter(Boolean) : [];
  const implementsList = Array.isArray(clsInfo.implements) ? clsInfo.implements.filter(Boolean) : [];
  if (language === "python") {
    return bases.length > 0
      ? `${prefix}${clsInfo.qualname}(${bases.join(", ")})`
      : `${prefix}${clsInfo.qualname}`;
  }
  let decl = `${prefix}${clsInfo.qualname}`;
  if (bases.length > 0) {
    decl += ` extends ${bases.join(", ")}`;
  }
  if (implementsList.length > 0) {
    decl += ` implements ${implementsList.join(", ")}`;
  }
  return decl;
}

function updateClassContext(node) {
  const ctxLink = document.getElementById("detail-class-context");
  const docBlock = document.getElementById("detail-class-docstring-block");
  const docTitle = document.getElementById("detail-class-docstring-title");
  const docText = document.getElementById("detail-class-docstring");

  const clsInfo = getClassInfoForFunction(node);
  if (!clsInfo) {
    if (ctxLink) {
      ctxLink.classList.add("hidden");
      ctxLink.textContent = "";
      ctxLink.href = "#";
      ctxLink.classList.remove("no-link");
    }
    if (docBlock) {
      docBlock.classList.add("hidden");
    }
    return;
  }

  const fileNode = state.nodesById.get(node.parent);
  const lang = fileNode ? fileNode.language : "";
  const decl = formatClassDeclaration(clsInfo, lang);

  if (ctxLink) {
    const filePath = resolveNodeFilePath(node);
    ctxLink.textContent = clsInfo.line ? `${decl} · L${clsInfo.line}` : decl;
    if (filePath && Number.isInteger(clsInfo.line) && clsInfo.line > 0) {
      ctxLink.href = `vscode://file/${encodeFileUriPath(filePath)}:${clsInfo.line}`;
      ctxLink.classList.remove("no-link");
      ctxLink.title = `Abrir declaración de ${clsInfo.short_name || clsInfo.qualname} en VS Code (línea ${clsInfo.line})`;
    } else {
      ctxLink.href = "#";
      ctxLink.classList.add("no-link");
      ctxLink.title = decl;
    }
    ctxLink.classList.remove("hidden");
  }

  if (docBlock && docTitle && docText) {
    const clsDoc = (clsInfo.docstring || "").trim();
    if (clsDoc) {
      docTitle.textContent = `Docstring de la clase (${clsInfo.short_name || clsInfo.qualname})`;
      docText.textContent = clsDoc;
      docBlock.classList.remove("hidden");
    } else {
      docBlock.classList.add("hidden");
    }
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
  if (node.type === "variable") {
    if (node.var_kind === "variable") {
      appendBadge("VARIABLE", "flow-badge-variable");
    } else {
      appendBadge("CONSTANTE", "flow-badge-constant");
    }
    if (node.type_annotation) {
      appendBadge(node.type_annotation, "flow-badge-vartype");
    }
    return;
  }
  if (node.type !== "function") {
    return;
  }

  if (node.is_constructor) {
    appendBadge("CONSTRUCTOR", "flow-badge-constructor");
  } else if (node.class_name) {
    appendBadge("MÉTODO", "flow-badge-method");
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
  if ((node.type === "function" || node.type === "variable") && node.parent) {
    const fileNode = state.nodesById.get(node.parent);
    return fileNode ? fileNode.file_path : null;
  }
  return null;
}

function isSafeHttpUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_err) {
    return false;
  }
}

function encodeFileUriPath(rawPath) {
  const normalized = String(rawPath || "").replace(/\\/g, "/");
  return normalized
    .split("/")
    .map((segment, index) => {
      if (segment === "") {
        return "";
      }
      if (index === 0 && /^[A-Za-z]:$/.test(segment)) {
        return segment;
      }
      if (index === 1 && normalized.startsWith("/") && /^[A-Za-z]:$/.test(segment)) {
        return segment;
      }
      return encodeURIComponent(segment);
    })
    .join("/");
}

function buildVsCodeHref(node) {
  const filePath = resolveNodeFilePath(node);
  if (!filePath) {
    return null;
  }
  const encodedPath = encodeFileUriPath(filePath);
  const line = Number.isInteger(node.line) && node.line > 0 ? node.line : 1;
  return `vscode://file/${encodedPath}:${line}`;
}

function updateVsCodeLink(node) {
  const link = document.getElementById("detail-vscode");
  const href = buildVsCodeHref(node);

  if (href) {
    link.href = href;
    link.textContent = node.line ? `VS Code (L${node.line})` : "Abrir en VS Code";
    link.title = node.line ? `Abrir en Visual Studio Code (línea ${node.line})` : "Abrir en Visual Studio Code";
    link.classList.remove("disabled-action");
    link.setAttribute("aria-disabled", "false");
  } else {
    link.href = "#";
    link.textContent = "Abrir en VS Code";
    link.title = "Este contenedor no corresponde a un archivo directo";
    link.classList.add("disabled-action");
    link.setAttribute("aria-disabled", "true");
  }
}

function updatePinButton(isPinned) {
  const btn = document.getElementById("btn-pin-node");
  btn.textContent = isPinned ? "Liberar posición 📌" : "Fijar posición";
  btn.classList.toggle("pinned", Boolean(isPinned));
}

function collectScopedPinnedNodeIds(
  cy,
  selectedNodeId,
  notesNodes,
  contextKey,
  nodesById,
  childrenByParent,
) {
  const candidateIds = new Set();
  const rootIds = [];
  if (cy) {
    const selected = cy.nodes(":selected");
    if (selected && selected.length > 0) {
      selected.forEach((n) => rootIds.push(n.id()));
    }
  }
  if (rootIds.length === 0 && selectedNodeId) {
    rootIds.push(selectedNodeId);
  }
  if (rootIds.length === 0) {
    return [];
  }

  const addGraphSubtree = (id) => {
    if (candidateIds.has(id)) {
      return;
    }
    candidateIds.add(id);
    if (cy) {
      const cyNode = cy.getElementById(id);
      if (cyNode && cyNode.length > 0 && cyNode.isParent()) {
        cyNode.descendants().forEach((desc) => {
          addGraphSubtree(desc.id());
        });
      }
    }
    const raw = nodesById ? nodesById.get(id) : null;
    if (raw && raw.type === "function" && Array.isArray(raw.internal_flow)) {
      for (const step of raw.internal_flow) {
        if (step && step.id) {
          candidateIds.add(`${id}::${step.id}`);
        }
      }
    }
    const children = childrenByParent ? (childrenByParent.get(id) || []) : [];
    for (const child of children) {
      if (child && child.id) {
        addGraphSubtree(child.id);
      }
    }
  };

  for (const rid of rootIds) {
    addGraphSubtree(rid);
  }

  const pinnedIds = [];
  for (const id of candidateIds) {
    const entry = notesNodes ? notesNodes[id] : null;
    if (entry && getPinnedPositionForContext(entry, contextKey) !== null) {
      pinnedIds.push(id);
    }
  }
  return pinnedIds;
}

function updateReleasePinnedButton() {
  const btn = document.getElementById("btn-release-pinned");
  if (!btn) {
    return;
  }
  const contextKey = getCurrentLayoutContextKey();
  const scopedIds = collectScopedPinnedNodeIds(
    state.cy,
    state.selectedNodeId,
    state.notes && state.notes.nodes ? state.notes.nodes : {},
    contextKey,
    state.nodesById,
    state.childrenByParent,
  );
  const count = scopedIds.length;
  btn.textContent = `Liberar fijados (${count})`;
  btn.disabled = count === 0;
  btn.title = count > 0
    ? `Liberar ${count} nodo(s) fijado(s) dentro de la selección o subárbol actual`
    : "No hay nodos fijados en la selección o subárbol actual";
}

async function releaseScopedPinnedNodes() {
  const contextKey = getCurrentLayoutContextKey();
  const legacyKey = LEGACY_PIN_FALLBACK_KEY[contextKey];
  const scopedIds = collectScopedPinnedNodeIds(
    state.cy,
    state.selectedNodeId,
    state.notes && state.notes.nodes ? state.notes.nodes : {},
    contextKey,
    state.nodesById,
    state.childrenByParent,
  );
  if (scopedIds.length === 0) {
    updateReleasePinnedButton();
    return;
  }

  const patchNodes = {};
  for (const id of scopedIds) {
    const entry = getNoteEntry(id);
    const raw = state.nodesById.get(id);
    const nextPositions = { ...(entry.pinned_positions || {}) };
    delete nextPositions[contextKey];
    if (legacyKey) {
      delete nextPositions[legacyKey];
    }
    const stillHasOtherPins = Object.keys(nextPositions).length > 0;
    const updated = {
      ...entry,
      pinned: stillHasOtherPins,
      x: contextKey === "functions" ? null : entry.x,
      y: contextKey === "functions" ? null : entry.y,
      pinned_positions: nextPositions,
      last_fingerprint: (raw && raw.fingerprint) || entry.last_fingerprint || "",
    };
    state.notes.nodes[id] = updated;
    patchNodes[id] = updated;
    refreshCyNodeMetadata(id);
  }

  const response = await fetch("/notes.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes: patchNodes }),
  });
  if (response.ok) {
    state.notes = await response.json();
  }
  if (state.selectedNodeId) {
    updatePinButton(isPinnedInCurrentContext(getNoteEntry(state.selectedNodeId)));
  }
  updateReleasePinnedButton();
  await refreshGraphView({ fit: false });
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
    btn.disabled = false;
    btn.textContent = collapsed ? "Expandir" : "Colapsar";
    btn.title = collapsed ? "Expandir contenedor" : "Colapsar contenedor";
  } else if (node.type === "function" && node.internal_flow && node.internal_flow.length > 0) {
    const expanded = state.expandedFunctions.has(node.id);
    btn.disabled = false;
    btn.textContent = expanded ? "Ocultar flujo" : "Expandir flujo";
    btn.title = expanded ? "Ocultar flujo interno (Nivel 3+)" : "Expandir flujo interno (Nivel 3+)";
  } else {
    btn.disabled = true;
    btn.textContent = "Sin flujo (3+)";
    btn.title = "Esta función no tiene flujo interno expandible";
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
    if (win && !win.destroyed && win.isFunctionFlow && win.targetId === fnId) {
      win.selectedStepId = stepId || null;
      if (win.viewMode === "split" || win.viewMode === "code") {
        highlightFloatingCodeForStep(win, stepId, { scroll: true });
      }
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
  } else if (targetNode.type === "variable" && targetNode.value_preview) {
    const sig = document.createElement("pre");
    sig.className = "call-signature";
    sig.textContent = `= ${targetNode.value_preview}`;
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
  const titleEl = document.getElementById("detail-internal-calls-title");
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

  if (node.type === "variable") {
    if (!state.rawGraph || !Array.isArray(state.rawGraph.edges)) {
      block.classList.add("hidden");
      return;
    }
    const seenReaders = new Set();
    const readers = [];
    for (const edge of state.rawGraph.edges) {
      if (edge.target !== node.id || edge.source === node.id || seenReaders.has(edge.source)) {
        continue;
      }
      const srcNode = state.nodesById.get(edge.source);
      if (!srcNode) {
        continue;
      }
      seenReaders.add(edge.source);
      readers.push({ targetNode: srcNode, edge });
    }
    if (readers.length === 0) {
      block.classList.add("hidden");
      return;
    }
    if (titleEl) {
      titleEl.textContent = `Leída por (${readers.length})`;
    }
    for (const { targetNode, edge } of readers) {
      list.appendChild(createInternalCallCard(targetNode, edge));
    }
    block.classList.remove("hidden");
    return;
  }

  if (titleEl) {
    titleEl.textContent = "Llamadas internas";
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
  const variableItems = [];
  const hiddenUtilityItems = [];
  for (const edge of state.rawGraph.edges) {
    if (edge.source !== node.id || edge.target === node.id || seenTargets.has(edge.target)) {
      continue;
    }
    const targetNode = state.nodesById.get(edge.target);
    if (
      !targetNode
      || (targetNode.type !== "function" && targetNode.type !== "file" && targetNode.type !== "variable")
    ) {
      continue;
    }
    seenTargets.add(edge.target);
    if (targetNode.type === "variable") {
      variableItems.push({ targetNode, edge });
    } else if (isUtilityNodeHidden(targetNode.id, activeFlowNodeSet)) {
      hiddenUtilityItems.push({ targetNode, edge });
    } else {
      visibleItems.push({ targetNode, edge });
    }
  }

  if (visibleItems.length === 0 && variableItems.length === 0 && hiddenUtilityItems.length === 0) {
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
  for (const { targetNode, edge } of variableItems) {
    list.appendChild(createInternalCallCard(targetNode, edge));
  }
  block.classList.remove("hidden");
}

const EXTERNAL_KIND_LABELS = {
  stdlib: "Stdlib",
  native: "Nativo JS",
  method: "Método",
  package: "Paquete",
  syntax: "Sintaxis",
  posix: "POSIX",
  control: "Control",
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

function getProjectInventoryMap() {
  const map = getProjectExternalApisMap();
  const vocabHelper = typeof window !== "undefined" ? window.CodeMapVocab : null;
  if (vocabHelper) {
    for (const [apiId, item] of map.entries()) {
      const dictEntry = vocabHelper.getDictionaryEntry(state.vocabDict, apiId);
      if (dictEntry) {
        item.title = item.title || dictEntry.title || "";
        item.input = item.input || dictEntry.input || "";
        item.transform = item.transform || dictEntry.transform || "";
        item.output = item.output || dictEntry.output || "";
        if (!item.docs_url && dictEntry.docs_url) {
          item.docs_url = dictEntry.docs_url;
        }
      }
    }
    const vocabMap = vocabHelper.collectProjectVocabItems(state.rawGraph, state.vocabDict);
    for (const [vocabId, vItem] of vocabMap.entries()) {
      if (!map.has(vocabId)) {
        map.set(vocabId, vItem);
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
  const projectApis = getProjectInventoryMap();
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
  btn.title = `Inventario de APIs y Vocabulario (${pendingCount} pendientes / ${knownCount} aprendidas)`;
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
  refreshAllVocabViews();
}

function getFloatingLineText(win, lineNumber) {
  if (!win || !win.sourceData || !Array.isArray(win.sourceData.lines)) {
    return "";
  }
  const found = win.sourceData.lines.find((item) => item.number === lineNumber);
  return found ? (found.text || "") : "";
}

function refreshFloatingWindowLineNoteMarkers(win) {
  if (!win || win.destroyed || !win.codeLinesEl || !win.sourceData) {
    return;
  }
  const vocabHelper = typeof window !== "undefined" ? window.CodeMapVocab : null;
  const fileId = win.sourceData.file_id || "";
  const rows = win.codeLinesEl.querySelectorAll(".fw-code-line");
  rows.forEach((row) => {
    const lineNum = Number(row.dataset.line || "0");
    const hasNote = Boolean(vocabHelper && vocabHelper.getLineNote(state.notes, fileId, lineNum));
    row.classList.toggle("has-line-note", hasNote);
    const numSpan = row.querySelector(".fw-code-lineno");
    if (numSpan) {
      numSpan.textContent = hasNote ? `📝${lineNum}` : String(lineNum);
    }
  });
}

function refreshWalkthroughLineNoteMarkers(fileId) {
  const linesEl = document.getElementById("wt-code-lines");
  const vocabHelper = typeof window !== "undefined" ? window.CodeMapVocab : null;
  if (!linesEl || !vocabHelper || !fileId) {
    return;
  }
  const rows = linesEl.querySelectorAll(".wt-code-row");
  rows.forEach((row) => {
    const lineNum = Number(row.dataset.line || "0");
    const hasNote = Boolean(vocabHelper.getLineNote(state.notes, fileId, lineNum));
    row.classList.toggle("has-line-note", hasNote);
    const numSpan = row.querySelector(".wt-code-lineno");
    if (numSpan) {
      numSpan.textContent = hasNote ? `📝${lineNum}` : String(lineNum);
    }
  });
}

function getRecentLineNoteStatus(fileId, line) {
  const recent = state.recentLineNoteStatus;
  const vocabHelper = typeof window !== "undefined" ? window.CodeMapVocab : null;
  if (!recent || Date.now() > recent.expiresAt) {
    return "";
  }
  const key = vocabHelper ? vocabHelper.getLineNoteKey(fileId, line) : `${fileId}::${line}`;
  return recent.key === key ? recent.text : "";
}

function renderFloatingWindowVocab(win) {
  if (!win || win.destroyed || !win.vocabDockEl) {
    return;
  }
  const vocabHelper = typeof window !== "undefined" ? window.CodeMapVocab : null;
  if (!vocabHelper || !win.sourceData || !win.activeCodeLine) {
    win.vocabDockEl.replaceChildren();
    win.vocabDockEl.classList.add("hidden");
    return;
  }
  const fnNode = state.nodesById.get(win.targetId) || null;
  const fileId = win.sourceData.file_id || (fnNode && fnNode.parent) || "";
  vocabHelper.renderVocabDock(
    win.vocabDockEl,
    {
      fnNode,
      fileId,
      line: win.activeCodeLine,
      endLine: win.activeCodeEndLine || win.activeCodeLine,
      lineText: getFloatingLineText(win, win.activeCodeLine),
      vocabDict: state.vocabDict,
      knownApis: state.knownApis,
      notes: state.notes,
      statusText: getRecentLineNoteStatus(fileId, win.activeCodeLine),
    },
    {
      onMarkKnown: (item) => setApiKnownStatus(item, true),
      onSaveLineNote: (fId, ln, text, hash) => saveLineNote(fId, ln, text, hash, { skipContainer: win.vocabDockEl }),
    },
  );
}

function refreshAllVocabViews({ skipContainer = null, updatedFileId = "" } = {}) {
  for (const win of state.floatingWindows.values()) {
    if (!win || win.destroyed || !win.isFunctionFlow || !win.sourceData) {
      continue;
    }
    refreshFloatingWindowLineNoteMarkers(win);
    if (win.vocabDockEl && win.vocabDockEl !== skipContainer) {
      renderFloatingWindowVocab(win);
    }
  }
  if (state.walkthrough && typeof state.walkthrough.isActive === "function" && state.walkthrough.isActive()) {
    const wtDock = document.getElementById("wt-vocab-dock");
    if (wtDock && wtDock === skipContainer) {
      refreshWalkthroughLineNoteMarkers(updatedFileId);
    } else if (typeof state.walkthrough.refreshVocabView === "function") {
      state.walkthrough.refreshVocabView();
    }
  }
}

async function saveLineNote(fileId, line, noteText, lineHash, { skipContainer = null } = {}) {
  const vocabHelper = typeof window !== "undefined" ? window.CodeMapVocab : null;
  const key = vocabHelper ? vocabHelper.getLineNoteKey(fileId, line) : `${fileId}::${line}`;
  if (!key) {
    return null;
  }
  const trimmed = String(noteText || "").trim();
  const entryPayload = trimmed
    ? {
        file_id: fileId,
        line: Number(line),
        note: trimmed,
        line_hash: String(lineHash || ""),
      }
    : null;
  const response = await fetch("/notes.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      line_notes: {
        [key]: entryPayload,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`No se pudo guardar nota de línea (${response.status})`);
  }
  const updated = await response.json();
  state.notes = updated;
  if (!state.notes.line_notes || typeof state.notes.line_notes !== "object") {
    state.notes.line_notes = {};
  }
  state.recentLineNoteStatus = {
    key,
    text: trimmed ? "Guardada ✓" : "Borrada",
    expiresAt: Date.now() + 2500,
  };
  refreshAllVocabViews({ skipContainer, updatedFileId: fileId });
  return updated;
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

    if (isSafeHttpUrl(ext.docs_url)) {
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
  const entry = getNoteEntry(nodeId);
  const raw = state.nodesById.get(nodeId);
  if (!raw) {
    if (!state.cy) {
      return;
    }
    const cyNode = state.cy.getElementById(nodeId);
    if (!cyNode || cyNode.length === 0) {
      return;
    }
    const isPinnedHere = isPinnedInCurrentContext(entry);
    cyNode.data("pinned", isPinnedHere ? "true" : "false");
    cyNode.data("hasNote", entry.note && entry.note.trim() ? "true" : "false");
    const rawBase = cyNode.data("baseLabel")
      || String(cyNode.data("label") || "").replace(/\s*\[📌\]\s*$/, "");
    cyNode.data("baseLabel", rawBase);
    cyNode.data("label", isPinnedHere ? `${rawBase} [📌]` : rawBase);
    return;
  }
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
    const haystack = `${node.label} ${node.id} ${node.signature || ""} ${node.value_preview || ""} ${noteText}`.toLowerCase();
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
    const typeBadge = item.node.type === "variable"
      ? (item.node.var_kind === "variable" ? "variable" : "constante")
      : item.node.type;
    title.innerHTML = `<span>${escapeHtml(item.node.label)}</span><span>${escapeHtml(typeBadge)}</span>`;
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
  if (current && current.type === "variable" && !state.showVariables) {
    state.showVariables = true;
    updateVariablesButton();
    changed = true;
  }
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

function switchApisCategory(category) {
  state.apisModalCategory = category === "apis" || category === "vocab" ? category : "all";
  renderApisModal();
}

function renderApisModal() {
  const vocabHelper = typeof window !== "undefined" ? window.CodeMapVocab : null;
  const projectMap = getProjectInventoryMap();
  const knownMap = (state.knownApis && state.knownApis.known) || {};

  const pendingItems = [];
  for (const item of projectMap.values()) {
    if (!knownMap[item.api_id]) {
      pendingItems.push(item);
    }
  }
  pendingItems.sort((a, b) => (b.usageCount - a.usageCount) || a.symbol.localeCompare(b.symbol));

  const knownItems = Object.values(knownMap).map((entry) => {
    const dictEntry = vocabHelper ? vocabHelper.getDictionaryEntry(state.vocabDict, entry.api_id) : null;
    return {
      ...entry,
      title: (dictEntry && dictEntry.title) || "",
      input: (dictEntry && dictEntry.input) || "",
      transform: (dictEntry && dictEntry.transform) || "",
      output: (dictEntry && dictEntry.output) || "",
      docs_url: entry.docs_url || (dictEntry && dictEntry.docs_url) || "",
      inCurrentProject: projectMap.has(entry.api_id),
      usageCount: projectMap.has(entry.api_id) ? projectMap.get(entry.api_id).usageCount : 0,
    };
  });
  knownItems.sort((a, b) => Number(b.inCurrentProject) - Number(a.inCurrentProject) || a.symbol.localeCompare(b.symbol));

  document.getElementById("tab-apis-pending").textContent = `Por aprender (${pendingItems.length})`;
  document.getElementById("tab-apis-known").textContent = `Aprendidas (${knownItems.length})`;
  document.getElementById("tab-apis-pending").classList.toggle("active", state.apisModalTab === "pending");
  document.getElementById("tab-apis-known").classList.toggle("active", state.apisModalTab === "known");

  const catAllBtn = document.getElementById("filter-apis-all");
  const catApisBtn = document.getElementById("filter-apis-only");
  const catVocabBtn = document.getElementById("filter-apis-vocab");
  if (catAllBtn) catAllBtn.classList.toggle("active", state.apisModalCategory === "all");
  if (catApisBtn) catApisBtn.classList.toggle("active", state.apisModalCategory === "apis");
  if (catVocabBtn) catVocabBtn.classList.toggle("active", state.apisModalCategory === "vocab");

  const query = (state.apisSearchQuery || "").trim().toLowerCase();
  const sourceList = state.apisModalTab === "pending" ? pendingItems : knownItems;
  const filtered = sourceList.filter((item) => {
    if (state.apisModalCategory !== "all") {
      const isVocab = vocabHelper ? vocabHelper.isVocabConcept(item.api_id, item.kind) : false;
      if (state.apisModalCategory === "vocab" && !isVocab) {
        return false;
      }
      if (state.apisModalCategory === "apis" && isVocab) {
        return false;
      }
    }
    if (!query) {
      return true;
    }
    const haystack = `${item.symbol} ${item.title || ""} ${item.module || ""} ${item.kind || ""} ${item.call_expr || ""} ${item.input || ""} ${item.output || ""}`.toLowerCase();
    return haystack.includes(query);
  });

  const hint = document.getElementById("apis-summary-hint");
  if (state.apisModalTab === "pending") {
    hint.textContent = pendingItems.length === 0
      ? "No quedan APIs ni conceptos de vocabulario pendientes en este proyecto."
      : `Mostrando ${filtered.length} de ${pendingItems.length} conceptos pendientes en este proyecto.`;
  } else {
    hint.textContent = knownItems.length === 0
      ? "Aún no has marcado ninguna API ni concepto en ~/.codemap/known_apis.json."
      : `Inventario global compartido (~/.codemap/known_apis.json): ${filtered.length} de ${knownItems.length} aprendidos.`;
  }

  const list = document.getElementById("apis-list");
  list.replaceChildren();

  for (const item of filtered) {
    const isVocab = vocabHelper ? vocabHelper.isVocabConcept(item.api_id, item.kind) : false;
    const li = document.createElement("li");
    li.className = "orphan-card";

    const header = document.createElement("div");
    header.className = "call-card-header";

    const name = document.createElement("span");
    name.className = "call-name";
    name.textContent = isVocab
      ? (item.title ? `${item.symbol} — ${item.title}` : item.symbol)
      : `${item.symbol}()`;
    header.appendChild(name);

    const origin = document.createElement("span");
    origin.className = "call-origin";
    origin.textContent = item.module || "";
    header.appendChild(origin);
    li.appendChild(header);

    if (item.input || item.output) {
      const contractSummary = document.createElement("div");
      contractSummary.className = "apis-contract-summary";
      const parts = [];
      if (item.input) {
        parts.push(`Entrada: ${item.input}`);
      }
      if (item.output) {
        parts.push(`Salida: ${item.output}`);
      }
      contractSummary.textContent = parts.join("  →  ");
      li.appendChild(contractSummary);
    }

    const meta = document.createElement("div");
    meta.className = "orphan-meta";
    meta.textContent = state.apisModalTab === "pending"
      ? `Detectado en ${item.usageCount} ${item.usageCount === 1 ? "función" : "funciones"}`
      : `Marcado el ${(item.marked_at || "").slice(0, 10) || "—"}${item.inCurrentProject ? ` · ${item.usageCount} usos en este proyecto` : ""}`;
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

    if (isSafeHttpUrl(item.docs_url)) {
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
      toggleBtn.textContent = "✓ Ya la sé";
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
  if (!state.traceMode && !state.activeFlowId) {
    return false;
  }
  return Boolean(computeSubgraphFilter()) || state.cy.elements(".dimmed").length > 0;
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

function applySpacePanToCy(cyInst, areaEl, active) {
  if (areaEl) {
    areaEl.classList.toggle("pan-mode", active);
    if (!active) {
      areaEl.classList.remove("panning-active");
    }
  }
  if (cyInst) {
    if (typeof cyInst.autoungrabify === "function") {
      cyInst.autoungrabify(active);
    }
    if (typeof cyInst.boxSelectionEnabled === "function") {
      cyInst.boxSelectionEnabled(!active);
    }
  }
}

function setSpacePanMode(enabled) {
  const active = Boolean(enabled);
  if (state.spacePanning === active) {
    return;
  }
  state.spacePanning = active;
  applySpacePanToCy(state.cy, document.getElementById("canvas-area"), active);
  for (const win of state.floatingWindows.values()) {
    if (win && !win.destroyed && win.cy) {
      applySpacePanToCy(win.cy, win.bodyEl, active);
    }
  }
}

function hitTestCyNodeAtClientPoint(cyInst, clientX, clientY) {
  if (!cyInst || typeof cyInst.container !== "function" || typeof cyInst.nodes !== "function") {
    return null;
  }
  const container = cyInst.container();
  if (!container) {
    return null;
  }
  const rect = container.getBoundingClientRect();
  const rx = clientX - rect.left;
  const ry = clientY - rect.top;
  if (rx < 0 || ry < 0 || rx > rect.width || ry > rect.height) {
    return null;
  }

  const hits = [];
  cyInst.nodes(":visible").forEach((cyNode) => {
    const bb = cyNode.renderedBoundingBox({ includeLabels: true, includeOverlays: false });
    if (rx >= bb.x1 && rx <= bb.x2 && ry >= bb.y1 && ry <= bb.y2) {
      const area = Math.max(1, (bb.x2 - bb.x1) * (bb.y2 - bb.y1));
      hits.push({
        node: cyNode,
        isLeaf: !cyNode.isParent(),
        depth: cyNode.ancestors().length,
        area,
      });
    }
  });
  if (hits.length === 0) {
    return null;
  }
  hits.sort((a, b) => {
    if (a.isLeaf !== b.isLeaf) {
      return a.isLeaf ? -1 : 1;
    }
    if (a.depth !== b.depth) {
      return b.depth - a.depth;
    }
    return a.area - b.area;
  });
  return hits[0].node;
}

function attachPanControls(
  getCy,
  eventTarget,
  areaContainer,
  { onPanStart, onPanMove, onPanEnd, onMiddleClick } = {},
) {
  if (!eventTarget || !areaContainer) {
    return () => {};
  }

  let panDrag = null;

  const onMouseDown = (event) => {
    const cyInst = typeof getCy === "function" ? getCy() : getCy;
    if (!cyInst) {
      return;
    }
    const isRightPan = event.button === 2;
    const isMiddlePan = event.button === 1;
    const isSpaceLeftPan = event.button === 0 && state.spacePanning;
    if (!isRightPan && !isMiddlePan && !isSpaceLeftPan) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (typeof onPanStart === "function") {
      onPanStart(event);
    }
    hideEdgeTooltip();
    hideNodeTooltip();
    const currentPan = cyInst.pan();
    panDrag = {
      button: event.button,
      startX: event.clientX,
      startY: event.clientY,
      startPanX: currentPan.x,
      startPanY: currentPan.y,
      didMove: false,
    };
    areaContainer.classList.add("panning-active");
  };

  const onContextMenu = (event) => {
    event.preventDefault();
  };

  const onAuxClick = (event) => {
    if (event.button === 1) {
      event.preventDefault();
    }
  };

  const onMouseMove = (event) => {
    const cyInst = typeof getCy === "function" ? getCy() : getCy;
    if (!panDrag || !cyInst) {
      return;
    }
    const dx = event.clientX - panDrag.startX;
    const dy = event.clientY - panDrag.startY;
    if (!panDrag.didMove && Math.hypot(dx, dy) > 4) {
      panDrag.didMove = true;
    }
    cyInst.pan({ x: panDrag.startPanX + dx, y: panDrag.startPanY + dy });
    if (typeof onPanMove === "function") {
      onPanMove(event, panDrag.didMove);
    }
  };

  const finishPanDrag = (upEvent = null) => {
    if (!panDrag) {
      return;
    }
    const completed = panDrag;
    const didMove = completed.didMove;
    if (didMove) {
      state.suppressNextTap = true;
      setTimeout(() => {
        state.suppressNextTap = false;
      }, 60);
    }
    panDrag = null;
    areaContainer.classList.remove("panning-active");
    if (typeof onPanEnd === "function") {
      onPanEnd(didMove);
    }
    if (
      !didMove
      && completed.button === 1
      && upEvent
      && upEvent.type === "mouseup"
      && upEvent.button === 1
      && typeof onMiddleClick === "function"
    ) {
      const cyInst = typeof getCy === "function" ? getCy() : getCy;
      if (cyInst) {
        onMiddleClick({
          cy: cyInst,
          clientX: completed.startX,
          clientY: completed.startY,
          originalEvent: upEvent,
        });
      }
    }
  };

  const onWindowBlur = () => {
    finishPanDrag(null);
  };

  eventTarget.addEventListener("mousedown", onMouseDown, true);
  eventTarget.addEventListener("contextmenu", onContextMenu, true);
  eventTarget.addEventListener("auxclick", onAuxClick, true);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", finishPanDrag);
  window.addEventListener("blur", onWindowBlur);

  return () => {
    finishPanDrag(null);
    eventTarget.removeEventListener("mousedown", onMouseDown, true);
    eventTarget.removeEventListener("contextmenu", onContextMenu, true);
    eventTarget.removeEventListener("auxclick", onAuxClick, true);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", finishPanDrag);
    window.removeEventListener("blur", onWindowBlur);
  };
}

function attachManualBackgroundPanDetector(cyInstance) {
  if (!cyInstance || typeof cyInstance.on !== "function") {
    return () => {};
  }
  let bgPointerDown = false;
  const onCyDown = (event) => {
    if (event.target !== cyInstance) {
      bgPointerDown = false;
      return;
    }
    const orig = event.originalEvent;
    if (!orig || orig.type === "touchstart" || orig.button === 0) {
      bgPointerDown = true;
    }
  };
  const onCyPan = () => {
    if (bgPointerDown && state.walkthrough && typeof state.walkthrough.notifyManualPan === "function") {
      state.walkthrough.notifyManualPan(cyInstance);
    }
  };
  const clearDown = () => {
    bgPointerDown = false;
  };
  cyInstance.on("mousedown touchstart", onCyDown);
  cyInstance.on("pan", onCyPan);
  window.addEventListener("mouseup", clearDown);
  window.addEventListener("touchend", clearDown);
  window.addEventListener("blur", clearDown);
  return () => {
    bgPointerDown = false;
    if (typeof cyInstance.off === "function") {
      cyInstance.off("mousedown touchstart", onCyDown);
      cyInstance.off("pan", onCyPan);
    }
    window.removeEventListener("mouseup", clearDown);
    window.removeEventListener("touchend", clearDown);
    window.removeEventListener("blur", clearDown);
  };
}

function bindCanvasPanControls() {
  if (state.mainPanCleanup) {
    state.mainPanCleanup();
    state.mainPanCleanup = null;
  }
  const container = document.getElementById("cy");
  const area = document.getElementById("canvas-area");
  state.mainPanCleanup = attachPanControls(() => state.cy, container, area, {
    onPanMove: (_event, didMove) => {
      if (didMove && state.walkthrough && typeof state.walkthrough.notifyManualPan === "function") {
        state.walkthrough.notifyManualPan(state.cy);
      }
    },
    onMiddleClick: ({ cy, clientX, clientY }) => {
      const hitNode = hitTestCyNodeAtClientPoint(cy, clientX, clientY);
      if (!hitNode) {
        return;
      }
      const data = hitNode.data();
      if (!data || data.type === "port") {
        return;
      }
      const targetId = data.ownerFunctionId || data.id;
      const rawTarget = state.nodesById.get(targetId);
      if (canOpenInFloatingWindow(rawTarget)) {
        openFloatingWindow(targetId, { parentWindowId: null });
      }
    },
  });
}

function fitCyWithDynamicMinZoom(cy, eles = undefined, padding = 36, baseMinZoom = MAIN_MIN_ZOOM) {
  if (!cy) {
    return;
  }
  const container = typeof cy.container === "function" ? cy.container() : null;
  const targetEles = eles || (typeof cy.elements === "function" ? cy.elements() : null);
  let nextMinZoom = baseMinZoom;
  if (container && targetEles && targetEles.length > 0 && typeof targetEles.boundingBox === "function") {
    const bb = targetEles.boundingBox();
    const availW = Math.max(40, (container.clientWidth || 0) - padding * 2);
    const availH = Math.max(40, (container.clientHeight || 0) - padding * 2);
    if (bb && bb.w > 0 && bb.h > 0 && availW > 0 && availH > 0) {
      const neededZoom = Math.min(availW / bb.w, availH / bb.h);
      if (Number.isFinite(neededZoom) && neededZoom < baseMinZoom) {
        nextMinZoom = Math.max(DYNAMIC_MIN_ZOOM_FLOOR, neededZoom * 0.92);
      }
    }
  }
  if (typeof cy.minZoom === "function") {
    cy.minZoom(nextMinZoom);
  }
  cy.fit(eles, padding);
}

function parseZoomPercentInput(rawText, minPct = 2, maxPct = 400) {
  if (rawText === null || rawText === undefined) {
    return null;
  }
  const cleaned = String(rawText).trim().replace(/%$/g, "").replace(",", ".").trim();
  if (!cleaned || !/^\d+(?:\.\d+)?$/.test(cleaned)) {
    return null;
  }
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  const lo = Math.max(1, Number.isFinite(minPct) ? minPct : 2);
  const hi = Math.max(lo, Number.isFinite(maxPct) ? maxPct : 400);
  return Math.min(hi, Math.max(lo, num));
}

function formatZoomPercent(zoomLevel) {
  if (!Number.isFinite(zoomLevel) || zoomLevel <= 0) {
    return "100%";
  }
  const pct = zoomLevel * 100;
  if (pct < 1) {
    return `${Math.max(0.5, Number(pct.toFixed(1)))}%`;
  }
  return `${Math.round(pct)}%`;
}

function fitGraphToScreen() {
  if (state.cy) {
    fitCyWithDynamicMinZoom(state.cy, undefined, 40, MAIN_MIN_ZOOM);
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
  const minZoom = typeof state.cy.minZoom === "function" ? state.cy.minZoom() : MAIN_MIN_ZOOM;
  const maxZoom = typeof state.cy.maxZoom === "function" ? state.cy.maxZoom() : MAIN_MAX_ZOOM;
  const nextZoom = Math.min(maxZoom, Math.max(minZoom, state.cy.zoom() * factor));
  state.cy.zoom({ level: nextZoom, renderedPosition });
  updateZoomIndicator();
}

function setZoomPercentCentered(percent) {
  if (!state.cy || !Number.isFinite(percent)) {
    return false;
  }
  const minZoom = typeof state.cy.minZoom === "function" ? state.cy.minZoom() : MAIN_MIN_ZOOM;
  const maxZoom = typeof state.cy.maxZoom === "function" ? state.cy.maxZoom() : MAIN_MAX_ZOOM;
  const minPct = Math.max(1, Math.min(Math.round(MAIN_MIN_ZOOM * 100), Math.floor(minZoom * 100)));
  const maxPct = Math.round(maxZoom * 100);
  const clampedPct = Math.min(maxPct, Math.max(minPct, percent));
  const level = Math.min(maxZoom, Math.max(minZoom, clampedPct / 100));
  const container = typeof state.cy.container === "function" ? state.cy.container() : null;
  const renderedPosition = container
    ? { x: container.clientWidth / 2, y: container.clientHeight / 2 }
    : undefined;
  state.cy.zoom({ level, renderedPosition });
  updateZoomIndicator();
  return true;
}

function updateZoomIndicator() {
  const el = document.getElementById("zoom-indicator");
  if (!el || !state.cy) {
    return;
  }
  el.textContent = formatZoomPercent(state.cy.zoom());
}

function closeZoomEdit({ focusIndicator = false } = {}) {
  const indicator = document.getElementById("zoom-indicator");
  const input = document.getElementById("zoom-input");
  state.zoomEditActive = false;
  if (input) {
    input.classList.add("hidden");
  }
  if (indicator) {
    indicator.classList.remove("hidden");
    updateZoomIndicator();
    if (focusIndicator) {
      indicator.focus();
    }
  }
}

function beginZoomEdit() {
  const indicator = document.getElementById("zoom-indicator");
  const input = document.getElementById("zoom-input");
  if (!indicator || !input || !state.cy) {
    return;
  }
  state.zoomEditActive = true;
  const currentPct = Math.max(1, Math.round(state.cy.zoom() * 100));
  input.value = String(currentPct);
  indicator.classList.add("hidden");
  input.classList.remove("hidden");
  input.focus();
  input.select();
}

function commitZoomEdit() {
  if (!state.zoomEditActive) {
    return;
  }
  const input = document.getElementById("zoom-input");
  if (input && state.cy) {
    const minZoom = typeof state.cy.minZoom === "function" ? state.cy.minZoom() : MAIN_MIN_ZOOM;
    const maxZoom = typeof state.cy.maxZoom === "function" ? state.cy.maxZoom() : MAIN_MAX_ZOOM;
    const minPct = Math.max(1, Math.min(Math.round(MAIN_MIN_ZOOM * 100), Math.floor(minZoom * 100)));
    const maxPct = Math.round(maxZoom * 100);
    const parsed = parseZoomPercentInput(input.value, minPct, maxPct);
    if (parsed !== null) {
      setZoomPercentCentered(parsed);
    }
  }
  closeZoomEdit({ focusIndicator: false });
}

function cancelZoomEdit() {
  if (!state.zoomEditActive) {
    return;
  }
  closeZoomEdit({ focusIndicator: true });
}

const INSPECTOR_WIDTH_STORAGE_KEY = "codemap.inspector.width";
const INSPECTOR_WIDTH_DEFAULT = 350;
const INSPECTOR_WIDTH_MIN = 280;

function clampInspectorWidth(rawWidth) {
  const vw = typeof window !== "undefined" ? (window.innerWidth || 1280) : 1280;
  const maxWidth = Math.max(INSPECTOR_WIDTH_MIN + 40, Math.min(760, Math.round(vw * 0.62)));
  const numeric = Number(rawWidth);
  if (!Number.isFinite(numeric)) {
    return INSPECTOR_WIDTH_DEFAULT;
  }
  return Math.round(Math.max(INSPECTOR_WIDTH_MIN, Math.min(maxWidth, numeric)));
}

function applyInspectorWidth(widthPx, { persist = false } = {}) {
  const panel = document.getElementById("details-panel");
  if (!panel) {
    return;
  }
  const clamped = clampInspectorWidth(widthPx);
  state.inspectorWidth = clamped;
  if (!state.panelCollapsed) {
    panel.style.width = `${clamped}px`;
  }
  if (persist) {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(clamped));
      }
    } catch (_err) {
      // Ignorar errores de almacenamiento privado.
    }
  }
}

function notifyLayoutViewportResized() {
  if (state.cy) {
    state.cy.resize();
  }
  scheduleBridgeRender();
  if (state.walkthrough && typeof state.walkthrough.onViewportChanged === "function") {
    state.walkthrough.onViewportChanged();
  }
}

function initInspectorPanelResizer() {
  const panel = document.getElementById("details-panel");
  const resizer = document.getElementById("details-panel-resizer");
  if (!panel || !resizer) {
    return;
  }

  let savedWidth = INSPECTOR_WIDTH_DEFAULT;
  try {
    if (typeof localStorage !== "undefined") {
      const parsed = Number.parseInt(localStorage.getItem(INSPECTOR_WIDTH_STORAGE_KEY) || "", 10);
      if (Number.isFinite(parsed)) {
        savedWidth = parsed;
      }
    }
  } catch (_err) {
    // Ignorar errores de almacenamiento privado.
  }
  applyInspectorWidth(savedWidth, { persist: false });
  resizer.classList.toggle("hidden-resizer", Boolean(state.panelCollapsed));

  let dragging = false;
  let rafId = null;
  const scheduleResizeSync = () => {
    if (rafId !== null) {
      return;
    }
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      notifyLayoutViewportResized();
    });
  };

  const onMouseMove = (event) => {
    if (!dragging || state.panelCollapsed) {
      return;
    }
    const workspace = panel.parentElement;
    const rightEdge = workspace ? workspace.getBoundingClientRect().right : window.innerWidth;
    applyInspectorWidth(rightEdge - event.clientX, { persist: false });
    scheduleResizeSync();
  };

  const stopDragging = () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    panel.classList.remove("resizing");
    resizer.classList.remove("dragging");
    document.body.style.cursor = "";
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", stopDragging);
    window.removeEventListener("blur", stopDragging);
    applyInspectorWidth(state.inspectorWidth || INSPECTOR_WIDTH_DEFAULT, { persist: true });
    notifyLayoutViewportResized();
  };

  resizer.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || state.panelCollapsed) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragging = true;
    panel.classList.add("resizing");
    resizer.classList.add("dragging");
    document.body.style.cursor = "ew-resize";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stopDragging);
    window.addEventListener("blur", stopDragging);
  });

  resizer.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    applyInspectorWidth(INSPECTOR_WIDTH_DEFAULT, { persist: true });
    notifyLayoutViewportResized();
  });

  window.addEventListener("resize", () => {
    if (!state.panelCollapsed) {
      applyInspectorWidth(state.inspectorWidth || INSPECTOR_WIDTH_DEFAULT, { persist: false });
    }
    scheduleResizeSync();
  });
}

function scheduleCanvasResize(panelEl) {
  let resized = false;
  const syncCanvasSize = () => {
    if (resized || !state.cy) {
      return;
    }
    resized = true;
    notifyLayoutViewportResized();
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
  legend.classList.toggle("hidden", shouldCollapse);
  if (body) {
    body.classList.toggle("hidden", shouldCollapse);
  }
  toggleBtn.classList.toggle("active", !shouldCollapse);
  toggleBtn.setAttribute("aria-expanded", String(!shouldCollapse));
  toggleBtn.title = shouldCollapse ? "Mostrar leyenda visual" : "Ocultar leyenda visual";
}

function toggleInspectorPanel(forceOpen = null) {
  const panel = document.getElementById("details-panel");
  const showBtn = document.getElementById("btn-show-panel");
  const resizer = document.getElementById("details-panel-resizer");
  if (!panel || !showBtn) {
    return;
  }
  const shouldCollapse = forceOpen === null ? !state.panelCollapsed : !forceOpen;
  state.panelCollapsed = shouldCollapse;
  panel.classList.toggle("collapsed", shouldCollapse);
  if (!shouldCollapse) {
    panel.style.width = `${clampInspectorWidth(state.inspectorWidth || INSPECTOR_WIDTH_DEFAULT)}px`;
  }
  if (resizer) {
    resizer.classList.toggle("hidden-resizer", shouldCollapse);
  }
  showBtn.classList.toggle("hidden", !shouldCollapse);
  scheduleCanvasResize(panel);
}

// ---------------------------------------------------------------------------
// Eventos de barra, panel lateral y atajos de teclado
// ---------------------------------------------------------------------------

function updateLayoutOrderButton() {
  const btn = document.getElementById("btn-layout-order");
  if (!btn) {
    return;
  }
  const isCreation = state.layoutOrderMode === "creation";
  btn.textContent = isCreation ? "Orden: Creación (1→N)" : "Orden: ↓ Ejecución";
  btn.dataset.order = state.layoutOrderMode;
  btn.setAttribute("aria-pressed", String(isCreation));
  btn.classList.toggle("creation-mode", isCreation);
  btn.title = isCreation
    ? "Orden de Creación estricto activo (funciones 1→N por línea en bandas y cimientos→ensamblaje). Clic para volver a ↓ Ejecución"
    : "Orden de Ejecución activo (entradas arriba, destinos abajo). Clic para cambiar a Creación (1→N)";
}

async function toggleLayoutOrderMode(forceMode = null) {
  const nextMode = forceMode === "execution" || forceMode === "creation"
    ? forceMode
    : (state.layoutOrderMode === "creation" ? "execution" : "creation");
  if (state.layoutOrderMode === nextMode) {
    updateLayoutOrderButton();
    return;
  }
  state.layoutOrderMode = nextMode;
  updateLayoutOrderButton();
  await refreshGraphView({ fit: true });
  // Re-layoutar ventanas flotantes abiertas de archivo o módulo para mantener coherencia visual.
  for (const win of Array.from(state.floatingWindows.values())) {
    if (win.destroyed || !win.cy || win.isFunctionFlow) {
      continue;
    }
    if (Array.isArray(win.subgraphNodes) && Array.isArray(win.subgraphEdges)) {
      await runSubElkLayout(win.cy, win.subgraphNodes, win.subgraphEdges, false);
    }
  }
  scheduleBridgeRender();
  if (state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
    selectNode(state.selectedNodeId, state.activeFlowStepId);
  }
}

function bindControls() {
  for (const btn of document.querySelectorAll(".level-btn")) {
    btn.addEventListener("click", () => applyLevel(Number(btn.dataset.level)));
  }
  for (const btn of document.querySelectorAll(".group-btn")) {
    btn.addEventListener("click", () => setGroupingMode(btn.dataset.grouping));
  }
  const layoutOrderBtn = document.getElementById("btn-layout-order");
  if (layoutOrderBtn) {
    layoutOrderBtn.addEventListener("click", () => toggleLayoutOrderMode());
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
  window.addEventListener("blur", () => {
    setSpacePanMode(false);
  });
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
    zoomIndicator.addEventListener("click", beginZoomEdit);
  }
  const zoomInput = document.getElementById("zoom-input");
  if (zoomInput) {
    zoomInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        commitZoomEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelZoomEdit();
      }
    });
    zoomInput.addEventListener("blur", () => {
      if (state.zoomEditActive) {
        commitZoomEdit();
      }
    });
  }

  document.getElementById("btn-relayout").addEventListener("click", () => {
    refreshGraphView({ fit: false });
  });
  document.getElementById("btn-fit").addEventListener("click", fitGraphToScreen);
  document.getElementById("btn-trace").addEventListener("click", toggleTraceMode);
  document.getElementById("btn-hide-utilities").addEventListener("click", toggleHideUtilities);
  const toggleVarsBtn = document.getElementById("btn-toggle-variables");
  if (toggleVarsBtn) {
    toggleVarsBtn.addEventListener("click", toggleShowVariables);
  }
  const varSourceBtn = document.getElementById("btn-var-load-source");
  if (varSourceBtn) {
    varSourceBtn.addEventListener("click", toggleSelectedVariableSource);
  }
  const onDemandBtn = document.getElementById("btn-on-demand-edges");
  if (onDemandBtn) {
    onDemandBtn.addEventListener("click", toggleOnDemandEdges);
  }
  const isolateContextBtn = document.getElementById("btn-isolate-context");
  if (isolateContextBtn) {
    isolateContextBtn.addEventListener("click", toggleIsolateActiveContext);
  }
  const inspectorIsolateFlowBtn = document.getElementById("btn-inspector-isolate-flow");
  if (inspectorIsolateFlowBtn) {
    inspectorIsolateFlowBtn.addEventListener("click", toggleIsolateActiveContext);
  }
  const traceIsolateBtn = document.getElementById("btn-trace-isolate");
  if (traceIsolateBtn) {
    traceIsolateBtn.addEventListener("click", toggleIsolateActiveContext);
  }
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
  initInspectorPanelResizer();

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
  const filterApisAllBtn = document.getElementById("filter-apis-all");
  if (filterApisAllBtn) {
    filterApisAllBtn.addEventListener("click", () => switchApisCategory("all"));
  }
  const filterApisOnlyBtn = document.getElementById("filter-apis-only");
  if (filterApisOnlyBtn) {
    filterApisOnlyBtn.addEventListener("click", () => switchApisCategory("apis"));
  }
  const filterApisVocabBtn = document.getElementById("filter-apis-vocab");
  if (filterApisVocabBtn) {
    filterApisVocabBtn.addEventListener("click", () => switchApisCategory("vocab"));
  }
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

  const isolateFileBtn = document.getElementById("btn-isolate-file");
  if (isolateFileBtn) {
    isolateFileBtn.addEventListener("click", () => toggleIsolateSelectedFile());
  }
  const exitIsolateFileBtn = document.getElementById("btn-exit-file-isolation");
  if (exitIsolateFileBtn) {
    exitIsolateFileBtn.addEventListener("click", () => exitFileIsolation());
  }
  const exploreNHopsBtn = document.getElementById("btn-explore-nhops");
  if (exploreNHopsBtn) {
    exploreNHopsBtn.addEventListener("click", () => exploreNHopsFromSelectedNode());
  }
  const nhopsAddBackBtn = document.getElementById("btn-nhops-add-back");
  if (nhopsAddBackBtn) {
    nhopsAddBackBtn.addEventListener("click", () => adjustNHopsDepth("backward", 1));
  }
  const nhopsAddFwdBtn = document.getElementById("btn-nhops-add-fwd");
  if (nhopsAddFwdBtn) {
    nhopsAddFwdBtn.addEventListener("click", () => adjustNHopsDepth("forward", 1));
  }
  const nhops1Btn = document.getElementById("btn-nhops-1");
  if (nhops1Btn) {
    nhops1Btn.addEventListener("click", () => setNHopsPreset(1));
  }
  const nhops2Btn = document.getElementById("btn-nhops-2");
  if (nhops2Btn) {
    nhops2Btn.addEventListener("click", () => setNHopsPreset(2));
  }
  const nhopsShowAllBtn = document.getElementById("btn-nhops-show-all");
  if (nhopsShowAllBtn) {
    nhopsShowAllBtn.addEventListener("click", () => exitNHops());
  }

  window.addEventListener("resize", () => {
    scheduleBridgeRender();
  });

  document.getElementById("btn-pin-node").addEventListener("click", async () => {
    if (!state.selectedNodeId) {
      return;
    }
    const contextKey = getCurrentLayoutContextKey();
    const legacyKey = LEGACY_PIN_FALLBACK_KEY[contextKey];
    const entry = getNoteEntry(state.selectedNodeId);
    const cyNode = state.cy.getElementById(state.selectedNodeId);
    if (isPinnedInCurrentContext(entry)) {
      const nextPositions = { ...(entry.pinned_positions || {}) };
      delete nextPositions[contextKey];
      if (legacyKey) {
        delete nextPositions[legacyKey];
      }
      const stillHasOtherPins = Object.keys(nextPositions).length > 0;
      await saveNotePatch(state.selectedNodeId, {
        pinned: stillHasOtherPins,
        x: contextKey === "functions" ? null : entry.x,
        y: contextKey === "functions" ? null : entry.y,
        pinned_positions: nextPositions,
      });
      refreshCyNodeMetadata(state.selectedNodeId);
      updatePinButton(false);
      updateReleasePinnedButton();
      await refreshGraphView({ fit: false });
    } else if (cyNode && cyNode.length > 0) {
      if (cyNode.isParent() && typeof cyNode.updateCompoundBounds === "function") {
        cyNode.updateCompoundBounds(true);
      }
      const pos = cyNode.position();
      const x = Math.round(pos.x * 10) / 10;
      const y = Math.round(pos.y * 10) / 10;
      const nextPositions = {
        ...(entry.pinned_positions || {}),
        [contextKey]: { x, y },
      };
      await saveNotePatch(state.selectedNodeId, {
        pinned: true,
        x: contextKey === "functions" ? x : entry.x,
        y: contextKey === "functions" ? y : entry.y,
        pinned_positions: nextPositions,
      });
      refreshCyNodeMetadata(state.selectedNodeId);
      updatePinButton(true);
      updateReleasePinnedButton();
    }
  });

  const releasePinnedBtn = document.getElementById("btn-release-pinned");
  if (releasePinnedBtn) {
    releasePinnedBtn.addEventListener("click", async () => {
      await releaseScopedPinnedNodes();
    });
  }

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
      if (state.zoomEditActive) {
        event.preventDefault();
        cancelZoomEdit();
        return;
      }
      if (document.activeElement && document.activeElement.id === "wt-speed-select") {
        event.preventDefault();
        document.activeElement.blur();
        return;
      }
      if (closeOpenModals()) {
        return;
      }
      if (
        state.walkthrough
        && state.walkthrough.isActive()
        && typeof state.walkthrough.getScope === "function"
        && state.walkthrough.getScope().scope === "window"
      ) {
        state.walkthrough.stop();
        return;
      }
      if (closeMostRecentLeafFloatingWindow()) {
        return;
      }
      if (state.walkthrough && state.walkthrough.isActive()) {
        state.walkthrough.stop();
        return;
      }
      if (state.traceMode) {
        toggleTraceMode();
        return;
      }
      if (state.isolatedFileId) {
        exitFileIsolation();
        return;
      }
      if (state.nhops.active) {
        exitNHops();
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
    if (
      (event.key === "1" || event.key === "2" || event.key === "3" || event.key === "4")
      && !event.ctrlKey
      && !event.metaKey
      && !event.altKey
    ) {
      applyLevel(Number(event.key));
    } else if (key === "r" && !event.ctrlKey && !event.metaKey) {
      refreshGraphView({ fit: false });
    } else if (key === "t" && !event.ctrlKey && !event.metaKey) {
      toggleTraceMode();
    } else if (key === "w" && !event.ctrlKey && !event.metaKey) {
      if (state.walkthrough) {
        state.walkthrough.toggle({ autoPlay: false });
      }
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
      if (state.walkthrough && state.walkthrough.isActive() && !state.traceMode) {
        state.walkthrough.stepForward();
      } else {
        stepTrace("forward");
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (state.walkthrough && state.walkthrough.isActive() && !state.traceMode) {
        state.walkthrough.stepBackward();
      } else {
        stepTrace("backward");
      }
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
    btn.disabled = true;
    btn.textContent = "↗ Abrir en ventana";
    btn.title = "No disponible para este nodo";
    return;
  }
  btn.disabled = false;
  const alreadyOpen = state.floatingWindowByTarget.has(node.id);
  if (alreadyOpen) {
    btn.textContent = "↗ Enfocar ventana";
    btn.title = "Enfocar ventana flotante abierta";
  } else if (node.type === "function") {
    btn.textContent = "↗ Abrir en ventana";
    btn.title = "Abrir flujo interno (3+) y código en ventana flotante (Alt + Doble clic)";
  } else {
    btn.textContent = "↗ Abrir en ventana";
    btn.title = "Abrir contenedor aislado en ventana flotante (Alt + Doble clic)";
  }
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
  if (externalNode.type === "function" || externalNode.type === "variable") {
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
  if (externalNode.type === "function" || externalNode.type === "variable") {
    const parentFile = externalNode.parent ? state.nodesById.get(externalNode.parent) : null;
    const rawName = String(externalNode.label || externalNode.id);
    const displayName = externalNode.type === "function" && !rawName.endsWith(")")
      ? `${rawName}()`
      : rawName;
    if (parentFile && parentFile.label) {
      return `${arrow} ${parentFile.label} :: ${displayName}`;
    }
    return `${arrow} ${displayName}`;
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
    appendInternalFlowElements(targetNode, nodes, visibleIds, { ignorePins: true });
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
      if (rawNode.type === "variable" && !state.showVariables) {
        continue;
      }
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
        varKind: rawNode.var_kind || "constant",
        entryKind: rawNode.entry_kind || "",
        fileLang: rawNode.language || "",
        mainEntry: rawNode.is_main_entry ? "true" : "false",
        terminal: rawNode.type === "function" && rawNode.is_terminal ? "true" : "false",
        pinned: "false",
        hasNote: noteEntry.note && noteEntry.note.trim() ? "true" : "false",
        collapsed: "false",
        expandedFn: "false",
        flowStepOrder: 0,
        line: rawNode.line || 0,
        archLayer: getNodeArchLayer(rawNode),
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
    if (!state.showVariables && rawEdge.edge_type === "reads_var") {
      continue;
    }
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
  const useCreationInSub = !isFunctionFlow && state.layoutOrderMode === "creation";
  let elkGraph;
  let creationMeta = null;
  if (useCreationInSub) {
    const built = buildCreationElkInput(visibleNodes, visibleEdges, { floatingPorts: true });
    elkGraph = built.elkGraph;
    creationMeta = built.creationMeta;
  } else {
    elkGraph = buildElkInput(visibleNodes, visibleEdges, { forceExecution: true });
    elkGraph.layoutOptions = isFunctionFlow
      ? {
          "elk.algorithm": "layered",
          "elk.direction": "DOWN",
          "elk.hierarchyHandling": "INCLUDE_CHILDREN",
          "elk.edgeRouting": "ORTHOGONAL",
          "elk.layered.spacing.nodeNodeBetweenLayers": "54",
          "elk.layered.spacing.edgeNodeBetweenLayers": "26",
          "elk.layered.spacing.edgeEdgeBetweenLayers": "20",
          "elk.spacing.nodeNode": "38",
          "elk.spacing.edgeNode": "24",
          "elk.spacing.edgeEdge": "20",
          "elk.padding": "[top=24,left=24,bottom=24,right=24]",
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
          "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        };
  }

  const layouted = await state.elk.layout(elkGraph);
  const elkPositions = new Map();
  const containerOffsets = new Map([["root", { x: 0, y: 0 }]]);
  collectAbsolutePositions(layouted, 0, 0, elkPositions, containerOffsets);

  let staggerMeta = null;
  if (useCreationInSub) {
    const dataById = new Map(visibleNodes.map((item) => [item.data.id, item.data]));
    const shifted = applyCreationRowStagger(
      layouted,
      elkPositions,
      new Set(),
      dataById,
      CREATION_ROW_STAGGER_PX,
    );
    staggerMeta = shifted.staggerMeta || null;
  }

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
  subCy.batch(() => {
    applyElkEdgeRoutes(
      subCy,
      layouted,
      elkPositions,
      containerOffsets,
      null,
      isFunctionFlow || useCreationInSub ? "downward" : "rightward",
      staggerMeta,
      creationMeta,
    );
  });
  subCy.resize();
  fitCyWithDynamicMinZoom(subCy, undefined, 22, FW_MIN_ZOOM);
}

function computeFloatingWindowPosition(parentWindowId) {
  const area = document.getElementById("canvas-area");
  const areaW = area ? area.clientWidth : 960;
  const areaH = area ? area.clientHeight : 640;
  const winW = Math.min(460, Math.max(320, Math.round(areaW * 0.44)));
  const winH = Math.min(360, Math.max(250, Math.round(areaH * 0.52)));

  const hudActive = Boolean(state.walkthrough && typeof state.walkthrough.isActive === "function" && state.walkthrough.isActive());
  const minTop = hudActive ? 58 : 12;
  const baseTop = hudActive ? 58 : 24;
  let left = 24;
  let top = baseTop;
  const parentWin = parentWindowId ? state.floatingWindows.get(parentWindowId) : null;
  if (parentWin && parentWin.el) {
    const siblingIndex = parentWin.childWindowIds.size;
    const pLeft = parseFloat(parentWin.el.style.left) || 24;
    const pTop = parseFloat(parentWin.el.style.top) || baseTop;
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
    top = baseTop + (rootOffset % 4) * 30;
  }

  const maxLeft = Math.max(12, areaW - winW - 12);
  const maxTop = Math.max(minTop, areaH - winH - 12);
  return {
    left: Math.round(Math.min(maxLeft, Math.max(12, left))),
    top: Math.round(Math.min(maxTop, Math.max(minTop, top))),
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

const FW_CODE_WRAP_STORAGE_KEY = "codemap.fw.codeWrap";
const FW_CODE_FONT_SIZE_STORAGE_KEY = "codemap.fw.codeFontSize";
const FW_CODE_FONT_MIN = 10;
const FW_CODE_FONT_MAX = 22;
const FW_CODE_FONT_DEFAULT = 12;
const FW_SPLIT_MIN_PANE_PX = 180;

const fwCodePrefs = {
  wrap: false,
  fontSize: FW_CODE_FONT_DEFAULT,
  loaded: false,
};

function loadFloatingCodePrefs() {
  if (fwCodePrefs.loaded) {
    return fwCodePrefs;
  }
  fwCodePrefs.loaded = true;
  try {
    if (typeof localStorage !== "undefined") {
      const savedWrap = localStorage.getItem(FW_CODE_WRAP_STORAGE_KEY);
      if (savedWrap === "true" || savedWrap === "1") {
        fwCodePrefs.wrap = true;
      }
      const savedSize = parseInt(localStorage.getItem(FW_CODE_FONT_SIZE_STORAGE_KEY) || "", 10);
      if (Number.isFinite(savedSize)) {
        fwCodePrefs.fontSize = Math.max(FW_CODE_FONT_MIN, Math.min(FW_CODE_FONT_MAX, savedSize));
      }
    }
  } catch (_err) {
    // Ignorar errores de almacenamiento privado.
  }
  return fwCodePrefs;
}

function saveFloatingCodePrefs() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(FW_CODE_WRAP_STORAGE_KEY, String(Boolean(fwCodePrefs.wrap)));
      localStorage.setItem(FW_CODE_FONT_SIZE_STORAGE_KEY, String(fwCodePrefs.fontSize));
    }
  } catch (_err) {
    // Ignorar errores de almacenamiento privado.
  }
}

function applyFloatingCodePrefsToWindow(win) {
  if (!win || win.destroyed || !win.codePaneEl) {
    return;
  }
  const prefs = loadFloatingCodePrefs();
  win.codePaneEl.classList.toggle("wrap-enabled", Boolean(prefs.wrap));
  win.codePaneEl.style.setProperty("--fw-code-font-size", `${prefs.fontSize}px`);
  if (win.wrapCodeBtn) {
    win.wrapCodeBtn.classList.toggle("active", Boolean(prefs.wrap));
    win.wrapCodeBtn.setAttribute("aria-pressed", String(Boolean(prefs.wrap)));
  }
  if (win.zoomValEl) {
    win.zoomValEl.textContent = `${prefs.fontSize}px`;
  }
  if (win.zoomOutBtn) {
    win.zoomOutBtn.disabled = prefs.fontSize <= FW_CODE_FONT_MIN;
  }
  if (win.zoomInBtn) {
    win.zoomInBtn.disabled = prefs.fontSize >= FW_CODE_FONT_MAX;
  }
}

function applyFloatingCodePrefsToAllWindows() {
  for (const win of state.floatingWindows.values()) {
    applyFloatingCodePrefsToWindow(win);
  }
}

function applyFloatingSplitRatio(win) {
  if (!win || win.destroyed || !win.cyContainer || !win.codePaneEl) {
    return;
  }
  if (win.viewMode !== "split") {
    win.cyContainer.style.flex = "";
    win.cyContainer.style.width = "";
    win.codePaneEl.style.flex = "";
    win.codePaneEl.style.width = "";
    return;
  }
  const resizerW = win.splitResizerEl ? (win.splitResizerEl.offsetWidth || 6) : 6;
  const totalW = Math.max(0, (win.bodyEl ? win.bodyEl.clientWidth : 0) - resizerW);
  const ratio = typeof win.splitRatio === "number" && Number.isFinite(win.splitRatio)
    ? win.splitRatio
    : 0.5;
  if (totalW > FW_SPLIT_MIN_PANE_PX * 2) {
    const minRatio = FW_SPLIT_MIN_PANE_PX / totalW;
    const maxRatio = 1 - minRatio;
    const clamped = Math.max(minRatio, Math.min(maxRatio, ratio));
    win.splitRatio = clamped;
    const leftPx = Math.round(totalW * clamped);
    win.cyContainer.style.flex = `0 0 ${leftPx}px`;
    win.cyContainer.style.width = `${leftPx}px`;
    win.codePaneEl.style.flex = "1 1 0%";
    win.codePaneEl.style.width = "";
  } else {
    const clamped = Math.max(0.25, Math.min(0.75, ratio));
    win.splitRatio = clamped;
    const pct = Math.round(clamped * 1000) / 10;
    win.cyContainer.style.flex = `0 0 ${pct}%`;
    win.cyContainer.style.width = "";
    win.codePaneEl.style.flex = "1 1 0%";
    win.codePaneEl.style.width = "";
  }
}

function bindFloatingSplitResizer(win) {
  if (!win || !win.splitResizerEl || !win.bodyEl) {
    return null;
  }
  let dragging = false;
  let rafPending = false;

  const scheduleSplitResize = () => {
    if (rafPending) {
      return;
    }
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!win.destroyed && win.cy) {
        win.cy.resize();
        scheduleBridgeRender();
      }
    });
  };

  const onMouseMove = (event) => {
    if (!dragging || win.destroyed || win.viewMode !== "split") {
      return;
    }
    const rect = win.bodyEl.getBoundingClientRect();
    const resizerW = win.splitResizerEl.offsetWidth || 6;
    const availW = Math.max(1, rect.width - resizerW);
    const relX = event.clientX - rect.left;
    win.splitRatio = relX / availW;
    applyFloatingSplitRatio(win);
    scheduleSplitResize();
  };

  const stopDragging = () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    win.splitResizerEl.classList.remove("dragging");
    document.body.style.cursor = "";
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", stopDragging);
    window.removeEventListener("blur", stopDragging);
    scheduleSplitResize();
  };

  const onMouseDown = (event) => {
    if (event.button !== 0 || win.viewMode !== "split") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    focusFloatingWindow(win.id);
    dragging = true;
    win.splitResizerEl.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stopDragging);
    window.addEventListener("blur", stopDragging);
  };

  const onDblClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (win.viewMode !== "split") {
      return;
    }
    win.splitRatio = 0.5;
    applyFloatingSplitRatio(win);
    scheduleSplitResize();
  };

  win.splitResizerEl.addEventListener("mousedown", onMouseDown);
  win.splitResizerEl.addEventListener("dblclick", onDblClick);

  return () => {
    stopDragging();
    win.splitResizerEl.removeEventListener("mousedown", onMouseDown);
    win.splitResizerEl.removeEventListener("dblclick", onDblClick);
  };
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

  let modeSwitcherEl = null;
  const modeButtons = new Map();
  if (subgraph.isFunctionFlow) {
    modeSwitcherEl = document.createElement("div");
    modeSwitcherEl.className = "fw-mode-switcher";
    modeSwitcherEl.setAttribute("role", "group");
    modeSwitcherEl.setAttribute("aria-label", "Modo de vista de función");
    const modes = [
      { key: "flow", label: "Solo flujo", title: "Mostrar únicamente el diagrama de flujo interno (3+)" },
      { key: "code", label: "Solo código", title: "Mostrar el código fuente con números de línea" },
      { key: "split", label: "Flujo y código", title: "Vista dividida 50/50 sincronizando pasos del flujo y líneas de código" },
    ];
    for (const m of modes) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `fw-mode-btn${m.key === "flow" ? " active" : ""}`;
      btn.dataset.fwMode = m.key;
      btn.textContent = m.label;
      btn.title = m.title;
      btn.setAttribute("aria-pressed", m.key === "flow" ? "true" : "false");
      modeSwitcherEl.appendChild(btn);
      modeButtons.set(m.key, btn);
    }
  }

  let walkthroughBtn = null;
  if (subgraph.isFunctionFlow) {
    walkthroughBtn = document.createElement("button");
    walkthroughBtn.type = "button";
    walkthroughBtn.className = "fw-btn fw-walkthrough-btn";
    walkthroughBtn.textContent = "⚡ Recorrer";
    walkthroughBtn.setAttribute("aria-pressed", "false");
    walkthroughBtn.title = "Iniciar Recorrido Visual aislado dentro de esta ventana (sin alterar el grafo principal)";
    actionsEl.appendChild(walkthroughBtn);
  }

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
  if (modeSwitcherEl) {
    headerEl.appendChild(modeSwitcherEl);
  }
  headerEl.appendChild(actionsEl);

  const lockNoticeEl = document.createElement("div");
  lockNoticeEl.className = "fw-lock-notice hidden";
  lockNoticeEl.setAttribute("role", "alert");

  const bodyEl = document.createElement("div");
  bodyEl.className = "fw-body mode-flow";

  const cyContainer = document.createElement("div");
  cyContainer.className = "fw-cy-container";
  bodyEl.appendChild(cyContainer);

  let splitResizerEl = null;
  let codePaneEl = null;
  let codeMetaEl = null;
  let wrapCodeBtn = null;
  let zoomOutBtn = null;
  let zoomValEl = null;
  let zoomInBtn = null;
  let copyCodeBtn = null;
  let codeLinesEl = null;
  let vocabDockEl = null;
  if (subgraph.isFunctionFlow) {
    splitResizerEl = document.createElement("div");
    splitResizerEl.className = "fw-split-resizer";
    splitResizerEl.setAttribute("role", "separator");
    splitResizerEl.setAttribute("aria-orientation", "vertical");
    splitResizerEl.setAttribute("aria-label", "Redimensionar paneles de flujo y código");
    splitResizerEl.title = "Arrastra para redimensionar · Doble clic para restaurar 50/50";
    bodyEl.appendChild(splitResizerEl);

    codePaneEl = document.createElement("div");
    codePaneEl.className = "fw-code-pane hidden";
    codePaneEl.setAttribute("aria-label", "Código fuente de la función");

    const codeToolbar = document.createElement("div");
    codeToolbar.className = "fw-code-toolbar";

    codeMetaEl = document.createElement("span");
    codeMetaEl.className = "fw-code-meta";
    codeMetaEl.textContent = "Código fuente";

    const codeControls = document.createElement("div");
    codeControls.className = "fw-code-controls";

    wrapCodeBtn = document.createElement("button");
    wrapCodeBtn.type = "button";
    wrapCodeBtn.className = "fw-btn fw-code-wrap-btn";
    wrapCodeBtn.textContent = "Ajustar líneas";
    wrapCodeBtn.setAttribute("aria-pressed", "false");
    wrapCodeBtn.title = "Alternar ajuste de líneas largas (Word Wrap)";

    const zoomGroup = document.createElement("div");
    zoomGroup.className = "fw-code-zoom-group";
    zoomGroup.setAttribute("role", "group");
    zoomGroup.setAttribute("aria-label", "Tamaño de fuente del código");

    zoomOutBtn = document.createElement("button");
    zoomOutBtn.type = "button";
    zoomOutBtn.className = "fw-code-zoom-btn fw-code-zoom-out-btn";
    zoomOutBtn.textContent = "A−";
    zoomOutBtn.title = "Reducir fuente del código";

    zoomValEl = document.createElement("span");
    zoomValEl.className = "fw-code-zoom-val";
    zoomValEl.textContent = `${FW_CODE_FONT_DEFAULT}px`;

    zoomInBtn = document.createElement("button");
    zoomInBtn.type = "button";
    zoomInBtn.className = "fw-code-zoom-btn fw-code-zoom-in-btn";
    zoomInBtn.textContent = "A+";
    zoomInBtn.title = "Aumentar fuente del código";

    zoomGroup.appendChild(zoomOutBtn);
    zoomGroup.appendChild(zoomValEl);
    zoomGroup.appendChild(zoomInBtn);

    copyCodeBtn = document.createElement("button");
    copyCodeBtn.type = "button";
    copyCodeBtn.className = "fw-btn fw-copy-code-btn";
    copyCodeBtn.textContent = "Copiar";
    copyCodeBtn.title = "Copiar código fuente de la función";

    codeControls.appendChild(wrapCodeBtn);
    codeControls.appendChild(zoomGroup);
    codeControls.appendChild(copyCodeBtn);

    codeToolbar.appendChild(codeMetaEl);
    codeToolbar.appendChild(codeControls);

    const codeScroll = document.createElement("div");
    codeScroll.className = "fw-code-scroll";

    codeLinesEl = document.createElement("div");
    codeLinesEl.className = "fw-code-lines";
    codeLinesEl.setAttribute("role", "region");
    codeLinesEl.setAttribute("aria-label", "Líneas de código");

    codeScroll.appendChild(codeLinesEl);
    codePaneEl.appendChild(codeToolbar);
    codePaneEl.appendChild(codeScroll);

    vocabDockEl = document.createElement("div");
    vocabDockEl.className = "vocab-dock fw-vocab-dock hidden";
    vocabDockEl.setAttribute("aria-label", "Fichas vivas de vocabulario y notas por línea");
    codePaneEl.appendChild(vocabDockEl);

    bodyEl.appendChild(codePaneEl);
  }

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
    modeSwitcherEl,
    modeButtons,
    walkthroughBtn,
    fitBtn,
    closeChainBtn,
    closeBtn,
    lockNoticeEl,
    bodyEl,
    cyContainer,
    splitResizerEl,
    codePaneEl,
    codeMetaEl,
    wrapCodeBtn,
    zoomOutBtn,
    zoomValEl,
    zoomInBtn,
    copyCodeBtn,
    codeLinesEl,
    vocabDockEl,
    statsEl,
    hintEl,
  };
}

const CODE_KEYWORDS_BY_LANG = {
  python: new Set([
    "def", "async", "await", "return", "if", "elif", "else", "for", "while", "in",
    "try", "except", "finally", "with", "as", "class", "raise", "yield", "match",
    "case", "pass", "break", "continue", "import", "from", "and", "or", "not", "is",
    "lambda", "True", "False", "None", "self", "cls",
  ]),
  js: new Set([
    "function", "async", "await", "return", "if", "else", "for", "while", "do", "of",
    "in", "try", "catch", "finally", "throw", "switch", "case", "default", "break",
    "continue", "const", "let", "var", "class", "new", "export", "import", "from",
    "typeof", "instanceof", "true", "false", "null", "undefined", "this",
  ]),
};

function appendHighlightedCodeTokens(parentEl, lineText, language) {
  const isPython = language === "python";
  const keywords = isPython ? CODE_KEYWORDS_BY_LANG.python : CODE_KEYWORDS_BY_LANG.js;
  const tokenRe = isPython
    ? /(#.*$|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/gm
    : /(\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/gm;

  let cursor = 0;
  let match;
  while ((match = tokenRe.exec(lineText)) !== null) {
    if (match.index > cursor) {
      parentEl.appendChild(document.createTextNode(lineText.slice(cursor, match.index)));
    }
    const token = match[0];
    let cls = "";
    if ((isPython && token.startsWith("#")) || (!isPython && (token.startsWith("//") || token.startsWith("/*")))) {
      cls = "tok-comment";
    } else if (token.startsWith('"') || token.startsWith("'") || token.startsWith("`")) {
      cls = "tok-string";
    } else if (/^\d/.test(token)) {
      cls = "tok-number";
    } else if (keywords.has(token)) {
      cls = "tok-keyword";
    }

    if (cls) {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = token;
      parentEl.appendChild(span);
    } else {
      parentEl.appendChild(document.createTextNode(token));
    }
    cursor = match.index + token.length;
  }
  if (cursor < lineText.length) {
    parentEl.appendChild(document.createTextNode(lineText.slice(cursor)));
  }
}

function findFlowStepRange(fnId, stepId, cyInst = null) {
  if (!fnId || !stepId) {
    return null;
  }
  const rawNode = state.nodesById.get(fnId);
  if (rawNode && Array.isArray(rawNode.internal_flow)) {
    const step = rawNode.internal_flow.find((item) => item.id === stepId);
    if (step && step.line > 0) {
      return {
        startLine: step.line,
        endLine: step.end_line && step.end_line >= step.line ? step.end_line : step.line,
      };
    }
  }
  if (cyInst && typeof cyInst.getElementById === "function") {
    const cyStep = cyInst.getElementById(`${fnId}::${stepId}`);
    if (cyStep && cyStep.length > 0) {
      const line = Number(cyStep.data("stepLine") || 0);
      const endLine = Number(cyStep.data("stepEndLine") || line);
      if (line > 0) {
        return { startLine: line, endLine: Math.max(line, endLine) };
      }
    }
  }
  return null;
}

function findBestFlowStepForLine(fnId, lineNum) {
  const rawNode = state.nodesById.get(fnId);
  if (!rawNode || !Array.isArray(rawNode.internal_flow) || !lineNum) {
    return null;
  }
  const matching = rawNode.internal_flow.filter((step) => {
    if (!step.line || step.line <= 0) {
      return false;
    }
    const endLine = step.end_line && step.end_line >= step.line ? step.end_line : step.line;
    return lineNum >= step.line && lineNum <= endLine;
  });
  if (matching.length === 0) {
    return null;
  }
  matching.sort((a, b) => {
    const spanA = (a.end_line && a.end_line >= a.line ? a.end_line : a.line) - a.line;
    const spanB = (b.end_line && b.end_line >= b.line ? b.end_line : b.line) - b.line;
    if (spanA !== spanB) {
      return spanA - spanB;
    }
    if (Boolean(a.is_container) !== Boolean(b.is_container)) {
      return a.is_container ? 1 : -1;
    }
    return b.line - a.line;
  });
  return matching[0];
}

function highlightFloatingCodeForStep(win, stepId, { scroll = true, skipVocab = false } = {}) {
  if (!win || win.destroyed || !win.codeLinesEl) {
    return;
  }
  const rows = win.codeLinesEl.querySelectorAll(".fw-code-line");
  rows.forEach((row) => row.classList.remove("highlighted-step"));

  if (!stepId) {
    return;
  }
  const range = findFlowStepRange(win.targetId, stepId, win.cy);
  if (!range) {
    return;
  }

  let firstMatch = null;
  rows.forEach((row) => {
    const lineNum = Number(row.dataset.line || "0");
    if (lineNum >= range.startLine && lineNum <= range.endLine) {
      row.classList.add("highlighted-step");
      if (!firstMatch) {
        firstMatch = row;
      }
    }
  });
  if (scroll && firstMatch && typeof firstMatch.scrollIntoView === "function") {
    firstMatch.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  if (!skipVocab) {
    win.activeCodeLine = range.startLine;
    win.activeCodeEndLine = range.endLine;
    renderFloatingWindowVocab(win);
  }
}

function renderFloatingWindowSource(win, sourceData) {
  if (!win || win.destroyed || !win.codeLinesEl) {
    return;
  }
  win.codeLinesEl.replaceChildren();

  if (!sourceData || !Array.isArray(sourceData.lines)) {
    const empty = document.createElement("div");
    empty.className = "fw-code-status";
    empty.textContent = "Sin código fuente disponible.";
    win.codeLinesEl.appendChild(empty);
    renderFloatingWindowVocab(win);
    return;
  }

  if (win.codeMetaEl) {
    const fileBase = (sourceData.file_id || "").split("/").pop() || sourceData.file_id || "";
    const langTag = sourceData.language ? ` · ${sourceData.language}` : "";
    win.codeMetaEl.textContent = `${fileBase} · L${sourceData.start_line}–L${sourceData.end_line}${langTag}`;
    win.codeMetaEl.title = `${sourceData.file_id || ""} (líneas ${sourceData.start_line}-${sourceData.end_line})`;
  }

  const vocabHelper = typeof window !== "undefined" ? window.CodeMapVocab : null;
  const fragment = document.createDocumentFragment();
  for (const lineObj of sourceData.lines) {
    const row = document.createElement("div");
    const hasLineNote = Boolean(vocabHelper && vocabHelper.getLineNote(state.notes, sourceData.file_id, lineObj.number));
    row.className = hasLineNote ? "fw-code-line has-line-note" : "fw-code-line";
    row.dataset.line = String(lineObj.number);

    const numSpan = document.createElement("span");
    numSpan.className = "fw-code-lineno";
    numSpan.textContent = hasLineNote ? `📝${lineObj.number}` : String(lineObj.number);

    const textSpan = document.createElement("span");
    textSpan.className = "fw-code-text";
    appendHighlightedCodeTokens(textSpan, lineObj.text || "", sourceData.language || "");

    row.appendChild(numSpan);
    row.appendChild(textSpan);

    row.addEventListener("click", () => {
      if (win.destroyed) {
        return;
      }
      focusFloatingWindow(win.id);
      const matchedStep = findBestFlowStepForLine(win.targetId, lineObj.number);
      if (matchedStep) {
        win.selectedStepId = matchedStep.id;
        selectNode(win.targetId, matchedStep.id);
        highlightFloatingCodeForStep(win, matchedStep.id, { scroll: false, skipVocab: true });
        if (win.viewMode === "split" && win.cy) {
          const cyStep = win.cy.getElementById(`${win.targetId}::${matchedStep.id}`);
          if (cyStep && cyStep.length > 0) {
            win.cy.animate({ center: { eles: cyStep }, duration: 160 });
          }
        }
      } else {
        win.codeLinesEl.querySelectorAll(".fw-code-line").forEach((el) => el.classList.remove("highlighted-step"));
        row.classList.add("highlighted-step");
      }
      win.activeCodeLine = lineObj.number;
      win.activeCodeEndLine = lineObj.number;
      renderFloatingWindowVocab(win);
    });

    fragment.appendChild(row);
  }
  win.codeLinesEl.appendChild(fragment);

  if (win.selectedStepId) {
    highlightFloatingCodeForStep(win, win.selectedStepId, { scroll: true });
  } else {
    const fnNode = state.nodesById.get(win.targetId) || null;
    let initialLine = sourceData.start_line || 0;
    if (vocabHelper && fnNode) {
      for (const lineObj of sourceData.lines) {
        const items = vocabHelper.collectLineVocabItems(
          fnNode,
          lineObj.number,
          lineObj.number,
          state.vocabDict,
          state.knownApis,
        );
        if (items.length > 0) {
          initialLine = lineObj.number;
          break;
        }
      }
    }
    win.activeCodeLine = initialLine;
    win.activeCodeEndLine = initialLine;
    renderFloatingWindowVocab(win);
  }
}

async function loadFloatingWindowSource(win, { force = false } = {}) {
  if (!win || win.destroyed || !win.isFunctionFlow || !win.codeLinesEl) {
    return null;
  }
  if (!force && win.sourceLoaded && win.sourceData) {
    return win.sourceData;
  }
  if (win.sourceLoading) {
    return win.sourceLoading;
  }

  win.codeLinesEl.replaceChildren();
  const loadingEl = document.createElement("div");
  loadingEl.className = "fw-code-status";
  loadingEl.textContent = "Cargando código fuente…";
  win.codeLinesEl.appendChild(loadingEl);

  const requestPromise = (async () => {
    try {
      const response = await fetch(`/source?node_id=${encodeURIComponent(win.targetId)}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        let errText = `HTTP ${response.status}`;
        try {
          const body = await response.json();
          if (body && body.error) {
            errText = body.error;
          }
        } catch (_err) {
          // Mantener texto de estado HTTP.
        }
        throw new Error(errText);
      }
      const data = await response.json();
      if (win.destroyed) {
        return null;
      }
      win.sourceData = data;
      win.sourceLoaded = true;
      renderFloatingWindowSource(win, data);
      return data;
    } catch (error) {
      if (!win.destroyed && win.codeLinesEl) {
        win.codeLinesEl.replaceChildren();
        const errEl = document.createElement("div");
        errEl.className = "fw-code-status error";
        errEl.textContent = `No se pudo cargar el código: ${error.message || error}`;
        win.codeLinesEl.appendChild(errEl);
      }
      return null;
    } finally {
      win.sourceLoading = null;
    }
  })();

  win.sourceLoading = requestPromise;
  return requestPromise;
}

async function setFloatingWindowViewMode(win, mode) {
  if (!win || win.destroyed || !win.isFunctionFlow) {
    return;
  }
  const nextMode = mode === "code" || mode === "split" ? mode : "flow";
  const prevMode = win.viewMode || "flow";
  win.viewMode = nextMode;

  win.bodyEl.classList.remove("mode-flow", "mode-code", "mode-split");
  win.bodyEl.classList.add(`mode-${nextMode}`);

  win.cyContainer.classList.toggle("hidden", nextMode === "code");
  if (win.codePaneEl) {
    win.codePaneEl.classList.toggle("hidden", nextMode === "flow");
  }
  if (win.fitBtn) {
    win.fitBtn.classList.toggle("hidden", nextMode === "code");
  }

  if (win.modeButtons) {
    for (const [key, btn] of win.modeButtons.entries()) {
      const active = key === nextMode;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    }
  }

  if (win.hintEl) {
    if (nextMode === "code") {
      win.hintEl.textContent = "Clic en línea: resaltar paso · Copiar arriba";
    } else if (nextMode === "split") {
      win.hintEl.textContent = "Clic en paso o línea: sincronizar flujo ↔ código";
    } else {
      win.hintEl.textContent = "Clic en paso: inspeccionar código";
    }
  }

  // Auto-ensanchamiento ergonómico para vista dividida 50/50.
  const area = document.getElementById("canvas-area");
  const areaW = area ? area.clientWidth : window.innerWidth;
  if (nextMode === "split" && prevMode !== "split") {
    const currentW = win.el.offsetWidth || parseFloat(win.el.style.width) || 460;
    const targetW = Math.min(840, Math.max(660, Math.round(areaW * 0.72)), Math.max(360, areaW - 24));
    if (targetW > currentW) {
      win.preSplitWidth = currentW;
      win.splitExpandedWidth = targetW;
      win.el.style.width = `${targetW}px`;
      const curLeft = parseFloat(win.el.style.left) || 12;
      const maxLeft = Math.max(12, areaW - targetW - 12);
      if (curLeft > maxLeft) {
        win.el.style.left = `${Math.round(maxLeft)}px`;
      }
    }
  } else if (prevMode === "split" && nextMode !== "split") {
    const currentW = win.el.offsetWidth || parseFloat(win.el.style.width) || 0;
    if (
      win.preSplitWidth
      && win.splitExpandedWidth
      && Math.abs(currentW - win.splitExpandedWidth) < 24
    ) {
      win.el.style.width = `${win.preSplitWidth}px`;
    }
    win.preSplitWidth = null;
    win.splitExpandedWidth = null;
  }

  if (nextMode === "code" || nextMode === "split") {
    await loadFloatingWindowSource(win);
    if (!win.destroyed && win.selectedStepId) {
      highlightFloatingCodeForStep(win, win.selectedStepId, { scroll: true });
    }
  }

  applyFloatingSplitRatio(win);

  if (nextMode === "flow" || nextMode === "split") {
    requestAnimationFrame(() => {
      if (!win.destroyed && win.cy) {
        applyFloatingSplitRatio(win);
        win.cy.resize();
        fitCyWithDynamicMinZoom(win.cy, undefined, 18, FW_MIN_ZOOM);
        scheduleBridgeRender();
      }
    });
  } else {
    scheduleBridgeRender();
  }
}

function bindFloatingWindowDrag(win) {
  const onMouseDown = (event) => {
    if (event.button !== 0) {
      return;
    }
    if (event.target.closest("button")) {
      return;
    }
    if (win.activeDragCleanup) {
      win.activeDragCleanup();
      win.activeDragCleanup = null;
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
      if (state.walkthrough && typeof state.walkthrough.onViewportChanged === "function") {
        state.walkthrough.onViewportChanged();
      }
    };

    const onMouseUp = () => {
      win.el.classList.remove("dragging");
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onMouseUp);
      win.activeDragCleanup = null;
      scheduleBridgeRender();
      if (state.walkthrough && typeof state.walkthrough.onViewportChanged === "function") {
        state.walkthrough.onViewportChanged();
      }
    };

    win.activeDragCleanup = () => {
      win.el.classList.remove("dragging");
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", onMouseUp);
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
    minZoom: FW_MIN_ZOOM,
    maxZoom: FW_MAX_ZOOM,
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
    modeSwitcherEl: dom.modeSwitcherEl,
    modeButtons: dom.modeButtons,
    walkthroughBtn: dom.walkthroughBtn,
    fitBtn: dom.fitBtn,
    closeChainBtn: dom.closeChainBtn,
    closeBtn: dom.closeBtn,
    lockNoticeEl: dom.lockNoticeEl,
    bodyEl: dom.bodyEl,
    cyContainer: dom.cyContainer,
    splitResizerEl: dom.splitResizerEl,
    codePaneEl: dom.codePaneEl,
    codeMetaEl: dom.codeMetaEl,
    wrapCodeBtn: dom.wrapCodeBtn,
    zoomOutBtn: dom.zoomOutBtn,
    zoomValEl: dom.zoomValEl,
    zoomInBtn: dom.zoomInBtn,
    copyCodeBtn: dom.copyCodeBtn,
    codeLinesEl: dom.codeLinesEl,
    vocabDockEl: dom.vocabDockEl,
    activeCodeLine: 0,
    activeCodeEndLine: 0,
    statsEl: dom.statsEl,
    hintEl: dom.hintEl,
    cy: subCy,
    portsMeta: subgraph.portsMeta,
    internalNodeIds: subgraph.internalNodeIds,
    isFunctionFlow: subgraph.isFunctionFlow,
    subgraphNodes: subgraph.nodes,
    subgraphEdges: subgraph.edges,
    viewMode: "flow",
    splitRatio: 0.5,
    sourceData: null,
    sourceLoaded: false,
    sourceLoading: null,
    selectedStepId: null,
    preSplitWidth: null,
    splitExpandedWidth: null,
    copyFeedbackTimer: null,
    resizeObserver: null,
    lockNoticeTimer: null,
    pulseTimer: null,
    activeDragCleanup: null,
    splitResizerCleanup: null,
    panCleanup: null,
    tooltipCleanup: null,
    destroyed: false,
  };

  state.floatingWindows.set(winId, win);
  state.floatingWindowByTarget.set(targetId, winId);
  if (parentWin) {
    parentWin.childWindowIds.add(winId);
    updateFloatingWindowHeaderState(parentWin);
  }
  updateFloatingWindowHeaderState(win);
  applyFloatingCodePrefsToWindow(win);

  dom.winEl.addEventListener("mousedown", () => {
    focusFloatingWindow(win.id);
  });

  bindFloatingWindowDrag(win);
  win.splitResizerCleanup = bindFloatingSplitResizer(win);

  if (dom.wrapCodeBtn) {
    dom.wrapCodeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      focusFloatingWindow(win.id);
      const prefs = loadFloatingCodePrefs();
      prefs.wrap = !prefs.wrap;
      saveFloatingCodePrefs();
      applyFloatingCodePrefsToAllWindows();
    });
  }

  if (dom.zoomOutBtn) {
    dom.zoomOutBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      focusFloatingWindow(win.id);
      const prefs = loadFloatingCodePrefs();
      if (prefs.fontSize > FW_CODE_FONT_MIN) {
        prefs.fontSize = Math.max(FW_CODE_FONT_MIN, prefs.fontSize - 1);
        saveFloatingCodePrefs();
        applyFloatingCodePrefsToAllWindows();
      }
    });
  }

  if (dom.zoomInBtn) {
    dom.zoomInBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      focusFloatingWindow(win.id);
      const prefs = loadFloatingCodePrefs();
      if (prefs.fontSize < FW_CODE_FONT_MAX) {
        prefs.fontSize = Math.min(FW_CODE_FONT_MAX, prefs.fontSize + 1);
        saveFloatingCodePrefs();
        applyFloatingCodePrefsToAllWindows();
      }
    });
  }

  if (dom.walkthroughBtn) {
    dom.walkthroughBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      focusFloatingWindow(win.id);
      if (!state.walkthrough) {
        return;
      }
      const wtScope = typeof state.walkthrough.getScope === "function"
        ? state.walkthrough.getScope()
        : { scope: "main", windowId: null };
      if (state.walkthrough.isActive() && wtScope.scope === "window" && wtScope.windowId === win.id) {
        state.walkthrough.stop();
        return;
      }
      // Evitar que la barra superior `#walkthrough-hud` solape la cabecera de la ventana flotante.
      const curTop = Number.parseFloat(win.el.style.top || "0") || 0;
      if (curTop < 54) {
        win.el.style.top = "54px";
        scheduleBridgeRender();
      }
      await state.walkthrough.start({
        scope: "window",
        windowId: win.id,
        rootId: win.targetId,
        granularity: "step",
        stepInto: false,
        autoPlay: false,
      });
    });
  }

  dom.fitBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    focusFloatingWindow(win.id);
    if (win.cy && !win.destroyed) {
      fitCyWithDynamicMinZoom(win.cy, undefined, 22, FW_MIN_ZOOM);
      scheduleBridgeRender();
    }
  });

  if (dom.modeButtons && dom.modeButtons.size > 0) {
    for (const [modeKey, modeBtn] of dom.modeButtons.entries()) {
      modeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        focusFloatingWindow(win.id);
        setFloatingWindowViewMode(win, modeKey);
      });
    }
  }

  if (dom.copyCodeBtn) {
    dom.copyCodeBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      focusFloatingWindow(win.id);
      const data = win.sourceData || (await loadFloatingWindowSource(win));
      if (!data || typeof data.code !== "string") {
        return;
      }
      const copied = await copyTextToClipboard(data.code);
      if (!win.destroyed && copied) {
        dom.copyCodeBtn.textContent = "✓ Copiado";
        dom.copyCodeBtn.classList.add("copied");
        if (win.copyFeedbackTimer) {
          clearTimeout(win.copyFeedbackTimer);
        }
        win.copyFeedbackTimer = setTimeout(() => {
          if (!win.destroyed && dom.copyCodeBtn) {
            dom.copyCodeBtn.textContent = "Copiar";
            dom.copyCodeBtn.classList.remove("copied");
          }
          win.copyFeedbackTimer = null;
        }, 1600);
      }
    });
  }

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
    if (state.suppressNextTap) {
      return;
    }
    focusFloatingWindow(win.id);
    const data = event.target.data();
    if (data.type === "port") {
      await handlePortClick(win, data.id);
      return;
    }
    const selTargetId = data.ownerFunctionId || data.id;
    const stepId = data.type === "flow" ? (data.stepId || null) : null;
    if (win.isFunctionFlow) {
      win.selectedStepId = stepId;
    }
    selectNode(selTargetId, stepId);
    if (win.isFunctionFlow && (win.viewMode === "split" || win.viewMode === "code")) {
      highlightFloatingCodeForStep(win, stepId, { scroll: true });
    }
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
    if (state.walkthrough && typeof state.walkthrough.onViewportChanged === "function") {
      state.walkthrough.onViewportChanged();
    }
  });

  win.panCleanup = attachPanControls(
    () => (win.destroyed ? null : win.cy),
    win.cyContainer,
    win.bodyEl,
    {
      onPanStart: () => focusFloatingWindow(win.id),
      onPanMove: (_event, didMove) => {
        scheduleBridgeRender();
        if (didMove && state.walkthrough && typeof state.walkthrough.notifyManualPan === "function") {
          state.walkthrough.notifyManualPan(win.cy);
        }
      },
      onMiddleClick: ({ cy, clientX, clientY }) => {
        const hitNode = hitTestCyNodeAtClientPoint(cy, clientX, clientY);
        if (!hitNode) {
          return;
        }
        const data = hitNode.data();
        if (!data || data.type === "port") {
          return;
        }
        const targetId = data.ownerFunctionId || data.id;
        if (targetId === win.targetId) {
          return;
        }
        const rawTarget = state.nodesById.get(targetId);
        if (canOpenInFloatingWindow(rawTarget)) {
          openFloatingWindow(targetId, { parentWindowId: win.id });
        }
      },
    },
  );
  if (state.spacePanning) {
    applySpacePanToCy(subCy, win.bodyEl, true);
  }
  win.manualBgPanCleanup = attachManualBackgroundPanDetector(subCy);
  win.tooltipCleanup = bindNodeDocstringTooltip(subCy, win.bodyEl);

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      if (win.destroyed || !win.cy) {
        return;
      }
      if (win.viewMode === "split") {
        applyFloatingSplitRatio(win);
      }
      win.cy.resize();
      scheduleBridgeRender();
      if (state.walkthrough && typeof state.walkthrough.onViewportChanged === "function") {
        state.walkthrough.onViewportChanged();
      }
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
  if (state.walkthrough && typeof state.walkthrough.onFloatingWindowClosed === "function") {
    state.walkthrough.onFloatingWindowClosed(win.id);
  }
  hideEdgeTooltip();
  hideNodeTooltip();

  if (win.lockNoticeTimer) {
    clearTimeout(win.lockNoticeTimer);
    win.lockNoticeTimer = null;
  }
  if (win.pulseTimer) {
    clearTimeout(win.pulseTimer);
    win.pulseTimer = null;
  }
  if (win.copyFeedbackTimer) {
    clearTimeout(win.copyFeedbackTimer);
    win.copyFeedbackTimer = null;
  }
  if (win.activeDragCleanup) {
    win.activeDragCleanup();
    win.activeDragCleanup = null;
  }
  if (win.splitResizerCleanup) {
    win.splitResizerCleanup();
    win.splitResizerCleanup = null;
  }
  if (win.panCleanup) {
    win.panCleanup();
    win.panCleanup = null;
  }
  if (win.tooltipCleanup) {
    win.tooltipCleanup();
    win.tooltipCleanup = null;
  }
  if (win.resizeObserver) {
    try {
      win.resizeObserver.disconnect();
    } catch (_err) {
      // Ignorar errores de observador ya desconectado.
    }
    win.resizeObserver = null;
  }
  if (win.manualBgPanCleanup) {
    win.manualBgPanCleanup();
    win.manualBgPanCleanup = null;
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
    win.subgraphNodes = subgraph.nodes;
    win.subgraphEdges = subgraph.edges;
    win.titleSpan.textContent = rawNode.label || rawNode.id;
    win.statsEl.textContent = formatFloatingFooterStats(subgraph);

    win.cy.elements().remove();
    win.cy.add([...subgraph.nodes, ...subgraph.edges]);
    await runSubElkLayout(win.cy, subgraph.nodes, subgraph.edges, subgraph.isFunctionFlow);
    updateFloatingWindowHeaderState(win);
    if (win.isFunctionFlow) {
      win.sourceData = null;
      win.sourceLoaded = false;
      if (win.viewMode === "code" || win.viewMode === "split") {
        await loadFloatingWindowSource(win, { force: true });
      }
    }
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

// ---------------------------------------------------------------------------
// Ciclo 8 / 10: Integración del Recorrido Visual Estático
// ---------------------------------------------------------------------------

function updateFloatingWindowWalkthroughButtons(wtSnapshot) {
  const isWinActive = Boolean(wtSnapshot && wtSnapshot.active && wtSnapshot.scope === "window" && wtSnapshot.windowId);
  for (const win of state.floatingWindows.values()) {
    if (!win || win.destroyed || !win.walkthroughBtn) {
      continue;
    }
    const activeHere = isWinActive && wtSnapshot.windowId === win.id;
    win.walkthroughBtn.classList.toggle("active", activeHere);
    win.walkthroughBtn.setAttribute("aria-pressed", activeHere ? "true" : "false");
    win.walkthroughBtn.textContent = activeHere ? "⏹ Detener" : "⚡ Recorrer";
    win.walkthroughBtn.title = activeHere
      ? "Detener Recorrido Visual en esta ventana"
      : "Iniciar Recorrido Visual aislado dentro de esta ventana (sin alterar el grafo principal)";
  }
}

function highlightFloatingCodeLineRange(win, startLine, endLine, { scroll = true } = {}) {
  if (!win || win.destroyed || !win.codeLinesEl) {
    return;
  }
  const rows = win.codeLinesEl.querySelectorAll(".fw-code-line");
  rows.forEach((row) => row.classList.remove("highlighted-step"));
  if (!startLine || startLine <= 0) {
    return;
  }
  const hiEnd = endLine && endLine >= startLine ? endLine : startLine;
  let firstMatch = null;
  rows.forEach((row) => {
    const lineNum = Number(row.dataset.line || "0");
    if (lineNum >= startLine && lineNum <= hiEnd) {
      row.classList.add("highlighted-step");
      if (!firstMatch) {
        firstMatch = row;
      }
    }
  });
  if (scroll && firstMatch && typeof firstMatch.scrollIntoView === "function") {
    firstMatch.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  win.activeCodeLine = startLine;
  win.activeCodeEndLine = hiEnd;
  renderFloatingWindowVocab(win);
}

function resetWalkthroughExpansionSnapshot() {
  const we = state.walkthroughExpansion;
  if (!we) {
    return;
  }
  we.hasSnapshot = false;
  we.activeLevel = null;
  we.groupingMode = null;
  we.preCollapsed.clear();
  we.preExpanded.clear();
  we.tempOpenedContainers.clear();
  we.tempCollapsedContainers.clear();
  we.tempExpandedFunctions.clear();
  we.activeTargetKey = null;
  we.lastActiveAnchorId = null;
}

function captureWalkthroughExpansionSnapshot() {
  const we = state.walkthroughExpansion;
  if (!we) {
    return;
  }
  if (
    we.hasSnapshot
    && we.activeLevel === state.activeLevel
    && we.groupingMode === state.groupingMode
  ) {
    return;
  }
  we.hasSnapshot = true;
  we.activeLevel = state.activeLevel;
  we.groupingMode = state.groupingMode;
  we.preCollapsed = new Set(state.collapsedContainers);
  we.preExpanded = new Set(state.expandedFunctions);
  we.tempOpenedContainers.clear();
  we.tempCollapsedContainers.clear();
  we.tempExpandedFunctions.clear();
  we.activeTargetKey = null;
  we.lastActiveAnchorId = null;
}

function clearWalkthroughTempDeltas() {
  const we = state.walkthroughExpansion;
  if (!we) {
    return false;
  }
  let changed = false;
  for (const id of we.tempOpenedContainers) {
    if (we.preCollapsed.has(id) && !state.collapsedContainers.has(id)) {
      state.collapsedContainers.add(id);
      changed = true;
    }
  }
  for (const id of we.tempCollapsedContainers) {
    if (!we.preCollapsed.has(id) && state.collapsedContainers.has(id)) {
      state.collapsedContainers.delete(id);
      changed = true;
    }
  }
  for (const id of we.tempExpandedFunctions) {
    if (!we.preExpanded.has(id) && state.expandedFunctions.has(id)) {
      state.expandedFunctions.delete(id);
      changed = true;
    }
  }
  we.tempOpenedContainers.clear();
  we.tempCollapsedContainers.clear();
  we.tempExpandedFunctions.clear();
  we.activeTargetKey = null;
  return changed;
}

function resolveOwnerFunctionIdForWalkthrough(ev) {
  if (!ev) {
    return null;
  }
  const rawCandidate = ev.fn_id || ev.to || ev.from || null;
  if (!rawCandidate) {
    return null;
  }
  if (state.nodesById.has(rawCandidate)) {
    return rawCandidate;
  }
  const parts = String(rawCandidate).split("::");
  if (parts.length >= 3) {
    const ownerFn = parts.slice(0, -1).join("::");
    if (state.nodesById.has(ownerFn)) {
      return ownerFn;
    }
  }
  return rawCandidate;
}

function resolveVisibleFallbackLayerId(rawNodeId) {
  if (state.groupingMode !== "layers" || !rawNodeId) {
    return null;
  }
  const node = state.nodesById.get(rawNodeId);
  if (!node) {
    return null;
  }
  const target = state.activeLevel <= 2 && node.type === "function" && node.parent
    ? (state.nodesById.get(node.parent) || node)
    : node;
  const layerIdx = getNodeArchLayer(target);
  return Number.isFinite(layerIdx) ? `layer::${layerIdx}` : null;
}

function computeWalkthroughSelectiveExpansionPlan(ev, opts = {}) {
  const we = state.walkthroughExpansion;
  if (!we || !we.hasSnapshot || !ev) {
    return null;
  }
  if (opts.scope === "window" || opts.granularity !== "step" || state.activeLevel >= 4) {
    return null;
  }
  const ownerId = resolveOwnerFunctionIdForWalkthrough(ev);
  if (!ownerId) {
    return null;
  }
  const ownerNode = state.nodesById.get(ownerId);
  if (!ownerNode) {
    return null;
  }
  const fileId = resolveFileIdForNode(ownerId);
  const fileNode = fileId ? state.nodesById.get(fileId) : null;

  const openContainers = [];
  const collapseContainers = [];
  const expandFunctions = [];

  const collectAncestorModules = (startNode) => {
    const mods = [];
    let cur = startNode;
    const seen = new Set();
    while (cur && cur.parent && !seen.has(cur.parent)) {
      seen.add(cur.parent);
      const pNode = state.nodesById.get(cur.parent);
      if (pNode && pNode.type === "module") {
        mods.push(pNode.id);
      }
      cur = pNode;
    }
    return mods;
  };

  if (state.activeLevel === 1) {
    if (state.groupingMode === "layers") {
      const layerTarget = fileNode || ownerNode;
      const layerIdx = getNodeArchLayer(layerTarget);
      const layerId = `layer::${layerIdx}`;
      if (we.preCollapsed.has(layerId)) {
        openContainers.push(layerId);
        for (const n of (state.rawGraph && state.rawGraph.nodes) || []) {
          if (
            n.type === "file"
            && getNodeArchLayer(n) === layerIdx
            && countDescendantFunctions(n.id) > 0
            && !we.preCollapsed.has(n.id)
          ) {
            collapseContainers.push(n.id);
          }
        }
      }
      return { key: `L1:layer:${layerId}`, openContainers, collapseContainers, expandFunctions };
    }

    if (!fileNode) {
      return null;
    }
    const ancestorModules = collectAncestorModules(fileNode);
    if (ancestorModules.length > 0) {
      const ancestorSet = new Set(ancestorModules);
      const collapsedAncestors = ancestorModules.filter((mId) => we.preCollapsed.has(mId));
      if (collapsedAncestors.length > 0) {
        for (const mId of collapsedAncestors) {
          openContainers.push(mId);
        }
        // Colapsar temporalmente archivos (y submódulos hermanos) dentro de los módulos abiertos para expansión estricta +1.
        for (const mId of ancestorModules) {
          const children = state.childrenByParent.get(mId) || [];
          for (const child of children) {
            if (child.type === "file" && countDescendantFunctions(child.id) > 0 && !we.preCollapsed.has(child.id)) {
              collapseContainers.push(child.id);
            } else if (
              child.type === "module"
              && !ancestorSet.has(child.id)
              && countDescendantFunctions(child.id) > 0
              && !we.preCollapsed.has(child.id)
            ) {
              collapseContainers.push(child.id);
            }
          }
        }
      }
      return { key: `L1:mod:${ancestorModules[0]}`, openContainers, collapseContainers, expandFunctions };
    }

    // Archivo en la raíz sin módulo padre: su +1 abre el archivo para mostrar sus funciones.
    if (we.preCollapsed.has(fileNode.id)) {
      openContainers.push(fileNode.id);
    }
    return { key: `L1:rootfile:${fileNode.id}`, openContainers, collapseContainers, expandFunctions };
  }

  if (state.activeLevel === 2) {
    if (!fileNode) {
      return null;
    }
    if (state.groupingMode === "layers") {
      const layerIdx = getNodeArchLayer(fileNode);
      const layerId = `layer::${layerIdx}`;
      if (we.preCollapsed.has(layerId)) {
        openContainers.push(layerId);
        for (const n of (state.rawGraph && state.rawGraph.nodes) || []) {
          if (
            n.type === "file"
            && n.id !== fileNode.id
            && getNodeArchLayer(n) === layerIdx
            && countDescendantFunctions(n.id) > 0
            && !we.preCollapsed.has(n.id)
          ) {
            collapseContainers.push(n.id);
          }
        }
      }
    } else {
      const ancestorModules = collectAncestorModules(fileNode);
      const ancestorSet = new Set(ancestorModules);
      for (const mId of ancestorModules) {
        if (we.preCollapsed.has(mId)) {
          openContainers.push(mId);
          for (const child of state.childrenByParent.get(mId) || []) {
            if (
              child.type === "file"
              && child.id !== fileNode.id
              && countDescendantFunctions(child.id) > 0
              && !we.preCollapsed.has(child.id)
            ) {
              collapseContainers.push(child.id);
            } else if (
              child.type === "module"
              && !ancestorSet.has(child.id)
              && countDescendantFunctions(child.id) > 0
              && !we.preCollapsed.has(child.id)
            ) {
              collapseContainers.push(child.id);
            }
          }
        }
      }
    }
    if (we.preCollapsed.has(fileNode.id)) {
      openContainers.push(fileNode.id);
    }
    return { key: `L2:file:${fileNode.id}`, openContainers, collapseContainers, expandFunctions };
  }

  if (state.activeLevel === 3) {
    if (ownerNode.type !== "function") {
      return null;
    }
    if (state.groupingMode === "layers") {
      const layerId = `layer::${getNodeArchLayer(ownerNode)}`;
      if (we.preCollapsed.has(layerId)) {
        openContainers.push(layerId);
      }
    } else {
      if (fileNode && we.preCollapsed.has(fileNode.id)) {
        openContainers.push(fileNode.id);
      }
      for (const mId of collectAncestorModules(fileNode || ownerNode)) {
        if (we.preCollapsed.has(mId)) {
          openContainers.push(mId);
        }
      }
    }
    if (
      Array.isArray(ownerNode.internal_flow)
      && ownerNode.internal_flow.length > 0
      && !we.preExpanded.has(ownerNode.id)
    ) {
      expandFunctions.push(ownerNode.id);
    }
    return { key: `L3:fn:${ownerNode.id}`, openContainers, collapseContainers, expandFunctions };
  }

  return null;
}

function resolveScaleAnchorIdForNode(rawNodeId) {
  if (!rawNodeId) {
    return null;
  }
  const ownerId = resolveOwnerFunctionIdForWalkthrough({ fn_id: rawNodeId });
  if (!ownerId) {
    return null;
  }
  if (state.activeLevel === 1) {
    if (state.groupingMode === "layers") {
      return resolveVisibleFallbackLayerId(ownerId) || ownerId;
    }
    const fileId = resolveFileIdForNode(ownerId);
    const fileNode = fileId ? state.nodesById.get(fileId) : null;
    if (fileNode && fileNode.parent) {
      const pNode = state.nodesById.get(fileNode.parent);
      if (pNode && pNode.type === "module") {
        return pNode.id;
      }
    }
    return fileId || ownerId;
  }
  if (state.activeLevel === 2) {
    return resolveFileIdForNode(ownerId) || ownerId;
  }
  return ownerId;
}

async function syncWalkthroughSelectiveExpansion(ev, opts = {}) {
  if (opts && opts.scope === "window") {
    return { relayouted: false };
  }
  captureWalkthroughExpansionSnapshot();
  const we = state.walkthroughExpansion;
  const plan = computeWalkthroughSelectiveExpansionPlan(ev, opts);
  const fromAnchor = ev && ev.from ? resolveScaleAnchorIdForNode(ev.from) : null;
  const toAnchor = ev ? resolveScaleAnchorIdForNode(ev.fn_id || ev.to || ev.from) : null;

  if (!plan) {
    const anchorCandidates = [we.lastActiveAnchorId, toAnchor, fromAnchor].filter(Boolean);
    const reverted = clearWalkthroughTempDeltas();
    if (reverted) {
      await refreshGraphView({
        fit: false,
        viewportAnchor: anchorCandidates.length > 0 ? { candidateIds: anchorCandidates, mode: "top" } : null,
        preserveViewport: true,
      });
      return { relayouted: true };
    }
    return { relayouted: false };
  }

  if (we.activeTargetKey === plan.key) {
    if (toAnchor) {
      we.lastActiveAnchorId = toAnchor;
    }
    return { relayouted: false };
  }

  const prevAnchor = we.lastActiveAnchorId;
  let changed = clearWalkthroughTempDeltas();
  for (const id of plan.openContainers) {
    if (state.collapsedContainers.delete(id)) {
      changed = true;
    }
    if (we.preCollapsed.has(id)) {
      we.tempOpenedContainers.add(id);
    }
  }
  for (const id of plan.collapseContainers) {
    if (!state.collapsedContainers.has(id)) {
      state.collapsedContainers.add(id);
      changed = true;
    }
    if (!we.preCollapsed.has(id)) {
      we.tempCollapsedContainers.add(id);
    }
  }
  for (const fid of plan.expandFunctions) {
    if (!state.expandedFunctions.has(fid)) {
      state.expandedFunctions.add(fid);
      changed = true;
    }
    if (!we.preExpanded.has(fid)) {
      we.tempExpandedFunctions.add(fid);
    }
  }
  we.activeTargetKey = plan.key;
  we.lastActiveAnchorId = toAnchor || fromAnchor || prevAnchor || null;

  if (!changed) {
    return { relayouted: false };
  }

  // Anclamos el encabezado del nodo saliente (o entrante si abre in-place) en su píxel exacto
  // antes/después del intercambio atómico ELK para eliminar cualquier salto visual de pantalla.
  const anchorCandidates = [fromAnchor, prevAnchor, toAnchor].filter(Boolean);
  await refreshGraphView({
    fit: false,
    viewportAnchor: anchorCandidates.length > 0 ? { candidateIds: anchorCandidates, mode: "top" } : null,
    preserveViewport: true,
  });
  return { relayouted: true };
}

async function restoreWalkthroughExpansion({ scope = "main", keepSnapshot = false } = {}) {
  if (scope === "window") {
    return false;
  }
  const we = state.walkthroughExpansion;
  const anchorId = we ? we.lastActiveAnchorId : null;
  const changed = clearWalkthroughTempDeltas();
  if (!keepSnapshot) {
    resetWalkthroughExpansionSnapshot();
  }
  if (changed && state.cy) {
    await refreshGraphView({
      fit: false,
      viewportAnchor: anchorId ? { candidateIds: [anchorId], mode: "top" } : null,
      preserveViewport: true,
    });
  }
  return changed;
}

function initWalkthroughController() {
  if (typeof window === "undefined" || !window.CodeMapWalkthrough) {
    return;
  }

  state.walkthrough = window.CodeMapWalkthrough.createController({
    getCy: () => state.cy,
    getRawGraph: () => state.rawGraph,
    getNodesById: () => state.nodesById,
    getActiveFlowId: () => state.activeFlowId,
    getActiveLevel: () => state.activeLevel,
    resolveVisibleFallbackId: (rawNodeId) => resolveVisibleFallbackLayerId(rawNodeId),
    getPreferredRootId: () => {
      if (state.selectedNodeId && state.nodesById.has(state.selectedNodeId)) {
        return state.selectedNodeId;
      }
      return null;
    },
    getFloatingWindows: () => Array.from(state.floatingWindows.values()),
    getFloatingWindowById: (winId) => state.floatingWindows.get(winId) || null,
    onFloatingCameraPan: () => {
      scheduleBridgeRender();
    },
    onWalkthroughStateChanged: (snapshot) => {
      updateFloatingWindowWalkthroughButtons(snapshot);
    },
    highlightCodeTokens: (parentEl, lineText, language) => {
      appendHighlightedCodeTokens(parentEl, lineText, language);
    },
    hasLineNote: (fileId, lineNumber) => Boolean(
      window.CodeMapVocab && window.CodeMapVocab.getLineNote(state.notes, fileId, lineNumber)
    ),
    renderWalkthroughVocab: (cur, sourceData) => {
      const dock = document.getElementById("wt-vocab-dock");
      if (!dock || !window.CodeMapVocab) {
        return;
      }
      if (!cur || !cur.fn_id || !sourceData) {
        dock.replaceChildren();
        dock.classList.add("hidden");
        return;
      }
      const fnNode = state.nodesById.get(cur.fn_id) || null;
      const line = cur.line > 0 ? cur.line : (sourceData.start_line || 0);
      const endLine = cur.end_line && cur.end_line >= line ? cur.end_line : line;
      const lineObj = Array.isArray(sourceData.lines)
        ? sourceData.lines.find((item) => item.number === line)
        : null;
      window.CodeMapVocab.renderVocabDock(
        dock,
        {
          fnNode,
          fileId: sourceData.file_id || (fnNode && fnNode.parent) || "",
          line,
          endLine,
          lineText: lineObj ? lineObj.text : "",
          vocabDict: state.vocabDict,
          knownApis: state.knownApis,
          notes: state.notes,
          statusText: getRecentLineNoteStatus(sourceData.file_id || (fnNode && fnNode.parent) || "", line),
        },
        {
          onMarkKnown: (item) => setApiKnownStatus(item, true),
          onSaveLineNote: (fId, ln, text, hash) => saveLineNote(fId, ln, text, hash, { skipContainer: dock }),
        },
      );
    },
    prepareCanvasForTrace: async (trace, opts = {}) => {
      if (opts && opts.scope === "window") {
        // Recorrido aislado dentro de una ventana flotante: nunca expandir ni mutar el grafo principal `#cy`.
        return;
      }
      if (!trace || !Array.isArray(trace.events) || trace.events.length === 0) {
        return;
      }
      // Capturamos la instantánea exacta de expansiones manuales sin forzar cambios de nivel global.
      captureWalkthroughExpansionSnapshot();
    },
    syncActiveEventExpansion: async (ev, opts = {}) => syncWalkthroughSelectiveExpansion(ev, opts),
    restoreWalkthroughExpansion: async (opts = {}) => restoreWalkthroughExpansion(opts),
    onWalkthroughStopped: async (opts = {}) => restoreWalkthroughExpansion({
      scope: opts && opts.scope ? opts.scope : "main",
      keepSnapshot: false,
    }),
    syncFloatingCodeForEvent: (ev) => {
      if (!ev || !ev.fn_id) {
        return;
      }
      const winId = state.floatingWindowByTarget.get(ev.fn_id);
      if (!winId) {
        return;
      }
      const win = state.floatingWindows.get(winId);
      if (!win || win.destroyed || !win.isFunctionFlow) {
        return;
      }
      if (ev.step_id) {
        win.selectedStepId = ev.step_id;
      }
      if (win.viewMode === "code" || win.viewMode === "split") {
        if (ev.line && ev.line > 0) {
          highlightFloatingCodeLineRange(win, ev.line, ev.end_line || ev.line, { scroll: true });
        } else if (ev.step_id) {
          highlightFloatingCodeForStep(win, ev.step_id, { scroll: true });
        }
      }
    },
    openFunctionSplitWindow: async (fnId, ev) => {
      const fnNode = state.nodesById.get(fnId);
      if (!fnNode || !canOpenInFloatingWindow(fnNode)) {
        return;
      }
      await openFloatingWindow(fnId, { parentWindowId: null });
      const winId = state.floatingWindowByTarget.get(fnId);
      const win = winId ? state.floatingWindows.get(winId) : null;
      if (!win || win.destroyed) {
        return;
      }
      const splitBtn = win.modeButtons && win.modeButtons.get("split");
      if (splitBtn && win.viewMode !== "split") {
        splitBtn.click();
      }
      await loadFloatingWindowSource(win);
      if (ev && ev.line > 0) {
        highlightFloatingCodeLineRange(win, ev.line, ev.end_line || ev.line, { scroll: true });
      } else if (ev && ev.step_id) {
        highlightFloatingCodeForStep(win, ev.step_id, { scroll: true });
      }
    },
    focusNode: (nodeId) => navigateToNode(nodeId),
  });
  state.walkthrough.bindDomEvents();
}

initViewer().catch((error) => {
  document.getElementById("project-title").textContent = "Error al iniciar CodeMap";
  console.error(error);
});
