import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";

const HOST = "127.0.0.1";
const PORT = 5599;
let server: ChildProcess | null = null;

export async function cleanupServer(): Promise<void> {
  if (server) {
    server.kill();
    await new Promise((resolve) => setTimeout(resolve, 100));
    server = null;
  }
}
(globalThis as { __cleanupServer?: () => Promise<void> }).__cleanupServer = cleanupServer;

function waitForServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const tick = (): void => {
      const req = request({ host: HOST, port: PORT, path: "/api/health", method: "GET" }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error("服务器未在超时内启动"));
        } else {
          setTimeout(tick, 150);
        }
      });
      req.end();
    };
    tick();
  });
}

function call(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve({ status: res.statusCode ?? 0, data: raw ? JSON.parse(raw) : null });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("HTTP 服务接口", () => {
  it("启动后健康检查、自动播种并返回规则包", async () => {
    process.env.WWS_PORT = String(PORT);
    process.env.WWS_DB_PATH = ":memory:";
    server = spawn(process.execPath, ["src/server.ts"], {
      env: { ...process.env, WWS_PORT: String(PORT), WWS_DB_PATH: ":memory:" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      if (!text.includes("ExperimentalWarning") && !text.includes("node:sqlite")) {
        process.stderr.write(chunk);
      }
    });
    await waitForServer();

    const health = await call("/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.data.service, "焊程见证台");

    const packages = await call("/api/packages/current");
    assert.equal(packages.status, 200);
    assert.equal(packages.data.packageId, "wws-welding-pqr");
    assert.equal(packages.data.versions.length, 2);
  });

  it("端到端评估：P1 在 2025 覆盖、2024 拒绝，且运行记录入库可导出", async () => {
    await waitForServer();
    const specs = (await call("/api/specs")).data as Array<{ id: number; name: string }>;
    const p1 = specs.find((spec) => spec.name.includes("P1"));
    assert.ok(p1);

    const covered = await call("/api/evaluate", "POST", { version: "2025.0", spec: { id: p1!.id } });
    assert.equal(covered.status, 200);
    assert.equal(covered.data.conclusion, "COVERED");
    assert.equal(covered.data.packageId, "wws-welding-pqr");

    const rejected = await call("/api/evaluate", "POST", { version: "2024.1", spec: { id: p1!.id } });
    assert.equal(rejected.data.conclusion, "NOT_COVERED");
    assert.ok(rejected.data.rejectionReasons.some((reason: string) => reason.includes("禁止跨试件拼接")));

    const runs = await call("/api/runs");
    assert.ok(runs.data.length >= 2);
    const exported = await call("/api/export");
    assert.equal(exported.data.rulePackages.length, 1);
    assert.ok(exported.data.evaluationRuns.length >= 2);
  });

  it("重放接口清空并重建数据", async () => {
    await waitForServer();
    const replayed = await call("/api/replay", "POST", {});
    assert.equal(replayed.status, 200);
    const runs = await call("/api/runs");
    assert.equal(runs.data.length, 0, "重放后运行记录应清空");
    const coupons = await call("/api/coupons");
    assert.equal(coupons.data.length, 7);
  });

  it("首页返回含标题的 HTML", async () => {
    await waitForServer();
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      request({ host: HOST, port: PORT, path: "/", method: "GET" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
      }).on("error", reject).end();
    });
    assert.equal(result.status, 200);
    assert.ok(result.body.includes("焊程见证台"));
  });
});

process.on("exit", () => {
  server?.kill();
});
