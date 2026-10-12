import { describe, expect, it } from "vitest";
import { compare, stepRule } from "../src/alerts";
import { DEFAULT_KIND_MAP, detectSleep } from "../src/sleep";
import { parseTime } from "../src/util";

describe("alert rule state machine", () => {
  const rule = { duration_s: 60, cooldown_s: 300 };
  it("só dispara depois de a condição durar o tempo mínimo", () => {
    let s = { since: null as number | null, lastFired: null as number | null };
    let r = stepRule(rule, s, true, 0);
    expect(r.fire).toBe(false);
    r = stepRule(rule, r.state, true, 59_000);
    expect(r.fire).toBe(false);
    r = stepRule(rule, r.state, true, 60_000);
    expect(r.fire).toBe(true);
  });
  it("interromper a condição zera o relógio", () => {
    let r = stepRule(rule, { since: null, lastFired: null }, true, 0);
    r = stepRule(rule, r.state, false, 30_000);
    expect(r.state.since).toBeNull();
    r = stepRule(rule, r.state, true, 40_000);
    r = stepRule(rule, r.state, true, 99_000);
    expect(r.fire).toBe(false);
  });
  it("respeita o cooldown", () => {
    let r = stepRule({ duration_s: 0, cooldown_s: 300 }, { since: null, lastFired: null }, true, 1000);
    expect(r.fire).toBe(true);
    r = stepRule({ duration_s: 0, cooldown_s: 300 }, r.state, true, 100_000);
    expect(r.fire).toBe(false);
    r = stepRule({ duration_s: 0, cooldown_s: 300 }, r.state, true, 301_001);
    expect(r.fire).toBe(true);
  });
  it("compara", () => {
    expect(compare("gt", 5, 4)).toBe(true);
    expect(compare("lte", 4, 4)).toBe(true);
    expect(compare("lt", 4, 4)).toBe(false);
  });
});

describe("detecção de sono", () => {
  const MIN = 60_000;
  const t0 = Date.UTC(2026, 0, 1, 23, 0);
  const sample = (i: number, kind: number, hr = 55) => ({ ts: t0 + i * MIN, kind, intensity: 0, steps: 0, hr });

  it("agrupa minutos de sono em uma sessão e tolera pequenos despertares", () => {
    const samples = [
      ...Array.from({ length: 60 }, (_, i) => sample(i, 9)),
      ...Array.from({ length: 5 }, (_, i) => sample(60 + i, 1, 70)), // acordado 5 min
      ...Array.from({ length: 60 }, (_, i) => sample(65 + i, 11, 50)),
    ];
    const [s, ...rest] = detectSleep(samples, DEFAULT_KIND_MAP);
    expect(rest).toHaveLength(0);
    expect(s.light_min).toBe(60);
    expect(s.deep_min).toBe(60);
    expect(s.duration_min).toBe(125);
    expect(s.awake_min).toBe(5);
    expect(s.min_hr).toBe(50);
  });

  it("separa sessões distantes e descarta sonecas curtas", () => {
    const samples = [
      ...Array.from({ length: 10 }, (_, i) => sample(i, 9)), // 10 min: descartada
      ...Array.from({ length: 40 }, (_, i) => sample(300 + i, 9)),
      ...Array.from({ length: 40 }, (_, i) => sample(600 + i, 11)),
    ];
    expect(detectSleep(samples, DEFAULT_KIND_MAP)).toHaveLength(2);
  });
});

describe("parseTime", () => {
  it("aceita ms, s e ISO", () => {
    expect(parseTime("1700000000000")).toBe(1700000000000);
    expect(parseTime("1700000000")).toBe(1700000000000);
    expect(parseTime("2024-01-01T00:00:00Z")).toBe(Date.UTC(2024, 0, 1));
    expect(parseTime("lixo")).toBeNull();
  });
});
