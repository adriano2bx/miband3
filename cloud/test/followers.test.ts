import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call } from "./helpers";

async function panelLogin(credential: string, password: string): Promise<string> {
  const res = await SELF.fetch("https://cloud.test/v1/panel/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential, password }),
  });
  const json = await res.json<any>();
  if (res.status !== 201) throw new Error(JSON.stringify(json));
  return json.session_token as string;
}

describe("seguidores (acesso por paciente)", () => {
  it("seguidor só enxerga os devices do seu paciente", async () => {
    // Dois pacientes, cada um com um device.
    const a = (await call("POST", "/v1/patients", { body: { name: "Paciente A" } })).json.id as string;
    const b = (await call("POST", "/v1/patients", { body: { name: "Paciente B" } })).json.id as string;
    const devA = (await call("POST", "/v1/devices", { body: { name: "Pulseira A", patient_id: a } })).json.id as string;
    const devB = (await call("POST", "/v1/devices", { body: { name: "CGM B", type: "cgm", patient_id: b } })).json.id as string;

    // Seguidor do paciente A.
    const f = await call("POST", `/v1/patients/${a}/followers`, { body: { name: "Seguidor A", credential: "seg.a", password: "senhaforte1" } });
    expect(f.status).toBe(201);
    expect(f.json.role).toBe("follower");

    const token = await panelLogin("seg.a", "senhaforte1");

    // Vê só o device do paciente A.
    const me = await call("GET", "/v1/me", { token });
    expect(me.json.device_ids).toEqual([devA]);

    const devices = await call("GET", "/v1/devices", { token });
    expect(devices.json.data.map((d: any) => d.id)).toEqual([devA]);

    const patients = await call("GET", "/v1/patients", { token });
    expect(patients.json.data.map((p: any) => p.id)).toEqual([a]);

    // Não acessa o device do paciente B.
    const forbidden = await call("GET", `/v1/devices/${devB}/heart-rate`, { token });
    expect(forbidden.status).toBe(403);

    // Não gerencia contas (só leitura).
    const cantCreate = await call("POST", `/v1/patients/${b}/followers`, { token, body: { name: "x", credential: "y.z", password: "senhaforte1" } });
    expect(cantCreate.status).toBe(403);
  });

  it("técnico responsável enxerga vários voluntários atrelados", async () => {
    const p1 = (await call("POST", "/v1/patients", { body: { name: "Voluntário 1" } })).json.id as string;
    const p2 = (await call("POST", "/v1/patients", { body: { name: "Voluntário 2" } })).json.id as string;
    const p3 = (await call("POST", "/v1/patients", { body: { name: "Voluntário 3 (fora)" } })).json.id as string;
    const d1 = (await call("POST", "/v1/devices", { body: { name: "D1", patient_id: p1 } })).json.id as string;
    const d2 = (await call("POST", "/v1/devices", { body: { name: "D2", patient_id: p2 } })).json.id as string;
    await call("POST", "/v1/devices", { body: { name: "D3", patient_id: p3 } });

    // Cria o técnico responsável (panel_read) e atrela 2 voluntários.
    const tech = await call("POST", "/v1/technicians", { body: { credential: "tec.resp", name: "Téc. Responsável", password: "senhaforte1", scopes: ["panel_read"] } });
    expect(tech.status).toBe(201);
    const tid = tech.json.id as string;
    expect((await call("POST", `/v1/technicians/${tid}/patients`, { body: { patient_id: p1 } })).status).toBe(201);
    expect((await call("POST", `/v1/technicians/${tid}/patients`, { body: { patient_id: p2 } })).status).toBe(201);

    const token = await panelLogin("tec.resp", "senhaforte1");
    const me = await call("GET", "/v1/me", { token });
    expect([...me.json.device_ids].sort()).toEqual([d1, d2].sort());
    // Não vê o voluntário de fora.
    const patients = await call("GET", "/v1/patients", { token });
    expect(patients.json.data.map((p: any) => p.id).sort()).toEqual([p1, p2].sort());
  });
});
