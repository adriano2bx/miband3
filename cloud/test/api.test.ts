import { describe, expect, it } from "vitest";
import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { ADMIN, call, newDevice, openSocket } from "./helpers";

const now = () => Date.now();

describe("autenticação e permissões", () => {
  it("rejeita requisições sem token e com token errado", async () => {
    expect((await call("GET", "/v1/devices", { token: "nada" })).status).toBe(401);
    expect((await SELF.fetch("https://cloud.test/v1/devices")).status).toBe(401);
  });

  it("chave só-leitura não pode comandar nem gerenciar", async () => {
    const { id } = await newDevice("A");
    const key = (await call("POST", "/v1/api-keys", { body: { name: "leitor", scopes: ["read"] } })).json.api_key;
    expect((await call("GET", `/v1/devices/${id}`, { token: key })).status).toBe(200);
    expect((await call("POST", `/v1/devices/${id}/vibrate`, { token: key, body: {} })).status).toBe(403);
    expect((await call("POST", "/v1/devices", { token: key, body: { name: "x" } })).status).toBe(403);
    expect((await call("GET", "/v1/api-keys", { token: key })).status).toBe(403);
  });

  it("chave restrita a pulseiras enxerga apenas as suas", async () => {
    const a = await newDevice("Mine");
    const b = await newDevice("Other");
    const key = (await call("POST", "/v1/api-keys", { body: { name: "restrita", scopes: ["read", "command"], device_ids: [a.id] } })).json.api_key;
    expect((await call("GET", `/v1/devices/${a.id}`, { token: key })).status).toBe(200);
    expect((await call("GET", `/v1/devices/${b.id}`, { token: key })).status).toBe(403);
    const list = await call("GET", "/v1/devices", { token: key });
    expect(list.json.data.map((d: any) => d.id)).toEqual([a.id]);
    expect((await call("POST", `/v1/devices/${b.id}/vibrate`, { token: key, body: {} })).status).toBe(403);
  });

  it("chave revogada deixa de funcionar", async () => {
    const created = (await call("POST", "/v1/api-keys", { body: { name: "tmp", scopes: ["read"] } })).json;
    expect((await call("GET", "/v1/me", { token: created.api_key })).status).toBe(200);
    await call("DELETE", `/v1/api-keys/${created.id}`);
    expect((await call("GET", "/v1/me", { token: created.api_key })).status).toBe(401);
  });

  it("token de dispositivo inválido não conecta", async () => {
    expect((await SELF.fetch("https://cloud.test/v1/connect", { headers: { upgrade: "websocket" } })).status).toBe(401);
    expect((await SELF.fetch("https://cloud.test/v1/connect", { headers: { upgrade: "websocket", authorization: "Bearer mbd_falso" } })).status).toBe(401);
  });
});

describe("tempo real: app -> nuvem -> visores", () => {
  it("dados do app chegam ao visor e ficam gravados", async () => {
    const { id, token } = await newDevice("Tempo real");
    const app = await openSocket("/v1/connect", token);
    await app.waitFor((m) => m.t === "welcome");

    const viewer = await openSocket(`/v1/devices/${id}/stream`, ADMIN);
    const snap = await viewer.waitFor((m) => m.t === "snapshot");
    expect(snap.online).toBe(true);

    const t = now();
    app.send({ t: "hello", client: { app: "miband3", version: "2" }, band: { name: "Mi Smart Band 3", firmware: "1.2.3" } });
    app.send({ t: "hr", ts: t, bpm: 72 });
    app.send({ t: "batch", items: [
      { t: "steps", ts: t, steps: 1234, meters: 900, calories: 50 },
      { t: "battery", ts: t, level: 80, charging: false },
      { t: "event", ts: t, type: "BUTTON_PRESSED" },
    ] });

    const hr = await viewer.waitFor((m) => m.t === "hr");
    expect(hr).toMatchObject({ bpm: 72, device_id: id });
    await viewer.waitFor((m) => m.t === "battery");
    await viewer.waitFor((m) => m.t === "event");

    const hrs = await call("GET", `/v1/devices/${id}/heart-rate`);
    expect(hrs.json.data).toEqual([{ ts: t, bpm: 72 }]);
    expect((await call("GET", `/v1/devices/${id}/steps`)).json.data[0].steps).toBe(1234);
    expect((await call("GET", `/v1/devices/${id}/events`)).json.data[0].type).toBe("BUTTON_PRESSED");

    const status = await call("GET", `/v1/devices/${id}/status`);
    expect(status.json).toMatchObject({ online: true, latest: { hr: { bpm: 72 }, battery: { level: 80 } }, band: { firmware: "1.2.3" } });
    app.close(); viewer.close();
  });

  it("filtra tipos assinados pelo visor", async () => {
    const { id, token } = await newDevice("Filtro");
    const app = await openSocket("/v1/connect", token);
    await app.waitFor((m) => m.t === "welcome");
    const viewer = await openSocket(`/v1/devices/${id}/stream`, ADMIN);
    await viewer.waitFor((m) => m.t === "snapshot");
    viewer.send({ t: "subscribe", types: ["battery"] });
    await viewer.waitFor((m) => m.t === "subscribed");
    app.send({ t: "hr", ts: now(), bpm: 80 });
    app.send({ t: "battery", ts: now(), level: 50, charging: true });
    await viewer.waitFor((m) => m.t === "battery");
    expect(viewer.messages.some((m) => m.t === "hr")).toBe(false);
  });

  it("mensagens inválidas do app recebem erro sem derrubar a conexão", async () => {
    const { token } = await newDevice("Inválido");
    const app = await openSocket("/v1/connect", token);
    await app.waitFor((m) => m.t === "welcome");
    app.send({ t: "hr", ts: now(), bpm: 9999 });
    await app.waitFor((m) => m.t === "error");
    app.send({ t: "ping" });
    await app.waitFor((m) => m.t === "pong");
  });

  it("fluxo global recebe dados de todas as pulseiras permitidas", async () => {
    const a = await newDevice("G1");
    const app = await openSocket("/v1/connect", a.token);
    await app.waitFor((m) => m.t === "welcome");
    const fleet = await openSocket("/v1/stream", ADMIN);
    await fleet.waitFor((m) => m.t === "hello");
    app.send({ t: "hr", ts: now(), bpm: 66 });
    const m = await fleet.waitFor((x) => x.t === "hr" && x.device_id === a.id);
    expect(m.bpm).toBe(66);
  });
});

