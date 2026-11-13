/* Visor Web Local de CodeMap (Etapas 1 y 2)
 * Renderiza graph.json con Cytoscape.js + ELKjs, nodos compuestos colapsables
 * y formas UML por rol (entry, transform, decision, io).
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

const state = {
  rawGraph: null,
  nodesById: new Map(),
  childrenByParent: new Map(),
  collapsedContainers: new Set(),
  expandedFunctions: new Set(),
  activeLevel: 2,
  selectedNodeId: null,
  cy: null,
  elk: null,
};

// ---------------------------------------------------------------------------
// Inicialización y carga
// ---------------------------------------------------------------------------

async function initViewer() {
  state.elk = new ELK();
  const response = await fetch("/graph.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`No se pudo cargar /graph.json (${response.status})`);
  }
  state.rawGraph = await response.json();
  indexGraph(state.rawGraph);

  renderHeader(state.rawGraph.meta, state.rawGraph.edges.length);
  initCytoscape();
  bindControls();

  const initialLevel = state.rawGraph.meta.recommended_level || 2;
  await applyLevel(initialLevel);
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

  await refreshGraphView();
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
// Proyección jerárquica de nodos y aristas visibles
// ---------------------------------------------------------------------------

function buildVisibleElements() {
  const visibleNodeIds = new Set();
  const nodes = [];

  for (const rawNode of state.rawGraph.nodes) {
    if (hasCollapsedAncestor(rawNode)) {
      continue;
    }
    visibleNodeIds.add(rawNode.id);

    const isCollapsed = state.collapsedContainers.has(rawNode.id);
    const isExpandedFn = rawNode.type === "function" && state.expandedFunctions.has(rawNode.id);
    const childCount = countDescendantFunctions(rawNode.id);

    const displayLabel = isCollapsed && childCount > 0
      ? `${rawNode.label} [+ ${childCount}]`
      : rawNode.label;

    nodes.push({
      data: {
        id: rawNode.id,
        parent: rawNode.parent || undefined,
        label: displayLabel,
        type: rawNode.type,
        role: rawNode.role || rawNode.type,
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
    // Evitar auto-bucles sintéticos cuando origen y destino quedan en el mismo
    // contenedor colapsado; solo conservar recursión directa entre funciones visibles.
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
// Cytoscape.js + ELKjs layout
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
  });

  state.cy.on("dbltap", "node", async (event) => {
    const data = event.target.data();
    const nodeId = data.ownerFunctionId || data.id;
    await toggleNodeExpansion(nodeId);
  });
}

function buildStylesheet() {
  return [
    // Contenedores compuestos (módulos y archivos abiertos)
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
    // Contenedor colapsado (sin hijos visibles en Cytoscape)
    {
      selector: 'node[collapsed = "true"]',
      style: {
        "background-color": "#1e293b",
        "background-opacity": 0.95,
        "border-color": "#38bdf8",
        "border-style": "solid",
        "width": 170,
        "height": 54,
        "text-valign": "center",
        "text-margin-y": 0,
      },
    },
    // Nodos de función y pasos de flujo interno
    {
      selector: 'node[type = "function"], node[type = "flow"]',
      style: {
        "label": "data(label)",
        "color": "#f8fafc",
        "font-size": 11,
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "wrap",
        "text-max-width": 160,
        "border-width": 2,
        "width": "label",
        "height": "label",
        "padding": 12,
      },
    },
    // Función expandida como contenedor de su internal_flow (Nivel 3+)
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
    // Taxonomía de formas por rol
    {
      selector: 'node[role = "entry"]',
      style: {
        "shape": "ellipse",
        "background-color": "#0d3b2e",
        "border-color": "#10b981",
      },
    },
    {
      selector: 'node[role = "transform"]',
      style: {
        "shape": "round-rectangle",
        "background-color": "#172b4d",
        "border-color": "#3b82f6",
      },
    },
    {
      selector: 'node[role = "decision"]',
      style: {
        "shape": "diamond",
        "background-color": "#452a08",
        "border-color": "#f59e0b",
        "padding": 18,
      },
    },
    {
      selector: 'node[role = "io"]',
      style: {
        "shape": "barrel",
        "background-color": "#33184d",
        "border-color": "#a855f7",
      },
    },
    {
      selector: "node:selected",
      style: {
        "border-width": 3,
        "border-color": "#38bdf8",
      },
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
      style: {
        "line-style": "solid",
        "line-color": "#7dd3fc",
        "target-arrow-color": "#7dd3fc",
      },
    },
    {
      selector: 'edge[confidence = "inferred"]',
      style: {
        "line-style": "dashed",
        "line-color": "#94a3b8",
        "target-arrow-color": "#94a3b8",
      },
    },
    {
      selector: 'edge[kind = "flow"]',
      style: {
        "width": 1.4,
        "line-color": "#475569",
        "target-arrow-color": "#475569",
      },
    },
  ];
}

async function refreshGraphView() {
  const { nodes, edges } = buildVisibleElements();
  state.cy.elements().remove();
  state.cy.add([...nodes, ...edges]);
  await runElkLayout(nodes, edges);
  state.cy.fit(undefined, 36);
}

async function runElkLayout(visibleNodes, visibleEdges) {
  const elkGraph = buildElkInput(visibleNodes, visibleEdges);
  const layouted = await state.elk.layout(elkGraph);

  const positions = new Map();
  collectAbsolutePositions(layouted, 0, 0, positions);

  state.cy.batch(() => {
    state.cy.nodes().forEach((cyNode) => {
      if (cyNode.isParent()) {
        return;
      }
      const pos = positions.get(cyNode.id());
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
            // Dentro de una función expandida forzamos el flujo secuencial de arriba a abajo.
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

  // En ELKjs los contenedores con hijos ajustan su tamaño automáticamente;
  // borramos width/height fijos en nodos que tienen hijos.
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
    return { width: 175, height: 54 };
  }
  const textLen = (data.label || "").length;
  const width = Math.max(120, Math.min(230, textLen * 7.5 + 36));
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
        x: absX + (child.width || 120) / 2,
        y: absY + (child.height || 44) / 2,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Interacción y panel lateral
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
    await refreshGraphView();
    selectNode(nodeId);
  } else if (node.type === "function" && node.internal_flow && node.internal_flow.length > 0) {
    if (state.expandedFunctions.has(nodeId)) {
      state.expandedFunctions.delete(nodeId);
    } else {
      state.expandedFunctions.add(nodeId);
    }
    await refreshGraphView();
    selectNode(nodeId);
  }
}

function selectNode(nodeId) {
  const node = state.nodesById.get(nodeId);
  if (!node) {
    return;
  }
  state.selectedNodeId = nodeId;

  document.getElementById("details-empty").classList.add("hidden");
  document.getElementById("details-content").classList.remove("hidden");

  const roleKey = node.role || node.type;
  const badge = document.getElementById("detail-badge");
  badge.textContent = ROLE_LABELS[roleKey] || roleKey;
  badge.className = `role-badge role-${roleKey}`;

  document.getElementById("detail-title").textContent = node.label;
  document.getElementById("detail-id").textContent = node.id;

  updateVsCodeLink(node);
  updateToggleButton(node);
  updateOptionalBlock("detail-signature-block", "detail-signature", node.signature);
  updateOptionalBlock("detail-docstring-block", "detail-docstring", node.docstring);
  updateOptionalBlock("detail-fingerprint-block", "detail-fingerprint", node.fingerprint);
  updateFlowBlock(node);
}

function updateVsCodeLink(node) {
  const link = document.getElementById("detail-vscode");
  let filePath = node.file_path;
  let line = node.line || 1;

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

function bindControls() {
  for (const btn of document.querySelectorAll(".level-btn")) {
    btn.addEventListener("click", () => {
      applyLevel(Number(btn.dataset.level));
    });
  }

  document.getElementById("btn-relayout").addEventListener("click", () => {
    refreshGraphView();
  });

  document.getElementById("btn-fit").addEventListener("click", () => {
    state.cy.fit(undefined, 36);
  });

  document.getElementById("btn-toggle-node").addEventListener("click", () => {
    if (state.selectedNodeId) {
      toggleNodeExpansion(state.selectedNodeId);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "r" && !event.ctrlKey && !event.metaKey) {
      refreshGraphView();
    }
  });
}

initViewer().catch((error) => {
  document.getElementById("project-title").textContent = "Error al iniciar CodeMap";
  console.error(error);
});
