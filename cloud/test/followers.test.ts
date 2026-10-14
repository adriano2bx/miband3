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
});
