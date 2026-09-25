import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WitnessDb } from "./db.js";
import { importFixtures } from "./fixtures.js";
import { checkCoverage } from "../shared/coverage.js";
import { qualifiedInterval, ruleDigest } from "../shared/rules.js";
import type { ProductionProcess, RulePackage } from "../shared/types.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const WEB_DIR = join(ROOT, "src/web");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function intervalsFor(rule: RulePackage, records: ReturnType<WitnessDb["listRecords"]>, asOf: string) {
  const usable = records.filter((r) => r.status === "valid" && (!r.validUntil || r.validUntil >= asOf));
  const out: { variable: string; label: string; unit?: string; pieces: { recordId: string; pieceId: string; measured: number; interval: unknown }[] }[] = [];
  for (const v of rule.variables) {
    if (v.kind !== "number") continue;
    const pieces = [];
    for (const rec of usable) {
      for (const piece of rec.pieces) {
        const pv = piece.values[v.key];
        if (!pv || typeof pv.measured !== "number" || !pv.unit || (v.unit && pv.unit !== v.unit)) continue;
        const nominal = typeof pv.nominal === "number" ? pv.nominal : undefined;
        pieces.push({
          recordId: rec.id,
          pieceId: piece.id,
          measured: pv.measured,
          interval: qualifiedInterval(v, pv.measured, nominal),
        });
      }
    }
    out.push({ variable: v.key, label: v.label, unit: v.unit, pieces });
  }
  return out;
}

export function buildServer(db: WitnessDb): Server {
  const resolveProduction = (body: Record<string, unknown>): ProductionProcess | null => {
    if (body.production && typeof body.production === "object") return body.production as ProductionProcess;
    return db.getProduction();
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/api/state") {
        const rules = db.listRules().map(({ rule, digest }) => ({
          version: rule.version, issuedAt: rule.issuedAt, digest,
          splice: rule.splice, jointGroups: rule.jointGroups,
          variables: rule.variables.map((v) => ({ key: v.key, label: v.label, kind: v.kind, unit: v.unit, required: v.required })),
        }));
        return send(res, 200, {
          rules,
          records: db.listRecords(),
          production: db.getProduction(),
          runs: db.listRuns(50),
        });
      }

      if (req.method === "GET" && path === "/api/intervals") {
        const version = url.searchParams.get("version") ?? "";
        const asOf = url.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);
        const entry = db.getRule(version);
        if (!entry) return send(res, 404, { error: `规则版本不存在: ${version}` });
        return send(res, 200, { version, digest: entry.digest, variables: intervalsFor(entry.rule, db.listRecords(), asOf) });
      }

      if (req.method === "POST" && path === "/api/check") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const version = String(body.ruleVersion ?? "");
        const asOf = String(body.asOf ?? new Date().toISOString().slice(0, 10));
        const entry = db.getRule(version);
        if (!entry) return send(res, 404, { error: `规则版本不存在: ${version}` });
        const production = resolveProduction(body);
        if (!production) return send(res, 400, { error: "缺少生产工艺" });
        const result = checkCoverage(entry.rule, db.listRecords(), production, asOf);
        const runId = db.logRun("check", version, result.ruleDigest, { production, asOf }, result);
        return send(res, 200, { runId, ...result });
      }

      if (req.method === "POST" && path === "/api/compare") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const versions = body.versions as string[];
        if (!Array.isArray(versions) || versions.length !== 2) return send(res, 400, { error: "需要两个规则版本" });
        const asOf = String(body.asOf ?? new Date().toISOString().slice(0, 10));
        const production = resolveProduction(body);
        if (!production) return send(res, 400, { error: "缺少生产工艺" });
        const [ea, eb] = versions.map((v) => db.getRule(String(v)));
        if (!ea || !eb) return send(res, 404, { error: "规则版本不存在" });
        const records = db.listRecords();
        const a = checkCoverage(ea.rule, records, production, asOf);
        const b = checkCoverage(eb.rule, records, production, asOf);
        const diff = a.variables.map((va) => {
          const vb = b.variables.find((x) => x.key === va.key)!;
          const aInterval = va.evidence[0]?.interval ?? va.gap?.nearest?.interval ?? null;
          const bInterval = vb.evidence[0]?.interval ?? vb.gap?.nearest?.interval ?? null;
          return {
            key: va.key, label: va.label,
            aCovered: va.covered, bCovered: vb.covered,
            changed: va.covered !== vb.covered || JSON.stringify(aInterval) !== JSON.stringify(bInterval),
            aInterval,
            bInterval,
          };
        });
        const result = { a, b, diff };
        const runId = db.logRun("compare", versions.join(" vs "), `${a.ruleDigest}|${b.ruleDigest}`, { production, asOf, versions }, result);
        return send(res, 200, { runId, ...result });
      }

      if (req.method === "POST" && path === "/api/reset") {
        importFixtures(db, ROOT);
        return send(res, 200, { ok: true, rules: db.listRules().length, records: db.listRecords().length });
      }

      if (req.method === "GET" && path === "/api/export") {
        const payload = JSON.stringify({ exportedAt: new Date().toISOString(), runs: db.listRuns(10000) }, null, 2);
        return send(res, 200, payload, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": "attachment; filename=witness-runs.json",
        });
      }

      if (req.method === "GET") {
        const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
        const file = join(WEB_DIR, rel);
        if (file.startsWith(WEB_DIR) && existsSync(file)) {
          res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
          return res.end(readFileSync(file));
        }
      }

      return send(res, 404, { error: "not found" });
    } catch (err) {
      return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const isMain = process.argv[1] && resolve(process.argv[1]).includes("main");
if (isMain) {
  const host = argValue(process.argv, "--host") ?? "127.0.0.1";
  const port = Number(argValue(process.argv, "--port") ?? "5515");
  const db = new WitnessDb(join(ROOT, "data", "witness.db"));
  if (db.isEmpty()) importFixtures(db, ROOT);
  const server = buildServer(db);
  server.listen(port, host, () => {
    console.log(`焊程见证台 listening on http://${host}:${port}`);
    console.log(`规则包摘要: ${db.listRules().map((r) => `${r.rule.version}=${r.digest.slice(0, 12)}`).join(", ")}`);
  });
}
