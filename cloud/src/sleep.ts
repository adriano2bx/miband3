/**
 * Classificação de sono a partir das amostras por minuto baixadas da pulseira.
 *
 * ATENÇÃO: os códigos de categoria abaixo seguem o que se sabe da família Huami
 * (Gadgetbridge), mas AINDA NÃO FORAM VALIDADOS em uma Mi Band 3 real. As amostras
 * brutas ficam guardadas (`/activity`) e o mapa pode ser corrigido sem reprocessar
 * nada via a variável SLEEP_KIND_MAP, ex.: {"light":[9],"deep":[11],"nonwear":[3,6]}.
 */
export interface KindMap {
  light: number[];
  deep: number[];
  nonwear: number[];
}

export const DEFAULT_KIND_MAP: KindMap = { light: [9], deep: [11], nonwear: [6] };

export function loadKindMap(json: string | undefined): KindMap {
  if (!json) return DEFAULT_KIND_MAP;
  try {
    const parsed = JSON.parse(json) as Partial<KindMap>;
    return { ...DEFAULT_KIND_MAP, ...parsed };
  } catch {
    return DEFAULT_KIND_MAP;
  }
}

export interface ActivitySample {
  ts: number;
  kind: number;
  intensity: number;
  steps: number;
  hr: number | null;
}

export type Stage = "deep" | "light" | "awake" | "nonwear";

export interface SleepSession {
  start: number;
  end: number;
  duration_min: number;
  deep_min: number;
  light_min: number;
  awake_min: number;
  avg_hr: number | null;
  min_hr: number | null;
}

export function stageOf(kind: number, map: KindMap): Stage {
  if (map.deep.includes(kind)) return "deep";
  if (map.light.includes(kind)) return "light";
  if (map.nonwear.includes(kind)) return "nonwear";
  return "awake";
}

const MINUTE = 60_000;

/**
 * Agrupa minutos de sono em sessões. Interrupções de até `maxGapMin` minutos acordado
 * não encerram a sessão; sessões menores que `minSessionMin` são descartadas (sonecas curtas).
 */
export function detectSleep(samples: ActivitySample[], map: KindMap, opts: { maxGapMin?: number; minSessionMin?: number } = {}): SleepSession[] {
  const maxGap = opts.maxGapMin ?? 15;
  const minSession = opts.minSessionMin ?? 30;
  const sorted = [...samples].sort((a, b) => a.ts - b.ts);

  const sessions: SleepSession[] = [];
  let cur: { start: number; last: number; deep: number; light: number; hrs: number[] } | null = null;

  const close = () => {
    if (!cur) return;
    const asleep = cur.deep + cur.light;
    const duration = Math.round((cur.last + MINUTE - cur.start) / MINUTE);
    if (asleep >= minSession) {
      const hrs = cur.hrs;
      sessions.push({
        start: cur.start,
        end: cur.last + MINUTE,
        duration_min: duration,
        deep_min: cur.deep,
        light_min: cur.light,
        awake_min: Math.max(0, duration - asleep),
        avg_hr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
        min_hr: hrs.length ? Math.min(...hrs) : null,
      });
    }
    cur = null;
  };

  for (const s of sorted) {
    const stage = stageOf(s.kind, map);
    const asleep = stage === "deep" || stage === "light";
    if (asleep) {
      if (cur && s.ts - cur.last > (maxGap + 1) * MINUTE) close();
      cur ??= { start: s.ts, last: s.ts, deep: 0, light: 0, hrs: [] };
      cur.last = s.ts;
      if (stage === "deep") cur.deep++;
      else cur.light++;
      if (s.hr && s.hr > 0 && s.hr < 255) cur.hrs.push(s.hr);
    } else if (cur && s.ts - cur.last > maxGap * MINUTE) {
      close();
    }
  }
  close();
  return sessions;
}