describe("comandos", () => {
  it("vibrar: entrega ao app, recebe confirmação e atualiza o estado", async () => {
    const { id, token } = await newDevice("Vibrar");
    const app = await openSocket("/v1/connect", token);
    await app.waitFor((m) => m.t === "welcome");
    const viewer = await openSocket(`/v1/devices/${id}/stream`, ADMIN);

    const r = await call("POST", `/v1/devices/${id}/vibrate`, { body: { count: 3 } });
    expect(r.status).toBe(202);
    const cmd = await app.waitFor((m) => m.t === "command");
    expect(cmd).toMatchObject({ id: r.json.id, type: "vibrate", params: { count: 3, durationMs: 800 } });

    app.send({ t: "ack", id: cmd.id, ok: true });
    await viewer.waitFor((m) => m.t === "command" && m.command.status === "acked");
    expect((await call("GET", `/v1/devices/${id}/commands/${cmd.id}`)).json.status).toBe("acked");
  });

  it("comando enviado com o app offline fica na fila e é entregue ao conectar", async () => {
    const { id, token } = await newDevice("Fila");
    const r = await call("POST", `/v1/devices/${id}/commands`, { body: { type: "message", params: { title: "Remédio", body: "Hora de tomar" }, ttl_s: 600 } });
    expect(r.json.status).toBe("queued");
    const app = await openSocket("/v1/connect", token);
    const cmd = await app.waitFor((m) => m.t === "command");
    expect(cmd.params).toMatchObject({ title: "Remédio", kind: "app" });
    app.send({ t: "ack", id: cmd.id, ok: false, error: "pulseira desconectada" });
    await new Promise((r) => setTimeout(r, 100));
    const done = await call("GET", `/v1/devices/${id}/commands/${cmd.id}`);
    expect(done.json).toMatchObject({ status: "failed", error: "pulseira desconectada" });
  });

  it("valida o comando e permite cancelar o que está na fila", async () => {
    const { id } = await newDevice("Valida");
    const bad = await call("POST", `/v1/devices/${id}/commands`, { body: { type: "explodir" } });
    expect(bad.status).toBe(400);
    expect(bad.json.supported_types).toContain("vibrate");
    expect((await call("POST", `/v1/devices/${id}/commands`, { body: { type: "vibrate", params: { count: 99 } } })).status).toBe(400);

    const q = await call("POST", `/v1/devices/${id}/vibrate`, { body: {} });
    expect(q.json.status).toBe("queued");
    expect((await call("DELETE", `/v1/devices/${id}/commands/${q.json.id}`)).status).toBe(200);
    expect((await call("DELETE", `/v1/devices/${id}/commands/${q.json.id}`)).status).toBe(409);
  });

  it("visor envia comando pelo WebSocket", async () => {
    const { id, token } = await newDevice("WS cmd");
    const app = await openSocket("/v1/connect", token);
    await app.waitFor((m) => m.t === "welcome");
    const viewer = await openSocket(`/v1/devices/${id}/stream`, ADMIN);
    await viewer.waitFor((m) => m.t === "snapshot");
    viewer.send({ t: "command", req: "r1", type: "vibrate", params: { count: 2 } });
    const created = await viewer.waitFor((m) => m.t === "command_created");
    expect(created.req).toBe("r1");
    const cmd = await app.waitFor((m) => m.t === "command");
    expect(cmd.params.count).toBe(2);
  });
});

