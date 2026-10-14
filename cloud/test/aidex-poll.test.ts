import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { newDevice } from "./helpers";
import { pollDevice, type AidexLink } from "../src/aidex";

describe("aidex — coleta (fetch mockado)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pollDevice coleta a glicemia e avança o cursor", async () => {
    const d = await newDevice("CGM poll");
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO aidex_links (device_id, env, status, access_token, refresh_token, expires_at, cursor_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).bind(d.id, "sandbox", "linked", "tok", "ref", now + 86_400_000, now - 2 * 3600_000, now, now).run();

    // Access token válido → sem refresh; só a chamada de sensor-glucose é usada.
    vi.stubGlobal("fetch", async (url: string | URL) =>
      new Response(
        JSON.stringify(
          String(url).includes("sensor-glucose")
            ? { code: 1, data: [{ deviceTime: "2024-06-01T12:00:00", sensorGlucose: 6.5, warning: null }, { deviceTime: "2024-06-01T12:05:00", sensorGlucose: 3.2, warning: "low glucose alert" }] }
            : { code: 1, data: [] },
        ),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const link: AidexLink = {
      device_id: d.id, env: "sandbox", status: "linked", state: null,
      access_token: "tok", refresh_token: "ref", expires_at: now + 86_400_000,
      cursor_at: now - 2 * 3600_000, last_poll_at: null, last_error: null, created_at: now, updated_at: now,
    };
    const res = await pollDevice(env, link);
    expect(res.inserted).toBe(2);

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM glucose WHERE device_id = ?").bind(d.id).first<{ n: number }>();
    expect(row!.n).toBe(2);

    const l = await env.DB.prepare("SELECT cursor_at, status FROM aidex_links WHERE device_id = ?").bind(d.id).first<{ cursor_at: number; status: string }>();
    expect(l!.status).toBe("linked");
    expect(l!.cursor_at).toBeGreaterThan(now - 1000);
  });
});
