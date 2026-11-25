/* Fichas Vivas de Vocabulario Técnico ("Anki en vivo") y Notas por Línea — Ciclo 9 (Lote 4)
 * - 100 % estático, offline y seguro (renderizado exclusivo vía DOM/textContent, sin HTML crudo)
 * - Filtra conceptos ya marcados como aprendidos en `~/.codemap/known_apis.json`
 * - Permite guardar notas personales por línea en `~/.codemap/<hash>/notes.json["line_notes"]`
 */

(function initCodeMapVocab(globalScope) {
  "use strict";

  const CATEGORY_META = {
    syntax: { label: "Sintaxis", group: "vocab", priority: 1, cssClass: "vocab-cat-syntax" },
    method: { label: "Método", group: "api", priority: 2, cssClass: "vocab-cat-method" },
    stdlib: { label: "Stdlib", group: "api", priority: 2, cssClass: "vocab-cat-method" },
    native: { label: "Nativo JS", group: "api", priority: 2, cssClass: "vocab-cat-method" },
    package: { label: "Paquete", group: "api", priority: 3, cssClass: "vocab-cat-package" },
    posix: { label: "POSIX", group: "vocab", priority: 4, cssClass: "vocab-cat-posix" },
    control: { label: "Control", group: "vocab", priority: 5, cssClass: "vocab-cat-control" },
  };

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

  function isVocabConcept(apiId, kind) {
    const id = String(apiId || "");
    const k = String(kind || "").toLowerCase();
    if (k === "syntax" || k === "posix" || k === "control") {
      return true;
    }
    return id.startsWith("syntax:") || id.startsWith("posix:") || id.startsWith("ctrl:");
  }

  function computeLineHash(lineText) {
    const text = String(lineText || "").trim();
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function getLineNoteKey(fileId, lineNumber) {
    const f = String(fileId || "").trim();
    const ln = Number(lineNumber || 0);
    if (!f || !Number.isInteger(ln) || ln <= 0) {
      return "";
    }
    return `${f}::${ln}`;
  }

  function getLineNote(notes, fileId, lineNumber) {
    const key = getLineNoteKey(fileId, lineNumber);
    if (!key || !notes || !notes.line_notes || typeof notes.line_notes !== "object") {
      return null;
    }
    const entry = notes.line_notes[key];
    if (!entry || typeof entry.note !== "string" || !entry.note.trim()) {
      return null;
    }
    return entry;
  }

  function isConceptKnown(conceptId, knownApis) {
    if (!conceptId || !knownApis || !knownApis.known || typeof knownApis.known !== "object") {
      return false;
    }
    return Boolean(knownApis.known[conceptId]);
  }

  function getDictionaryEntry(vocabDict, conceptId) {
    if (!conceptId || !vocabDict || !vocabDict.entries || typeof vocabDict.entries !== "object") {
      return null;
    }
    return vocabDict.entries[conceptId] || null;
  }

  function collectLineVocabItems(fnNode, startLine, endLine, vocabDict, knownApis) {
    if (!fnNode || typeof startLine !== "number" || startLine <= 0) {
      return [];
    }
    const hiEnd = typeof endLine === "number" && endLine >= startLine ? endLine : startLine;
    const seen = new Set();
    const items = [];

    const pushCandidate = (item) => {
      if (!item || !item.id || seen.has(item.id)) {
        return;
      }
      if (isConceptKnown(item.id, knownApis)) {
        return;
      }
      seen.add(item.id);
      items.push(item);
    };

    // 1. Ocurrencias AST extraídas en `vocab_by_line` para el rango [startLine..hiEnd].
    const byLine = fnNode.vocab_by_line && typeof fnNode.vocab_by_line === "object"
      ? fnNode.vocab_by_line
      : null;
    if (byLine) {
      for (let ln = startLine; ln <= hiEnd; ln += 1) {
        const ids = byLine[String(ln)];
        if (!Array.isArray(ids)) {
          continue;
        }
        for (const id of ids) {
          const dictEntry = getDictionaryEntry(vocabDict, id);
          if (!dictEntry) {
            continue;
          }
          pushCandidate({
            id: dictEntry.id,
            api_id: dictEntry.id,
            symbol: dictEntry.symbol || dictEntry.id,
            title: dictEntry.title || dictEntry.symbol || dictEntry.id,
            category: dictEntry.category || "syntax",
            kind: dictEntry.category || "syntax",
            module: dictEntry.category === "posix"
              ? "POSIX"
              : (dictEntry.category === "control" ? "Control" : "Sintaxis"),
            input: dictEntry.input || "",
            transform: dictEntry.transform || "",
            output: dictEntry.output || "",
            example: dictEntry.example || "",
            docs_url: dictEntry.docs_url || "",
            line: ln,
          });
        }
      }
    }

    // 2. Llamadas externas / métodos estándar detectados en el rango de líneas.
    const extCalls = Array.isArray(fnNode.external_calls) ? fnNode.external_calls : [];
    for (const ext of extCalls) {
      if (!ext) {
        continue;
      }
      const extLines = Array.isArray(ext.lines) && ext.lines.length > 0
        ? ext.lines
        : (typeof ext.line === "number" && ext.line > 0 ? [ext.line] : []);
      const matchedLine = extLines.find((ln) => typeof ln === "number" && ln >= startLine && ln <= hiEnd);
      if (matchedLine === undefined) {
        continue;
      }
      const apiId = ext.api_id || ext.symbol || "";
      if (!apiId) {
        continue;
      }
      const dictEntry = getDictionaryEntry(vocabDict, apiId);
      if (dictEntry) {
        pushCandidate({
          id: apiId,
          api_id: apiId,
          symbol: dictEntry.symbol || ext.symbol || apiId,
          title: dictEntry.title || ext.symbol || apiId,
          category: dictEntry.category || ext.kind || "method",
          kind: ext.kind || dictEntry.category || "method",
          module: ext.module || "",
          input: dictEntry.input || "",
          transform: dictEntry.transform || "",
          output: dictEntry.output || "",
          example: dictEntry.example || "",
          docs_url: dictEntry.docs_url || ext.docs_url || "",
          line: matchedLine,
        });
      } else {
        pushCandidate({
          id: apiId,
          api_id: apiId,
          symbol: `${ext.symbol || apiId}()`,
          title: ext.module ? `API externa (${ext.module})` : "API / método externo",
          category: ext.kind || "method",
          kind: ext.kind || "external",
          module: ext.module || "",
          input: "",
          transform: ext.call_expr ? `Invocación detectada: ${ext.call_expr}()` : "",
          output: "",
          example: "",
          docs_url: ext.docs_url || "",
          line: matchedLine,
        });
      }
    }

    items.sort((a, b) => {
      const pa = (CATEGORY_META[a.category] && CATEGORY_META[a.category].priority) || 9;
      const pb = (CATEGORY_META[b.category] && CATEGORY_META[b.category].priority) || 9;
      if (pa !== pb) {
        return pa - pb;
      }
      return String(a.symbol).localeCompare(String(b.symbol));
    });
    return items;
  }

  function collectProjectVocabItems(rawGraph, vocabDict) {
    const map = new Map();
    if (!rawGraph || !Array.isArray(rawGraph.nodes)) {
      return map;
    }
    for (const node of rawGraph.nodes) {
      if (!node || node.type !== "function" || !node.vocab_by_line || typeof node.vocab_by_line !== "object") {
        continue;
      }
      const seenInNode = new Set();
      for (const ids of Object.values(node.vocab_by_line)) {
        if (!Array.isArray(ids)) {
          continue;
        }
        for (const id of ids) {
          if (seenInNode.has(id)) {
            continue;
          }
          seenInNode.add(id);
          const dictEntry = getDictionaryEntry(vocabDict, id);
          if (!dictEntry) {
            continue;
          }
          if (!map.has(id)) {
            map.set(id, {
              api_id: id,
              symbol: dictEntry.symbol || id,
              title: dictEntry.title || "",
              module: dictEntry.category === "posix"
                ? "POSIX"
                : (dictEntry.category === "control" ? "Control" : "Sintaxis"),
              kind: dictEntry.category || "syntax",
              input: dictEntry.input || "",
              transform: dictEntry.transform || "",
              output: dictEntry.output || "",
              docs_url: dictEntry.docs_url || "",
              usageCount: 1,
              nodeIds: [node.id],
            });
          } else {
            const cur = map.get(id);
            cur.usageCount += 1;
            if (cur.nodeIds.length < 5 && !cur.nodeIds.includes(node.id)) {
              cur.nodeIds.push(node.id);
            }
          }
        }
      }
    }
    return map;
  }

  function createContractRow(labelText, valueText) {
    const row = document.createElement("div");
    row.className = "vocab-contract-row";

    const lbl = document.createElement("span");
    lbl.className = "vocab-contract-label";
    lbl.textContent = labelText;

    const val = document.createElement("span");
    val.className = "vocab-contract-val";
    val.textContent = valueText;

    row.appendChild(lbl);
    row.appendChild(val);
    return row;
  }

  function renderVocabDock(containerEl, context, callbacks) {
    if (!containerEl) {
      return;
    }
    containerEl.replaceChildren();

    const fnNode = context && context.fnNode ? context.fnNode : null;
    const line = Number(context && context.line ? context.line : 0);
    const endLine = Number(context && context.endLine ? context.endLine : line);
    const fileId = String((context && context.fileId) || (fnNode && fnNode.parent) || "");
    const lineText = String((context && context.lineText) || "");

    if (!fnNode || !line || line <= 0) {
      containerEl.classList.add("hidden");
      return;
    }

    const pendingItems = collectLineVocabItems(
      fnNode,
      line,
      endLine,
      context.vocabDict,
      context.knownApis,
    );
    const existingNote = getLineNote(context.notes, fileId, line);
    let noteEditorOpen = Boolean((context && context.forceOpenNoteEditor) || existingNote);

    containerEl.classList.remove("hidden");

    // 1. Cabecera del panel de Fichas Vivas + botón rápido para nota de línea.
    const header = document.createElement("div");
    header.className = "vocab-dock-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "vocab-dock-title-wrap";

    const titleEl = document.createElement("span");
    titleEl.className = "vocab-dock-title";
    const rangeStr = endLine > line ? `L${line}–L${endLine}` : `L${line}`;
    titleEl.textContent = pendingItems.length > 0
      ? `Fichas vivas · ${rangeStr} (${pendingItems.length})`
      : `Sin pendientes · ${rangeStr}`;
    titleWrap.appendChild(titleEl);

    const noteToggleBtn = document.createElement("button");
    noteToggleBtn.type = "button";
    noteToggleBtn.className = `vocab-note-toggle-btn${existingNote ? " has-note" : ""}`;
    noteToggleBtn.textContent = existingNote ? `📝 Nota en L${line}` : `+ 📝 Nota en L${line}`;
    noteToggleBtn.title = `Escribir o editar nota personal para la línea ${line} (solo en ~/.codemap/)`;

    header.appendChild(titleWrap);
    header.appendChild(noteToggleBtn);
    containerEl.appendChild(header);

    // 2. Micro-tarjetas de vocabulario pendiente (se desvanecen al pulsar "✓ Ya la sé").
    if (pendingItems.length > 0) {
      const list = document.createElement("div");
      list.className = "vocab-cards-list";

      for (const item of pendingItems) {
        const card = document.createElement("article");
        card.className = "vocab-card";
        card.dataset.vocabId = item.id;

        const top = document.createElement("div");
        top.className = "vocab-card-top";

        const symGroup = document.createElement("div");
        symGroup.className = "vocab-card-sym-group";

        const sym = document.createElement("code");
        sym.className = "vocab-symbol";
        sym.textContent = item.symbol;
        symGroup.appendChild(sym);

        const title = document.createElement("span");
        title.className = "vocab-title";
        title.textContent = item.title;
        symGroup.appendChild(title);

        const catMeta = CATEGORY_META[item.category] || { label: item.category || "Concepto", cssClass: "vocab-cat-syntax" };
        const catPill = document.createElement("span");
        catPill.className = `vocab-cat-pill ${catMeta.cssClass}`;
        catPill.textContent = catMeta.label;

        const knowBtn = document.createElement("button");
        knowBtn.type = "button";
        knowBtn.className = "vocab-known-btn";
        knowBtn.textContent = "✓ Ya la sé";
        knowBtn.title = "Marcar como aprendida globalmente en ~/.codemap/known_apis.json";
        knowBtn.addEventListener("click", () => {
          card.classList.add("vocab-card-vanishing");
          knowBtn.disabled = true;
          if (callbacks && typeof callbacks.onMarkKnown === "function") {
            callbacks.onMarkKnown(item);
          }
        });

        const topActions = document.createElement("div");
        topActions.className = "vocab-card-top-actions";
        topActions.appendChild(catPill);
        topActions.appendChild(knowBtn);

        top.appendChild(symGroup);
        top.appendChild(topActions);
        card.appendChild(top);

        // Contrato Entrada → Transformación → Salida.
        if (item.input || item.transform || item.output) {
          const contract = document.createElement("div");
          contract.className = "vocab-contract";
          if (item.input) {
            contract.appendChild(createContractRow("Entrada", item.input));
          }
          if (item.transform) {
            contract.appendChild(createContractRow("Acción", item.transform));
          }
          if (item.output) {
            contract.appendChild(createContractRow("Salida", item.output));
          }
          card.appendChild(contract);
        }

        if (item.example || isSafeHttpUrl(item.docs_url)) {
          const footer = document.createElement("div");
          footer.className = "vocab-card-footer";
          if (item.example) {
            const ex = document.createElement("code");
            ex.className = "vocab-example";
            ex.textContent = item.example;
            footer.appendChild(ex);
          }
          if (isSafeHttpUrl(item.docs_url)) {
            const link = document.createElement("a");
            link.className = "call-link docs-link";
            link.href = item.docs_url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = "Docs ↗";
            footer.appendChild(link);
          }
          card.appendChild(footer);
        }

        list.appendChild(card);
      }

      containerEl.appendChild(list);
    }

    // 3. Editor inline de nota personal por línea (`~/.codemap/<hash>/notes.json["line_notes"]`).
    const noteBox = document.createElement("div");
    noteBox.className = `vocab-line-note-box${noteEditorOpen ? "" : " hidden"}`;

    const noteInput = document.createElement("textarea");
    noteInput.className = "vocab-line-note-input";
    noteInput.rows = 2;
    noteInput.placeholder = `Nota personal para ${fileId.split("/").pop() || fileId} L${line} (guardada solo en ~/.codemap/)…`;
    noteInput.value = existingNote ? existingNote.note : "";

    const noteActions = document.createElement("div");
    noteActions.className = "vocab-line-note-actions";

    const statusSpan = document.createElement("span");
    statusSpan.className = "vocab-line-note-status";
    statusSpan.textContent = String((context && context.statusText) || "");

    const btnGroup = document.createElement("div");
    btnGroup.className = "vocab-line-note-btns";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "call-action-btn known-api-btn";
    saveBtn.textContent = "Guardar nota";

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "call-action-btn";
    clearBtn.textContent = "Borrar";
    clearBtn.classList.toggle("hidden", !existingNote);

    const doSave = async (textOverride = undefined) => {
      const finalText = textOverride !== undefined ? textOverride : noteInput.value.trim();
      saveBtn.disabled = true;
      clearBtn.disabled = true;
      statusSpan.textContent = "Guardando…";
      try {
        if (callbacks && typeof callbacks.onSaveLineNote === "function") {
          await callbacks.onSaveLineNote(fileId, line, finalText, computeLineHash(lineText));
        }
        statusSpan.textContent = finalText ? "Guardada ✓" : "Borrada";
        clearBtn.classList.toggle("hidden", !finalText);
        noteToggleBtn.classList.toggle("has-note", Boolean(finalText));
        noteToggleBtn.textContent = finalText ? `📝 Nota en L${line}` : `+ 📝 Nota en L${line}`;
        if (!finalText) {
          noteInput.value = "";
        }
      } catch (_err) {
        statusSpan.textContent = "Error al guardar";
      } finally {
        saveBtn.disabled = false;
        clearBtn.disabled = false;
      }
    };

    saveBtn.addEventListener("click", () => doSave());
    clearBtn.addEventListener("click", () => doSave(""));
    noteToggleBtn.addEventListener("click", () => {
      noteEditorOpen = !noteEditorOpen;
      noteBox.classList.toggle("hidden", !noteEditorOpen);
      if (noteEditorOpen) {
        noteInput.focus();
      }
    });

    btnGroup.appendChild(clearBtn);
    btnGroup.appendChild(saveBtn);
    noteActions.appendChild(statusSpan);
    noteActions.appendChild(btnGroup);
    noteBox.appendChild(noteInput);
    noteBox.appendChild(noteActions);
    containerEl.appendChild(noteBox);
  }

  const exportedApi = {
    CATEGORY_META,
    isSafeHttpUrl,
    isVocabConcept,
    computeLineHash,
    getLineNoteKey,
    getLineNote,
    isConceptKnown,
    getDictionaryEntry,
    collectLineVocabItems,
    collectProjectVocabItems,
    renderVocabDock,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exportedApi;
  }
  if (globalScope && typeof globalScope === "object") {
    globalScope.CodeMapVocab = exportedApi;
  }
})(typeof window !== "undefined" ? window : globalThis);