describe("alertas", () => {
  it("regra de FC dispara alerta, vibra a pulseira e avisa o visor", async () => {
    const { id, token } = await newDevice("Alerta");
    const rule = await call("POST", "/v1/alert-rules", {
      body: { device_id: id, name: "Taquicardia", metric: "heart_rate", op: "gt", threshold: 120, severity: "critical", action: { vibrate: { count: 3 } } },
    });
    expect(rule.status).toBe(201);

    const app = await openSocket("/v1/connect", token);
    await app.waitFor((m) => m.t === "welcome");
    const viewer = await openSocket(`/v1/devices/${id}/stream`, ADMIN);
    await viewer.waitFor((m) => m.t === "snapshot");

    app.send({ t: "hr", ts: now(), bpm: 70 }); // normal
    app.send({ t: "hr", ts: now() + 1, bpm: 150 });
    const alert = await viewer.waitFor((m) => m.t === "alert");
    expect(alert.alert).toMatchObject({ severity: "critical", metric: "heart_rate", value: 150, rule_name: "Taquicardia" });
    const vib = await app.waitFor((m) => m.t === "command" && m.type === "vibrate");
    expect(vib.params.count).toBe(3);

    const list = await call("GET", `/v1/alerts?device_id=${id}&acked=false`);
    expect(list.json.count).toBe(1);
    const ack = await call("POST", `/v1/alerts/${list.json.data[0].id}/ack`);
    expect(ack.json.acked_at).toBeTypeOf("number");
    expect((await call("GET", `/v1/alerts?device_id=${id}&acked=false`)).json.count).toBe(0);
  });

  it("regra por evento dispara e respeita o cooldown", async () => {
    const { id, token } = await newDevice("Evento");
    await call("POST", "/v1/alert-rules", { body: { device_id: id, name: "Botão", metric: "event", match: "BUTTON_PRESSED", cooldown_s: 600 } });
    const app = await openSocket("/v1/connect", token);
    await app.waitFor((m) => m.t === "welcome");
    app.send({ t: "event", ts: now(), type: "BUTTON_PRESSED" });
    app.send({ t: "event", ts: now() + 1, type: "BUTTON_PRESSED" });
    await new Promise((r) => setTimeout(r, 300));
    expect((await call("GET", `/v1/alerts?device_id=${id}`)).json.count).toBe(1);
  });

  it("regra offline dispara uma única vez quando o app some e a presença é publicada", async () => {
    const { id, token } = await newDevice("Offline");
    await call("POST", "/v1/alert-rules", { body: { device_id: id, name: "Sem sinal", metric: "offline", op: "gt", threshold: 0, severity: "critical" } });
    const app = await openSocket("/v1/connect", token);
    await app.waitFor((m) => m.t === "welcome");
    const viewer = await openSocket(`/v1/devices/${id}/stream`, ADMIN);
    await viewer.waitFor((m) => m.t === "snapshot");

    app.close();
    const presence = await viewer.waitFor((m) => m.t === "presence" && m.online === false);
    expect(presence.device_id).toBe(id);
    expect((await call("GET", `/v1/devices/${id}`)).json.online).toBe(false);

    await new Promise((r) => setTimeout(r, 1200));
    const stub = env.HUB.get(env.HUB.idFromName(id));
    await runDurableObjectAlarm(stub);
    await viewer.waitFor((m) => m.t === "alert");
    await runDurableObjectAlarm(stub); // segunda passada não repete o alerta
    expect((await call("GET", `/v1/alerts?device_id=${id}`)).json.count).toBe(1);
  });

  it("valida regras", async () => {
    expect((await call("POST", "/v1/alert-rules", { body: { name: "x", metric: "heart_rate" } })).status).toBe(400);
    expect((await call("POST", "/v1/alert-rules", { body: { name: "x", metric: "event" } })).status).toBe(400);
  });
});

