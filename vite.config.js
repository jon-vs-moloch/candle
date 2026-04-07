import fs from "node:fs/promises";
import path from "node:path";
import { defineConfig } from "vite";

function debugStatePlugin() {
  const debugDir = path.resolve(process.cwd(), ".candle-debug");
  const debugFile = path.join(debugDir, "state.json");
  const debugEventsFile = path.join(debugDir, "events.jsonl");

  async function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  return {
    name: "candle-debug-state",
    configureServer(server) {
      server.middlewares.use("/api/debug-state", async (req, res) => {
        try {
          if (req.method === "POST") {
            const body = await readBody(req);
            await fs.mkdir(debugDir, { recursive: true });
            await fs.writeFile(debugFile, body || "{}", "utf8");
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, path: debugFile }));
            return;
          }

          if (req.method === "GET") {
            const content = await fs.readFile(debugFile, "utf8").catch(() => "{}");
            res.setHeader("Content-Type", "application/json");
            res.end(content);
            return;
          }

          res.statusCode = 405;
          res.end("Method Not Allowed");
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
      });

      server.middlewares.use("/api/debug-event", async (req, res) => {
        try {
          if (req.method === "POST") {
            const body = await readBody(req);
            const payload = body || "{}";
            await fs.mkdir(debugDir, { recursive: true });
            await fs.appendFile(debugEventsFile, `${payload}\n`, "utf8");
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, path: debugEventsFile }));
            return;
          }

          if (req.method === "GET") {
            const content = await fs.readFile(debugEventsFile, "utf8").catch(() => "");
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ok: true,
                events: content
                  .split("\n")
                  .filter(Boolean)
                  .slice(-300)
                  .map((line) => {
                    try {
                      return JSON.parse(line);
                    } catch {
                      return { type: "parse_error", raw: line };
                    }
                  })
              })
            );
            return;
          }

          if (req.method === "DELETE") {
            await fs.rm(debugEventsFile, { force: true });
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, path: debugEventsFile, cleared: true }));
            return;
          }

          res.statusCode = 405;
          res.end("Method Not Allowed");
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [debugStatePlugin()],
  server: {
    host: "0.0.0.0",
    port: 5173
  }
});
