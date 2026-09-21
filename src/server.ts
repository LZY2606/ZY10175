import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDatabase, exportBundle } from "./db.ts";
import {
  firstPackageId,
  listRuleVersions,
  loadCoupons,
  loadPackage,
  loadRuleVersion,
  loadSpecs,
  replaceCoupons,
  replaceSpecs,
  upsertRulePackage,
} from "./store.ts";
import { evaluate, compareVersions } from "./engine.ts";
import { replayFixtures, seedIfEmpty } from "./fixture.ts";
import { digestPackage } from "./digest.ts";
import { clearAllData } from "./store.ts";
import type { CouponInput, ProductionSpec, RulePackage } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "web");

function parseCliArgs(): { host: string; port: number } {
  const args = process.argv.slice(2);
  let host = process.env.WWS_HOST ?? "127.0.0.1";
  let port = Number(process.env.WWS_PORT ?? "5515");
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--host" && next !== undefined) {
      host = next;
      i += 1;
    } else if (arg?.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    } else if (arg === "--port" && next !== undefined) {
      port = Number(next);
      i += 1;
    } else if (arg?.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    }
  }
  return { host, port };
}

const { host: HOST, port: PORT } = parseCliArgs();
const db = getDatabase();

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw.length === 0 ? null : (JSON.parse(raw) as unknown);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

function requirePackage(): { pkg: RulePackage; packageId: string } {
  const packageId = firstPackageId(db);
  if (!packageId) {
    throw Object.assign(new Error("规则包尚未导入，请先执行重放或导入"), { statusCode: 409 });
  }
  const pkg = loadPackage(db, packageId);
  if (!pkg) {
    throw Object.assign(new Error("规则包缺失"), { statusCode: 409 });
  }
  return { pkg, packageId };
}

