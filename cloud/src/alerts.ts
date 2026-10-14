export type AlertOp = "gt" | "gte" | "lt" | "lte" | "eq";
export type AlertMetric = "heart_rate" | "battery" | "offline" | "event" | "glucose";

export interface AlertRule {
  id: string;
  device_id: string | null;
  name: string;
  metric: AlertMetric;
  op: AlertOp;
  threshold: number | null;
  match: string | null;
  duration_s: number;
  cooldown_s: number;
  severity: "info" | "warning" | "critical";
  action: string;
  enabled: number;
}

export interface RuleState {
  /** Desde quando a condição está verdadeira sem interrupção. */
  since: number | null;
  lastFired: number | null;
}

export function compare(op: AlertOp, value: number, threshold: number): boolean {
  switch (op) {
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "eq": return value === threshold;
  }
}

/**
 * Avança a máquina de estados de uma regra com uma nova observação.
 * `holds` = a condição está verdadeira agora. Dispara quando ela se mantém por
 * `duration_s` e respeita o `cooldown_s` desde o último disparo.
 */
export function stepRule(rule: Pick<AlertRule, "duration_s" | "cooldown_s">, state: RuleState, holds: boolean, now: number): { fire: boolean; state: RuleState } {
  if (!holds) return { fire: false, state: state.since === null ? state : { ...state, since: null } };
  const since = state.since ?? now;
  const heldLongEnough = now - since >= rule.duration_s * 1000;
  const cooled = state.lastFired === null || now - state.lastFired >= rule.cooldown_s * 1000;
  if (heldLongEnough && cooled) return { fire: true, state: { since, lastFired: now } };
  return { fire: false, state: { since, lastFired: state.lastFired } };
}

export function describeRule(rule: AlertRule, value: number | string | null): string {
  const ops: Record<AlertOp, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" };
  switch (rule.metric) {
    case "heart_rate":
      return `Frequência cardíaca ${value} bpm (${ops[rule.op]} ${rule.threshold}${rule.duration_s ? ` por ${rule.duration_s}s` : ""})`;
    case "battery":
      return `Bateria da pulseira em ${value}% (${ops[rule.op]} ${rule.threshold}%)`;
    case "offline":
      return `Pulseira offline há ${value}s (limite ${rule.threshold}s)`;
    case "event":
      return `Evento '${rule.match}' registrado pela pulseira`;
    case "glucose":
      return `Glicemia ${value} mmol/L (${ops[rule.op]} ${rule.threshold} mmol/L)`;
  }
}
