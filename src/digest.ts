import { createHash } from "node:crypto";
import type { RulePackage, RuleVersion } from "./types.ts";

/**
 * 固定规则包摘要：对规范化（键排序、无多余空白）JSON 计算 SHA-256。
 * 结论必须携带规则包摘要，保证同一份输入在任何机器上复算出同一结论。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function digestPackage(pkg: RulePackage): string {
  return sha256Hex({
    packageId: pkg.packageId,
    formatVersion: pkg.formatVersion,
    unitRegistry: pkg.unitRegistry,
    versions: pkg.versions.map((v) => v.version).sort(),
  });
}

export function digestVersion(version: RuleVersion): string {
  return sha256Hex({
    packageId: version.packageId,
    version: version.version,
    requiredVariables: version.requiredVariables,
    variables: version.variables,
    requiredMechanical: version.requiredMechanical,
    jointGroups: version.jointGroups,
    stitching: version.stitching,
    recordPolicy: version.recordPolicy,
  });
}
