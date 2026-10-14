import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { call } from "./helpers";

describe("pacientes (fundação)", () => {
  it("cria paciente e vincula devices, herdando patient_ref", async () => {
    const pat = await call("POST", "/v1/patients", { body: { name: "Paula", ref: "P-0001" } });
    expect(pat.status).toBe(201);
    const pid = pat.json.id as string;
    expect(pid).toMatch(/^pat_/);

    const dev = await call("POST", "/v1/devices", { body: { name: "Pulseira da Paula", patient_id: pid } });
    expect(dev.status).toBe(201);
    expect(dev.json.patient_id).toBe(pid);
    expect(dev.json.patient_ref).toBe("P-0001"); // herdado do paciente

    const cgm = await call("POST", "/v1/devices", { body: { name: "CGM da Paula", type: "cgm", patient_id: pid } });
    expect(cgm.status).toBe(201);

    const got = await call("GET", `/v1/patients/${pid}`);
    expect(got.status).toBe(200);
    expect(got.json.devices.length).toBe(2);
    expect(got.json.devices.map((d: any) => d.type).sort()).toEqual(["cgm", "miband"]);
  });

  it("device com patient_id inexistente dá 404", async () => {
    const dev = await call("POST", "/v1/devices", { body: { name: "x", patient_id: "pat_naoexiste" } });
    expect(dev.status).toBe(404);
  });

  it("listagem traz device_count e arquivar desvincula os devices", async () => {
    const pat = await call("POST", "/v1/patients", { body: { name: "João" } });
    const pid = pat.json.id as string;
    const dev = await call("POST", "/v1/devices", { body: { name: "Pulseira do João", patient_id: pid } });

    const list = await call("GET", "/v1/patients");
    expect(list.json.data.find((p: any) => p.id === pid).device_count).toBe(1);

    const del = await call("DELETE", `/v1/patients/${pid}`);
    expect(del.status).toBe(200);

    const devAfter = await call("GET", `/v1/devices/${dev.json.id}`);
    expect(devAfter.json.patient_id).toBeNull();
    const list2 = await call("GET", "/v1/patients");
    expect(list2.json.data.find((p: any) => p.id === pid)).toBeUndefined();
  });

  it("listagem consolidada traz has_cgm e a última glicemia", async () => {
    const pid = (await call("POST", "/v1/patients", { body: { name: "Consolidado" } })).json.id as string;
    const cgm = (await call("POST", "/v1/devices", { body: { name: "CGM", type: "cgm", patient_id: pid } })).json.id as string;
    await env.DB.prepare("INSERT INTO glucose (device_id, ts, mmol, warning) VALUES (?,?,?,?)").bind(cgm, Date.now(), 7.2, null).run();

    const row = (await call("GET", "/v1/patients")).json.data.find((p: any) => p.id === pid);
    expect(row.has_cgm).toBe(true);
    expect(row.has_band).toBe(false);
    expect(row.last_glucose).toBe(7.2);
    expect(row.device_count).toBe(1);
  });
});
