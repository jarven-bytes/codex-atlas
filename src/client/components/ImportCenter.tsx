import { DatabaseZap, RotateCcw, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ImportCommitResponse, ImportMappingInput, UndoResponse } from "../api";
import type { ImportPreview, ImportSource, SavedMappingEntry } from "../../server/imports/types";

const mappingFieldOptions = [
  "name", "type", "needStatus", "userNeed", "currentState", "nextAction", "rootPath",
  "repositoryUrl", "aliases", "launchTargets", "missingItems", "tags"
] as const;

interface ImportCenterProps {
  onPreview: (source: ImportSource, mapping?: ImportMappingInput) => Promise<ImportPreview>;
  onCommit: (previewId: string) => Promise<ImportCommitResponse>;
  onUndo: (snapshotPath: string) => Promise<UndoResponse>;
  onGetSavedMappings: (format: "json" | "csv") => Promise<SavedMappingEntry[]>;
  onInputChange?: () => void;
}

function defaultLabel(kind: ImportSource["kind"]): string {
  return kind === "structured-file" ? "Structured import" : "Local folder import";
}

function buildMappingObject(columns: string[], values: Record<string, string>): ImportMappingInput {
  return columns.reduce<ImportMappingInput>((mapping, column) => {
    if (values[column]) mapping[column] = values[column];
    return mapping;
  }, {});
}

function inputKey(source: ImportSource, mapping: ImportMappingInput): string {
  return JSON.stringify({ source, mapping });
}

function mappingLabel(entry: SavedMappingEntry): string {
  return `Saved mapping: ${entry.format} (${entry.detectedColumns.join(", ")})`;
}

