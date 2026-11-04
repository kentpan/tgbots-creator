import { createServer, type Server } from "node:http";
import { verifyCodeExternally } from "@/services/external-verify";
import { loadDotEnv } from "@/lib/dotenv";

loadDotEnv();

function startMockServer(): Promise<{ server: Server; port: number; seen: { auth?: string; body?: string } }> {
  const seen: { auth?: string; body?: string } = {};
  const server = createServer((req, res) => {
    seen.auth = req.headers.authorization;
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.body = body;
      const payload = JSON.parse(body || "{}") as { code?: string };
      if (payload.code === "GOOD-CODE") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ valid: true, user: payload }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ valid: false }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port, seen });
    });
  });
}

async function main(): Promise<void> {
  const { server, port, seen } = await startMockServer();

  const config = {
    url: `http://127.0.0.1:${port}/verify`,
    api_key: "sk-test-123",
    http_method: "POST",
    body_template: '{"user_id":{{user_id}},"code":"{{code}}"}',
    success_status: 200,
    success_field: "valid",
    success_value: "true",
    timeout_seconds: 5,
  };

  const good = await verifyCodeExternally(config, {
    userId: 42n,
    username: "alice",
    code: "GOOD-CODE",
  });
  const bad = await verifyCodeExternally(config, {
    userId: 42n,
    username: "alice",
    code: "WRONG-CODE",
  });

  console.log("good result:", good);
  console.log("bad result:", bad);
  console.log("bearer header seen:", seen.auth);
  console.log("body seen:", seen.body);

  server.close();

  if (!good.ok) throw new Error("expected GOOD-CODE to pass");
  if (bad.ok) throw new Error("expected WRONG-CODE to fail");
  if (seen.auth !== "Bearer sk-test-123") throw new Error("Bearer header missing");
  if (!seen.body?.includes("42") || !seen.body?.includes("WRONG-CODE")) {
    throw new Error(`template rendering failed, body: ${seen.body}`);
  }
  console.log("EXTERNAL VERIFY SERVICE TEST PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
