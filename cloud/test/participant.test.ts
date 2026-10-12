import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN, call, openSocket } from "./helpers";

// Arquivo isolado dos demais: aqui os termos publicados mudam ao longo dos testes.
const V1 = "p-2026.1";

async function publish(version: string, requires_reconsent = true) {
  const r = await call("POST", "/v1/consent/terms", {
    body: { version, title: `Termo ${version}`, content: `Conteúdo completo do termo ${version} fornecido pela equipe responsável.`, requires_reconsent },
  });
  expect([201, 409]).toContain(r.status);
}

async function enroll() {
  const r = await call("POST", "/v1/installations", { token: "none", body: { consent_version: V1, accepted: true, client: { app: "biosense", version: "test" } } });
  expect(r.status).toBe(201);
  return { id: r.json.device_id as string, token: r.json.device_token as string, json: r.json };
}

async function createTech(credential: string, scopes: string[] = ["tech"]) {
  const r = await call("POST", "/v1/technicians", { body: { credential, name: `Técnico ${credential}`, password: "senha-forte-123", scopes } });
  expect(r.status).toBe(201);
}

async function login(credential: string, password: string, deviceToken?: string) {
  return call("POST", "/v1/tech/login", { token: "none", body: { credential, password, device_token: deviceToken } });
}

describe("termo e adesão", () => {
  it("sem termo publicado não há adesão", async () => {
    // Este teste roda antes de qualquer publicação neste arquivo.
    const current = await SELF.fetch("https://cloud.test/v1/consent/terms/current");
    if (current.status === 404) {
      const r = await call("POST", "/v1/installations", { token: "none", body: { consent_version: "x", accepted: true } });
      expect(r.status).toBe(409);
      expect(r.json.error).toBe("no_terms");
    }
  });

  it("termo vigente é público; versão desatualizada é recusada; adesão cria instalação pendente", async () => {
    await publish(V1);
    const term = await (await SELF.fetch("https://cloud.test/v1/consent/terms/current")).json<any>();
    expect(term.version).toBe(V1);
    expect(term.content).toMatch(/Conteúdo completo/);

    const outdated = await call("POST", "/v1/installations", { token: "none", body: { consent_version: "antiga", accepted: true } });
    expect(outdated.status).toBe(409);
    expect(outdated.json.current_version).toBe(V1);

    const { json } = await enroll();
    expect(json).toMatchObject({ status: "pending", authorized: false, consent: { accepted_version: V1, valid: true } });
    expect(json.device_token).toMatch(/^mbd_/);
    expect(json.config).toEqual({ hr_interval_min: 30, history_interval_min: 30 });

    const records = await call("GET", `/v1/devices/${json.device_id}/consents`);
    expect(records.json.data).toHaveLength(1);
    expect(records.json.data[0]).toMatchObject({ version: V1, accepted: true });
  });

  it("instalação pendente conecta mas a telemetria é recusada até a autorização", async () => {
    await publish(V1);
    const { id, token } = await enroll();
    const app = await openSocket("/v1/connect", token);
    const welcome = await app.waitFor((m) => m.t === "welcome");
    expect(welcome).toMatchObject({ authorized: false, status: "pending", consent: { valid: true } });

    app.send({ t: "batch", seq: 1, items: [{ t: "hr", ts: Date.now(), bpm: 70 }] });
    expect(await app.waitFor((m) => m.t === "stored" && m.seq === 1)).toMatchObject({ accepted: false, reason: "not_authorized" });
    expect((await call("GET", `/v1/devices/${id}/heart-rate`)).json.count).toBe(0);

    await call("POST", `/v1/devices/${id}/authorize`, { body: { participant_ref: "P-100" } });
    const status = await app.waitFor((m) => m.t === "status");
    expect(status).toMatchObject({ authorized: true, status: "active" });

    const ts = Date.now();
    app.send({ t: "batch", seq: 2, items: [{ t: "hr", ts, bpm: 71 }, { t: "event", ts, id: "evt-1", type: "BUTTON_PRESSED" }] });
    expect(await app.waitFor((m) => m.t === "stored" && m.seq === 2)).toMatchObject({ accepted: true, count: 2 });
    // Reenvio do mesmo lote (ex.: confirmação perdida): nada duplica.
    app.send({ t: "batch", seq: 3, items: [{ t: "hr", ts, bpm: 71 }, { t: "event", ts, id: "evt-1", type: "BUTTON_PRESSED" }] });
    await app.waitFor((m) => m.t === "stored" && m.seq === 3);
    expect((await call("GET", `/v1/devices/${id}/heart-rate`)).json.count).toBe(1);
    expect((await call("GET", `/v1/devices/${id}/events`)).json.count).toBe(1);
  });

  it("recusar o consentimento interrompe a telemetria", async () => {
    await publish(V1);
    const { id, token } = await enroll();
    await call("POST", `/v1/devices/${id}/authorize`, {});
    const r = await call("POST", "/v1/consent", { token, body: { version: V1, accepted: false } });
    expect(r.json.consent.valid).toBe(false);
    const app = await openSocket("/v1/connect", token);
    expect((await app.waitFor((m) => m.t === "welcome")).consent.valid).toBe(false);
    app.send({ t: "batch", seq: 1, items: [{ t: "hr", ts: Date.now(), bpm: 70 }] });
    expect((await app.waitFor((m) => m.t === "stored")).accepted).toBe(false);
  });
});

