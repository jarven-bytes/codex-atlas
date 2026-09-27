import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CandidateEvidence, ProjectCandidate, ProjectFieldKey } from "../../shared/domain";
import type { AdapterPreviewResult, FieldMapping, ImportAdapter, ImportSource } from "./types";

interface CsvParsedRow {
  cells?: string[];
  error?: string;
}

interface CsvParsedTable {
  detectedColumns: string[];
  rows: CsvParsedRow[];
}

function normalizeStringField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }

  return normalized;
}

function decodeSerializedValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function normalizeStringArray(value: unknown, field: string): string[] {
  value = decodeSerializedValue(value);
  if (typeof value === "undefined" || value === "") {
    return [];
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }

  return value.map((entry) => entry.trim()).filter(Boolean);
}

function sourceFieldName(targetField: string, mapping: FieldMapping | undefined): string {
  if (!mapping) {
    return targetField;
  }

  return Object.entries(mapping).find(([, mappedField]) => mappedField === targetField)?.[0] ?? targetField;
}

function buildCandidate(
  raw: Record<string, unknown>,
  mapped: Record<string, unknown>,
  source: ImportSource,
  rowId: string,
  mapping?: FieldMapping
): ProjectCandidate {
  const name = normalizeStringField(mapped.name, sourceFieldName("name", mapping));
  const evidence: CandidateEvidence[] = [{ kind: "source-id", value: `${source.path}:${rowId}` }];

  if (typeof mapped.rootPath === "string" && mapped.rootPath.trim()) {
    evidence.push({ kind: "root-path", value: mapped.rootPath.trim() });
  }

  if (typeof mapped.repositoryUrl === "string" && mapped.repositoryUrl.trim()) {
    evidence.push({ kind: "repository-url", value: mapped.repositoryUrl.trim() });
  }

  const aliases = normalizeStringArray(mapped.aliases, sourceFieldName("aliases", mapping));
  for (const alias of aliases) {
    evidence.push({ kind: "alias", value: alias });
  }

  const observedAt = new Date().toISOString();

  return {
    name,
    source: {
      kind: "import",
      label: source.label,
      sourceId: `${source.kind}:${source.path}:${rowId}`,
      syncStatus: "success",
      observedAt
    },
    evidence,
    verifiedAt: observedAt,
    type: typeof mapped.type === "string" ? mapped.type as ProjectCandidate["type"] : undefined,
    needStatus: typeof mapped.needStatus === "string" ? mapped.needStatus as ProjectCandidate["needStatus"] : undefined,
    userNeed: typeof mapped.userNeed === "string" ? mapped.userNeed.trim() : undefined,
    currentState: typeof mapped.currentState === "string" ? mapped.currentState.trim() : undefined,
    nextAction: typeof mapped.nextAction === "string" ? mapped.nextAction.trim() : undefined,
    rootPath: typeof mapped.rootPath === "string" && mapped.rootPath.trim() ? mapped.rootPath.trim() : undefined,
    repositoryUrl:
      typeof mapped.repositoryUrl === "string" && mapped.repositoryUrl.trim()
        ? mapped.repositoryUrl.trim()
        : undefined,
    aliases,
    importantFiles: normalizeStringArray(mapped.importantFiles, sourceFieldName("importantFiles", mapping)),
    tags: normalizeStringArray(mapped.tags, sourceFieldName("tags", mapping)),
    missingItems: normalizeStringArray(mapped.missingItems, sourceFieldName("missingItems", mapping)),
    launchTargets: Array.isArray(decodeSerializedValue(mapped.launchTargets))
      ? decodeSerializedValue(mapped.launchTargets) as ProjectCandidate["launchTargets"]
      : undefined
  };
}

function applyMapping(
  raw: Record<string, unknown>,
  mapping: FieldMapping | undefined
): Record<string, unknown> {
  if (!mapping || Object.keys(mapping).length === 0) {
    return raw;
  }

  const result: Record<string, unknown> = {};
  for (const [sourceKey, targetField] of Object.entries(mapping)) {
    if (!targetField) {
      continue;
    }
    result[targetField] = raw[sourceKey];
  }

  return result;
}

function validateFieldMapping(mapping: FieldMapping | undefined): void {
  if (!mapping) {
    return;
  }

  const validFields = new Set<ProjectFieldKey>([
    "name",
    "type",
    "needStatus",
    "userNeed",
    "currentState",
    "nextAction",
    "rootPath",
    "repositoryUrl",
    "aliases",
    "launchTargets",
    "importantFiles",
    "missingItems",
    "tags"
  ]);

  for (const targetField of Object.values(mapping)) {
    if (targetField && !validFields.has(targetField)) {
      throw new Error(`Unsupported mapped field: ${targetField}`);
    }
  }
}

type ParsedJsonRow =
  | { raw: Record<string, unknown>; error?: undefined }
  | { raw: unknown; error: string };

function parseJsonRows(raw: string): ParsedJsonRow[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("JSON import must be an array of objects");
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        raw: entry,
        error: `Row ${index + 1} must be an object`
      };
    }

    return { raw: entry as Record<string, unknown> };
  });
}

function normalizeSchemaColumns(columns: string[]): string[] {
  return Array.from(
    new Set(columns.map((column) => column.trim()).filter(Boolean).map((column) => column.toLowerCase()))
  ).sort();
}

