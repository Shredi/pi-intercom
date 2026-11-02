const FULL_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_IN_PATH = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
export const DISCOVERY_TIMEOUT_MS = 5_000;

const REMOTE_ARGV_WORD = /^[A-Za-z0-9._:/\\ -]+$/;
const REMOTE_ARGV_MAX_WORDS = 8;

/** Returns why `value` is not a usable hc remote argv, or undefined. A word may contain spaces: hc passes argv without a shell. */
export function validateRemoteArgv(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > REMOTE_ARGV_MAX_WORDS) {
    return `must be an array of 1 to ${REMOTE_ARGV_MAX_WORDS} words`;
  }
  for (const word of value) {
    if (typeof word !== "string" || !REMOTE_ARGV_WORD.test(word)) {
      return "words must be strings of letters, digits, and . _ : / \\ space - only";
    }
  }
  if (value[0].trimStart().startsWith("-")) return "first word must not start with -";
  if (value[0].trim() === "") return "first word must not be blank";
  return undefined;
}

export interface SavedMachine {
  label: string;
  target: string;
  enabled: boolean;
}

export interface RemoteAgent {
  name: string;
  sessionId?: string;
  cwd?: string;
  /** Herdr agent_status, e.g. "idle" or "working". */
  status?: string;
}

export interface DiscoveredRemoteAgent {
  machine: SavedMachine;
  agent: RemoteAgent;
}

export interface DiscoveryDeps {
  run: (command: string, args: string[], stdin?: string, timeoutMs?: number) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
    timedOut?: boolean;
  }>;
  herdrBin: string;
  /** Machine source: Herdr saved machines (default) or herdr-core's `hc machine ls`. */
  transport?: "herdr" | "hc";
  hcBin?: string;
  discoveryTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonOutput(raw: string, operation: string): unknown {
  try {
    const parsed = JSON.parse(raw);
    if (isRecord(parsed) && "result" in parsed) return parsed.result;
    return parsed;
  } catch {
    throw new Error(`${operation} returned invalid JSON.`);
  }
}

export function parseSavedMachines(raw: string): SavedMachine[] {
  const value = parseJsonOutput(raw, "herdr machine list");
  const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.machines) ? value.machines : [];
  return rows.flatMap((row): SavedMachine[] => {
    if (!isRecord(row) || typeof row.label !== "string" || typeof row.target !== "string") return [];
    return [{ label: row.label, target: row.target, enabled: row.enabled !== false }];
  });
}

export function parseRemoteAgents(raw: string): RemoteAgent[] {
  const value = parseJsonOutput(raw, "herdr agent list");
  const rows = isRecord(value) && Array.isArray(value.agents) ? value.agents : [];
  return rows.flatMap((row): RemoteAgent[] => {
    if (!isRecord(row) || row.agent !== "pi") return [];
    const agentSession = isRecord(row.agent_session) ? row.agent_session : undefined;
    const sessionPath = agentSession?.kind === "path" && typeof agentSession.value === "string" ? agentSession.value : undefined;
    const sessionId = sessionPath?.match(SESSION_ID_IN_PATH)?.[1];
    // Herdr only reports a name for renamed panes; an unnamed Pi session is addressed by its session id.
    const name = typeof row.name === "string" && row.name ? row.name : sessionId;
    if (!name) return [];
    return [{
      name,
      ...(sessionId ? { sessionId } : {}),
      ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
      ...(typeof row.agent_status === "string" ? { status: row.agent_status } : {}),
    }];
  });
}

export function parseCrossMachineTarget(target: string): { agentTarget: string; machineLabel: string } {
  const parts = target.split("@");
  if (parts.length !== 2 || parts.some((part) => !part || /\s/.test(part))) {
    throw new Error(`Invalid remote target "${target}"; expected name@machine or full-session-uuid@machine.`);
  }
  return { agentTarget: parts[0], machineLabel: parts[1] };
}

/** Parses `hc machine ls --json`: {"machines": [{name, state, ...}]}. The machine name is the exact, case-sensitive label. */
export function parseHcMachines(raw: string): SavedMachine[] {
  const value = parseJsonOutput(raw, "hc machine ls");
  const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.machines) ? value.machines : [];
  return rows.flatMap((row): SavedMachine[] => {
    if (!isRecord(row) || typeof row.name !== "string" || !row.name) return [];
    return [{ label: row.name, target: row.name, enabled: row.enabled !== false && row.state !== "disabled" }];
  });
}

