import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { call, newDevice } from "./helpers";
import { parseApiTime, summarize, toApiTime, mmolToMgdl, authorizeUrl, evaluateGlucoseAlerts, seedDefaultGlucoseRules } from "../src/aidex";

describe("aidex — lógica pura", () => {
  it("toApiTime/parseApiTime fazem round-trip em UTC", () => {
    const iso = "2022-06-21T00:01:10";
    expect(toApiTime(parseApiTime(iso))).toBe(iso);
    // sem sufixo de fuso é interpretado como UTC
    expect(parseApiTime("2022-06-21T00:01:10")).toBe(Date.parse("2022-06-21T00:01:10Z"));
  });

  it("mmolToMgdl usa o fator padrão", () => {
    expect(Math.round(mmolToMgdl(6))).toBe(108);
  });

  it("summarize calcula TIR, média e GMI", () => {
    const base = Date.UTC(2024, 0, 1);
    const rows = [3.5, 6.0, 12.0, 2.5, 15.0].map((mmol, i) => ({ ts: base + i * 300_000, mmol }));
    const s = summarize(rows);
    expect(s.samples).toBe(5);
    expect(s.mean_mmol).toBe(7.8);
    expect(s.tir.very_low).toBe(20);
    expect(s.tir.low).toBe(20);
    expect(s.tir.in_range).toBe(20);
    expect(s.tir.high).toBe(20);
    expect(s.tir.very_high).toBe(20);
    expect(s.min_mmol).toBe(2.5);
    expect(s.max_mmol).toBe(15);
    expect(s.gmi_percent).toBeGreaterThan(0);
  });

  it("summarize lida com conjunto vazio", () => {
    const s = summarize([]);
    expect(s.samples).toBe(0);
    expect(s.mean_mmol).toBeNull();
  });

  it("authorizeUrl monta a URL oficial com clientId e state", () => {
    const url = authorizeUrl({ AIDEX_CLIENT_ID: "abc" } as never, "sandbox", "xyz");
    expect(url).toContain("https://sandbox-accesslist.microtechmd.com/v1/oauth2/authorize");
    expect(url).toContain("clientId=abc");
    expect(url).toContain("responseType=code");
    expect(url).toContain("state=xyz");
  });
});

