/* Recorrido Visual Estático de CodeMap — Ciclo 8 / Ciclo 10
 * - Contrato desacoplado `WalkthroughTrace` (schema_version: 1), compatible con futuro `codemap trace`
 * - `StaticWalkthroughGenerator`: Modo Pulso (Nivel 3) y Modo Paso a Paso (Nivel 3+) con ramas if/switch/try-catch
 * - `WalkthroughCanvasRenderer`: capa <canvas> sincronizada con pan/zoom sobre polilíneas ortogonales exactas
 * - `WalkthroughController`: HUD flotante, Call Stack simulado, tarjeta de acción, ámbito de ventana flotante y sincronización con GET /source
 */

(function initCodeMapWalkthrough(globalScope) {
  "use strict";

  const WALKTHROUGH_SCHEMA_VERSION = 1;
  const DEFAULT_MAX_DEPTH = 12;
  const DEFAULT_MAX_EVENTS = 500;
  const FLASH_DURATION_MS = 380;
  const BASE_STEP_DURATION_MS = 950;
  const PULSE_STEP_DURATION_MS = 820;

  const SPARK_COLORS = {
    call: { core: "#ecfeff", glow: "#22d3ee", trail: "rgba(34, 211, 238, 0.78)" },
    return: { core: "#ecfdf5", glow: "#34d399", trail: "rgba(52, 211, 153, 0.78)" },
    return_value: { core: "#fffbeb", glow: "#fbbf24", trail: "rgba(251, 191, 36, 0.78)" },
    step: { core: "#f0f9ff", glow: "#7dd3fc", trail: "rgba(125, 211, 252, 0.72)" },
    branch_flash: { core: "#fff1f2", glow: "#f43f5e", trail: "rgba(244, 63, 94, 0.88)" },
    throw: { core: "#fff1f2", glow: "#f43f5e", trail: "rgba(244, 63, 94, 0.88)" },
    catch: { core: "#fff1f2", glow: "#f43f5e", trail: "rgba(244, 63, 94, 0.84)" },
  };

  const ACTION_META = {
    entry: { icon: "▶", badge: "ENTRADA", color: "#34d399" },
    assign: { icon: "＝", badge: "ASIGNACIÓN", color: "#7dd3fc" },
    check: { icon: "◆", badge: "DECISIÓN", color: "#fbbf24" },
    call: { icon: "⚡", badge: "LLAMADA", color: "#22d3ee" },
    loop: { icon: "🔁", badge: "BUCLE", color: "#38bdf8" },
    io: { icon: "⇄", badge: "I/O", color: "#c084fc" },
    return: { icon: "↩", badge: "RETORNO", color: "#34d399" },
    throw: { icon: "⚠️", badge: "EXCEPCIÓN", color: "#f43f5e" },
    catch: { icon: "🛡️", badge: "CAPTURA", color: "#fb7185" },
  };

  // -------------------------------------------------------------------------
  // 1. Generador estático determinista (`StaticWalkthroughGenerator`)
  // -------------------------------------------------------------------------

  function shortFnDisplayName(fnNode) {
    if (!fnNode) {
      return "";
    }
    return fnNode.label || fnNode.id || "";
  }

  function cloneStack(stack) {
    return stack.map((frame) => ({
      fn_id: frame.fn_id,
      label: frame.label,
      call_line: frame.call_line,
    }));
  }

  function classifyStepAction(step) {
    if (!step) {
      return "assign";
    }
    const kind = step.kind || "step";
    const role = step.role || "transform";
    const text = String(step.code || step.label || "").trim();
    const lower = text.toLowerCase();

    if (role === "entry") {
      return "entry";
    }
    if (kind === "except") {
      return "catch";
    }
    if (kind === "loop") {
      return "loop";
    }
    if (role === "decision") {
      return "check";
    }
    if (/^(?:raise\b|throw\b)/.test(lower)) {
      return "throw";
    }
    if (/^return\b/.test(lower)) {
      return "return";
    }
    if (role === "io") {
      return "io";
    }
    if (/\b(?:asignaciones|declaraciones)\b/.test(lower) || /(?:^|\s)(?:const|let|var)\s+/.test(lower) || /[^=!<>]=[^=]/.test(text)) {
      return "assign";
    }
    if (/\w+\s*\(/.test(text)) {
      return "call";
    }
    return "assign";
  }

  function looksLikeReturnWithValue(step) {
    if (!step) {
      return false;
    }
    const text = String(step.code || step.label || "").trim();
    const match = /^return\s+(.+)$/i.exec(text);
    if (!match) {
      return false;
    }
    const val = match[1].trim().replace(/;$/, "");
    return Boolean(val && val !== "None" && val !== "null" && val !== "undefined");
  }

  function summarizeStepAction(step, actionKind, fnNode) {
    if (!step) {
      return fnNode ? `Ejecuta ${shortFnDisplayName(fnNode)}` : "Paso";
    }
    const cleanLabel = String(step.label || step.code || "").replace(/\s+/g, " ").trim();
    const shortText = cleanLabel.length > 72 ? `${cleanLabel.slice(0, 69)}…` : cleanLabel;
    if (step.kind === "merge") {
      return "Reconvergencia de ramas";
    }
    switch (actionKind) {
      case "entry":
        return `Entra en ${shortFnDisplayName(fnNode)} (${shortText})`;
      case "check":
        return `Evalúa condición: ${shortText}`;
      case "loop":
        return `Itera bucle: ${shortText}`;
      case "io":
        return `Operación I/O: ${shortText}`;
      case "call":
        return `Invoca: ${shortText}`;
      case "return":
        return `Retorna: ${shortText}`;
      case "throw":
        return `Lanza excepción: ${shortText}`;
      case "catch":
        return `Captura excepción: ${shortText}`;
      default:
        return shortText || "Ejecuta instrucción";
    }
  }

  function stepLooksLikeErrorGuard(step) {
    if (!step) {
      return false;
    }
    if (step.kind === "except") {
      return true;
    }
    const text = String(step.code || step.label || "").trim().toLowerCase();
    if (/^(?:raise\b|throw\b)/.test(text)) {
      return true;
    }
    if (/^return\s+(?:none|null|false|undefined|err\b|error\b|-1\b)/.test(text)) {
      return true;
    }
    return false;
  }

  function formatBranchOptionLabel(edge, targetStep, isError) {
    const rawLabel = String(edge.label || "").trim();
    if (edge.kind === "exception") {
      const targetText = targetStep ? String(targetStep.label || "").trim() : "";
      const suffix = targetText ? ` (${targetText.slice(0, 26)})` : " (catch/except)";
      return `⚠️ Simular excepción${suffix}`;
    }
    if (edge.kind === "branch_yes") {
      return rawLabel ? `${rawLabel}${isError ? " (guarda)" : ""}` : (isError ? "Sí (guarda)" : "Sí");
    }
    if (edge.kind === "branch_no") {
      return rawLabel || "No";
    }
    if (rawLabel) {
      return rawLabel;
    }
    const preview = targetStep ? String(targetStep.label || "").trim().slice(0, 22) : edge.target;
    return preview || "Continuar";
  }

  function buildFunctionCallSites(rawGraph, nodesById) {
    const callSitesByFn = new Map();
    for (const edge of rawGraph.edges || []) {
      if (!edge || edge.edge_type === "reads_var" || edge.source === edge.target) {
        continue;
      }
      const srcNode = nodesById.get(edge.source);
      const tgtNode = nodesById.get(edge.target);
      if (!srcNode || !tgtNode || srcNode.type !== "function" || tgtNode.type !== "function") {
        continue;
      }
      const rawLines = Array.isArray(edge.call_lines) && edge.call_lines.length > 0
        ? edge.call_lines
        : [typeof edge.line === "number" ? edge.line : 0];
      const list = callSitesByFn.get(edge.source) || [];
      for (const ln of rawLines) {
        list.push({
          edgeId: edge.id,
          sourceId: edge.source,
          targetId: edge.target,
          edgeType: edge.edge_type || "direct_call",
          event: edge.event || "",
          line: typeof ln === "number" ? ln : 0,
        });
      }
      callSitesByFn.set(edge.source, list);
    }
    for (const list of callSitesByFn.values()) {
      list.sort((a, b) => (a.line - b.line) || String(a.edgeId).localeCompare(String(b.edgeId)));
    }
    return callSitesByFn;
  }

  function resolveDefaultRootId(rawGraph, nodesById, flowId) {
    if (flowId) {
      const flow = (rawGraph.execution_flows || []).find((f) => f && f.id === flowId);
      if (flow && flow.root_id && nodesById.has(flow.root_id)) {
        const rootNode = nodesById.get(flow.root_id);
        if (rootNode.type === "function") {
          return rootNode.id;
        }
      }
    }
    const meta = rawGraph.meta || {};
    const mainFns = Array.isArray(meta.main_entry_functions) ? meta.main_entry_functions : [];
    for (const fid of mainFns) {
      const n = nodesById.get(fid);
      if (n && n.type === "function") {
        return n.id;
      }
    }
    const firstFlow = (rawGraph.execution_flows || []).find((f) => f && f.root_id && nodesById.has(f.root_id));
    if (firstFlow) {
      const n = nodesById.get(firstFlow.root_id);
      if (n && n.type === "function") {
        return n.id;
      }
    }
    const firstFn = (rawGraph.nodes || []).find((n) => n && n.type === "function");
    return firstFn ? firstFn.id : null;
  }

  function chooseOutgoingBranch(fnId, step, outEdges, stepMap, branchOverrides) {
    if (!Array.isArray(outEdges) || outEdges.length === 0) {
      return { chosen: null, branchKey: null, branchOptions: [], flashedEdges: [] };
    }
    if (outEdges.length === 1) {
      return { chosen: outEdges[0], branchKey: null, branchOptions: [], flashedEdges: [] };
    }

    const branchKey = `${fnId}::${step.id}`;
    const annotated = outEdges.map((edge) => {
      const targetStep = stepMap.get(edge.target) || null;
      const isError = edge.kind === "exception" || stepLooksLikeErrorGuard(targetStep);
      return {
        edge,
        targetStep,
        isError,
      };
    });

    const overrideTarget = branchOverrides && typeof branchOverrides[branchKey] === "string"
      ? branchOverrides[branchKey]
      : null;

    let chosenItem = overrideTarget
      ? annotated.find((item) => item.edge.target === overrideTarget) || null
      : null;

    if (!chosenItem) {
      // Happy path por defecto: evitar ramas de error/excepción/guarda inmediata.
      const nonError = annotated.filter((item) => !item.isError);
      if (nonError.length > 0) {
        chosenItem = nonError.find((item) => item.edge.kind === "flow" || item.edge.kind === "branch_yes")
          || nonError[0];
      } else {
        chosenItem = annotated.find((item) => item.edge.kind !== "exception") || annotated[0];
      }
    }

    const branchOptions = annotated.map((item) => ({
      target_step_id: item.edge.target,
      edge_id: `flow:${fnId}:${step.id}->${item.edge.target}`,
      label: formatBranchOptionLabel(item.edge, item.targetStep, item.isError),
      kind: item.edge.kind || "flow",
      is_error: item.isError,
      selected: item.edge.target === chosenItem.edge.target,
    }));

    const flashedEdges = [];
    for (const item of annotated) {
      if (item.edge.target === chosenItem.edge.target) {
        continue;
      }
      if (item.isError || step.role === "decision" || item.edge.kind === "exception") {
        flashedEdges.push({
          source: `${fnId}::${step.id}`,
          target: `${fnId}::${item.edge.target}`,
          edge_id: `flow:${fnId}:${step.id}->${item.edge.target}`,
          kind: item.edge.kind || (item.isError ? "exception" : "branch_no"),
          label: item.edge.label || "",
        });
      }
    }

    return {
      chosen: chosenItem.edge,
      branchKey,
      branchOptions,
      flashedEdges,
    };
  }

  function findCallsMatchingStep(fnId, step, callSites, dispatchedKeys, nodesById) {
    if (!step || !Array.isArray(callSites) || callSites.length === 0) {
      return [];
    }
    const stepStart = typeof step.line === "number" ? step.line : 0;
    const stepEnd = typeof step.end_line === "number" && step.end_line >= stepStart ? step.end_line : stepStart;
    // Para un contenedor (bucle/evento), solo asociamos llamadas en su cabecera (`stepStart`),
    // dejando las líneas interiores a los pasos hijos dentro del contenedor.
    const matchEnd = step.is_container ? stepStart : stepEnd;
    const matches = [];
    for (let idx = 0; idx < callSites.length; idx += 1) {
      const site = callSites[idx];
      const key = `${idx}:${site.edgeId}:${site.line}`;
      if (dispatchedKeys.has(key)) {
        continue;
      }
      if (stepStart > 0 && site.line >= stepStart && site.line <= matchEnd) {
        dispatchedKeys.add(key);
        matches.push(site);
      }
    }
    if (matches.length > 0 || step.is_container || step.role === "entry" || step.kind === "merge") {
      return matches;
    }
    // Respaldo textual si el paso no tenía rango de línea exacto.
    const codeText = String(step.code || step.label || "");
    if (!codeText) {
      return [];
    }
    for (let idx = 0; idx < callSites.length; idx += 1) {
      const site = callSites[idx];
      const key = `${idx}:${site.edgeId}:${site.line}`;
      if (dispatchedKeys.has(key)) {
        continue;
      }
      const targetNode = nodesById.get(site.targetId);
      const shortName = targetNode
        ? String(targetNode.label || "").replace(/\(\)$/, "").split(".").pop()
        : "";
      if (shortName && codeText.includes(`${shortName}(`)) {
        dispatchedKeys.add(key);
        matches.push(site);
      }
    }
    return matches;
  }

  function generateStaticWalkthrough(rawGraph, options = {}) {
    const granularity = options.granularity === "step" ? "step" : "pulse";
    const stepInto = options.stepInto !== undefined ? Boolean(options.stepInto) : true;
    const branchOverrides = options.branchOverrides && typeof options.branchOverrides === "object"
      ? { ...options.branchOverrides }
      : {};
    const maxDepth = typeof options.maxDepth === "number" && options.maxDepth > 0
      ? options.maxDepth
      : DEFAULT_MAX_DEPTH;
    const maxEvents = typeof options.maxEvents === "number" && options.maxEvents > 0
      ? options.maxEvents
      : DEFAULT_MAX_EVENTS;
    const flowId = options.flowId || null;

    const nodesById = new Map();
    for (const node of (rawGraph && rawGraph.nodes) || []) {
      if (node && node.id) {
        nodesById.set(node.id, node);
      }
    }

    let rootId = options.rootId && nodesById.has(options.rootId) ? options.rootId : null;
    if (rootId) {
      const candidate = nodesById.get(rootId);
      if (candidate.type === "file") {
        const fileFns = (rawGraph.nodes || [])
          .filter((n) => n.type === "function" && n.parent === rootId)
          .sort((a, b) => Number(Boolean(b.is_main_entry)) - Number(Boolean(a.is_main_entry)) || (a.line || 0) - (b.line || 0));
        rootId = fileFns.length > 0 ? fileFns[0].id : null;
      } else if (candidate.type !== "function") {
        rootId = null;
      }
    }
    if (!rootId) {
      rootId = resolveDefaultRootId(rawGraph || {}, nodesById, flowId);
    }

    const baseTrace = {
      schema_version: WALKTHROUGH_SCHEMA_VERSION,
      mode: "static",
      granularity,
      root_id: rootId,
      flow_id: flowId,
      step_into: stepInto,
      branch_overrides: branchOverrides,
      truncated: false,
      events: [],
    };

    if (!rootId || !nodesById.has(rootId)) {
      return baseTrace;
    }

    const callSitesByFn = buildFunctionCallSites(rawGraph, nodesById);
    const events = [];
    const callStack = [];
    const activeFnSet = new Set();
    let truncated = false;

    const pushEvent = (payload) => {
      if (events.length >= maxEvents) {
        truncated = true;
        return false;
      }
      events.push({
        seq: events.length + 1,
        kind: payload.kind || "step",
        from: payload.from || null,
        to: payload.to || null,
        fn_id: payload.fn_id || rootId,
        step_id: payload.step_id || null,
        edge_id: payload.edge_id || null,
        line: typeof payload.line === "number" ? payload.line : 0,
        end_line: typeof payload.end_line === "number" ? payload.end_line : (typeof payload.line === "number" ? payload.line : 0),
        label: payload.label || "",
        action_kind: payload.action_kind || "assign",
        branch_key: payload.branch_key || null,
        branch_kind: payload.branch_kind || null,
        branch_options: Array.isArray(payload.branch_options) ? payload.branch_options : [],
        flashed_edges: Array.isArray(payload.flashed_edges) ? payload.flashed_edges : [],
        step_over: Boolean(payload.step_over),
        has_return_value: Boolean(payload.has_return_value),
        stack_frame: payload.stack_frame || (callStack.length > 0 ? { ...callStack[callStack.length - 1] } : null),
        call_stack: cloneStack(callStack),
        timestamp_us: null,
        locals_diff: null,
        exception_info: null,
      });
      return true;
    };

    const walkPulse = (fnId, depth) => {
      const fnNode = nodesById.get(fnId);
      if (!fnNode || events.length >= maxEvents) {
        return;
      }
      const sites = callSitesByFn.get(fnId) || [];
      for (const site of sites) {
        if (events.length >= maxEvents - 2) {
          truncated = true;
          break;
        }
        const targetNode = nodesById.get(site.targetId);
        if (!targetNode || targetNode.type !== "function") {
          continue;
        }
        if (activeFnSet.has(site.targetId) || depth >= maxDepth) {
          continue;
        }

        const frame = {
          fn_id: site.targetId,
          label: shortFnDisplayName(targetNode),
          call_line: site.line || fnNode.line || 0,
        };
        callStack.push(frame);
        activeFnSet.add(site.targetId);

        const callOk = pushEvent({
          kind: "call",
          from: fnId,
          to: site.targetId,
          fn_id: site.targetId,
          step_id: null,
          edge_id: site.edgeId,
          line: site.line || fnNode.line || 0,
          end_line: site.line || fnNode.line || 0,
          label: `Llama a ${shortFnDisplayName(targetNode)}`,
          action_kind: "call",
          stack_frame: frame,
        });

        if (callOk) {
          walkPulse(site.targetId, depth + 1);
        }

        callStack.pop();
        activeFnSet.delete(site.targetId);

        const hasVal = (targetNode.internal_flow || []).some((s) => looksLikeReturnWithValue(s));
        pushEvent({
          kind: "return",
          from: site.targetId,
          to: fnId,
          fn_id: fnId,
          step_id: null,
          edge_id: site.edgeId,
          line: site.line || targetNode.end_line || fnNode.line || 0,
          end_line: site.line || targetNode.end_line || fnNode.line || 0,
          label: `Retorna de ${shortFnDisplayName(targetNode)} a ${shortFnDisplayName(fnNode)}`,
          action_kind: "return",
          has_return_value: hasVal,
          stack_frame: callStack.length > 0 ? { ...callStack[callStack.length - 1] } : null,
        });
      }
    };

    const walkStepFunction = (fnId, depth) => {
      const fnNode = nodesById.get(fnId);
      if (!fnNode || events.length >= maxEvents) {
        return { lastNodeId: fnId, hasReturnValue: false };
      }

      const flowSteps = Array.isArray(fnNode.internal_flow) ? fnNode.internal_flow : [];
      const callSites = callSitesByFn.get(fnId) || [];
      const dispatchedCallKeys = new Set();

      if (flowSteps.length === 0) {
        pushEvent({
          kind: "step",
          from: fnId,
          to: fnId,
          fn_id: fnId,
          step_id: null,
          line: fnNode.line || 0,
          end_line: fnNode.end_line || fnNode.line || 0,
          label: `Ejecuta ${shortFnDisplayName(fnNode)}`,
          action_kind: "assign",
        });
        return { lastNodeId: fnId, hasReturnValue: false };
      }

      const stepMap = new Map();
      const childrenByParent = new Map();
      for (const step of flowSteps) {
        stepMap.set(step.id, step);
        const parentKey = step.parent_id && flowSteps.some((s) => s.id === step.parent_id)
          ? step.parent_id
          : "__root__";
        if (!childrenByParent.has(parentKey)) {
          childrenByParent.set(parentKey, []);
        }
        childrenByParent.get(parentKey).push(step);
      }

      const visitedSteps = new Set();
      let lastNodeId = `${fnId}::${flowSteps[0].id}`;
      let lastReturnVal = false;

      const dispatchStepCalls = (step, stepFullId) => {
        const matchedCalls = findCallsMatchingStep(fnId, step, callSites, dispatchedCallKeys, nodesById);
        for (const site of matchedCalls) {
          if (events.length >= maxEvents - 2) {
            truncated = true;
            break;
          }
          const targetNode = nodesById.get(site.targetId);
          if (!targetNode || targetNode.type !== "function") {
            continue;
          }
          const canDescend = stepInto && !activeFnSet.has(site.targetId) && depth < maxDepth;
          const targetFlow = Array.isArray(targetNode.internal_flow) ? targetNode.internal_flow : [];
          const targetEntryId = targetFlow.length > 0 ? `${site.targetId}::${targetFlow[0].id}` : site.targetId;

          if (!canDescend) {
            const hasVal = targetFlow.some((s) => looksLikeReturnWithValue(s));
            pushEvent({
              kind: "call",
              from: stepFullId,
              to: site.targetId,
              fn_id: fnId,
              step_id: step.id,
              edge_id: site.edgeId,
              line: site.line || step.line || 0,
              end_line: step.end_line || site.line || step.line || 0,
              label: `Step Over → ${shortFnDisplayName(targetNode)}`,
              action_kind: "call",
              step_over: true,
              has_return_value: hasVal,
            });
            continue;
          }

          const frame = {
            fn_id: site.targetId,
            label: shortFnDisplayName(targetNode),
            call_line: site.line || step.line || 0,
          };
          callStack.push(frame);
          activeFnSet.add(site.targetId);

          const callOk = pushEvent({
            kind: "call",
            from: stepFullId,
            to: targetEntryId,
            fn_id: site.targetId,
            step_id: targetFlow.length > 0 ? targetFlow[0].id : null,
            edge_id: site.edgeId,
            line: site.line || step.line || 0,
            end_line: site.line || step.line || 0,
            label: `Entra en ${shortFnDisplayName(targetNode)}`,
            action_kind: "call",
            stack_frame: frame,
          });

          let childResult = { lastNodeId: targetEntryId, hasReturnValue: false };
          if (callOk) {
            childResult = walkStepFunction(site.targetId, depth + 1);
          }

          callStack.pop();
          activeFnSet.delete(site.targetId);

          pushEvent({
            kind: "return",
            from: childResult.lastNodeId || site.targetId,
            to: stepFullId,
            fn_id: fnId,
            step_id: step.id,
            edge_id: site.edgeId,
            line: step.line || site.line || 0,
            end_line: step.end_line || step.line || 0,
            label: `Retorna de ${shortFnDisplayName(targetNode)} a ${shortFnDisplayName(fnNode)}`,
            action_kind: "return",
            has_return_value: childResult.hasReturnValue,
            stack_frame: callStack.length > 0 ? { ...callStack[callStack.length - 1] } : null,
          });
        }
      };

      const walkScopeChain = (parentKey, prevFromId) => {
        const siblings = childrenByParent.get(parentKey) || [];
        if (siblings.length === 0) {
          return prevFromId;
        }
        const siblingIds = new Set(siblings.map((s) => s.id));
        const incomingInScope = new Set();
        for (const s of siblings) {
          for (const e of s.edges || []) {
            if (siblingIds.has(e.target) && e.target !== s.id) {
              incomingInScope.add(e.target);
            }
          }
        }
        const entryStep = siblings.find((s) => s.role === "entry")
          || siblings.find((s) => !incomingInScope.has(s.id))
          || siblings[0];

        let cursor = entryStep;
        let currentFrom = prevFromId;
        let guard = flowSteps.length * 2 + 4;

        while (cursor && guard > 0 && events.length < maxEvents) {
          guard -= 1;
          if (visitedSteps.has(cursor.id)) {
            break;
          }
          visitedSteps.add(cursor.id);

          const stepFullId = `${fnId}::${cursor.id}`;
          const actionKind = classifyStepAction(cursor);
          const outEdges = (cursor.edges || []).filter((e) => e && stepMap.has(e.target));
          const { chosen, branchKey, branchOptions, flashedEdges } = chooseOutgoingBranch(
            fnId,
            cursor,
            outEdges,
            stepMap,
            branchOverrides,
          );

          let eventKind = "step";
          if (actionKind === "throw") {
            eventKind = "throw";
          } else if (actionKind === "catch") {
            eventKind = "catch";
          } else if (branchOptions.length > 1) {
            eventKind = "branch_eval";
          } else if (actionKind === "entry" && currentFrom === null) {
            eventKind = "enter";
          }

          if (actionKind === "return" && looksLikeReturnWithValue(cursor)) {
            lastReturnVal = true;
          }

          const edgeId = currentFrom && currentFrom !== stepFullId
            ? `flow:${fnId}:${currentFrom.split("::").pop()}->${cursor.id}`
            : null;

          const ok = pushEvent({
            kind: eventKind,
            from: currentFrom || stepFullId,
            to: stepFullId,
            fn_id: fnId,
            step_id: cursor.id,
            edge_id: edgeId,
            line: cursor.line || fnNode.line || 0,
            end_line: cursor.end_line || cursor.line || fnNode.line || 0,
            label: summarizeStepAction(cursor, actionKind, fnNode),
            action_kind: actionKind,
            branch_key: branchKey,
            branch_kind: chosen ? (chosen.kind || "flow") : null,
            branch_options: branchOptions,
            flashed_edges: flashedEdges,
            has_return_value: actionKind === "return" && looksLikeReturnWithValue(cursor),
          });
          lastNodeId = stepFullId;
          if (!ok) {
            break;
          }

          dispatchStepCalls(cursor, stepFullId);

          // Si el paso es un contenedor (`loop` o `event`), recorrer sus pasos interiores antes de salir.
          if (cursor.is_container && childrenByParent.has(cursor.id)) {
            walkScopeChain(cursor.id, stepFullId);
          }

          if (!chosen) {
            break;
          }
          currentFrom = stepFullId;
          cursor = stepMap.get(chosen.target) || null;
        }
        return lastNodeId;
      };

      walkScopeChain("__root__", null);
      return { lastNodeId, hasReturnValue: lastReturnVal };
    };

    const rootNode = nodesById.get(rootId);
    const rootFrame = {
      fn_id: rootId,
      label: shortFnDisplayName(rootNode),
      call_line: rootNode.line || 0,
    };
    callStack.push(rootFrame);
    activeFnSet.add(rootId);

    if (granularity === "pulse") {
      pushEvent({
        kind: "enter",
        from: rootId,
        to: rootId,
        fn_id: rootId,
        step_id: null,
        line: rootNode.line || 0,
        end_line: rootNode.line || 0,
        label: `Inicio en ${shortFnDisplayName(rootNode)}`,
        action_kind: "entry",
        stack_frame: rootFrame,
      });
      walkPulse(rootId, 0);
      pushEvent({
        kind: "exit",
        from: rootId,
        to: rootId,
        fn_id: rootId,
        step_id: null,
        line: rootNode.end_line || rootNode.line || 0,
        end_line: rootNode.end_line || rootNode.line || 0,
        label: `Fin de ${shortFnDisplayName(rootNode)}`,
        action_kind: "return",
        stack_frame: rootFrame,
      });
    } else {
      const rootResult = walkStepFunction(rootId, 0);
      if (events.length > 0 && events.length < maxEvents) {
        pushEvent({
          kind: "exit",
          from: rootResult.lastNodeId,
          to: rootResult.lastNodeId,
          fn_id: rootId,
          step_id: rootResult.lastNodeId.includes("::") ? rootResult.lastNodeId.split("::").pop() : null,
          line: rootNode.end_line || rootNode.line || 0,
          end_line: rootNode.end_line || rootNode.line || 0,
          label: `Fin de ${shortFnDisplayName(rootNode)}`,
          action_kind: "return",
          has_return_value: rootResult.hasReturnValue,
          stack_frame: rootFrame,
        });
      }
    }

    baseTrace.truncated = truncated;
    baseTrace.events = events;
    return baseTrace;
  }

  function normalizeTrace(trace) {
    if (!trace || !Array.isArray(trace.events)) {
      return {
        schema_version: WALKTHROUGH_SCHEMA_VERSION,
        mode: "static",
        granularity: "pulse",
        root_id: null,
        flow_id: null,
        step_into: true,
        branch_overrides: {},
        truncated: false,
        events: [],
      };
    }
    const derivedStack = [];
    const normalizedEvents = trace.events.map((ev, idx) => {
      if (Array.isArray(ev.call_stack)) {
        return { ...ev, seq: typeof ev.seq === "number" ? ev.seq : idx + 1 };
      }
      if ((ev.kind === "enter" || ev.kind === "call") && ev.stack_frame) {
        derivedStack.push({ ...ev.stack_frame });
      } else if (ev.kind === "return" && derivedStack.length > 1) {
        derivedStack.pop();
      }
      return {
        ...ev,
        seq: typeof ev.seq === "number" ? ev.seq : idx + 1,
        call_stack: cloneStack(derivedStack),
      };
    });
    return {
      schema_version: trace.schema_version || WALKTHROUGH_SCHEMA_VERSION,
      mode: trace.mode || "static",
      granularity: trace.granularity || "pulse",
      root_id: trace.root_id || null,
      flow_id: trace.flow_id || null,
      step_into: trace.step_into !== undefined ? Boolean(trace.step_into) : true,
      branch_overrides: trace.branch_overrides || {},
      truncated: Boolean(trace.truncated),
      events: normalizedEvents,
    };
  }

  // -------------------------------------------------------------------------
  // 2. Geometría de polilíneas ortogonales e interpolación por longitud de arco
  // -------------------------------------------------------------------------

  function dedupePolylinePoints(rawPoints) {
    const clean = [];
    for (const pt of rawPoints || []) {
      if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
        continue;
      }
      if (clean.length > 0) {
        const prev = clean[clean.length - 1];
        if (Math.hypot(pt.x - prev.x, pt.y - prev.y) < 0.5) {
          continue;
        }
      }
      clean.push({ x: pt.x, y: pt.y });
    }
    return clean;
  }

  function computePolylineArcLengths(points) {
    if (!Array.isArray(points) || points.length === 0) {
      return { cumulative: [], totalLength: 0 };
    }
    const cumulative = [0];
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      cumulative.push(total);
    }
    return { cumulative, totalLength: total };
  }

  function samplePolylineAt(points, t) {
    if (!Array.isArray(points) || points.length === 0) {
      return null;
    }
    if (points.length === 1) {
      return { x: points[0].x, y: points[0].y, tx: 1, ty: 0 };
    }
    const clamped = Math.max(0, Math.min(1, Number(t) || 0));
    const { cumulative, totalLength } = computePolylineArcLengths(points);
    if (totalLength < 0.001) {
      return { x: points[0].x, y: points[0].y, tx: 1, ty: 0 };
    }
    const targetDist = clamped * totalLength;
    for (let i = 1; i < cumulative.length; i += 1) {
      if (targetDist <= cumulative[i] || i === cumulative.length - 1) {
        const segStart = cumulative[i - 1];
        const segLen = Math.max(0.0001, cumulative[i] - segStart);
        const localT = Math.max(0, Math.min(1, (targetDist - segStart) / segLen));
        const a = points[i - 1];
        const b = points[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        return {
          x: a.x + dx * localT,
          y: a.y + dy * localT,
          tx: dx / len,
          ty: dy / len,
        };
      }
    }
    const last = points[points.length - 1];
    return { x: last.x, y: last.y, tx: 1, ty: 0 };
  }

  function modelToScreen(pt, pan, zoom) {
    return {
      x: pt.x * zoom + pan.x,
      y: pt.y * zoom + pan.y,
    };
  }

  function resolveVisibleCyNodeId(cy, rawId, nodesById, resolveFallbackId = null) {
    if (!cy || !rawId) {
      return null;
    }
    const direct = cy.getElementById(rawId);
    if (direct && direct.length > 0 && direct.isNode()) {
      return rawId;
    }
    // Si es un paso `fn::step`, retroceder primero a la función propietaria `fn`.
    const parts = String(rawId).split("::");
    if (parts.length >= 3) {
      const fnCandidate = parts.slice(0, -1).join("::");
      const fnEl = cy.getElementById(fnCandidate);
      if (fnEl && fnEl.length > 0 && fnEl.isNode()) {
        return fnCandidate;
      }
      rawId = fnCandidate;
    }
    if (nodesById && typeof nodesById.get === "function") {
      let cur = nodesById.get(rawId);
      const seen = new Set();
      while (cur && cur.parent && !seen.has(cur.parent)) {
        seen.add(cur.parent);
        const pEl = cy.getElementById(cur.parent);
        if (pEl && pEl.length > 0 && pEl.isNode()) {
          return cur.parent;
        }
        cur = nodesById.get(cur.parent);
      }
    }
    if (typeof resolveFallbackId === "function") {
      const fallbackId = resolveFallbackId(rawId);
      if (fallbackId) {
        const fbEl = cy.getElementById(fallbackId);
        if (fbEl && fbEl.length > 0 && fbEl.isNode()) {
          return fallbackId;
        }
      }
    }
    return null;
  }

  function computeCameraFollowPanStep(curPan, focusModelPt, viewportSize, zoom, dtSec, lambda = 9) {
    if (!curPan || !focusModelPt || !viewportSize || !Number.isFinite(zoom) || zoom <= 0) {
      return null;
    }
    if (!Number.isFinite(focusModelPt.x) || !Number.isFinite(focusModelPt.y)) {
      return null;
    }
    const targetX = (viewportSize.width / 2) - focusModelPt.x * zoom;
    const targetY = (viewportSize.height / 2) - focusModelPt.y * zoom;
    const dx = targetX - curPan.x;
    const dy = targetY - curPan.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return null;
    }
    const dist = Math.hypot(dx, dy);
    if (dist < 0.45) {
      return { x: targetX, y: targetY, settled: true, moved: dist >= 0.05 };
    }
    const safeDt = Math.min(0.05, Math.max(0.001, Number.isFinite(dtSec) ? dtSec : 0.016));
    const alpha = 1 - Math.exp(-Math.max(1, lambda) * safeDt);
    return {
      x: curPan.x + dx * alpha,
      y: curPan.y + dy * alpha,
      settled: false,
      moved: true,
    };
  }

  function parseEndpointOffsetPx(endpointStr) {
    if (typeof endpointStr !== "string") {
      return null;
    }
    const parts = endpointStr.trim().split(/\s+/);
    if (parts.length !== 2) {
      return null;
    }
    const parseCoord = (tok) => {
      if (!tok.endsWith("px")) {
        return null;
      }
      const n = Number(tok.slice(0, -2));
      return Number.isFinite(n) ? n : null;
    };
    const dx = parseCoord(parts[0]);
    const dy = parseCoord(parts[1]);
    return dx !== null && dy !== null ? { dx, dy } : null;
  }

  function reconstructElkSegmentsPolyline(cyEdge) {
    const weights = cyEdge.data("segWeights");
    const distances = cyEdge.data("segDistances");
    if (!Array.isArray(weights) || !Array.isArray(distances) || weights.length === 0 || weights.length !== distances.length) {
      return null;
    }
    const srcNode = cyEdge.source();
    const tgtNode = cyEdge.target();
    if (!srcNode || srcNode.length === 0 || !tgtNode || tgtNode.length === 0) {
      return null;
    }
    const sp = srcNode.position();
    const tp = tgtNode.position();
    if (!sp || !tp || !Number.isFinite(sp.x) || !Number.isFinite(tp.x)) {
      return null;
    }
    const sOff = parseEndpointOffsetPx(cyEdge.data("srcEndpoint"));
    const tOff = parseEndpointOffsetPx(cyEdge.data("tgtEndpoint"));
    const srcPt = sOff ? { x: sp.x + sOff.dx, y: sp.y + sOff.dy } : { x: sp.x, y: sp.y };
    const tgtPt = tOff ? { x: tp.x + tOff.dx, y: tp.y + tOff.dy } : { x: tp.x, y: tp.y };
    const dx = tgtPt.x - srcPt.x;
    const dy = tgtPt.y - srcPt.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) {
      return null;
    }
    const nx = -dy / len;
    const ny = dx / len;
    const pts = [srcPt];
    for (let i = 0; i < weights.length; i += 1) {
      const w = Number(weights[i]);
      const d = Number(distances[i]);
      if (!Number.isFinite(w) || !Number.isFinite(d)) {
        continue;
      }
      pts.push({
        x: srcPt.x + w * dx + d * nx,
        y: srcPt.y + w * dy + d * ny,
      });
    }
    pts.push(tgtPt);
    const clean = dedupePolylinePoints(pts);
    return clean.length >= 2 ? clean : null;
  }

  function readCyEdgeModelPolyline(cyEdge) {
    if (!cyEdge || cyEdge.length === 0) {
      return null;
    }
    const rawPts = [];
    const safeCall = (fnName) => {
      try {
        return typeof cyEdge[fnName] === "function" ? cyEdge[fnName]() : null;
      } catch (_err) {
        return null;
      }
    };
    const srcPt = safeCall("sourceEndpoint");
    const segPts = safeCall("segmentPoints");
    const ctrlPts = !segPts || segPts.length === 0 ? safeCall("controlPoints") : null;
    const tgtPt = safeCall("targetEndpoint");

    if (Array.isArray(segPts) && segPts.length > 0) {
      if (srcPt && Number.isFinite(srcPt.x) && Number.isFinite(srcPt.y)) {
        rawPts.push(srcPt);
      } else if (cyEdge.source() && cyEdge.source().length > 0) {
        rawPts.push(cyEdge.source().position());
      }
      for (const p of segPts) {
        rawPts.push(p);
      }
      if (tgtPt && Number.isFinite(tgtPt.x) && Number.isFinite(tgtPt.y)) {
        rawPts.push(tgtPt);
      } else if (cyEdge.target() && cyEdge.target().length > 0) {
        rawPts.push(cyEdge.target().position());
      }
      const clean = dedupePolylinePoints(rawPts);
      if (clean.length >= 2) {
        return clean;
      }
    }

    // Reconstrucción exacta desde `segWeights` / `segDistances` (respaldo determinista y headless).
    const reconstructed = reconstructElkSegmentsPolyline(cyEdge);
    if (reconstructed) {
      return reconstructed;
    }

    if (srcPt && Number.isFinite(srcPt.x) && Number.isFinite(srcPt.y)) {
      rawPts.push(srcPt);
    } else if (cyEdge.source() && cyEdge.source().length > 0) {
      rawPts.push(cyEdge.source().position());
    }
    if (Array.isArray(ctrlPts) && ctrlPts.length > 0) {
      for (const p of ctrlPts) {
        rawPts.push(p);
      }
    }
    if (tgtPt && Number.isFinite(tgtPt.x) && Number.isFinite(tgtPt.y)) {
      rawPts.push(tgtPt);
    } else if (cyEdge.target() && cyEdge.target().length > 0) {
      rawPts.push(cyEdge.target().position());
    }

    const clean = dedupePolylinePoints(rawPts);
    return clean.length >= 2 ? clean : null;
  }

  function extractEdgePolyline(cy, fromId, toId, edgeHintId, options = {}) {
    if (!cy) {
      return null;
    }
    const nodesById = options.nodesById || null;
    const resolveFallbackId = options.resolveFallbackId || null;
    const isReturn = Boolean(options.reversed);
    const visFrom = resolveVisibleCyNodeId(cy, fromId, nodesById, resolveFallbackId);
    const visTo = resolveVisibleCyNodeId(cy, toId, nodesById, resolveFallbackId);
    if (!visFrom && !visTo) {
      return null;
    }
    if (!visFrom || !visTo || visFrom === visTo) {
      const onlyNode = cy.getElementById(visTo || visFrom);
      if (onlyNode && onlyNode.length > 0) {
        const pos = onlyNode.position();
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
          return [{ x: pos.x, y: pos.y }];
        }
      }
      return null;
    }

    // Buscar la arista Cytoscape exacta en sentido directo (o inverso en retornos `return`).
    const findEdgeBetween = (sId, tId) => {
      let best = null;
      const allEdges = cy.edges();
      for (let i = 0; i < allEdges.length; i += 1) {
        const e = allEdges[i];
        if (e.source().id() !== sId || e.target().id() !== tId) {
          continue;
        }
        if (edgeHintId) {
          const rawIds = e.data("rawEdgeIds");
          if (e.id() === edgeHintId || (Array.isArray(rawIds) && rawIds.includes(edgeHintId))) {
            return e;
          }
        }
        if (!best) {
          best = e;
        }
      }
      return best;
    };

    let matchedEdge = null;
    let shouldReverse = false;

    if (isReturn) {
      matchedEdge = findEdgeBetween(visTo, visFrom);
      if (matchedEdge) {
        shouldReverse = true;
      } else {
        matchedEdge = findEdgeBetween(visFrom, visTo);
      }
    } else {
      matchedEdge = findEdgeBetween(visFrom, visTo);
      if (!matchedEdge) {
        // Si los extremos son pasos internos `fn::step`, intentar la arista de llamada entre las funciones propietarias.
        const fnFrom = String(fromId || "").split("::").length >= 3
          ? String(fromId).split("::").slice(0, -1).join("::")
          : visFrom;
        const fnTo = String(toId || "").split("::").length >= 3
          ? String(toId).split("::").slice(0, -1).join("::")
          : visTo;
        if (fnFrom !== fnTo) {
          matchedEdge = findEdgeBetween(fnFrom, fnTo);
        }
      }
    }

    if (matchedEdge) {
      const pts = readCyEdgeModelPolyline(matchedEdge);
      if (pts && pts.length >= 2) {
        return shouldReverse ? [...pts].reverse() : pts;
      }
    }

    // Respaldo ortogonal limpio entre centros de nodos si no había arista directa en Cytoscape.
    const srcNode = cy.getElementById(visFrom);
    const tgtNode = cy.getElementById(visTo);
    if (srcNode.length > 0 && tgtNode.length > 0) {
      const sp = srcNode.position();
      const tp = tgtNode.position();
      if (sp && tp && Number.isFinite(sp.x) && Number.isFinite(tp.x)) {
        const midY = (sp.y + tp.y) / 2;
        if (Math.abs(sp.x - tp.x) < 2 || Math.abs(sp.y - tp.y) < 2) {
          return dedupePolylinePoints([sp, tp]);
        }
        return dedupePolylinePoints([sp, { x: sp.x, y: midY }, { x: tp.x, y: midY }, tp]);
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 3. Motor <canvas> de Recorrido Visual sincronizado con cy.pan(), cy.zoom() y rAF
  // -------------------------------------------------------------------------

  class WalkthroughCanvasRenderer {
    constructor(getTargetsFn, getNodesByIdFn, options = {}) {
      this._getTargets = getTargetsFn;
      this._getNodesById = getNodesByIdFn;
      this._resolveFallbackId = options.resolveFallbackId || null;
      this._runProgrammaticPan = options.runProgrammaticPan || null;
      this._onCameraPan = options.onCameraPan || null;
      this._followCamera = false;
      this._lastFrameMs = 0;
      this._rafId = null;
      this._active = false;
      this._currentEvent = null;
      this._animStartMs = 0;
      this._animDurationMs = BASE_STEP_DURATION_MS;
      this._flashStartMs = 0;
      this._observers = new Map();
      this._mirrorCanvases = new Map();
    }

    setFollowCamera(enabled) {
      this._followCamera = Boolean(enabled);
      if (!this._followCamera) {
        this._lastFrameMs = 0;
      }
    }

    _ensureCanvasSized(canvas, containerEl) {
      if (!canvas || !containerEl) {
        return null;
      }
      const dpr = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1;
      const w = Math.max(1, Math.round(containerEl.clientWidth || 1));
      const h = Math.max(1, Math.round(containerEl.clientHeight || 1));
      const targetW = Math.round(w * dpr);
      const targetH = Math.round(h * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      return { ctx, width: w, height: h };
    }

    _ensureMirrorCanvas(win) {
      if (!win || win.destroyed || !win.cyContainer) {
        return null;
      }
      let canvas = this._mirrorCanvases.get(win.id);
      if (canvas && canvas.parentNode === win.cyContainer) {
        return canvas;
      }
      canvas = document.createElement("canvas");
      canvas.className = "fw-walkthrough-canvas";
      canvas.setAttribute("aria-hidden", "true");
      win.cyContainer.appendChild(canvas);
      this._mirrorCanvases.set(win.id, canvas);
      return canvas;
    }

    cleanupMirrorCanvases() {
      for (const canvas of this._mirrorCanvases.values()) {
        if (canvas && canvas.parentNode) {
          canvas.parentNode.removeChild(canvas);
        }
      }
      this._mirrorCanvases.clear();
    }

    _pruneStaleMirrors(activeWinIds) {
      for (const [winId, canvas] of Array.from(this._mirrorCanvases.entries())) {
        if (!activeWinIds.has(winId)) {
          if (canvas && canvas.parentNode) {
            canvas.parentNode.removeChild(canvas);
          }
          this._mirrorCanvases.delete(winId);
        }
      }
    }

    setEvent(event, durationMs) {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      this._currentEvent = event || null;
      this._animStartMs = now;
      this._animDurationMs = Math.max(180, durationMs || BASE_STEP_DURATION_MS);
      this._flashStartMs = now;
      if (event) {
        this.start();
      } else {
        this.clearAll();
      }
    }

    start() {
      if (this._active) {
        return;
      }
      this._active = true;
      const tick = (ts) => {
        if (!this._active) {
          this._rafId = null;
          return;
        }
        this._renderFrame(ts || (typeof performance !== "undefined" ? performance.now() : Date.now()));
        this._rafId = window.requestAnimationFrame(tick);
      };
      this._rafId = window.requestAnimationFrame(tick);
    }

    stop() {
      this._active = false;
      if (this._rafId !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(this._rafId);
        this._rafId = null;
      }
      this._currentEvent = null;
      this.clearAll();
      this.cleanupMirrorCanvases();
    }

    clearAll() {
      const targets = this._getTargets ? this._getTargets() : [];
      for (const target of targets) {
        if (target && target.canvas) {
          const ctx = target.canvas.getContext("2d");
          if (ctx) {
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, target.canvas.width, target.canvas.height);
            ctx.restore();
          }
        }
      }
      for (const canvas of this._mirrorCanvases.values()) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.restore();
        }
      }
    }

    _pickEventPalette(event) {
      if (!event) {
        return SPARK_COLORS.step;
      }
      if (event.kind === "throw" || event.kind === "catch") {
        return SPARK_COLORS.throw;
      }
      if (event.kind === "call") {
        return SPARK_COLORS.call;
      }
      if (event.kind === "return" || event.kind === "exit") {
        return event.has_return_value ? SPARK_COLORS.return_value : SPARK_COLORS.return;
      }
      return SPARK_COLORS.step;
    }

    _resolveNodeModelCenter(cy, nodeId) {
      if (!cy || !nodeId) {
        return null;
      }
      const cyNode = cy.getElementById(nodeId);
      if (!cyNode || cyNode.length === 0) {
        return null;
      }
      if (typeof cyNode.boundingBox === "function") {
        const bb = cyNode.boundingBox({ includeLabels: false });
        if (bb && Number.isFinite(bb.x1) && Number.isFinite(bb.x2) && bb.w > 0 && bb.h > 0) {
          return { x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 };
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

    _renderTarget(ctx, width, height, cy, event, nowMs, nodesById, targetMeta = null) {
      ctx.clearRect(0, 0, width, height);
      if (!cy || !event) {
        return;
      }
      let pan = cy.pan();
      const zoom = cy.zoom();
      if (!pan || !Number.isFinite(zoom) || zoom <= 0) {
        return;
      }

      const elapsed = Math.max(0, nowMs - this._animStartMs);
      const rawProgress = Math.min(1, elapsed / this._animDurationMs);
      // Curva suave easeInOutCubic para deslizamiento natural por segmentos ortogonales.
      const easedT = rawProgress < 0.5
        ? 4 * rawProgress * rawProgress * rawProgress
        : 1 - Math.pow(-2 * rawProgress + 2, 3) / 2;

      const resolveFallbackId = this._resolveFallbackId;
      const isReturn = event.kind === "return";
      const poly = extractEdgePolyline(cy, event.from, event.to, event.edge_id, {
        nodesById,
        resolveFallbackId,
        reversed: isReturn,
      });

      let palette = this._pickEventPalette(event);
      let activeT = easedT;
      let activePoly = poly;

      if (event.step_over && poly && poly.length >= 2) {
        if (rawProgress <= 0.5) {
          const halfP = rawProgress * 2;
          activeT = halfP < 0.5 ? 2 * halfP * halfP : 1 - Math.pow(-2 * halfP + 2, 2) / 2;
          palette = SPARK_COLORS.call;
        } else {
          const halfP = (rawProgress - 0.5) * 2;
          activeT = 1 - (halfP < 0.5 ? 2 * halfP * halfP : 1 - Math.pow(-2 * halfP + 2, 2) / 2);
          palette = event.has_return_value ? SPARK_COLORS.return_value : SPARK_COLORS.return;
        }
      }

      const focusNodeId = resolveVisibleCyNodeId(
        cy,
        event.step_over ? event.from : (event.to || event.from),
        nodesById,
        resolveFallbackId,
      );

      // 0. Cámara de seguimiento suave (lerp exponencial, conserva intacto cy.zoom()).
      if (this._followCamera && targetMeta && targetMeta.isPrimaryCamera) {
        let focusModelPt = null;
        if (activePoly && activePoly.length >= 2 && rawProgress < 0.99) {
          focusModelPt = samplePolylineAt(activePoly, activeT);
        }
        if (!focusModelPt && focusNodeId) {
          focusModelPt = this._resolveNodeModelCenter(cy, focusNodeId);
        }
        if (focusModelPt) {
          const dtSec = this._lastFrameMs > 0 ? (nowMs - this._lastFrameMs) / 1000 : 0.016;
          const lambda = rawProgress < 0.99 ? 8.5 : 10.5;
          const step = computeCameraFollowPanStep(pan, focusModelPt, { width, height }, zoom, dtSec, lambda);
          if (step && step.moved) {
            const applyPan = () => {
              cy.pan({ x: step.x, y: step.y });
            };
            if (typeof this._runProgrammaticPan === "function") {
              this._runProgrammaticPan(cy, applyPan);
            } else {
              applyPan();
            }
            pan = cy.pan() || { x: step.x, y: step.y };
            if (typeof this._onCameraPan === "function") {
              this._onCameraPan(targetMeta);
            }
          }
        }
      }

      // 1. Destellos rojos concurrentes en ramas de error / guardas evaluadas (`flashed_edges`).
      const flashElapsed = Math.max(0, nowMs - this._flashStartMs);
      if (Array.isArray(event.flashed_edges) && event.flashed_edges.length > 0 && flashElapsed < FLASH_DURATION_MS) {
        const flashAlpha = Math.max(0, 1 - flashElapsed / FLASH_DURATION_MS);
        const flashT = Math.min(1, flashElapsed / (FLASH_DURATION_MS * 0.85));
        for (const fEdge of event.flashed_edges) {
          const fPts = extractEdgePolyline(cy, fEdge.source, fEdge.target, fEdge.edge_id, {
            nodesById,
            resolveFallbackId,
          });
          if (!fPts || fPts.length < 2) {
            continue;
          }
          ctx.save();
          ctx.beginPath();
          fPts.forEach((pt, idx) => {
            const sp = modelToScreen(pt, pan, zoom);
            if (idx === 0) ctx.moveTo(sp.x, sp.y);
            else ctx.lineTo(sp.x, sp.y);
          });
          ctx.strokeStyle = `rgba(244, 63, 94, ${(0.88 * flashAlpha).toFixed(3)})`;
          ctx.lineWidth = Math.max(2.4, 3.2 * Math.min(1.4, zoom));
          ctx.shadowColor = "#f43f5e";
          ctx.shadowBlur = 12;
          ctx.stroke();

          const fHead = samplePolylineAt(fPts, flashT);
          if (fHead) {
            const hs = modelToScreen(fHead, pan, zoom);
            ctx.beginPath();
            ctx.arc(hs.x, hs.y, 4.2, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 228, 230, ${flashAlpha.toFixed(3)})`;
            ctx.fill();
          }
          ctx.restore();
        }
      }

      // 2. Polilínea activa del evento y partícula de recorrido (ida, vuelta o ida+vuelta en Step Over).
      if (activePoly && activePoly.length >= 2) {
        // Resaltado sutil de la arista activa.
        ctx.save();
        ctx.beginPath();
        activePoly.forEach((pt, idx) => {
          const sp = modelToScreen(pt, pan, zoom);
          if (idx === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        });
        ctx.strokeStyle = palette.trail;
        ctx.lineWidth = Math.max(2, 2.4 * Math.min(1.3, zoom));
        ctx.globalAlpha = rawProgress < 1 ? 0.55 : 0.32;
        ctx.stroke();
        ctx.restore();

        // Estela cometa (8 muestras previas sobre la polilínea ortogonal exacta).
        if (rawProgress < 0.99) {
          const trailSpan = 0.24;
          const samples = 8;
          const directionSign = event.step_over && rawProgress > 0.5 ? -1 : 1;
          for (let sIdx = samples; sIdx >= 1; sIdx -= 1) {
            const frac = sIdx / samples;
            const sampleT = Math.max(0, Math.min(1, activeT - directionSign * trailSpan * frac));
            const prevT = Math.max(0, Math.min(1, activeT - directionSign * trailSpan * ((sIdx - 1) / samples)));
            const pA = samplePolylineAt(activePoly, sampleT);
            const pB = samplePolylineAt(activePoly, prevT);
            if (!pA || !pB) {
              continue;
            }
            const sA = modelToScreen(pA, pan, zoom);
            const sB = modelToScreen(pB, pan, zoom);
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(sA.x, sA.y);
            ctx.lineTo(sB.x, sB.y);
            ctx.strokeStyle = palette.glow;
            ctx.lineCap = "round";
            ctx.lineWidth = Math.max(1.5, (1 - frac) * 5.8);
            ctx.globalAlpha = (1 - frac) * 0.85;
            ctx.stroke();
            ctx.restore();
          }

          // Núcleo luminoso de la partícula de recorrido.
          const head = samplePolylineAt(activePoly, activeT);
          if (head) {
            const hs = modelToScreen(head, pan, zoom);
            ctx.save();
            const grad = ctx.createRadialGradient(hs.x, hs.y, 1, hs.x, hs.y, 15);
            grad.addColorStop(0, palette.core);
            grad.addColorStop(0.35, palette.glow);
            grad.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(hs.x, hs.y, 15, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = palette.core;
            ctx.beginPath();
            ctx.arc(hs.x, hs.y, 4.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
      }

      // 3. Destello radial persistente / onda de llegada sobre el nodo o paso activo.
      if (focusNodeId) {
        const cyNode = cy.getElementById(focusNodeId);
        if (cyNode && cyNode.length > 0) {
          const bb = cyNode.renderedBoundingBox({ includeLabels: false });
          const cx = (bb.x1 + bb.x2) / 2;
          const cyPos = (bb.y1 + bb.y2) / 2;
          const breathe = 0.55 + 0.45 * Math.sin(nowMs / 260);
          const pad = 4 + breathe * 3.5;

          ctx.save();
          ctx.strokeStyle = palette.glow;
          ctx.lineWidth = 2.6;
          ctx.globalAlpha = rawProgress >= 0.8 ? 0.92 : 0.45;
          ctx.shadowColor = palette.glow;
          ctx.shadowBlur = 12;
          const rx = Math.max(0, bb.x1 - pad);
          const ry = Math.max(0, bb.y1 - pad);
          const rw = Math.max(12, bb.w + pad * 2);
          const rh = Math.max(12, bb.h + pad * 2);
          if (typeof ctx.roundRect === "function") {
            ctx.beginPath();
            ctx.roundRect(rx, ry, rw, rh, 9);
            ctx.stroke();
          } else {
            ctx.strokeRect(rx, ry, rw, rh);
          }

          if (rawProgress >= 0.82 && rawProgress <= 1) {
            const ringT = (rawProgress - 0.82) / 0.18;
            const ringR = Math.max(bb.w, bb.h) * 0.45 + ringT * 18;
            ctx.beginPath();
            ctx.arc(cx, cyPos, ringR, 0, Math.PI * 2);
            ctx.strokeStyle = palette.glow;
            ctx.globalAlpha = Math.max(0, (1 - ringT) * 0.55);
            ctx.lineWidth = 2;
            ctx.stroke();
          }
          ctx.restore();
        }
      }
    }

    _renderFrame(nowMs) {
      const nodesById = this._getNodesById ? this._getNodesById() : null;
      const targets = this._getTargets ? this._getTargets() : [];
      const activeWinIds = new Set();

      for (const target of targets) {
        if (!target || !target.cy) {
          continue;
        }
        let canvas = target.canvas;
        if (!canvas && target.win) {
          canvas = this._ensureMirrorCanvas(target.win);
          activeWinIds.add(target.win.id);
        }
        const sized = this._ensureCanvasSized(canvas, target.containerEl);
        if (!sized || !sized.ctx) {
          continue;
        }
        this._renderTarget(sized.ctx, sized.width, sized.height, target.cy, this._currentEvent, nowMs, nodesById, target);
      }
      this._lastFrameMs = nowMs;
      this._pruneStaleMirrors(activeWinIds);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Controlador UI (`WalkthroughController`): HUD, Call Stack, Tarjeta y Código
  // -------------------------------------------------------------------------

  const WT_CODE_WRAP_STORAGE_KEY = "codemap.wt.codeWrap";

  function createWalkthroughController(hooks) {
    const loadInitialCodeWrap = () => {
      try {
        if (typeof localStorage !== "undefined") {
          const saved = localStorage.getItem(WT_CODE_WRAP_STORAGE_KEY);
          if (saved === "false" || saved === "0") {
            return false;
          }
          if (saved === "true" || saved === "1") {
            return true;
          }
        }
      } catch (_err) {
        // Ignorar errores de almacenamiento privado.
      }
      return true;
    };

    const wtState = {
      active: false,
      playing: false,
      followCamera: false,
      scope: "main", // "main" | "window"
      windowId: null,
      granularity: "pulse", // "pulse" | "step"
      stepInto: true,
      speed: 1,
      rootId: null,
      flowId: null,
      branchOverrides: {},
      trace: null,
      index: 0,
      playTimer: null,
      transitionToken: 0,
      programmaticPanDepth: 0,
      sourceCache: new Map(),
      lastRenderedCodeKey: "",
      codeWrap: loadInitialCodeWrap(),
    };

    const getScopedFloatingWindow = () => {
      if (wtState.scope !== "window" || !wtState.windowId) {
        return null;
      }
      if (hooks.getFloatingWindowById) {
        const w = hooks.getFloatingWindowById(wtState.windowId);
        return w && !w.destroyed ? w : null;
      }
      const floatingWins = hooks.getFloatingWindows ? hooks.getFloatingWindows() : [];
      return floatingWins.find((w) => w && !w.destroyed && w.id === wtState.windowId) || null;
    };

    const getActiveCameraCy = () => {
      if (wtState.scope === "window") {
        const targetWin = getScopedFloatingWindow();
        return targetWin ? targetWin.cy : null;
      }
      return hooks.getCy ? hooks.getCy() : null;
    };

    const getActiveLevelSafe = () => {
      if (hooks.getActiveLevel) {
        const lvl = Number(hooks.getActiveLevel());
        if (Number.isFinite(lvl) && lvl >= 1) {
          return lvl;
        }
      }
      return 3;
    };

    const getEffectiveGeneratorGranularity = () => {
      if (wtState.scope === "window") {
        return "step";
      }
      if (wtState.granularity !== "step") {
        return "pulse";
      }
      // En Nivel 1 y Nivel 2 (+1 expande módulo→archivos o archivo→funciones),
      // avanzamos evento a evento de llamada/retorno para que la luz viaje entre nodos visibles.
      return getActiveLevelSafe() <= 2 ? "pulse" : "step";
    };

    const runProgrammaticPan = (_cy, fn) => {
      wtState.programmaticPanDepth += 1;
      try {
        fn();
      } finally {
        wtState.programmaticPanDepth = Math.max(0, wtState.programmaticPanDepth - 1);
      }
    };

    const clearMainCanvasOnly = () => {
      const mainCanvas = document.getElementById("walkthrough-canvas");
      if (!mainCanvas) {
        return;
      }
      const ctx = mainCanvas.getContext("2d");
      if (ctx) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
        ctx.restore();
      }
    };

    const renderer = new WalkthroughCanvasRenderer(
      () => {
        const list = [];
        if (wtState.scope === "window") {
          clearMainCanvasOnly();
          const targetWin = getScopedFloatingWindow();
          if (targetWin && targetWin.cy && targetWin.cyContainer) {
            list.push({
              cy: targetWin.cy,
              canvas: null,
              containerEl: targetWin.cyContainer,
              win: targetWin,
              isPrimaryCamera: true,
            });
          }
          return list;
        }
        const mainCy = hooks.getCy ? hooks.getCy() : null;
        const mainCanvas = document.getElementById("walkthrough-canvas");
        const mainArea = document.getElementById("canvas-area");
        if (mainCy && mainCanvas && mainArea) {
          list.push({
            cy: mainCy,
            canvas: mainCanvas,
            containerEl: mainArea,
            win: null,
            isPrimaryCamera: true,
          });
        }
        const floatingWins = hooks.getFloatingWindows ? hooks.getFloatingWindows() : [];
        for (const win of floatingWins) {
          if (win && !win.destroyed && win.cy && win.cyContainer) {
            list.push({
              cy: win.cy,
              canvas: null,
              containerEl: win.cyContainer,
              win,
              isPrimaryCamera: false,
            });
          }
        }
        return list;
      },
      () => (hooks.getNodesById ? hooks.getNodesById() : null),
      {
        resolveFallbackId: hooks.resolveVisibleFallbackId || null,
        runProgrammaticPan,
        onCameraPan: (targetMeta) => {
          positionActionCard();
          if (targetMeta && targetMeta.win && hooks.onFloatingCameraPan) {
            hooks.onFloatingCameraPan(targetMeta.win);
          }
        },
      },
    );

    const applyCodeWrapState = () => {
      const box = document.getElementById("wt-code-preview-box");
      const btn = document.getElementById("btn-wt-wrap-code");
      if (box) {
        box.classList.toggle("wrap-enabled", Boolean(wtState.codeWrap));
      }
      if (btn) {
        btn.classList.toggle("active", Boolean(wtState.codeWrap));
        btn.setAttribute("aria-pressed", wtState.codeWrap ? "true" : "false");
      }
    };

    const toggleCodeWrap = () => {
      wtState.codeWrap = !wtState.codeWrap;
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(WT_CODE_WRAP_STORAGE_KEY, String(wtState.codeWrap));
        }
      } catch (_err) {
        // Ignorar errores de almacenamiento privado.
      }
      applyCodeWrapState();
    };

    const getSnapshotState = () => ({
      active: wtState.active,
      playing: wtState.playing,
      followCamera: wtState.followCamera,
      scope: wtState.scope,
      windowId: wtState.windowId,
      granularity: wtState.granularity,
      effectiveGranularity: getEffectiveGeneratorGranularity(),
      stepInto: wtState.stepInto,
      speed: wtState.speed,
      index: wtState.index,
      total: wtState.trace ? wtState.trace.events.length : 0,
      rootId: wtState.rootId,
    });

    const notifyStateChanged = () => {
      if (hooks.onWalkthroughStateChanged) {
        hooks.onWalkthroughStateChanged(getSnapshotState());
      }
    };

    const clearPlayTimer = () => {
      if (wtState.playTimer !== null) {
        clearTimeout(wtState.playTimer);
        wtState.playTimer = null;
      }
    };

    const getStepDurationMs = () => {
      const base = wtState.granularity === "step" ? BASE_STEP_DURATION_MS : PULSE_STEP_DURATION_MS;
      return Math.round(base / Math.max(0.25, wtState.speed));
    };

    const getCurrentEvent = () => {
      if (!wtState.trace || !Array.isArray(wtState.trace.events) || wtState.trace.events.length === 0) {
        return null;
      }
      const idx = Math.max(0, Math.min(wtState.trace.events.length - 1, wtState.index));
      return wtState.trace.events[idx];
    };

    const updateSidebarButton = () => {
      const btn = document.getElementById("btn-walkthrough");
      if (!btn) {
        return;
      }
      btn.classList.toggle("active", wtState.active);
      btn.setAttribute("aria-pressed", wtState.active ? "true" : "false");
    };

    const updateHudControls = () => {
      const hud = document.getElementById("walkthrough-hud");
      if (!hud) {
        return;
      }
      hud.classList.toggle("hidden", !wtState.active);
      if (!wtState.active) {
        return;
      }

      const events = (wtState.trace && wtState.trace.events) || [];
      const total = events.length;
      const cur = getCurrentEvent();

      const playBtn = document.getElementById("btn-wt-play");
      if (playBtn) {
        playBtn.textContent = wtState.playing ? "⏸" : "▶";
        playBtn.title = wtState.playing ? "Pausar recorrido" : "Reproducir recorrido";
        playBtn.classList.toggle("active", wtState.playing);
      }

      const prevBtn = document.getElementById("btn-wt-prev");
      if (prevBtn) {
        prevBtn.disabled = total === 0 || wtState.index <= 0;
      }

      const nextBtn = document.getElementById("btn-wt-next");
      if (nextBtn) {
        nextBtn.disabled = total === 0 || wtState.index >= total - 1;
      }

      const counterEl = document.getElementById("wt-counter");
      if (counterEl) {
        counterEl.textContent = total > 0 ? `${wtState.index + 1} / ${total}` : "0 / 0";
      }

      const speedSelect = document.getElementById("wt-speed-select");
      if (speedSelect) {
        speedSelect.value = String(wtState.speed);
      }

      const isWindowScope = wtState.scope === "window";
      const scopePill = document.getElementById("wt-scope-pill");
      if (scopePill) {
        if (isWindowScope) {
          const nodesById = hooks.getNodesById ? hooks.getNodesById() : null;
          const rootNode = nodesById && wtState.rootId ? nodesById.get(wtState.rootId) : null;
          const label = (rootNode && rootNode.label) || wtState.rootId || "función";
          scopePill.textContent = `Ventana: ${label}`;
          scopePill.title = `Recorrido Visual aislado dentro de la ventana flotante (${label})`;
          scopePill.classList.remove("hidden");
        } else {
          scopePill.textContent = "";
          scopePill.classList.add("hidden");
        }
      }

      const pulseBtn = document.getElementById("btn-wt-mode-pulse");
      const stepBtn = document.getElementById("btn-wt-mode-step");
      if (pulseBtn) {
        pulseBtn.classList.toggle("hidden", isWindowScope);
        pulseBtn.classList.toggle("active", wtState.granularity === "pulse");
        pulseBtn.setAttribute("aria-pressed", wtState.granularity === "pulse" ? "true" : "false");
      }
      if (stepBtn) {
        stepBtn.classList.toggle("active", wtState.granularity === "step");
        stepBtn.setAttribute("aria-pressed", wtState.granularity === "step" ? "true" : "false");
      }

      const stepIntoBtn = document.getElementById("btn-wt-step-into");
      const showStepInto = !isWindowScope
        && wtState.granularity === "step"
        && getEffectiveGeneratorGranularity() === "step";
      if (stepIntoBtn) {
        stepIntoBtn.classList.toggle("hidden", !showStepInto);
        stepIntoBtn.classList.toggle("active", wtState.stepInto);
        stepIntoBtn.setAttribute("aria-pressed", wtState.stepInto ? "true" : "false");
        stepIntoBtn.textContent = wtState.stepInto ? "↳ Profundizar" : "↷ Sin hijas";
        stepIntoBtn.title = wtState.stepInto
          ? "Profundizar en funciones hijas: Sí (Step Into). Clic para cambiar a Step Over"
          : "Profundizar en funciones hijas: No (Step Over). Clic para profundizar";
      }

      const followBtn = document.getElementById("btn-wt-follow");
      if (followBtn) {
        followBtn.classList.toggle("active", Boolean(wtState.followCamera));
        followBtn.setAttribute("aria-pressed", wtState.followCamera ? "true" : "false");
        followBtn.title = wtState.followCamera
          ? "Cámara de seguimiento activa (conserva tu zoom). Arrastra el mapa o haz clic para desactivar"
          : "Activar cámara de seguimiento suave conservando tu zoom actual";
      }

      // Píldoras de bifurcación (if / switch / try-catch).
      const branchBar = document.getElementById("wt-branch-bar");
      const branchOptionsEl = document.getElementById("wt-branch-options");
      if (branchBar && branchOptionsEl) {
        branchOptionsEl.innerHTML = "";
        if (cur && cur.branch_key && Array.isArray(cur.branch_options) && cur.branch_options.length > 1) {
          for (const opt of cur.branch_options) {
            const pill = document.createElement("button");
            pill.type = "button";
            pill.className = `wt-branch-pill${opt.selected ? " active" : ""}${opt.is_error ? " is-error" : ""}`;
            pill.textContent = opt.label;
            pill.addEventListener("click", () => selectBranchOption(cur.branch_key, opt.target_step_id));
            branchOptionsEl.appendChild(pill);
          }
          branchBar.classList.remove("hidden");
        } else {
          branchBar.classList.add("hidden");
        }
      }
      notifyStateChanged();
    };

    const renderStackPanel = () => {
      const panel = document.getElementById("walkthrough-stack-panel");
      const listEl = document.getElementById("wt-stack-list");
      const depthEl = document.getElementById("wt-stack-depth");
      const modeBadgeEl = document.getElementById("wt-stack-mode-badge");
      if (!panel || !listEl) {
        return;
      }
      panel.classList.toggle("hidden", !wtState.active);
      if (!wtState.active) {
        return;
      }

      const cur = getCurrentEvent();
      const stack = (cur && Array.isArray(cur.call_stack)) ? cur.call_stack : [];
      if (depthEl) {
        depthEl.textContent = `${stack.length} ${stack.length === 1 ? "frame" : "frames"}`;
      }
      if (modeBadgeEl) {
        if (wtState.scope === "window") {
          modeBadgeEl.textContent = "Ventana · Paso a Paso";
        } else {
          const lvl = getActiveLevelSafe();
          const lvlTag = lvl >= 4 ? "N3+" : `N${lvl}`;
          if (wtState.granularity === "step") {
            modeBadgeEl.textContent = lvl < 4 ? `Paso a Paso · ${lvlTag} (+1)` : "Paso a Paso · N3+";
          } else {
            modeBadgeEl.textContent = `Pulso · ${lvlTag}`;
          }
        }
      }

      listEl.innerHTML = "";
      // Mostrar pila con el frame activo arriba (top of stack).
      const reversed = [...stack].reverse();
      reversed.forEach((frame, idx) => {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `wt-stack-frame${idx === 0 ? " active" : ""}`;
        btn.title = frame.fn_id;

        const idxSpan = document.createElement("span");
        idxSpan.className = "wt-stack-idx";
        idxSpan.textContent = `#${idx}`;

        const nameSpan = document.createElement("span");
        nameSpan.className = "wt-stack-name";
        nameSpan.textContent = frame.label || frame.fn_id;

        const lineSpan = document.createElement("span");
        lineSpan.className = "wt-stack-line";
        lineSpan.textContent = frame.call_line ? `L${frame.call_line}` : "";

        btn.appendChild(idxSpan);
        btn.appendChild(nameSpan);
        if (frame.call_line) {
          btn.appendChild(lineSpan);
        }
        btn.addEventListener("click", () => {
          if (hooks.focusNode) {
            hooks.focusNode(frame.fn_id);
          }
        });
        li.appendChild(btn);
        listEl.appendChild(li);
      });
    };

    const positionActionCard = () => {
      const card = document.getElementById("walkthrough-action-card");
      const area = document.getElementById("canvas-area");
      const cur = getCurrentEvent();
      if (!card || !area) {
        return;
      }
      if (!wtState.active || !cur) {
        card.classList.add("hidden");
        card.style.zIndex = "";
        return;
      }

      const targetWin = wtState.scope === "window" ? getScopedFloatingWindow() : null;
      const cy = targetWin ? targetWin.cy : (hooks.getCy ? hooks.getCy() : null);
      const nodesById = hooks.getNodesById ? hooks.getNodesById() : null;
      const focusId = resolveVisibleCyNodeId(
        cy,
        cur.step_over ? cur.from : (cur.to || cur.from),
        nodesById,
        hooks.resolveVisibleFallbackId || null,
      );
      const cyNode = cy && focusId ? cy.getElementById(focusId) : null;

      let offsetX = 0;
      let offsetY = 0;
      if (targetWin && targetWin.el) {
        const areaRect = area.getBoundingClientRect();
        const boxEl = targetWin.viewMode === "code" ? targetWin.el : targetWin.cyContainer;
        const boxRect = boxEl ? boxEl.getBoundingClientRect() : areaRect;
        offsetX = boxRect.left - areaRect.left;
        offsetY = boxRect.top - areaRect.top;
        const winZ = Number.parseInt(targetWin.el.style.zIndex || "32", 10) || 32;
        card.style.zIndex = String(Math.min(855, winZ + 4));
      } else {
        card.style.zIndex = "";
      }

      let left = offsetX + 20;
      let top = offsetY + 56;
      if (targetWin && targetWin.viewMode === "code" && targetWin.el) {
        left = offsetX + Math.max(12, targetWin.el.clientWidth - 290);
        top = offsetY + 42;
      } else if (cyNode && cyNode.length > 0) {
        const bb = cyNode.renderedBoundingBox({ includeLabels: false });
        left = Math.round(offsetX + bb.x2 + 14);
        top = Math.round(offsetY + bb.y1 - 4);
      }

      card.classList.remove("hidden");
      const cardW = card.offsetWidth || 260;
      const cardH = card.offsetHeight || 68;
      if ((!targetWin || targetWin.viewMode !== "code") && left + cardW > area.clientWidth - 14 && cyNode && cyNode.length > 0) {
        const bb = cyNode.renderedBoundingBox({ includeLabels: false });
        left = Math.round(offsetX + bb.x1 - cardW - 14);
      }
      left = Math.max(14, Math.min(Math.max(14, area.clientWidth - cardW - 14), left));
      top = Math.max(58, Math.min(Math.max(58, area.clientHeight - cardH - 18), top));
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
    };

    const renderActionCard = () => {
      const card = document.getElementById("walkthrough-action-card");
      if (!card) {
        return;
      }
      const cur = getCurrentEvent();
      if (!wtState.active || !cur) {
        card.classList.add("hidden");
        return;
      }
      const meta = ACTION_META[cur.action_kind] || ACTION_META.assign;
      const badgeEl = document.getElementById("wt-action-badge");
      const lineEl = document.getElementById("wt-action-line");
      const textEl = document.getElementById("wt-action-text");
      if (badgeEl) {
        badgeEl.textContent = `${meta.icon} ${meta.badge}`;
        badgeEl.style.borderColor = meta.color;
        badgeEl.style.color = meta.color;
      }
      if (lineEl) {
        const lineText = cur.line > 0
          ? (cur.end_line > cur.line ? `L${cur.line}–L${cur.end_line}` : `L${cur.line}`)
          : "";
        lineEl.textContent = lineText;
        lineEl.classList.toggle("hidden", !lineText);
      }
      if (textEl) {
        textEl.textContent = cur.label || "";
      }
      positionActionCard();
    };

    const fetchFunctionSource = async (fnId) => {
      if (!fnId) {
        return null;
      }
      if (wtState.sourceCache.has(fnId)) {
        return wtState.sourceCache.get(fnId);
      }
      try {
        const res = await fetch(`/source?node_id=${encodeURIComponent(fnId)}`, { cache: "no-store" });
        if (!res.ok) {
          return null;
        }
        const data = await res.json();
        wtState.sourceCache.set(fnId, data);
        return data;
      } catch (_err) {
        return null;
      }
    };

    const syncCodeForCurrentEvent = async () => {
      const cur = getCurrentEvent();
      const box = document.getElementById("wt-code-preview-box");
      const metaEl = document.getElementById("wt-code-meta");
      const linesEl = document.getElementById("wt-code-lines");
      const openBtn = document.getElementById("btn-wt-open-split");
      if (!box || !linesEl) {
        return;
      }
      if (!wtState.active || !cur || !cur.fn_id) {
        box.classList.add("hidden");
        if (hooks.renderWalkthroughVocab) {
          hooks.renderWalkthroughVocab(null, null);
        }
        return;
      }

      // 1. Sincronizar cualquier ventana flotante abierta para `cur.fn_id`.
      if (hooks.syncFloatingCodeForEvent) {
        hooks.syncFloatingCodeForEvent(cur);
      }

      // 2. Vista de código sincronizada en vivo dentro del panel Call Stack del Inspector.
      const showInlineCode = wtState.granularity === "step" || (cur.line && cur.line > 0);
      if (!showInlineCode) {
        box.classList.add("hidden");
        if (hooks.renderWalkthroughVocab) {
          hooks.renderWalkthroughVocab(null, null);
        }
        return;
      }
      box.classList.remove("hidden");

      const renderKey = `${cur.fn_id}:${cur.line}:${cur.end_line}:${cur.kind}`;
      if (wtState.lastRenderedCodeKey === renderKey && linesEl.childElementCount > 0) {
        return;
      }
      wtState.lastRenderedCodeKey = renderKey;

      const sourceData = await fetchFunctionSource(cur.fn_id);
      if (!wtState.active || getCurrentEvent() !== cur) {
        return;
      }
      if (!sourceData || !Array.isArray(sourceData.lines) || sourceData.lines.length === 0) {
        box.classList.add("hidden");
        if (hooks.renderWalkthroughVocab) {
          hooks.renderWalkthroughVocab(null, null);
        }
        return;
      }

      if (metaEl) {
        const fileBase = (sourceData.file_id || "").split("/").pop() || sourceData.file_id || "";
        const lineTag = cur.line > 0 ? ` · L${cur.line}` : "";
        metaEl.textContent = `${fileBase}${lineTag}`;
      }
      if (openBtn) {
        openBtn.dataset.fnId = cur.fn_id;
      }

      const startLine = cur.line > 0 ? cur.line : sourceData.start_line;
      const endLine = cur.end_line >= startLine ? cur.end_line : startLine;
      const totalLines = sourceData.lines.length;
      const windowStart = totalLines <= 28
        ? sourceData.start_line
        : Math.max(sourceData.start_line, startLine - 4);
      const windowEnd = totalLines <= 28
        ? sourceData.end_line
        : Math.min(sourceData.end_line, endLine + 5);

      applyCodeWrapState();
      linesEl.replaceChildren();
      const frag = document.createDocumentFragment();
      let firstActiveRow = null;
      for (const lineObj of sourceData.lines) {
        if (lineObj.number < windowStart || lineObj.number > windowEnd) {
          continue;
        }
        const row = document.createElement("div");
        const isActiveLine = lineObj.number >= startLine && lineObj.number <= endLine;
        const kindCls = cur.kind === "throw" || cur.kind === "catch"
          ? " wt-line-error"
          : (cur.kind === "return" ? " wt-line-return" : "");
        const hasLineNote = Boolean(hooks.hasLineNote && hooks.hasLineNote(sourceData.file_id, lineObj.number));
        row.className = `wt-code-row${isActiveLine ? ` active${kindCls}` : ""}${hasLineNote ? " has-line-note" : ""}`;
        row.dataset.line = String(lineObj.number);

        const numSpan = document.createElement("span");
        numSpan.className = "wt-code-lineno";
        numSpan.textContent = hasLineNote ? `📝${lineObj.number}` : String(lineObj.number);

        const textSpan = document.createElement("span");
        textSpan.className = "wt-code-text";
        if (hooks.highlightCodeTokens) {
          hooks.highlightCodeTokens(textSpan, lineObj.text || "", sourceData.language || "");
        } else {
          textSpan.textContent = lineObj.text || "";
        }

        row.appendChild(numSpan);
        row.appendChild(textSpan);
        if (isActiveLine && !firstActiveRow) {
          firstActiveRow = row;
        }
        frag.appendChild(row);
      }
      linesEl.appendChild(frag);
      if (firstActiveRow && typeof firstActiveRow.scrollIntoView === "function") {
        firstActiveRow.scrollIntoView({ block: "nearest" });
      }

      if (hooks.renderWalkthroughVocab) {
        hooks.renderWalkthroughVocab(cur, sourceData);
      }
    };

    const applyCurrentEvent = async ({ rescheduleAfter = false } = {}) => {
      const token = ++wtState.transitionToken;
      const cur = getCurrentEvent();
      if (rescheduleAfter) {
        clearPlayTimer();
      }
      updateHudControls();
      renderStackPanel();

      if (cur && hooks.syncActiveEventExpansion) {
        await hooks.syncActiveEventExpansion(cur, {
          scope: wtState.scope,
          windowId: wtState.windowId,
          granularity: wtState.granularity,
          effectiveGranularity: getEffectiveGeneratorGranularity(),
          followCamera: wtState.followCamera,
        });
        if (!wtState.active || token !== wtState.transitionToken) {
          return false;
        }
      }

      renderActionCard();
      renderer.setEvent(cur, getStepDurationMs());
      if (cur && hooks.onEventActive) {
        hooks.onEventActive(cur);
      }
      syncCodeForCurrentEvent();
      if (rescheduleAfter && wtState.active && wtState.playing && token === wtState.transitionToken) {
        scheduleNextTick();
      }
      return true;
    };

    const scheduleNextTick = () => {
      clearPlayTimer();
      if (!wtState.active || !wtState.playing) {
        return;
      }
      const events = (wtState.trace && wtState.trace.events) || [];
      if (wtState.index >= events.length - 1) {
        wtState.playing = false;
        updateHudControls();
        return;
      }
      wtState.playTimer = window.setTimeout(() => {
        wtState.playTimer = null;
        if (!wtState.active || !wtState.playing) {
          return;
        }
        wtState.index = Math.min(events.length - 1, wtState.index + 1);
        void applyCurrentEvent({ rescheduleAfter: true });
      }, getStepDurationMs());
    };

    const rebuildTrace = async ({ preserveIndex = false, autoPlay = false } = {}) => {
      const rawGraph = hooks.getRawGraph ? hooks.getRawGraph() : null;
      if (!rawGraph) {
        return false;
      }
      const prevSeq = preserveIndex ? wtState.index : 0;
      const effectiveGranularity = getEffectiveGeneratorGranularity();
      const trace = generateStaticWalkthrough(rawGraph, {
        rootId: wtState.rootId,
        flowId: wtState.flowId,
        granularity: effectiveGranularity,
        stepInto: wtState.stepInto,
        branchOverrides: wtState.branchOverrides,
      });
      wtState.trace = trace;
      wtState.rootId = trace.root_id;
      wtState.index = trace.events.length > 0
        ? Math.max(0, Math.min(trace.events.length - 1, prevSeq))
        : 0;
      wtState.lastRenderedCodeKey = "";

      if (hooks.prepareCanvasForTrace && trace.events.length > 0) {
        await hooks.prepareCanvasForTrace(trace, {
          scope: wtState.scope,
          windowId: wtState.windowId,
          granularity: wtState.granularity,
          effectiveGranularity,
        });
      }

      await applyCurrentEvent({ rescheduleAfter: false });
      if (autoPlay && trace.events.length > 1 && wtState.active) {
        wtState.playing = true;
        updateHudControls();
        scheduleNextTick();
      }
      return trace.events.length > 0;
    };

    const start = async (options = {}) => {
      clearPlayTimer();
      const rawGraph = hooks.getRawGraph ? hooks.getRawGraph() : null;
      if (!rawGraph) {
        return false;
      }
      const nextScope = options.scope === "window" && options.windowId ? "window" : "main";
      wtState.active = true;
      wtState.playing = false;
      wtState.scope = nextScope;
      wtState.windowId = nextScope === "window" ? options.windowId : null;
      if (options.followCamera !== undefined) {
        wtState.followCamera = Boolean(options.followCamera);
        renderer.setFollowCamera(wtState.followCamera);
      }
      if (nextScope === "window") {
        wtState.granularity = "step";
        wtState.stepInto = false;
        wtState.flowId = null;
      } else {
        wtState.granularity = options.granularity || wtState.granularity || "pulse";
        if (options.stepInto !== undefined) {
          wtState.stepInto = Boolean(options.stepInto);
        }
        wtState.flowId = options.flowId !== undefined ? options.flowId : (hooks.getActiveFlowId ? hooks.getActiveFlowId() : null);
      }
      wtState.rootId = options.rootId !== undefined ? options.rootId : (hooks.getPreferredRootId ? hooks.getPreferredRootId() : null);
      wtState.branchOverrides = options.branchOverrides ? { ...options.branchOverrides } : {};
      wtState.index = 0;

      updateSidebarButton();
      const ok = await rebuildTrace({ preserveIndex: false, autoPlay: Boolean(options.autoPlay) });
      if (!ok) {
        stop();
        return false;
      }
      return true;
    };

    const loadExternalTrace = async (externalTrace, { autoPlay = false, scope = "main", windowId = null, followCamera } = {}) => {
      clearPlayTimer();
      const normalized = normalizeTrace(externalTrace);
      if (normalized.events.length === 0) {
        return false;
      }
      wtState.active = true;
      wtState.playing = false;
      wtState.scope = scope === "window" && windowId ? "window" : "main";
      wtState.windowId = wtState.scope === "window" ? windowId : null;
      if (followCamera !== undefined) {
        wtState.followCamera = Boolean(followCamera);
        renderer.setFollowCamera(wtState.followCamera);
      }
      wtState.trace = normalized;
      wtState.granularity = normalized.granularity;
      wtState.stepInto = normalized.step_into;
      wtState.rootId = normalized.root_id;
      wtState.flowId = normalized.flow_id;
      wtState.branchOverrides = { ...(normalized.branch_overrides || {}) };
      wtState.index = 0;
      wtState.lastRenderedCodeKey = "";
      updateSidebarButton();
      if (hooks.prepareCanvasForTrace) {
        await hooks.prepareCanvasForTrace(normalized, {
          scope: wtState.scope,
          windowId: wtState.windowId,
          granularity: wtState.granularity,
          effectiveGranularity: normalized.granularity,
        });
      }
      await applyCurrentEvent({ rescheduleAfter: false });
      if (autoPlay && normalized.events.length > 1 && wtState.active) {
        wtState.playing = true;
        updateHudControls();
        scheduleNextTick();
      }
      return true;
    };

    const stop = () => {
      const prevScope = wtState.scope;
      wtState.transitionToken += 1;
      clearPlayTimer();
      wtState.active = false;
      wtState.playing = false;
      wtState.scope = "main";
      wtState.windowId = null;
      wtState.trace = null;
      wtState.index = 0;
      wtState.lastRenderedCodeKey = "";
      renderer.stop();
      clearMainCanvasOnly();
      updateSidebarButton();
      updateHudControls();
      renderStackPanel();
      renderActionCard();
      const codeBox = document.getElementById("wt-code-preview-box");
      if (codeBox) {
        codeBox.classList.add("hidden");
      }
      const vocabDock = document.getElementById("wt-vocab-dock");
      if (vocabDock) {
        vocabDock.replaceChildren();
        vocabDock.classList.add("hidden");
      }
      if (hooks.onWalkthroughStopped) {
        void hooks.onWalkthroughStopped({ scope: prevScope });
      }
      notifyStateChanged();
    };

    const onFloatingWindowClosed = (closedWinId) => {
      if (wtState.active && wtState.scope === "window" && wtState.windowId === closedWinId) {
        stop();
      }
    };

    const toggle = async (options = {}) => {
      if (wtState.active) {
        stop();
        return false;
      }
      return start(options);
    };

    const togglePlay = () => {
      if (!wtState.active || !wtState.trace || wtState.trace.events.length === 0) {
        return;
      }
      if (wtState.playing) {
        wtState.playing = false;
        clearPlayTimer();
        updateHudControls();
        return;
      }
      if (wtState.index >= wtState.trace.events.length - 1) {
        wtState.index = 0;
        wtState.playing = true;
        void applyCurrentEvent({ rescheduleAfter: true });
        return;
      }
      wtState.playing = true;
      updateHudControls();
      scheduleNextTick();
    };

    const stepForward = () => {
      if (!wtState.active || !wtState.trace || wtState.trace.events.length === 0) {
        return Promise.resolve(false);
      }
      wtState.playing = false;
      clearPlayTimer();
      if (wtState.index < wtState.trace.events.length - 1) {
        wtState.index += 1;
        return applyCurrentEvent({ rescheduleAfter: false });
      }
      return Promise.resolve(false);
    };

    const stepBackward = () => {
      if (!wtState.active || !wtState.trace || wtState.trace.events.length === 0) {
        return Promise.resolve(false);
      }
      wtState.playing = false;
      clearPlayTimer();
      if (wtState.index > 0) {
        wtState.index -= 1;
        return applyCurrentEvent({ rescheduleAfter: false });
      }
      return Promise.resolve(false);
    };

    const setSpeed = (newSpeed) => {
      const parsed = Number(newSpeed);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return;
      }
      wtState.speed = parsed;
      updateHudControls();
      if (wtState.playing) {
        scheduleNextTick();
      }
    };

    const setFollowCamera = (enabled) => {
      const next = Boolean(enabled);
      if (wtState.followCamera === next) {
        return wtState.followCamera;
      }
      wtState.followCamera = next;
      renderer.setFollowCamera(next);
      updateHudControls();
      return wtState.followCamera;
    };

    const toggleFollowCamera = () => setFollowCamera(!wtState.followCamera);

    const notifyManualPan = (cyInstance = null) => {
      if (!wtState.active || !wtState.followCamera || wtState.programmaticPanDepth > 0) {
        return false;
      }
      const activeCy = getActiveCameraCy();
      if (cyInstance && activeCy && cyInstance !== activeCy) {
        return false;
      }
      wtState.followCamera = false;
      renderer.setFollowCamera(false);
      updateHudControls();
      return true;
    };

    const setGranularity = async (mode) => {
      const clean = mode === "step" ? "step" : "pulse";
      if (wtState.granularity === clean) {
        return;
      }
      wtState.playing = false;
      clearPlayTimer();
      wtState.granularity = clean;
      if (wtState.active) {
        if (clean === "pulse" && hooks.restoreWalkthroughExpansion) {
          await hooks.restoreWalkthroughExpansion({ scope: wtState.scope, keepSnapshot: true });
        }
        await rebuildTrace({ preserveIndex: false, autoPlay: false });
      }
    };

    const onLevelChanged = async () => {
      if (!wtState.active || wtState.scope !== "main") {
        return;
      }
      wtState.playing = false;
      clearPlayTimer();
      await rebuildTrace({ preserveIndex: false, autoPlay: false });
    };

    const toggleStepInto = async () => {
      wtState.playing = false;
      clearPlayTimer();
      wtState.stepInto = !wtState.stepInto;
      if (wtState.active && wtState.granularity === "step") {
        await rebuildTrace({ preserveIndex: false, autoPlay: false });
      } else {
        updateHudControls();
      }
    };

    const selectBranchOption = async (branchKey, targetStepId) => {
      if (!branchKey || !targetStepId || !wtState.active) {
        return;
      }
      wtState.playing = false;
      clearPlayTimer();
      wtState.branchOverrides[branchKey] = targetStepId;
      await rebuildTrace({ preserveIndex: true, autoPlay: false });
    };

    const onViewportChanged = () => {
      if (wtState.active) {
        positionActionCard();
      }
    };

    const onLiveGraphUpdated = async () => {
      wtState.sourceCache.clear();
      wtState.lastRenderedCodeKey = "";
      if (wtState.active) {
        await rebuildTrace({ preserveIndex: true, autoPlay: false });
      }
    };

    const refreshVocabView = () => {
      if (!wtState.active) {
        return;
      }
      wtState.lastRenderedCodeKey = "";
      syncCodeForCurrentEvent();
    };

    const bindDomEvents = () => {
      const bindClick = (id, fn) => {
        const el = document.getElementById(id);
        if (el) {
          el.addEventListener("click", fn);
        }
      };
      bindClick("btn-walkthrough", () => toggle({ autoPlay: false }));
      bindClick("btn-inspector-walkthrough-flow", () => start({ autoPlay: false }));
      bindClick("btn-wt-play", togglePlay);
      bindClick("btn-wt-prev", stepBackward);
      bindClick("btn-wt-next", stepForward);
      bindClick("btn-wt-mode-pulse", () => {
        if (wtState.scope !== "window") {
          setGranularity("pulse");
        }
      });
      bindClick("btn-wt-mode-step", () => setGranularity("step"));
      bindClick("btn-wt-step-into", () => {
        if (wtState.scope !== "window") {
          toggleStepInto();
        }
      });
      bindClick("btn-wt-follow", toggleFollowCamera);
      bindClick("btn-wt-close", stop);
      bindClick("btn-wt-wrap-code", toggleCodeWrap);
      bindClick("btn-wt-open-split", () => {
        const btn = document.getElementById("btn-wt-open-split");
        const fnId = btn && btn.dataset.fnId;
        if (fnId && hooks.openFunctionSplitWindow) {
          hooks.openFunctionSplitWindow(fnId, getCurrentEvent());
        }
      });

      const speedSelect = document.getElementById("wt-speed-select");
      if (speedSelect) {
        speedSelect.addEventListener("change", (event) => setSpeed(event.target.value));
      }
      applyCodeWrapState();
    };

    return {
      isActive: () => wtState.active,
      getState: getSnapshotState,
      getScope: () => ({ scope: wtState.scope, windowId: wtState.windowId }),
      getCurrentEvent,
      getTrace: () => wtState.trace,
      bindDomEvents,
      start,
      loadExternalTrace,
      stop,
      toggle,
      togglePlay,
      stepForward,
      stepBackward,
      setSpeed,
      setFollowCamera,
      toggleFollowCamera,
      notifyManualPan,
      setGranularity,
      toggleStepInto,
      toggleCodeWrap,
      selectBranchOption,
      onViewportChanged,
      onLevelChanged,
      onLiveGraphUpdated,
      onFloatingWindowClosed,
      refreshVocabView,
    };
  }

  const exportedApi = {
    WALKTHROUGH_SCHEMA_VERSION,
    DEFAULT_MAX_DEPTH,
    DEFAULT_MAX_EVENTS,
    SPARK_COLORS,
    ACTION_META,
    StaticWalkthroughGenerator: {
      generate: generateStaticWalkthrough,
      normalizeTrace,
    },
    computePolylineArcLengths,
    samplePolylineAt,
    modelToScreen,
    resolveVisibleCyNodeId,
    computeCameraFollowPanStep,
    extractEdgePolyline,
    WalkthroughCanvasRenderer,
    createController: createWalkthroughController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exportedApi;
  }
  if (globalScope && typeof globalScope === "object") {
    globalScope.CodeMapWalkthrough = exportedApi;
  }
})(typeof window !== "undefined" ? window : globalThis);
