import { SELF } from "cloudflare:test";

export const ADMIN = "test-admin-key";

export async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await SELF.fetch(`https://cloud.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${opts.token ?? ADMIN}`,
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* csv etc. */ }
  return { status: res.status, json, text };
}

export class Sock {
  messages: any[] = [];
  private waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
  constructor(public ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string);
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
  }
  send(obj: unknown) { this.ws.send(JSON.stringify(obj)); }
  /** Espera uma mensagem (já recebida ou futura) que satisfaça o predicado. */
  waitFor(pred: (m: any) => boolean, ms = 5000): Promise<any> {
    const have = this.messages.find(pred);
    if (have) return Promise.resolve(have);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout; recebido: ${JSON.stringify(this.messages)}`)), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  close() { try { this.ws.close(1000); } catch { /* ok */ } }
}

export async function openSocket(path: string, token: string): Promise<Sock> {
  const res = await SELF.fetch(`https://cloud.test${path}`, { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } });
  if (res.status !== 101 || !res.webSocket) throw new Error(`WS ${path} falhou: ${res.status} ${await res.text()}`);
  return new Sock(res.webSocket);
}

export const TERM_VERSION = "2026.1";

/** Publica (uma vez) o termo de teste. */
export async function ensureTerm() {
  const r = await call("POST", "/v1/consent/terms", {
    body: { version: TERM_VERSION, title: "Termo de participação (teste)", content: "Conteúdo de teste do termo de participação, apenas para os testes automatizados." },
  });
  if (r.status !== 201 && r.status !== 409) throw new Error(JSON.stringify(r));
}

/** Cria uma pulseira autorizada e com consentimento válido (pronta para enviar telemetria). */
export async function newDevice(name = "Paciente Teste") {
  const r = await call("POST", "/v1/devices", { body: { name, patient_ref: `ref-${name}` } });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  await ensureTerm();
  const consent = await call("POST", "/v1/consent", { token: r.json.device_token, body: { version: TERM_VERSION, accepted: true } });
  if (consent.status !== 200) throw new Error(JSON.stringify(consent));
  return { id: r.json.id as string, token: r.json.device_token as string };
}
