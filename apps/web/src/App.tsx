import { useCallback, useEffect, useMemo, useState } from "react";
import {
  VERDICT_CLASS,
  VERDICT_LABEL,
  api,
  describeAction,
  formatAmount,
  runner,
  short,
  timeOf,
  type AgentInfo,
  type ApiKey,
  type CheckpointEvent,
  type Decision,
  type FeedEvent,
  type Outcome,
  type RequestRecord,
  type ScenarioInfo,
  type Usage,
} from "./api";

type View = "overview" | "lab" | "requests" | "keys" | "limits" | "verifiers";
const NAV: { id: View; label: string; hint: string }[] = [
  { id: "overview", label: "Live strips", hint: "Every action, as it happens" },
  { id: "lab", label: "Attack lab", hint: "Try to get past it" },
  { id: "requests", label: "Requests", hint: "The API log" },
  { id: "keys", label: "API keys", hint: "Create and revoke" },
  { id: "limits", label: "Owner limits", hint: "What the agent may do" },
  { id: "verifiers", label: "Verifiers", hint: "Who signs" },
];

function useAgent() {
  const [agent, setAgent] = useState<AgentInfo>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(() => {
    api<AgentInfo>("/v1/admin/agent").then(
      (a) => {
        setAgent(a);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(() => {
    refresh();
    // Keeps trying, so the dashboard recovers by itself when the API comes back.
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { agent, error, refresh };
}

function useFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  useEffect(() => {
    let cancelled = false;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const merge = (incoming: FeedEvent[]) =>
      setEvents((current) => {
        const known = new Set(current.map((e) => e.id));
        const added = incoming.filter((e) => !known.has(e.id));
        return added.length ? [...current, ...added].sort((a, b) => a.id - b.id) : current;
      });

    // EventSource stops for good after an error status, so this reconnects itself and refills what it missed.
    const connect = () => {
      if (cancelled) return;
      api<FeedEvent[]>("/v1/admin/events").then((initial) => {
        if (!cancelled) merge(initial);
      }, () => undefined);
      source = new EventSource("/api/v1/admin/feed");
      source.addEventListener("event", (message) => merge([JSON.parse((message as MessageEvent).data) as FeedEvent]));
      source.onerror = () => {
        source?.close();
        retry = setTimeout(connect, 2000);
      };
    };
    connect();

    return () => {
      cancelled = true;
      source?.close();
      if (retry) clearTimeout(retry);
    };
  }, []);
  return events;
}

export function App() {
  const [view, setView] = useState<View>(() => (location.hash.slice(1) as View) || "overview");
  const { agent, error, refresh } = useAgent();
  const events = useFeed();

  useEffect(() => {
    const onHash = () => setView((location.hash.slice(1) as View) || "overview");
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // Balances change whenever something lands on the chain.
  useEffect(refresh, [events.length, refresh]);

  const pending = useMemo(() => pendingCheckpoints(events), [events]);

  return (
    <div className="shell">
      <aside className="rail">
        <a className="mark" href="#overview">
          <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" /><path d="M8 17l5 5 11-12" /></svg>
          Clearance
        </a>
        <nav aria-label="Dashboard">
          {NAV.map((item) => (
            <a key={item.id} href={`#${item.id}`} className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined}>
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </a>
          ))}
        </nav>
        {agent && (
          <div className="agent-card">
            <div className="agent-name">{agent.name}</div>
            <code title={agent.account}>{short(agent.account)}</code>
            <ul>
              {agent.balances.filter((b) => b.raw !== "0").map((b) => (
                <li key={b.symbol}><span>{b.symbol}</span><span>{formatAmount(b.raw, b.decimals)}</span></li>
              ))}
            </ul>
          </div>
        )}
      </aside>
      <main className="stage">
        {error && <div className="notice bad" role="alert"><div><strong>The API isn't reachable.</strong> Start it with <code>pnpm start</code>. This page reconnects by itself.</div></div>}
        {pending[0] && <CheckpointBanner checkpoint={pending[0]} waiting={pending.length - 1} agent={agent} />}
        <Returned />
        {view === "overview" && <Overview events={events} agent={agent} />}
        {view === "lab" && <Lab />}
        {view === "requests" && <Requests agent={agent} />}
        {view === "keys" && <Keys />}
        {view === "limits" && <Limits agent={agent} onChange={refresh} />}
        {view === "verifiers" && <Verifiers />}
      </main>
    </div>
  );
}

function pendingCheckpoints(events: FeedEvent[]) {
  const latest = new Map<string, CheckpointEvent & { url?: string }>();
  for (const event of events) {
    if (event.type === "checkpoint") latest.set(event.data.id, { ...latest.get(event.data.id), ...event.data });
    if (event.type === "decision" && event.data.checkpoint) {
      latest.set(event.data.checkpoint.id, { ...latest.get(event.data.checkpoint.id), id: event.data.checkpoint.id, status: "pending", url: event.data.checkpoint.url, action: event.data.action });
    }
  }
  const fresh = events.filter((e) => Date.now() - e.at < 300_000);
  const freshIds = new Set(fresh.flatMap((e) => (e.type === "checkpoint" ? [e.data.id] : e.type === "decision" && e.data.checkpoint ? [e.data.checkpoint.id] : [])));
  return [...latest.values()].filter((c) => c.status === "pending" && freshIds.has(c.id) && c.url).reverse();
}

function CheckpointBanner({ checkpoint, waiting, agent }: { checkpoint: CheckpointEvent & { url?: string }; waiting: number; agent?: AgentInfo }) {
  const action = checkpoint.action && agent ? describeAction(checkpoint.action, agent.tokens) : undefined;
  return (
    <div className="notice human" role="status">
      <div>
        <strong>Your approval is needed.</strong>{" "}
        {action ? `The agent wants to ${action.verb.toLowerCase()} ${action.amount} ${action.detail}, which is over your limit.` : "The agent's request is over your limit."}
        {waiting > 0 && ` ${waiting} more waiting.`}
      </div>
      <a className="button human" href={checkpoint.url}>Review with World ID</a>
    </div>
  );
}

function Returned() {
  const [status] = useState(() => new URLSearchParams(location.search).get("status"));
  // Clear the address bar, so a reload doesn't repeat the message.
  useEffect(() => {
    if (status) history.replaceState(null, "", location.pathname + location.hash);
  }, [status]);
  if (!status) return null;
  return (
    <div className={`notice ${status === "approved" ? "ok" : "bad"}`} role="status">
      {status === "approved" ? "Approved. This one action can now go ahead." : "Not approved, so the action stays refused."}
    </div>
  );
}

// ---- Live strips ----

function Overview({ events, agent }: { events: FeedEvent[]; agent?: AgentInfo }) {
  const [usage, setUsage] = useState<Usage>();
  useEffect(() => {
    api<Usage>("/v1/admin/usage").then(setUsage, () => undefined);
  }, [events.length]);

  const strips = useMemo(() => {
    const outcomesAfter = new Map<number, Outcome[]>();
    const decisions = events.filter((e) => e.type === "decision") as Extract<FeedEvent, { type: "decision" }>[];
    for (const event of events) {
      if (event.type !== "outcome") continue;
      const owner = [...decisions].reverse().find((d) => (event.data.decisionId ? d.data.id === event.data.decisionId : d.id < event.id && d.data.action.kind === "swap"));
      if (!owner) continue;
      outcomesAfter.set(owner.id, [...(outcomesAfter.get(owner.id) ?? []), event.data]);
    }
    return [...decisions].reverse().map((d) => ({ event: d, outcomes: outcomesAfter.get(d.id) ?? [] }));
  }, [events]);

  return (
    <>
      <header className="page-head">
        <h1>Live strips</h1>
        <p>Each strip is one action an agent asked to take, and what happened to it.</p>
      </header>
      {usage && <UsageWindows usage={usage} />}
      {strips.length === 0 ? (
        <div className="empty">
          <h2>No actions yet</h2>
          <p>Point an agent at the API, or try to break it in the attack lab.</p>
          <a className="button" href="#lab">Open the attack lab</a>
        </div>
      ) : (
        <ol className="strips">
          {strips.map(({ event, outcomes }) => (
            <Strip key={event.id} decision={event.data} at={event.at} outcomes={outcomes} agent={agent} />
          ))}
        </ol>
      )}
    </>
  );
}

function UsageWindows({ usage }: { usage: Usage }) {
  const max = Math.max(1, ...usage.hourly.map((h) => h.cleared + h.refused + h.other));
  return (
    <section className="usage" aria-label="API usage">
      {[
        ["Last 15 minutes", usage.last15m],
        ["Last 24 hours", usage.last24h],
        ["Last 30 days", usage.last30d],
      ].map(([label, value]) => (
        <div key={label as string} className="window">
          <span>{label}</span>
          <b>{(value as number).toLocaleString()}</b>
        </div>
      ))}
      <div className="window hours" aria-label="Checks per hour, last 24 hours">
        <span>Checks per hour</span>
        <div className="bars">
          {usage.hourly.length === 0 && <small>Nothing in the last 24 hours</small>}
          {usage.hourly.map((h) => (
            <div key={h.hour} className="bar" title={`${new Date(h.hour).getHours()}:00. ${h.cleared} cleared, ${h.refused} refused, ${h.other} other`}>
              <i className="other" style={{ height: `${(h.other / max) * 100}%` }} />
              <i className="bad" style={{ height: `${(h.refused / max) * 100}%` }} />
              <i className="ok" style={{ height: `${(h.cleared / max) * 100}%` }} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Strip({ decision, at, outcomes, agent }: { decision: Decision; at: number; outcomes: Outcome[]; agent?: AgentInfo }) {
  const [open, setOpen] = useState(false);
  const action = describeAction(decision.action, agent?.tokens ?? {});
  const tone = VERDICT_CLASS[decision.verdict] ?? "other";
  const allowed = decision.evaluations.filter((e) => e.verdict === "ALLOW" || e.verdict === "REDUCE").length;
  const headline = [...new Set(decision.evaluations.flatMap((e) => e.reasons.filter((r) => r.severity !== "info").map((r) => r.detail)))][0];
  const tokenIn = decision.action.kind === "swap" ? (decision.action.zeroForOne ? decision.action.pool.currency0 : decision.action.pool.currency1) : undefined;

  return (
    <li className={`strip ${tone}`}>
      <button className="strip-main" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="stamp">{VERDICT_LABEL[decision.verdict]}</span>
        <span className="what">
          <b>{action.verb} {action.amount}</b> <span className="muted">{action.detail}</span>
          {headline && <small>{readable(headline, agent?.tokens)}</small>}
          {decision.verdict === "REDUCE" && decision.clearance && tokenIn && (
            <small>Cleared {formatAmount(decision.clearance.maxAmountIn, agent?.tokens[tokenIn]?.decimals ?? 18)} {agent?.tokens[tokenIn]?.symbol} instead</small>
          )}
        </span>
        <span className="sigs" aria-label={`${allowed} of ${decision.evaluations.length} verifiers signed, ${decision.required} needed`}>
          {decision.evaluations.map((e) => (
            <i key={e.verifier} className={VERDICT_CLASS[e.verdict]} />
          ))}
          {decision.unreachable.map((u) => <i key={u} className="off" />)}
          <small>{allowed} signed, {decision.required} needed</small>
        </span>
        <time>{timeOf(at)}</time>
      </button>
      {outcomes.length > 0 && (
        <ul className="legs">
          {outcomes.map((o, i) => (
            <li key={i} className={o.result}>
              <span className="leg-dot" />
              <span>{o.label}</span>
              <small>{friendly(o.detail)}</small>
            </li>
          ))}
        </ul>
      )}
      {open && <DecisionDetail decision={decision} tokens={agent?.tokens} />}
    </li>
  );
}

const friendly = (detail: string) => detail.replace(/Executed in (0x[0-9a-f]{6})[0-9a-f]+/, "Executed, tx $1…").replace(/^Reverted with /, "Reverted: ");

/** Shows a token's symbol, or a shortened address, instead of a full address in the middle of a sentence. */
function readable(text: string, tokens: AgentInfo["tokens"] = {}): string {
  return text.replace(/0x[0-9a-fA-F]{40}/g, (address) => tokens[address]?.symbol ?? short(address));
}

function DecisionDetail({ decision, tokens }: { decision: Decision; tokens?: AgentInfo["tokens"] }) {
  return (
    <div className="detail">
      {decision.action.reason && (
        <div className="quote"><span>The agent's stated reason. Treated as untrusted, and never read by the rules.</span><q>{decision.action.reason}</q></div>
      )}
      <div className="verifier-grid">
        {decision.evaluations.map((e) => (
          <div key={e.verifier} className="verifier-col">
            <header><code title={e.verifier}>{short(e.verifier)}</code><span className={`pill ${VERDICT_CLASS[e.verdict]}`}>{VERDICT_LABEL[e.verdict]}</span></header>
            <ul>{e.reasons.map((r, i) => <li key={i}>{readable(r.detail, tokens)}{r.source && <small> from {r.source}</small>}</li>)}</ul>
            <p className="model">
              {e.review.status === "ok" ? `${e.review.provider}: ${e.review.summary}` : e.review.status === "failed" ? `${e.review.provider} failed, so rules alone decided.` : "No model set up. Rules alone decided."}
            </p>
            <code className="hash" title={e.evidenceHash}>Evidence {short(e.evidenceHash, 10, 6)}</code>
          </div>
        ))}
      </div>
      <p className="detail-foot">
        <a href={`/api/v1/proofs/${decision.id}`} target="_blank" rel="noreferrer">Open the public proof</a>
        {decision.attestation && <span> Independent check: {decision.attestation.status}, by {decision.attestation.mode}.</span>}
      </p>
    </div>
  );
}

// ---- Attack lab ----

function Lab() {
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [running, setRunning] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const body = await runner<{ running?: string; scenarios: ScenarioInfo[] }>("/scenarios");
    setScenarios(body.scenarios);
    setRunning(body.running);
    return body.running;
  }, []);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
    const timer = setInterval(() => load().catch(() => undefined), 1500);
    return () => clearInterval(timer);
  }, [load]);

  async function run(id: string) {
    setError(undefined);
    try {
      await runner(`/run/${id}`, { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <header className="page-head">
        <h1>Attack lab</h1>
        <p>Each run sends real transactions to the test chain, then shows what the pool and the wallet did.</p>
      </header>
      {error && <div className="notice bad">{error}</div>}
      <ul className="scenarios">
        {scenarios.map((s) => {
          const state = running === s.id ? "running" : s.result ? (s.result.pass ? "pass" : "fail") : "idle";
          return (
            <li key={s.id} className={`scenario ${state}`}>
              <div className="scenario-head">
                <div>
                  <h2>{s.title}</h2>
                  <p>{s.description}{s.waitsForOwner ? " You answer the approval yourself." : ""}</p>
                </div>
                <button className="button" disabled={Boolean(running)} onClick={() => run(s.id)}>
                  {running === s.id ? "Running" : s.result ? "Run again" : "Run"}
                </button>
              </div>
              {s.result && (
                <ol className="checks">
                  {s.result.checks.map((c, i) => (
                    <li key={i} className={c.pass ? "pass" : "fail"}>
                      <span aria-hidden="true">{c.pass ? "✓" : "✕"}</span>
                      <div><b>{c.label}</b><small>{friendly(c.detail)}</small></div>
                    </li>
                  ))}
                  {s.result.error && <li className="fail"><span aria-hidden="true">✕</span><div><b>The run stopped</b><small>{s.result.error}</small></div></li>}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---- Requests ----

function Requests({ agent }: { agent?: AgentInfo }) {
  const [requests, setRequests] = useState<RequestRecord[]>([]);
  const [selected, setSelected] = useState<RequestRecord>();
  const [decision, setDecision] = useState<Decision>();

  useEffect(() => {
    const load = () => api<RequestRecord[]>("/v1/admin/requests").then(setRequests, () => undefined);
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setDecision(undefined);
    if (selected?.decisionId) api<Decision>(`/v1/admin/decisions/${selected.decisionId}`).then(setDecision, () => undefined);
  }, [selected]);

  const current = selected ?? requests[0];
  useEffect(() => {
    if (!selected && requests[0]) setSelected(requests[0]);
  }, [requests, selected]);

  return (
    <>
      <header className="page-head">
        <h1>Requests</h1>
        <p>Every call to the clearing API, newest first.</p>
      </header>
      {requests.length === 0 ? (
        <div className="empty"><h2>No requests yet</h2><p>Calls to the clearing API appear here.</p></div>
      ) : (
        <div className="split">
          <ul className="req-list">
            {requests.map((r) => (
              <li key={r.id}>
                <button className={current?.id === r.id ? "active" : ""} onClick={() => setSelected(r)}>
                  <span className={`code s${Math.floor(r.status / 100)}`}>{r.status}</span>
                  <code>{r.method} {r.path}</code>
                  <time>{timeOf(r.at)}</time>
                </button>
              </li>
            ))}
          </ul>
          {current && (
            <section className="req-detail" aria-label="Request detail">
              <h2><code>{current.method} {current.path}</code></h2>
              <dl>
                <dt>Status</dt><dd>{current.status}</dd>
                <dt>Paid with</dt><dd>{current.auth === "api_key" ? "API key" : current.auth === "x402" ? "x402 payment" : "No charge"}</dd>
                <dt>Time taken</dt><dd>{current.latencyMs} ms</dd>
                {current.verdict && <><dt>Verdict</dt><dd><span className={`pill ${VERDICT_CLASS[current.verdict]}`}>{VERDICT_LABEL[current.verdict]}</span></dd></>}
                {current.decisionId && <><dt>Decision</dt><dd><a href={`/api/v1/proofs/${current.decisionId}`} target="_blank" rel="noreferrer"><code>{current.decisionId}</code></a></dd></>}
              </dl>
              {current.status === 402 && <p className="muted">The server asked for payment here. The x402 client paid and retried, which appears as the next request.</p>}
              {decision && (
                <>
                  <p className="req-action">{(() => { const a = describeAction(decision.action, agent?.tokens ?? {}); return `${a.verb} ${a.amount} ${a.detail}`; })()}</p>
                  <DecisionDetail decision={decision} tokens={agent?.tokens} />
                </>
              )}
            </section>
          )}
        </div>
      )}
    </>
  );
}

// ---- Keys ----

function Keys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [quota, setQuota] = useState(0);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<ApiKey>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    api<{ keys: ApiKey[]; monthlyQuota: number }>("/v1/admin/keys").then((body) => {
      setKeys(body.keys);
      setQuota(body.monthlyQuota);
    }, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      setCreated(await api<ApiKey>("/v1/admin/keys", { method: "POST", body: JSON.stringify({ name }) }));
      setCopied(false);
      setName("");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function revoke(key: ApiKey) {
    if (!confirm(`Revoke "${key.name}"? Anything using it stops working.`)) return;
    await api(`/v1/admin/keys/${key.id}`, { method: "DELETE" });
    load();
  }

  return (
    <>
      <header className="page-head">
        <h1>API keys</h1>
        <p>A key includes {quota.toLocaleString()} checks a month. Without one, agents pay per check with x402.</p>
      </header>
      {error && <div className="notice bad">{error}</div>}
      <form className="inline-form" onSubmit={create}>
        <label>Key name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Trading agent" required maxLength={60} /></label>
        <button className="button">Create key</button>
      </form>
      {created?.secret && (
        <div className="secret" role="status">
          <h2>Copy this key now</h2>
          <p>It won't be shown again. Only its hash is stored.</p>
          <div className="secret-row">
            <code>{created.secret}</code>
            <button className="button quiet" onClick={() => { navigator.clipboard.writeText(created.secret!); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <pre>{`curl -X POST http://127.0.0.1:18787/v1/clear/swap \\
  -H "authorization: Bearer ${created.secret}" \\
  -H "content-type: application/json" \\
  -d @swap.json`}</pre>
        </div>
      )}
      {keys.length === 0 ? (
        <div className="empty"><h2>No keys yet</h2><p>Create one to call the API without paying per check.</p></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th><span className="sr">Actions</span></th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className={k.revokedAt ? "revoked" : ""}>
                  <td>{k.name}</td>
                  <td><code>clr_••••{k.hint}</code></td>
                  <td>{new Date(k.createdAt).toLocaleDateString("en-GB")}</td>
                  <td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString("en-GB") : "Never"}</td>
                  <td className="right">{k.revokedAt ? <span className="muted">Revoked</span> : <button className="link danger" onClick={() => revoke(k)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---- Limits ----

function Limits({ agent, onChange }: { agent?: AgentInfo; onChange: () => void }) {
  const [form, setForm] = useState({ maxSizeUsd: "", humanCapUsd: "", maxImpactBps: "" });
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (agent?.limits) {
      setForm({
        maxSizeUsd: String(agent.limits.maxSizeUsd),
        humanCapUsd: String(agent.limits.humanCapUsd),
        maxImpactBps: String(agent.limits.maxImpactBps),
      });
    }
  }, [agent?.limits?.maxSizeUsd, agent?.limits?.humanCapUsd, agent?.limits?.maxImpactBps]);

  if (!agent) return null;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      await api("/v1/admin/limits", {
        method: "POST",
        body: JSON.stringify({
          maxSizeUsd: Number(form.maxSizeUsd),
          humanCapUsd: Number(form.humanCapUsd),
          maxImpactBps: Number(form.maxImpactBps),
        }),
      });
      setSaved(true);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const field = (key: keyof typeof form, label: string, help: string, record: string, unit: string) => (
    <label className="limit">
      <span>{label}</span>
      <div className="with-unit"><input type="number" min="0" value={form[key]} disabled={!agent.canEditLimits} onChange={(e) => setForm({ ...form, [key]: e.target.value })} required /><em>{unit}</em></div>
      <small>{help}</small>
      <code>{record}</code>
    </label>
  );

  const tokenName = (a: string) => agent.tokens[a]?.symbol ?? short(a);

  return (
    <>
      <header className="page-head">
        <h1>Owner limits</h1>
        <p>These live in <code>{agent.name}</code>'s ENS records, so every verifier reads them from the chain, and only the owner's wallet can change them.</p>
      </header>
      {!agent.limits && <div className="notice bad">A limit record is missing or invalid, so every action is being refused.</div>}
      <form className="limits-form" onSubmit={save}>
        {field("maxSizeUsd", "Trade without asking me", "Above this, you approve each trade with World ID.", "clearance.maxSizeUsd", "USD")}
        {field("humanCapUsd", "Never trade above", "A hard cap. Even your approval can't exceed it.", "clearance.humanCapUsd", "USD")}
        {field("maxImpactBps", "Largest price impact", "Bigger trades get reduced. 100 is 1%.", "clearance.maxImpactBps", "bps")}
        {agent.canEditLimits ? (
          <div className="form-foot">
            <button className="button" disabled={saving}>{saving ? "Writing to the chain" : "Save limits"}</button>
            {saved && <span role="status">Saved. The next check uses these.</span>}
            {error && <span className="bad-text">{error}</span>}
          </div>
        ) : <p className="muted">Change these from the owner's wallet.</p>}
      </form>
      {agent.limits && (
        <dl className="facts">
          <dt>Tokens it may trade</dt><dd>{agent.limits.allowedTokens.map(tokenName).join(", ") || "None"}</dd>
          <dt>Who it may pay</dt><dd>{agent.limits.allowedPayees.map((p) => short(p)).join(", ") || "Nobody"}, up to ${agent.limits.maxPaymentUsd} each</dd>
          <dt>Signatures needed</dt><dd>{Math.max(agent.limits.requiredVerifiers, agent.threshold)} of {agent.verifierCount}</dd>
          <dt>Bound wallet</dt><dd><code>{agent.limits.account}</code></dd>
          <dt>Hook</dt><dd><code>{agent.hook}</code></dd>
          <dt>Independent check ledger</dt><dd><code>{agent.ledger}</code></dd>
        </dl>
      )}
    </>
  );
}

// ---- Verifiers ----

function Verifiers() {
  const [verifiers, setVerifiers] = useState<{ online: boolean; address?: string; provider?: string }[]>([]);
  const [record, setRecord] = useState<{ verdicts: Record<string, number>; attested: number; attestationRefused: number; verifiers: { address: string; evaluated: number; dissented: number }[] }>();

  useEffect(() => {
    const load = () => {
      api<typeof verifiers>("/v1/admin/verifiers").then(setVerifiers, () => undefined);
      api<NonNullable<typeof record>>("/v1/track-record").then(setRecord, () => undefined);
    };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <header className="page-head">
        <h1>Verifiers</h1>
        <p>Each one reads the data itself. A verifier that disagrees with the others shows up here.</p>
      </header>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Verifier</th><th>Status</th><th>Model</th><th className="right">Checks</th><th className="right">Disagreed</th></tr></thead>
          <tbody>
            {verifiers.map((v, i) => {
              const stats = record?.verifiers.find((s) => s.address === v.address);
              return (
                <tr key={i}>
                  <td>{v.address ? <code>{short(v.address, 10, 6)}</code> : `Verifier ${i + 1}`}</td>
                  <td><span className={`pill ${v.online ? "ok" : "bad"}`}>{v.online ? "Online" : "Offline"}</span></td>
                  <td>{v.provider && v.provider !== "none" ? v.provider : <span className="muted">Rules only. Add a provider key to turn on review.</span>}</td>
                  <td className="right">{stats?.evaluated ?? 0}</td>
                  <td className="right">{stats?.dissented ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {record && (
        <dl className="facts">
          <dt>Cleared</dt><dd>{(record.verdicts.ALLOW ?? 0) + (record.verdicts.REDUCE ?? 0)}</dd>
          <dt>Refused</dt><dd>{record.verdicts.BLOCK ?? 0}</dd>
          <dt>Sent to the owner</dt><dd>{record.verdicts.HUMAN_REQUIRED ?? 0}</dd>
          <dt>Independent checks passed</dt><dd>{record.attested}</dd>
          <dt>Independent checks refused</dt><dd>{record.attestationRefused}</dd>
        </dl>
      )}
    </>
  );
}
