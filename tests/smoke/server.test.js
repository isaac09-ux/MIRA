/**
 * @jest-environment node
 *
 * Smoke E2E: arranca `next start` contra el build de producción, hace un
 * request real a /, y valida que el servidor responde con la página
 * esperada (header MIRA, dropzone, bundle JS referenciado).
 *
 * No es un test de UI completo (este sandbox no permite descargar Chromium
 * de Playwright — el host está bloqueado), pero sí es un E2E real de
 * sistema: el binario de Next arranca, sirve un build de producción, y
 * el HTML enviado contiene lo que la primera pantalla debe mostrar.
 */
const { spawn } = require("child_process");
const path = require("path");

const PORT = 3100;
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, "../..");

let server;

async function waitFor(url, timeoutMs = 30000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return r;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Server no respondió en ${timeoutMs}ms: ${lastErr?.message || "(sin error)"}`
  );
}

beforeAll(async () => {
  server = spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
  });
  // Drenar stdout/stderr para que el buffer no se llene
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  await waitFor(URL);
}, 40000);

afterAll(async () => {
  if (server && !server.killed) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    const timed = new Promise((r) => setTimeout(r, 1500));
    await Promise.race([exited, timed]);
    if (!server.killed) server.kill("SIGKILL");
    server.stdout?.destroy();
    server.stderr?.destroy();
  }
});

describe("smoke E2E: next start sirve la página principal", () => {
  test("/ responde 200 con HTML que contiene la marca MIRA y el dropzone", async () => {
    const res = await fetch(URL + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toMatch(/MIRA/);
    expect(html).toMatch(/Calibrador de cancha/);
    expect(html).toMatch(/Carga un frame del video/);
    expect(html).toMatch(/Cercana izquierda/);
    // Botón de exportar debe venir disabled (sin esquinas marcadas)
    expect(html).toMatch(/Exportar cal\.json/);
  });

  test("la respuesta referencia los bundles JS de Next y son accesibles", async () => {
    const html = await fetch(URL + "/").then((r) => r.text());
    // Next inyecta script tags con /_next/static/chunks/*.js
    const scripts = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map(
      (m) => m[1]
    );
    expect(scripts.length).toBeGreaterThan(0);
    // Probar que al menos uno baja con 200
    const res = await fetch(URL + scripts[0]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
  });

  test("una ruta inexistente devuelve 404", async () => {
    const res = await fetch(URL + "/ruta-que-no-existe");
    expect(res.status).toBe(404);
  });
});