describe("perfil de coleta e bloqueio", () => {
  it("mudança de configuração chega ao app com nova versão", async () => {
    await publish(V1);
    const { id, token } = await enroll();
    await call("POST", `/v1/devices/${id}/authorize`, {});
    const app = await openSocket("/v1/connect", token);
    const welcome = await app.waitFor((m) => m.t === "welcome");
    expect(await call("PUT", `/v1/devices/${id}/config`, { body: { hr_interval_min: 7 } }).then((r) => r.status)).toBe(400);
    const put = await call("PUT", `/v1/devices/${id}/config`, { body: { hr_interval_min: 10 } });
    expect(put.json.config_version).toBe(welcome.config_version + 1);
    const status = await app.waitFor((m) => m.t === "status" && m.config?.hr_interval_min === 10);
    expect(status.config_version).toBe(put.json.config_version);
  });

  it("bloquear a instalação derruba o app e impede reconexão", async () => {
    await publish(V1);
    const { id, token } = await enroll();
    const app = await openSocket("/v1/connect", token);
    await app.waitFor((m) => m.t === "welcome");
    const closed = new Promise<number>((resolve) => app.ws.addEventListener("close", (e) => resolve(e.code)));
    await call("POST", `/v1/devices/${id}/revoke`);
    expect(await closed).toBe(4003);
    const again = await SELF.fetch("https://cloud.test/v1/connect", { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } });
    expect(again.status).toBe(403);
  });
});

describe("acesso técnico", () => {
  it("credencial errada é recusada e bloqueia após 5 tentativas", async () => {
    await publish(V1);
    const { token } = await enroll();
    await createTech("tec.bloqueio");
    for (let i = 1; i <= 4; i++) {
      const r = await login("tec.bloqueio", "errada", token);
      expect(r.status).toBe(401);
      expect(r.json.attempts_left).toBe(5 - i);
    }
    expect((await login("tec.bloqueio", "errada", token)).status).toBe(429);
    // Mesmo com a senha certa, continua bloqueado.
    expect((await login("tec.bloqueio", "senha-forte-123", token)).status).toBe(429);
    expect((await login("nao.existe", "qualquer", token)).status).toBe(401);
  });

  it("sessão presa à instalação, renovada por uso e encerrável", async () => {
    await publish(V1);
    const { id, token } = await enroll();
    await createTech("tec.sessao");
    expect((await login("tec.sessao", "senha-forte-123")).status).toBe(403); // sem instalação
    const ok = await login("tec.sessao", "senha-forte-123", token);
    expect(ok.status).toBe(201);
    const session = ok.json.session_token as string;
    expect(session).toMatch(/^mbt_/);
    expect(ok.json.idle_timeout_s).toBe(600);

    const inst = await call("GET", "/v1/tech/installation", { token: session });
    expect(inst.json).toMatchObject({ device_id: id, status: "pending", technician: "Técnico tec.sessao", scopes: ["tech"] });
    expect((await call("GET", "/v1/tech/ping", { token: session })).json.ok).toBe(true);

    // A chave mestra e o token do dispositivo não servem como sessão técnica.
    expect((await call("GET", "/v1/tech/installation", { token: ADMIN })).status).toBe(401);
    expect((await call("GET", "/v1/tech/installation", { token })).status).toBe(401);

    await call("POST", "/v1/tech/logout", { token: session });
    expect((await call("GET", "/v1/tech/installation", { token: session })).status).toBe(401);
  });

  it("sessão expirada por inatividade é recusada", async () => {
    await publish(V1);
    const { token } = await enroll();
    await createTech("tec.expira");
    const session = (await login("tec.expira", "senha-forte-123", token)).json.session_token;
    await env.DB.prepare("UPDATE tech_sessions SET expires_at = ?").bind(Date.now() - 1).run();
    const r = await call("GET", "/v1/tech/installation", { token: session });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("session_expired");
  });

  it("autorizar instalação exige o escopo provision", async () => {
    await publish(V1);
    const { token } = await enroll();
    await createTech("tec.basico", ["tech"]);
    await createTech("tec.prov", ["tech", "provision"]);
    const basic = (await login("tec.basico", "senha-forte-123", token)).json.session_token;
    expect((await call("POST", "/v1/tech/installation/authorize", { token: basic, body: { participant_ref: "P-1" } })).status).toBe(403);

    const app = await openSocket("/v1/connect", token);
    await app.waitFor((m) => m.t === "welcome");
    const prov = (await login("tec.prov", "senha-forte-123", token)).json.session_token;
    expect((await call("POST", "/v1/tech/installation/authorize", { token: prov, body: {} })).status).toBe(400);
    const r = await call("POST", "/v1/tech/installation/authorize", { token: prov, body: { participant_ref: "P-2" } });
    expect(r.json).toMatchObject({ status: "active", authorized: true, participant_ref: "P-2" });
    await app.waitFor((m) => m.t === "status" && m.authorized === true);
  });
});

describe("novo termo", () => {
  it("versão que exige novo aceite invalida o consentimento anterior até o reaceite", async () => {
    await publish(V1);
    const { token } = await enroll();
    await publish("p-2026.2", true);
    const inst = await call("GET", "/v1/installation", { token });
    expect(inst.json.consent).toMatchObject({ accepted_version: V1, current_version: "p-2026.2", valid: false });
    expect((await call("POST", "/v1/consent", { token, body: { version: V1, accepted: true } })).status).toBe(409);
    const re = await call("POST", "/v1/consent", { token, body: { version: "p-2026.2", accepted: true } });
    expect(re.json.consent.valid).toBe(true);
    // Termos publicados não são editados.
    expect((await call("POST", "/v1/consent/terms", { body: { version: "p-2026.2", title: "x", content: "outro conteúdo qualquer bem longo" } })).status).toBe(409);
  });
});
