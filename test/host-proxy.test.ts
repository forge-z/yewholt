import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const script = fileURLToPath(new URL("../../scripts/host-proxy.mjs", import.meta.url));

test("host proxy requires an explicit public relay host", () => {
  const env = { ...process.env };
  delete env.YEWHOLT_PUBLIC_HOST;
  const result = spawnSync(process.execPath, [script], { env, encoding: "utf8", timeout: 3000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /YEWHOLT_PUBLIC_HOST is required/);
});

test("host proxy rewrites Host for HTTP and WebSocket traffic", { timeout: 5000 }, async () => {
  const upstream = createServer((req, res) => res.end(`${req.headers.host} ${req.url}`));
  const ws = new WebSocketServer({ server: upstream });
  ws.on("connection", (peer, req) => {
    peer.on("message", (data) => peer.send(`${req.headers.host} ${req.url} ${data}`));
  });
  const host = "relay.example.test";
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  upstream.listen(0, "127.0.0.1");
  await Promise.all([once(reservation, "listening"), once(upstream, "listening")]);
  const listenPort = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const proxy = spawn(process.execPath, [script], {
    env: {
      ...process.env, YEWHOLT_PROXY_LISTEN: String(listenPort),
      YEWHOLT_PROXY_TARGET: String((upstream.address() as AddressInfo).port), YEWHOLT_PUBLIC_HOST: host,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(proxy, "exit");
  let client: WebSocket | undefined;
  try {
    await Promise.race([
      once(proxy.stdout, "data"),
      exited.then(([code]) => assert.fail(`host proxy exited before listening: ${code}`)),
    ]);
    const response = await fetch(`http://127.0.0.1:${listenPort}/_liveness`);
    assert.equal(await response.text(), `${host} /_liveness`);
    client = new WebSocket(`ws://127.0.0.1:${listenPort}/socket?test=1`);
    await once(client, "open");
    const reply = once(client, "message");
    client.send("ping");
    assert.equal(String((await reply)[0]), `${host} /socket?test=1 ping`);
  } finally {
    client?.terminate();
    proxy.kill();
    await exited;
    for (const peer of ws.clients) peer.terminate();
    ws.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
