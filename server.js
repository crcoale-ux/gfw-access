import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

const port = Number(process.env.PORT || 3000);

const upstream =
  process.env.GFW_UPSTREAM ||
  "https://global-fishing-watch-production.up.railway.app/mcp";

const token = process.env.GFW_TOKEN;

if (!token) {
  console.error("GFW_TOKEN is required");
  process.exit(1);
}

const proxyKey = process.env.PROXY_KEY;

if (!proxyKey) {
  console.error("PROXY_KEY is required");
  process.exit(1);
}

const sha256 = (value) => createHash("sha256").update(value).digest();

const proxyKeyHash = sha256(`Bearer ${proxyKey}`);

// Constant-time comparison of the caller's Authorization header.
function isAuthorized(req) {
  return timingSafeEqual(
    sha256(req.headers.authorization || ""),
    proxyKeyHash
  );
}

const server = http.createServer(async (req, res) => {
  // Railway / external health check
  if (req.url === "/health") {
    res.writeHead(200, {
      "content-type": "application/json"
    });

    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Only expose the MCP endpoint
  if (!req.url?.startsWith("/mcp")) {
    res.writeHead(404, {
      "content-type": "application/json"
    });

    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": "Bearer"
    });

    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  try {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks);

    /*
     * Forward MCP headers while deliberately removing:
     * - the client's Authorization header
     * - hop-by-hop headers
     * - content-length, which fetch will calculate
     */
    const headers = {};

    for (const [key, value] of Object.entries(req.headers)) {
      if (
        value !== undefined &&
        ![
          "host",
          "authorization",
          "content-length",
          "connection",
          "transfer-encoding"
        ].includes(key.toLowerCase())
      ) {
        headers[key] = Array.isArray(value)
          ? value.join(", ")
          : value;
      }
    }

    // Inject the Global Fishing Watch credential server-side.
    headers.authorization = `Bearer ${token}`;

    const url = new URL(upstream);

    // Preserve query parameters.
    const queryIndex = req.url.indexOf("?");

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
      error instanceof Error ? error.message : "Unknown error"
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