export function ImportCenter({
  onPreview,
  onCommit,
  onUndo,
  onGetSavedMappings,
  onInputChange
}: ImportCenterProps) {
  const [sourceKind, setSourceKind] = useState<ImportSource["kind"]>("local-folder");
  const [sourcePath, setSourcePath] = useState("");
  const [structuredFormat, setStructuredFormat] = useState<"json" | "csv">("json");
  const [selectedMappingId, setSelectedMappingId] = useState("manual");
  const [savedMappings, setSavedMappings] = useState<SavedMappingEntry[]>([]);
  const [mappingValues, setMappingValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "success" | "warning" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [undoToken, setUndoToken] = useState<string | null>(null);

  const selectedMapping = savedMappings.find((entry) => entry.schemaFingerprint === selectedMappingId);
  const mappingColumns = preview?.detectedColumns ?? selectedMapping?.detectedColumns ?? [];
  const currentMapping = useMemo(
    () => buildMappingObject(mappingColumns, mappingValues),
    [mappingColumns, mappingValues]
  );

  function buildSource(): ImportSource {
    return sourceKind === "structured-file"
      ? { kind: "structured-file", path: sourcePath, format: structuredFormat, label: defaultLabel(sourceKind) }
      : { kind: "local-folder", path: sourcePath, label: defaultLabel(sourceKind) };
  }

  const currentPreviewKey = inputKey(buildSource(), currentMapping);
  const previewIsCurrent = preview !== null && previewKey === currentPreviewKey;

  function invalidatePreview() {
    setPreviewKey(null);
    setMessage(null);
    setError(null);
    onInputChange?.();
  }

  useEffect(() => {
    if (sourceKind !== "structured-file") {
      setSavedMappings([]);
      setSelectedMappingId("manual");
      return;
    }
    let cancelled = false;
    void onGetSavedMappings(structuredFormat).then((mappings) => {
      if (!cancelled) setSavedMappings(mappings);
    }).catch((mappingError) => {
      if (!cancelled) setError(mappingError instanceof Error ? mappingError.message : "Could not load saved mappings.");
    });
    return () => { cancelled = true; };
  }, [sourceKind, structuredFormat, onGetSavedMappings]);

  async function handlePreview() {
    setBusy(true); setMessage(null); setError(null);
    try {
      const source = buildSource();
      const mapping = source.kind === "structured-file" && Object.keys(currentMapping).length > 0
        ? currentMapping
        : undefined;
      const nextPreview = mapping ? await onPreview(source, mapping) : await onPreview(source);
      setPreview(nextPreview);
      setPreviewKey(inputKey(source, mapping ?? {}));
      setMappingValues((current) => nextPreview.detectedColumns.reduce<Record<string, string>>((result, column) => {
        result[column] = current[column] ?? "";
        return result;
      }, {}));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Could not preview the import.");
    } finally { setBusy(false); }
  }

  async function handleCommit() {
    if (!preview || !previewIsCurrent) return;
    setBusy(true); setMessage(null); setError(null);
    try {
      const response = await onCommit(preview.id);
      setMessage({ text: `Imported ${response.result.importedCount} rows.`, tone: "success" });
      setUndoToken(response.result.snapshotPath);
      setPreviewKey(null);
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : "Could not commit the import.");
    } finally { setBusy(false); }
  }

  async function handleUndo() {
    if (!undoToken) return;
    setBusy(true); setMessage(null); setError(null);
    try {
      const response = await onUndo(undoToken);
      setUndoToken(null); setPreviewKey(null);
      setMessage(response.result.restored
        ? { text: "Restored the previous registry snapshot.", tone: "success" }
        : { text: "The import snapshot is no longer available to restore.", tone: "warning" });
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : "Could not undo the import.");
    } finally { setBusy(false); }
  }

  const previewCounts = preview?.rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.action] = (counts[row.action] ?? 0) + 1;
    return counts;
  }, {});

  return (
    <section className="detail-section import-center" aria-label="Import center" role="region">
      <div className="detail-section-header"><h3>Import center</h3></div>
      <div className="import-form-grid">
        <label className="form-field"><span>Import type</span><select aria-label="Import type" value={sourceKind} onChange={(event) => { setSourceKind(event.target.value as ImportSource["kind"]); invalidatePreview(); }}>
          <option value="local-folder">local-folder</option><option value="structured-file">structured-file</option>
        </select></label>
        <label className="form-field form-field-wide"><span>Import path</span><input aria-label="Import path" type="text" value={sourcePath} onChange={(event) => { setSourcePath(event.target.value); invalidatePreview(); }} placeholder="/workspace/imports/projects.csv" /></label>
        {sourceKind === "structured-file" ? <label className="form-field"><span>Structured format</span><select aria-label="Structured format" value={structuredFormat} onChange={(event) => { setStructuredFormat(event.target.value as "json" | "csv"); setSelectedMappingId("manual"); setMappingValues({}); invalidatePreview(); }}>
          <option value="json">json</option><option value="csv">csv</option>
        </select></label> : null}
        {sourceKind === "structured-file" ? <label className="form-field"><span>Mapping preset</span><select aria-label="Mapping preset" value={selectedMappingId} onChange={(event) => { const nextId = event.target.value; const next = savedMappings.find((entry) => entry.schemaFingerprint === nextId); setSelectedMappingId(nextId); setMappingValues(Object.entries(next?.mapping ?? {}).reduce<Record<string, string>>((result, [column, field]) => { if (field) result[column] = field; return result; }, {})); invalidatePreview(); }}>
          <option value="manual">manual</option>{savedMappings.map((entry) => <option key={entry.schemaFingerprint} value={entry.schemaFingerprint}>{mappingLabel(entry)}</option>)}
        </select></label> : null}
        <div className="import-actions">
          <button className="toolbar-button toolbar-button-primary" type="button" onClick={() => void handlePreview()} disabled={busy || !sourcePath.trim()} aria-label={preview ? "Refresh preview" : "Preview import"}><Upload size={15} /><span>{preview ? "Refresh preview" : "Preview import"}</span></button>
          {preview ? <button className="toolbar-button" type="button" onClick={() => void handleCommit()} disabled={busy || !previewIsCurrent} aria-label="Commit preview"><DatabaseZap size={15} /><span>Commit preview</span></button> : null}
          {undoToken ? <button className="toolbar-button toolbar-button-quiet" type="button" onClick={() => void handleUndo()} disabled={busy} aria-label="Undo last import"><RotateCcw size={15} /><span>Undo last import</span></button> : null}
        </div>
      </div>
      {error ? <div className="detail-banner detail-banner-error" role="alert" aria-live="assertive">{error}</div> : null}
      {message ? <div className={`detail-banner detail-banner-${message.tone}`} role="status" aria-live="polite">{message.text}</div> : null}
      {preview && !previewIsCurrent ? <div className="detail-banner detail-banner-warning" role="alert" aria-live="assertive">Preview is out of date. Refresh it before committing.</div> : null}
      {preview ? <>
        <div className="import-counts">{(["create", "update", "skip", "duplicate", "reject"] as const).map((action) => <span className={`import-count import-count-${action}`} key={action}>{action} {previewCounts?.[action] ?? 0}</span>)}</div>
        {sourceKind === "structured-file" ? <div className="mapping-panel"><div className="mapping-grid">{preview.detectedColumns.map((column) => <label className="form-field" key={column}><span>{`Map ${column}`}</span><select aria-label={`Map ${column}`} value={mappingValues[column] ?? ""} onChange={(event) => { setMappingValues((current) => ({ ...current, [column]: event.target.value })); invalidatePreview(); }}><option value="">ignore</option>{mappingFieldOptions.map((field) => <option key={field} value={field}>{field}</option>)}</select></label>)}</div></div> : null}
        <div className="import-preview-list">{preview.rows.map((row) => <article className="import-row" key={row.id}><div className="import-row-header"><strong>{row.candidate?.name ?? row.id}</strong><span className={`import-count import-count-${row.action}`}>{row.action}</span></div><p className="import-row-reason">{row.reason}</p></article>)}</div>
      </> : <p className="empty-copy">Preview a source to review row decisions before commit.</p>}
    </section>
  );
}