export async function listSavedMachines(deps: DiscoveryDeps): Promise<SavedMachine[]> {
  if (deps.transport === "hc") {
    const listed = await deps.run(deps.hcBin ?? "hc", ["machine", "ls", "--json"], undefined, deps.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS);
    if (listed.code !== 0) throw new Error(`Could not list hc machines: ${listed.timedOut ? "timed out" : listed.stderr.trim() || `exit ${listed.code}`}`);
    return parseHcMachines(listed.stdout);
  }
  const listed = await deps.run(deps.herdrBin, ["machine", "list", "--json"], undefined, deps.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS);
  if (listed.code !== 0) throw new Error(`Could not list Herdr saved machines: ${listed.timedOut ? "timed out" : listed.stderr.trim() || `exit ${listed.code}`}`);
  return parseSavedMachines(listed.stdout);
}

export async function listMachineAgents(machine: SavedMachine, deps: DiscoveryDeps): Promise<RemoteAgent[]> {
  const result = await deps.run(deps.herdrBin, ["--machine", machine.label, "agent", "list"], undefined, deps.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS);
  if (result.code !== 0) {
    // Herdr prints Rust debug errors: Error: Custom { kind: …, error: "machine 'x': reason" }.
    const herdrError = result.stderr.match(/error: "((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\(.)/g, "$1").replace(/^machine '[^']*': /, "");
    const detail = result.timedOut ? "timed out" : herdrError ?? (result.stderr.trim() || `exit ${result.code}`);
    const hint = /does not support machine API forwarding/.test(detail)
      ? ` Its running Herdr server is too old; update Herdr there, then run \`herdr --remote ${machine.target}\` in a terminal to replace the server.`
      : "";
    throw new Error(`Saved Herdr machine "${machine.label}" is unreachable: ${detail.replace(/\.$/, "")}.${hint}`);
  }
  try {
    return parseRemoteAgents(result.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid response";
    throw new Error(`Saved Herdr machine "${machine.label}" is unreachable: ${detail}`);
  }
}

export async function discoverRemoteAgent(target: string, deps: DiscoveryDeps): Promise<DiscoveredRemoteAgent> {
  const explicit = parseCrossMachineTarget(target);
  if (deps.transport === "hc") {
    // hc knows terminals, not Pi sessions: the remote broker resolves <name|uuid> inside `relay`.
    const selected = (await listSavedMachines(deps)).filter((machine) => machine.enabled && machine.label === explicit.machineLabel);
    if (selected.length === 0) {
      throw new Error(`hc machine "${explicit.machineLabel}" is unknown or disabled.`);
    }
    if (selected.length > 1) {
      throw new Error(`hc machine "${explicit.machineLabel}" is ambiguous; expected exactly one enabled machine.`);
    }
    const agent: RemoteAgent = FULL_SESSION_UUID.test(explicit.agentTarget)
      ? { name: explicit.agentTarget, sessionId: explicit.agentTarget }
      : { name: explicit.agentTarget };
    return { machine: selected[0]!, agent };
  }
  const selected = (await listSavedMachines(deps)).filter((machine) => (
    machine.enabled && machine.label.toLowerCase() === explicit.machineLabel.toLowerCase()
  ));
  if (selected.length === 0) {
    throw new Error(`Saved Herdr machine "${explicit.machineLabel}" is unknown or disabled.`);
  }
  if (selected.length > 1) {
    throw new Error(`Saved Herdr machine label "${explicit.machineLabel}" is ambiguous; expected exactly one enabled machine.`);
  }

  const machine = selected[0]!;
  const agents = await listMachineAgents(machine, deps);

  const bySessionId = FULL_SESSION_UUID.test(explicit.agentTarget);
  const matches = agents
    .filter((agent) => bySessionId
      ? agent.sessionId === explicit.agentTarget
      : agent.name.toLowerCase() === explicit.agentTarget.toLowerCase())
    .map((agent) => ({ machine, agent }));
  if (matches.length === 0) {
    throw new Error(`No live Pi agent on saved Herdr machine "${machine.label}" exactly matches "${explicit.agentTarget}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple live Pi agents on saved Herdr machine "${machine.label}" exactly match "${explicit.agentTarget}"; target is ambiguous.`);
  }

  return matches[0]!;
}
