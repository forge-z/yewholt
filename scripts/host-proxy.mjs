import http from "node:http";
import net from "node:net";

const listenPort = Number(process.env.YEWHOLT_PROXY_LISTEN || 3000);
const targetPort = Number(process.env.YEWHOLT_PROXY_TARGET || 3001);
const publicHost = process.env.YEWHOLT_PUBLIC_HOST?.trim();
if (!publicHost) {
  console.error("YEWHOLT_PUBLIC_HOST is required (set it to the public relay host, without a scheme).");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: publicHost };
  const upstream = http.request({ hostname: "127.0.0.1", port: targetPort, path: req.url, method: req.method, headers }, (incoming) => {
    res.writeHead(incoming.statusCode || 502, incoming.headers);
    incoming.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  const dst = net.connect(targetPort, "127.0.0.1", () => {
    const headers = { ...req.headers, host: publicHost };
    const block = Object.entries(headers)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join("\r\n");
    dst.write(`${req.method} ${req.url} HTTP/1.1\r\n${block}\r\n\r\n`);
    if (head.length) dst.write(head);
    dst.pipe(socket);
    socket.pipe(dst);
  });
  dst.on("error", () => socket.destroy());
  socket.on("error", () => dst.destroy());
});

server.listen(listenPort, "0.0.0.0", () => {
  console.log(`host-proxy listening on :${listenPort} -> 127.0.0.1:${targetPort} Host=${publicHost}`);
});