describe("histórico", () => {
  it("agrega FC por bucket, passos por dia e exporta CSV", async () => {
    const { id, token } = await newDevice("Histórico");
    const app = await openSocket("/v1/connect", token);
    await app.waitFor((m) => m.t === "welcome");
    const base = Math.floor(now() / 3_600_000) * 3_600_000 - 3_600_000;
    app.send({ t: "batch", items: [
      { t: "hr", ts: base + 1000, bpm: 60 },
      { t: "hr", ts: base + 2000, bpm: 80 },
      { t: "hr", ts: base + 120_000, bpm: 100 },
      { t: "steps", ts: base, steps: 100 },
      { t: "steps", ts: base + 5000, steps: 250 },
    ] });
    app.send({ t: "ping" });
    await app.waitFor((m) => m.t === "pong");

    const agg = await call("GET", `/v1/devices/${id}/heart-rate?from=${base}&to=${base + 3_600_000}&bucket=1m`);
    expect(agg.json.data).toHaveLength(2);
    expect(agg.json.data[0]).toMatchObject({ avg: 70, min: 60, max: 80, samples: 2 });

    const daily = await call("GET", `/v1/devices/${id}/steps?from=${base}&to=${base + 3_600_000}&bucket=1d`);
    expect(daily.json.data[0].steps).toBe(250);

    const csv = await call("GET", `/v1/devices/${id}/heart-rate?from=${base}&to=${base + 3_600_000}&format=csv`);
    expect(csv.text.split("\n")[0]).toBe("ts,bpm");

    const page = await call("GET", `/v1/devices/${id}/heart-rate?from=${base}&to=${base + 3_600_000}&limit=1`);
    expect(page.json.next).toEqual({ from: base + 1001 });

    const summary = await call("GET", `/v1/devices/${id}/summary?from=${base}&to=${base + 3_600_000}`);
    expect(summary.json.heart_rate).toMatchObject({ min: 60, max: 100, samples: 3 });
    expect((await call("GET", "/v1/overview")).json.count).toBeGreaterThan(0);
  });

  it("detecta sono a partir das amostras por minuto enviadas pelo app", async () => {
    const { id, token } = await newDevice("Sono");
    const app = await openSocket("/v1/connect", token);
    await app.waitFor((m) => m.t === "welcome");
    const start = Math.floor(now() / 60_000) * 60_000 - 3 * 3_600_000;
    app.send({ t: "activity", samples: Array.from({ length: 90 }, (_, i) => ({ ts: start + i * 60_000, kind: i < 45 ? 9 : 11, intensity: 1, steps: 0, hr: 55 })) });
    app.send({ t: "ping" });
    await app.waitFor((m) => m.t === "pong");
    const sleep = await call("GET", `/v1/devices/${id}/sleep?from=${start - 1000}&to=${start + 4 * 3_600_000}`);
    expect(sleep.json.data).toHaveLength(1);
    expect(sleep.json.data[0]).toMatchObject({ light_min: 45, deep_min: 45, avg_hr: 55 });
    expect(sleep.json.warning).toMatch(/provisória/);
  });
});

describe("pulseiras e webhooks", () => {
  it("rotacionar o token invalida o antigo", async () => {
    const { id, token } = await newDevice("Rotação");
    const rot = await call("POST", `/v1/devices/${id}/rotate-token`);
    expect(rot.json.device_token).not.toBe(token);
    expect((await SELF.fetch("https://cloud.test/v1/connect", { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } })).status).toBe(401);
    await openSocket("/v1/connect", rot.json.device_token).then((s) => s.close());
  });

  it("arquiva e apaga definitivamente", async () => {
    const { id } = await newDevice("Apagar");
    expect((await call("DELETE", `/v1/devices/${id}`)).json.purged).toBe(false);
    expect((await call("GET", "/v1/devices")).json.data.some((d: any) => d.id === id)).toBe(false);
    expect((await call("DELETE", `/v1/devices/${id}?purge=true`)).json.purged).toBe(true);
    expect((await call("GET", `/v1/devices/${id}`)).status).toBe(404);
  });

  it("webhook exige https e mostra o segredo uma única vez", async () => {
    expect((await call("POST", "/v1/webhooks", { body: { url: "http://x.test/h" } })).status).toBe(400);
    const w = await call("POST", "/v1/webhooks", { body: { url: "https://example.test/hook", events: ["alert.created"] } });
    expect(w.status).toBe(201);
    expect(w.json.secret).toMatch(/^whsec_/);
    const list = await call("GET", "/v1/webhooks");
    expect(list.json.data.every((x: any) => x.secret === undefined)).toBe(true);
  });

  it("documenta a API em OpenAPI", async () => {
    const json = await (await SELF.fetch("https://cloud.test/v1/openapi.json")).json<any>();
    expect(json.openapi).toBe("3.0.3");
    expect(Object.keys(json.paths)).toContain("/v1/devices/{id}/vibrate");
  });
});