export function createSchemaFingerprint(format: "json" | "csv", columns: string[]): string {
  const normalized = normalizeSchemaColumns(columns);
  return createHash("sha256")
    .update(JSON.stringify({ format, columns: normalized }))
    .digest("hex");
}

function parseCsvTable(raw: string): CsvParsedTable {
  const rows: CsvParsedRow[] = [];
  let currentCell = "";
  let currentRow: string[] = [];
  let inQuotes = false;
  let rowHasContent = false;

  const pushCell = () => {
    currentRow.push(currentCell);
    currentCell = "";
  };

  const pushRow = () => {
    rows.push({ cells: currentRow });
    currentRow = [];
    rowHasContent = false;
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];

    if (char === "\"") {
      rowHasContent = true;
      if (inQuotes) {
        if (next === "\"") {
          currentCell += "\"";
          index += 1;
          continue;
        }

        inQuotes = false;
        continue;
      }

      if (currentCell.length === 0) {
        inQuotes = true;
        continue;
      }

      currentCell += char;
      continue;
    }

    if (char === "," && !inQuotes) {
      pushCell();
      rowHasContent = true;
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }

      pushCell();
      pushRow();
      continue;
    }

    currentCell += char;
    if (char.trim() !== "") {
      rowHasContent = true;
    }
  }

  if (inQuotes) {
    rows.push({ error: "unterminated quoted field" });
  } else if (rowHasContent || currentCell.length > 0 || currentRow.length > 0) {
    pushCell();
    pushRow();
  }

  if (rows.length === 0) {
    return {
      detectedColumns: [],
      rows: []
    };
  }

  const [headerRow, ...dataRows] = rows;
  const detectedColumns = headerRow.cells ?? [];
  return {
    detectedColumns,
    rows: dataRows.map((row) => {
      if (row.error) {
        return row;
      }

      if (!row.cells) {
        return { error: "row could not be parsed" };
      }

      if (row.cells.length !== detectedColumns.length) {
        return {
          error: `column count mismatch: expected ${detectedColumns.length} columns but received ${row.cells.length}`
        };
      }

      return row;
    })
  };
}

export async function detectStructuredSchema(source: Extract<ImportSource, { kind: "structured-file" }>): Promise<{
  detectedColumns: string[];
  schemaFingerprint: string;
}> {
  const raw = await readFile(source.path, "utf8");

  if (source.format === "json") {
    const rows = parseJsonRows(raw);
    const detectedColumns = Array.from(
      new Set(
        rows.flatMap((row) =>
          !row.error && row.raw && typeof row.raw === "object" && !Array.isArray(row.raw)
            ? Object.keys(row.raw)
            : []
        )
      )
    );

    return {
      detectedColumns,
      schemaFingerprint: createSchemaFingerprint(source.format, detectedColumns)
    };
  }

  const parsed = parseCsvTable(raw);
  return {
    detectedColumns: parsed.detectedColumns,
    schemaFingerprint: createSchemaFingerprint(source.format, parsed.detectedColumns)
  };
}

export class StructuredImportAdapter implements ImportAdapter {
  canHandle(source: ImportSource): boolean {
    return source.kind === "structured-file";
  }

  async preview(source: ImportSource, mapping?: FieldMapping): Promise<AdapterPreviewResult> {
    if (source.kind !== "structured-file") {
      throw new Error(`Unsupported source kind: ${source.kind}`);
    }

    validateFieldMapping(mapping);
    const raw = await readFile(source.path, "utf8");

    if (source.format === "json") {
      const parsedRows = parseJsonRows(raw);
      const detectedColumns = Array.from(
        new Set(
          parsedRows.flatMap((row) =>
            !row.error && row.raw && typeof row.raw === "object" && !Array.isArray(row.raw)
              ? Object.keys(row.raw)
              : []
          )
        )
      );

      return {
        detectedColumns,
        schemaFingerprint: createSchemaFingerprint(source.format, detectedColumns),
        rows: parsedRows.map((row, index) => {
          if (row.error) {
            return {
              candidate: null,
              raw: row.raw,
              error: row.error
            };
          }

          try {
            const rawRecord = row.raw as Record<string, unknown>;
            const mapped = applyMapping(rawRecord, mapping);
            const candidate = buildCandidate(rawRecord, mapped, source, `row-${index + 1}`, mapping);
            return { candidate, raw: rawRecord };
          } catch (error) {
            return {
              candidate: null,
              raw: row.raw,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        })
      };
    }

    const parsed = parseCsvTable(raw);
    return {
      detectedColumns: parsed.detectedColumns,
      schemaFingerprint: createSchemaFingerprint(source.format, parsed.detectedColumns),
      rows: parsed.rows.map((row, index) => {
        if (row.error) {
          return {
            candidate: null,
            raw: null,
            error: `Row ${index + 2}: ${row.error}`
          };
        }

        const record = parsed.detectedColumns.reduce<Record<string, unknown>>((accumulator, column, columnIndex) => {
          accumulator[column] = row.cells?.[columnIndex] ?? "";
          return accumulator;
        }, {});

        try {
          const mapped = applyMapping(record, mapping);
          const candidate = buildCandidate(record, mapped, source, `row-${index + 1}`, mapping);
          return { candidate, raw: record };
        } catch (error) {
          return {
            candidate: null,
            raw: record,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    };
  }
}