describe("aidex — rotas", () => {
  it("status é 'unlinked' sem vínculo", async () => {
    const d = await newDevice("Glicemia A");
    const r = await call("GET", `/v1/devices/${d.id}/aidex`);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("unlinked");
  });

  it("connect responde 503 quando AIDEX_CLIENT_ID não está configurado", async () => {
    const d = await newDevice("Glicemia B");
    const r = await call("POST", `/v1/devices/${d.id}/aidex/connect`, { body: {} });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("not_configured");
  });

  it("device nasce como 'miband' e aceita 'cgm' no cadastro", async () => {
    const def = await call("POST", "/v1/devices", { body: { name: "Padrão" } });
    expect(def.status).toBe(201);
    expect(def.json.type).toBe("miband");

    const cgm = await call("POST", "/v1/devices", { body: { name: "Sensor", type: "cgm" } });
    expect(cgm.status).toBe(201);
    expect(cgm.json.type).toBe("cgm");
  });

  it("glucose e summary refletem as leituras armazenadas", async () => {
    const d = await newDevice("Glicemia C");
    const base = Date.now() - 3600_000;
    const vals: [number, number, string | null][] = [
      [base + 0, 5.5, null],
      [base + 300_000, 3.2, "low glucose alert"],
      [base + 600_000, 11.0, "high glucose alert"],
      [base + 900_000, 7.0, null],
    ];
    await env.DB.batch(
      vals.map(([ts, mmol, w]) =>
        env.DB.prepare("INSERT INTO glucose (device_id, ts, mmol, warning) VALUES (?, ?, ?, ?)").bind(d.id, ts, mmol, w),
      ),
    );

    const hist = await call("GET", `/v1/devices/${d.id}/glucose?from=0&to=99999999999999`);
    expect(hist.status).toBe(200);
    expect(hist.json.count).toBe(4);
    expect(hist.json.unit).toBe("mmol/L");
    expect(hist.json.data[1].warning).toBe("low glucose alert");

    const sum = await call("GET", `/v1/devices/${d.id}/glucose/summary?from=0&to=99999999999999`);
    expect(sum.status).toBe(200);
    expect(sum.json.samples).toBe(4);
    expect(sum.json.tir.in_range).toBe(50); // 5.5 e 7.0 dentro de 3.9–10.0
  });

  it("purge remove também glicemia e vínculo AiDEX", async () => {
    const d = await newDevice("Purge CGM");
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO aidex_links (device_id, env, status, state, created_at, updated_at) VALUES (?, 'sandbox', 'pending', 'st_x', ?, ?)").bind(d.id, now, now),
      env.DB.prepare("INSERT INTO glucose (device_id, ts, mmol, warning) VALUES (?, ?, ?, ?)").bind(d.id, now, 5.5, null),
      env.DB.prepare("INSERT INTO glucose_events (device_id, type, ext_id, ts, payload) VALUES (?, 'diet', 'e1', ?, '{}')").bind(d.id, now),
    ]);

    const del = await call("DELETE", `/v1/devices/${d.id}?purge=true`);
    expect(del.status).toBe(200);
    expect(del.json.purged).toBe(true);

    for (const t of ["aidex_links", "glucose", "glucose_events"]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE device_id = ?`).bind(d.id).first<{ n: number }>();
      expect(row!.n).toBe(0);
    }
  });

  it("alerta de glicemia (hipo) dispara na coleta e respeita o cooldown", async () => {
    const d = await newDevice("CGM alerta");
    await env.DB.prepare(
      "INSERT INTO alert_rules (id, device_id, name, metric, op, threshold, duration_s, cooldown_s, severity, action, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind("rul_glu_" + d.id, d.id, "Hipoglicemia", "glucose", "lt", 3.9, 0, 1800, "critical", "{}", 1, Date.now()).run();

    const t0 = Date.now();
    await env.DB.prepare("INSERT INTO glucose (device_id, ts, mmol, warning) VALUES (?,?,?,?)").bind(d.id, t0, 3.2, "low").run();
    expect(await evaluateGlucoseAlerts(env, d.id)).toBe(1);

    // Nova leitura baixa dentro do cooldown: não refaz.
    await env.DB.prepare("INSERT INTO glucose (device_id, ts, mmol, warning) VALUES (?,?,?,?)").bind(d.id, t0 + 60_000, 3.0, "low").run();
    expect(await evaluateGlucoseAlerts(env, d.id)).toBe(0);

    const alerts = await call("GET", `/v1/alerts?device_id=${d.id}&from=0&to=99999999999999`);
    expect(alerts.json.data.length).toBe(1);
    expect(alerts.json.data[0].metric).toBe("glucose");
  });

  it("seedDefaultGlucoseRules cria 3 regras padrão (idempotente)", async () => {
    const d = await newDevice("CGM defaults");
    expect(await seedDefaultGlucoseRules(env, d.id)).toBe(3);
    expect(await seedDefaultGlucoseRules(env, d.id)).toBe(0);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM alert_rules WHERE metric='glucose' AND device_id=?").bind(d.id).first<{ n: number }>();
    expect(row!.n).toBe(3);
  });

  it("alerta de glicemia vibra a pulseira do mesmo voluntário", async () => {
    const pid = (await call("POST", "/v1/patients", { body: { name: "V auto" } })).json.id as string;
    const band = (await call("POST", "/v1/devices", { body: { name: "Band", patient_id: pid } })).json.id as string;
    const cgm = (await call("POST", "/v1/devices", { body: { name: "CGM", type: "cgm", patient_id: pid } })).json.id as string;
    await env.DB.prepare(
      "INSERT INTO alert_rules (id,device_id,name,metric,op,threshold,duration_s,cooldown_s,severity,action,enabled,created_at) VALUES (?,?,?,?,?,?,0,1800,?,?,1,?)",
    ).bind("rul_auto_" + cgm, cgm, "Hipo", "glucose", "lt", 3.9, "critical", JSON.stringify({ vibrate: true }), Date.now()).run();
    await env.DB.prepare("INSERT INTO glucose (device_id,ts,mmol,warning) VALUES (?,?,?,?)").bind(cgm, Date.now(), 3.1, "low").run();

    expect(await evaluateGlucoseAlerts(env, cgm)).toBe(1);
    const cmd = await env.DB.prepare("SELECT COUNT(*) AS n FROM commands WHERE device_id=? AND type='vibrate'").bind(band).first<{ n: number }>();
    expect(cmd!.n).toBe(1);
  });

  it("glucose agrega por bucket", async () => {
    const d = await newDevice("Glicemia D");
    // Ancorado na borda de 5 min para as duas leituras caírem sempre no mesmo bucket.
    const base = Math.floor((Date.now() - 3600_000) / 300_000) * 300_000;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO glucose (device_id, ts, mmol, warning) VALUES (?, ?, ?, ?)").bind(d.id, base, 6.0, null),
      env.DB.prepare("INSERT INTO glucose (device_id, ts, mmol, warning) VALUES (?, ?, ?, ?)").bind(d.id, base + 30_000, 8.0, null),
    ]);
    const r = await call("GET", `/v1/devices/${d.id}/glucose?from=0&to=99999999999999&bucket=5m`);
    expect(r.status).toBe(200);
    expect(r.json.bucket).toBe("5m");
    expect(r.json.data[0].avg).toBe(7); // média de 6 e 8 na mesma janela de 5 min
  });
});