async function handleApi(req: IncomingMessage, url: URL): Promise<unknown> {
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (method === "GET" && path === "/api/health") {
    return { ok: true, service: "焊程见证台" };
  }

  if (method === "GET" && path === "/api/packages/current") {
    const { pkg, packageId } = requirePackage();
    return {
      packageId,
      digest: digestPackage(pkg),
      description: pkg.description,
      unitRegistry: pkg.unitRegistry,
      versions: listRuleVersions(db, packageId).map((v) => ({
        version: v.version,
        label: v.label,
        publishedAt: v.publishedAt,
        digest: v.digest,
        versionDigest: v.versionDigest,
        changelog: pkg.versions.find((candidate) => candidate.version === v.version)?.changelog ?? [],
      })),
    };
  }

  if (method === "GET" && path === "/api/versions") {
    const { pkg } = requirePackage();
    return pkg.versions;
  }

  if (method === "GET" && path === "/api/coupons") {
    return loadCoupons(db);
  }

  if (method === "GET" && path === "/api/specs") {
    return loadSpecs(db);
  }

  if (method === "GET" && path === "/api/runs") {
    return db
      .prepare(
        `SELECT id, package_id AS packageId, version, digest, spec_name AS specName,
                conclusion, created_at AS createdAt
         FROM evaluation_runs ORDER BY id DESC`,
      )
      .all();
  }

  if (method === "GET" && path.startsWith("/api/runs/")) {
    const id = Number(path.split("/").pop());
    const row = db
      .prepare(
        `SELECT id, package_id AS packageId, version, digest, spec_name AS specName,
                spec_json AS specJson, result_json AS resultJson, conclusion, created_at AS createdAt
         FROM evaluation_runs WHERE id = ?`,
      )
      .get(id);
    if (!row) {
      throw Object.assign(new Error("运行记录不存在"), { statusCode: 404 });
    }
    return {
      ...row,
      specJson: undefined,
      resultJson: undefined,
      spec: JSON.parse(row.specJson as string),
      result: JSON.parse(row.resultJson as string),
    };
  }

  if (method === "GET" && path === "/api/export") {
    return exportBundle(db);
  }

  if (method === "POST" && path === "/api/evaluate") {
    const body = (await readJson(req)) as { version: string; spec: ProductionSpec | { id: number } };
    const { pkg, packageId } = requirePackage();
    const rule = loadRuleVersion(db, packageId, body.version);
    if (!rule) {
      throw Object.assign(new Error(`未知规则版本: ${body.version}`), { statusCode: 404 });
    }
    let spec: ProductionSpec;
    if (body.spec && typeof body.spec === "object" && "id" in body.spec) {
      const found = loadSpecs(db).find((candidate) => candidate.id === (body.spec as { id: number }).id);
      if (!found) {
        throw Object.assign(new Error("生产工艺不存在"), { statusCode: 404 });
      }
      spec = { name: found.name, variables: found.variables };
    } else {
      spec = body.spec as ProductionSpec;
    }
    const coupons = loadCoupons(db) as CouponInput[];
    const result = evaluate({ pkg, rule, spec, coupons });
    db.prepare(
      `INSERT INTO evaluation_runs
         (package_id, version, digest, spec_name, spec_json, result_json, conclusion)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      result.packageId,
      result.version,
      result.packageDigest,
      spec.name ?? null,
      JSON.stringify(spec),
      JSON.stringify(result),
      result.conclusion,
    );
    return result;
  }

  if (method === "GET" && path === "/api/compare") {
    const fromVersion = url.searchParams.get("from");
    const toVersion = url.searchParams.get("to");
    if (!fromVersion || !toVersion) {
      throw Object.assign(new Error("需要 from 与 to 查询参数"), { statusCode: 400 });
    }
    const { pkg, packageId } = requirePackage();
    const from = loadRuleVersion(db, packageId, fromVersion);
    const to = loadRuleVersion(db, packageId, toVersion);
    if (!from || !to) {
      throw Object.assign(new Error("规则版本不存在"), { statusCode: 404 });
    }
    return {
      from: { version: from.version, label: from.label, stitching: from.stitching, requiredMechanical: from.requiredMechanical, changelog: from.changelog },
      to: { version: to.version, label: to.label, stitching: to.stitching, requiredMechanical: to.requiredMechanical, changelog: to.changelog },
      packageDigest: digestPackage(pkg),
      changes: compareVersions(from, to, { thickness: 10, heatInput: 1, diameter: 200 }),
    };
  }

  if (method === "POST" && path === "/api/import") {
    const body = (await readJson(req)) as {
      rulePackages?: Array<{ content: RulePackage }>;
      coupons?: CouponInput[];
      productionSpecs?: ProductionSpec[];
      evaluationRuns?: Array<Record<string, unknown>>;
    };
    if (body.rulePackages) {
      for (const entry of body.rulePackages) {
        upsertRulePackage(db, entry.content);
      }
    }
    if (body.coupons) {
      replaceCoupons(db, body.coupons);
    }
    if (body.productionSpecs) {
      replaceSpecs(db, body.productionSpecs);
    }
    if (body.evaluationRuns) {
      const insert = db.prepare(
        `INSERT INTO evaluation_runs
           (package_id, version, digest, spec_name, spec_json, result_json, conclusion, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const run of body.evaluationRuns) {
        insert.run(
          (run.packageId ?? run.package_id) as string,
          run.version as string,
          run.digest as string,
          (run.specName ?? run.spec_name ?? null) as string | null,
          (run.specJson ?? run.spec_json ?? "{}") as string,
          (run.resultJson ?? run.result_json ?? "{}") as string,
          run.conclusion as string,
          (run.createdAt ?? run.created_at ?? new Date().toISOString()) as string,
        );
      }
    }
    return { ok: true };
  }

  if (method === "POST" && path === "/api/replay") {
    clearAllData(db);
    await replayFixtures(db);
    return { ok: true, replayedAt: new Date().toISOString() };
  }

  throw Object.assign(new Error("未知接口"), { statusCode: 404 });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      send(res, 200, await handleApi(req, url));
      return;
    }
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const safe = join(webRoot, requested);
    if (!safe.startsWith(webRoot)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const data = await readFile(safe);
    const ext = requested.slice(requested.lastIndexOf("."));
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
    send(res, statusCode, { error: (error as Error).message });
  }
});

await seedIfEmpty(db).then((seeded) => {
  if (seeded) {
    console.log("数据库为空，已从 fixtures/ 重放固定数据");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`焊程见证台 已启动: http://${HOST}:${PORT}`);
});
