import http from "node:http";

const port = Number(process.env.PORT || 3000);

const upstream =
  process.env.GFW_UPSTREAM ||
  "https://global-fishing-watch-production.up.railway.app/mcp";

const token = process.env.GFW_TOKEN;
const accessPath = process.env.ACCESS_PATH;

if (!token) {
  console.error("GFW_TOKEN is required");
  process.exit(1);
}

if (!accessPath) {
  console.error("ACCESS_PATH is required");
  process.exit(1);
}

const normalizedPath = accessPath.startsWith("/")
  ? accessPath
  : `/${accessPath}`;

const server = http.createServer(async (req, res) => {
  // Railway health check — contains no credentials.
  if (req.url === "/health") {
    res.writeHead(200, {
      "content-type": "application/json"
    });

    res.end(JSON.stringify({ ok: true }));
    return;
  }

  /*
   * Only the secret MCP path is accepted.
   * Requests to /mcp or other paths receive 404.
   */
  const requestPath = (req.url || "").split("?")[0];

  if (requestPath !== normalizedPath) {
    res.writeHead(404, {
      "content-type": "application/json"
    });

    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  try {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks);

    const headers = {};

    for (const [key, value] of Object.entries(req.headers)) {
      const lowerKey = key.toLowerCase();

      if (
        value !== undefined &&
        ![
          "host",
          "authorization",
          "content-length",
          "connection",
          "transfer-encoding"
        ].includes(lowerKey)
      ) {
        headers[key] = Array.isArray(value)
          ? value.join(", ")
          : value;
      }
    }

    /*
     * The caller never sees this credential.
     * Railway injects GFW_TOKEN at runtime.
     */
    headers.authorization = `Bearer ${token}`;

    const url = new URL(upstream);

    // Preserve any MCP query parameters.
    const queryIndex = (req.url || "").indexOf("?");

    if (queryIndex !== -1) {
      url.search = req.url.slice(queryIndex);
    }

    const method = req.method || "POST";

    const upstreamResponse = await fetch(url, {
      method,
      headers,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : body,
      redirect: "manual"
    });

    const responseHeaders = {};

    upstreamResponse.headers.forEach((value, key) => {
      if (
        ![
          "content-encoding",
          "transfer-encoding",
          "connection",
          "content-length"
        ].includes(key.toLowerCase())
      ) {
        responseHeaders[key] = value;
      }
    });

    res.writeHead(
      upstreamResponse.status,
      responseHeaders
    );

    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        res.write(chunk);
      }
    }

    res.end();
  } catch (error) {
    console.error(
      "GFW proxy error:",
      error instanceof Error
        ? error.message
        : "Unknown error"
    );

    if (!res.headersSent) {
      res.writeHead(502, {
        "content-type": "application/json"
      });
    }

    res.end(
      JSON.stringify({
        error: "Upstream MCP service unavailable"
      })
    );
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`gfw-access listening on port ${port}`);
});
