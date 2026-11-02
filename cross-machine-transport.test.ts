import test from "node:test";
import assert from "node:assert/strict";
import { DISCOVERY_TIMEOUT_MS } from "./cross-machine-discovery.ts";
import {
  DELIVERY_TIMEOUT_MS,
  runCommand,
  sendCrossMachine,
  type CommandRunner,
} from "./cross-machine-transport.ts";

const fakeSessionId = "00000000-0000-4000-8000-000000000001";
const machines = JSON.stringify([{ label: "workstation", target: "workstation.example", enabled: true }]);
const agents = JSON.stringify({ id: "cli:agent:list", result: { agents: [{
  agent: "pi",
  name: "reviewer",
  agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: `/home/user/.pi/agent/sessions/session_${fakeSessionId}.jsonl` },
}] } });
const origin = { name: "worker", sessionId: fakeSessionId, machine: "laptop" };
const intercomList = JSON.stringify({ ok: true, sessions: [{ name: "host", id: fakeSessionId, model: "m", cwd: "/" }] });

function discoveryResult(command: string, args: string[]) {
  if (args[0] === "machine") return { code: 0, stdout: machines, stderr: "" };
  if (command === "herdr") return { code: 0, stdout: agents, stderr: "" };
  return undefined;
}

test("discovers only the selected machine and sends hostile message text only on stdin", async () => {
  const calls: Array<{ command: string; args: string[]; stdin?: string; timeoutMs?: number }> = [];
  const run: CommandRunner = async (command, args, stdin, timeoutMs) => {
    calls.push({ command, args, stdin, timeoutMs });
    if (command === "herdr" && args[0] === "machine") {
      return { code: 0, stdout: JSON.stringify([
        { label: "laptop", target: "laptop.example", enabled: true },
        { label: "workstation", target: "workstation.example", enabled: true },
        { label: "disabled", target: "disabled.example", enabled: false },
      ]), stderr: "" };
    }
    if (command === "herdr") {
      return args[1] === "workstation" ? { code: 0, stdout: agents, stderr: "" } : { code: 0, stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" };
    }
    return { code: 0, stdout: '{"ok":true}', stderr: "" };
  };
  const hostileText = 'hello; $(touch /tmp/nope)\n"quoted" && exit 9';
  const result = await sendCrossMachine("reviewer@workstation", hostileText, origin, {
    run,
    herdrBin: "herdr",
    remoteCommand: "/opt/pi tools/pi-intercom --profile trusted",
  });
  assert.equal(result.machine.label, "workstation");
  assert.equal(calls.some((call) => call.args.includes("disabled")), false);
  const ssh = calls.at(-1)!;
  assert.equal(ssh.command, "ssh");
  assert.deepEqual(ssh.args, ["workstation.example", "/opt/pi tools/pi-intercom --profile trusted relay --envelope-stdin --json"]);
  assert.equal(ssh.args.some((arg) => arg.includes(hostileText)), false);
  assert.equal(JSON.parse(ssh.stdin!).text, hostileText);
  assert.equal(ssh.timeoutMs, DELIVERY_TIMEOUT_MS);
  assert.equal(calls.filter((call) => call.command === "herdr").every((call) => call.timeoutMs === DISCOVERY_TIMEOUT_MS), true);
});

test("delivers to a machine without Herdr over non-interactive SSH, addressed by session id", async () => {
  const sshCalls: Array<{ args: string[]; stdin?: string }> = [];
  const run: CommandRunner = async (command, args, stdin) => {
    if (command === "herdr") throw Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" });
    sshCalls.push({ args, stdin });
    return { code: 0, stdout: args.at(-1)!.endsWith(" list --json") ? intercomList : '{"ok":true}', stderr: "" };
  };
  const result = await sendCrossMachine("host@buildbox", "hi", origin, { run, herdrBin: "herdr", remoteCommand: "pi-intercom" });
  assert.equal(result.machine.label, "buildbox");
  assert.deepEqual(sshCalls.at(-1)!.args, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "buildbox", "pi-intercom relay --envelope-stdin --json"]);
  assert.equal(JSON.parse(sshCalls.at(-1)!.stdin!).target, fakeSessionId);
});

test("finds a Pi session outside a Herdr pane in a saved machine's intercom roster over the saved SSH target", async () => {
  const sshCalls: string[][] = [];
  const run: CommandRunner = async (command, args) => {
    if (command === "herdr") {
      return args[0] === "machine" ? { code: 0, stdout: machines, stderr: "" } : { code: 0, stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" };
    }
    sshCalls.push(args);
    return { code: 0, stdout: args.at(-1)!.endsWith(" list --json") ? intercomList : '{"ok":true}', stderr: "" };
  };
  const result = await sendCrossMachine("host@workstation", "hi", origin, { run, herdrBin: "herdr", remoteCommand: "pi-intercom" });
  assert.equal(result.machine.label, "workstation");
  assert.deepEqual(sshCalls, [
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "workstation.example", "pi-intercom list --json"],
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "workstation.example", "pi-intercom relay --envelope-stdin --json"],
  ]);
});

test("rejects empty or control-character remote commands before invoking SSH", async () => {
  for (const remoteCommand of ["", "   ", "pi-intercom\0--bad", "pi-intercom\t--bad", "pi-intercom\x1f--bad", "pi-intercom\x7f--bad"]) {
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push(command);
      return discoveryResult(command, args) ?? { code: 0, stdout: '{"ok":true}', stderr: "" };
    };
    await assert.rejects(
      sendCrossMachine("reviewer@workstation", "hi", origin, { run, herdrBin: "herdr", remoteCommand }),
      /Remote command must (not be empty|not contain ASCII control characters)/,
    );
    assert.equal(calls.includes("ssh"), false);
  }
});

test("runCommand returns an awaitable timeout result after terminating its child", async () => {
  const started = Date.now();
  const result = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], undefined, 30);
  assert.deepEqual(result, { stdout: "", stderr: "", code: 124, timedOut: true });
  assert.ok(Date.now() - started < 2_000, "timed-out child should be reaped promptly");
});

test("runCommand rejects once when spawning fails", async () => {
  await assert.rejects(runCommand("/definitely/not/a/command", [], undefined, 100), /ENOENT/);
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("runCommand delivers all stdin to a reading child", async () => {
  const input = "hello π\n".repeat(32 * 1024);
  const result = await runCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], input, 5_000);
  assert.deepEqual(result, { stdout: input, stderr: "", code: 0 });
});

test("runCommand preserves diagnostics when a failing child closes stdin early", async () => {
  const result = await runCommand(process.execPath, ["-e", `
    require("node:fs").closeSync(0);
    process.stdout.write('{"ok":false,"error":"relay unavailable"}');
    process.stderr.write("relay unavailable");
    process.exitCode = 7;
  `], "x".repeat(1024 * 1024), 5_000);
  assert.deepEqual(result, {
    stdout: '{"ok":false,"error":"relay unavailable"}',
    stderr: "relay unavailable",
    code: 7,
  });
});

test("runCommand rejects incomplete stdin even when the child exits successfully", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", 'require("node:fs").closeSync(0)'], "x".repeat(1024 * 1024), 5_000),
    /EPIPE|EOF|ECONNRESET|closed|destroyed/i,
  );
});

test("runCommand still reaps a child that closes stdin and then times out", async () => {
  const result = await runCommand(process.execPath, ["-e", `
    require("node:fs").closeSync(0);
    process.stderr.write("stdin closed");
    setTimeout(() => process.exit(8), 10_000);
  `], "x".repeat(1024 * 1024), 1_000);
  assert.deepEqual(result, { stdout: "", stderr: "stdin closed", code: 124, timedOut: true });
});

test("non-JSON and incompatible remote output report incompatible relay support", async () => {
  for (const stdout of ["", '{"ok":"yes"}', '{"version":2,"ok":true}']) {
    const run: CommandRunner = async (command, args) => discoveryResult(command, args) ?? { code: 1, stdout, stderr: "unknown command: relay" };
    await assert.rejects(
      sendCrossMachine("reviewer@workstation", "hi", origin, { run, herdrBin: "herdr" }),
      /no compatible relay support and needs upgrading/,
    );
  }
});

test("structured remote failure preserves the reported error", async () => {
  const run: CommandRunner = async (command, args) => discoveryResult(command, args) ?? {
    code: 1,
    stdout: JSON.stringify({ ok: false, error: "target rejected the envelope version" }),
    stderr: "",
  };
  await assert.rejects(
    sendCrossMachine("reviewer@workstation", "hi", origin, { run, herdrBin: "herdr" }),
    /Remote intercom delivery via workstation failed: target rejected the envelope version/,
  );
});

const hcMachines = JSON.stringify({ machines: [
  { host: "h1.example", id: "m-1", name: "Workstation", session: "s1", state: "up", target: "Workstation", temporary: false, version: "1", via: "ssh" },
  { host: "h2.example", id: "m-2", name: "parked", session: "s1", state: "disabled", target: "parked", temporary: false, version: "1", via: "ssh" },
] });
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const hcReply = (relayStdout: string, code = 0, extra: Record<string, unknown> = {}) => JSON.stringify({
  code, ms: 5, signal: null, stderr: "", stdout: b64(relayStdout), timed_out: false, truncated: false, ...extra,
});

type Call = { command: string; args: string[]; stdin?: string; timeoutMs?: number };
function hcRunner(execReply: () => { code: number; stdout: string; stderr?: string; timedOut?: boolean }, calls: Call[] = []): CommandRunner {
  return async (command, args, stdin, timeoutMs) => {
    calls.push({ command, args, stdin, timeoutMs });
    if (args[0] === "machine") return { code: 0, stdout: hcMachines, stderr: "" };
    return { stderr: "", ...execReply() };
  };
}

test("hc transport lists machines, runs hc exec without a shell and decodes the relay reply", async () => {
  const calls: Call[] = [];
  const run = hcRunner(() => ({ code: 0, stdout: hcReply('{"ok":true,"version":1}\n') }), calls);
  const hostileText = 'hello; $(touch /tmp/nope)\n"quoted" äöü';
  const result = await sendCrossMachine("reviewer@Workstation", hostileText, origin, {
    run,
    transport: "hc",
    hcBin: "hc-bin",
    remoteArgv: ["C:/Program Files/nodejs/node.exe", "C:/pi tools/cli.mjs"],
  });
  assert.equal(result.machine.label, "Workstation");
  assert.equal(result.stdout, '{"ok":true,"version":1}\n');
  assert.equal(calls.length, 2, "machine list plus exec; no agent listing");
  assert.deepEqual([calls[0]!.command, calls[0]!.args], ["hc-bin", ["machine", "ls", "--json"]]);
  assert.equal(calls[0]!.timeoutMs, DISCOVERY_TIMEOUT_MS);
  const exec = calls[1]!;
  assert.equal(exec.command, "hc-bin");
  assert.deepEqual(exec.args, [
    "exec", "--on", "Workstation", "--timeout", "15", "-i", "--json", "--",
    "C:/Program Files/nodejs/node.exe", "C:/pi tools/cli.mjs", "relay", "--envelope-stdin", "--json",
  ]);
  assert.equal(exec.args.some((arg) => arg.includes(hostileText)), false);
  assert.equal(JSON.parse(exec.stdin!).text, hostileText);
  assert.equal(JSON.parse(exec.stdin!).target, "reviewer");
  assert.ok(exec.timeoutMs! >= DELIVERY_TIMEOUT_MS);
});

test("hc transport sends the same envelope bytes as the herdr transport", async () => {
  const stdins: Record<string, string | undefined> = {};
  const herdrRun: CommandRunner = async (command, args, stdin) => {
    if (command === "ssh") { stdins.herdr = stdin; return { code: 0, stdout: '{"ok":true}', stderr: "" }; }
    return discoveryResult(command, args) ?? { code: 0, stdout: "{}", stderr: "" };
  };
  const hcRun: CommandRunner = async (command, args, stdin) => {
    if (args[0] === "machine") return { code: 0, stdout: JSON.stringify({ machines: [{ name: "workstation", state: "up" }] }), stderr: "" };
    stdins.hc = stdin;
    return { code: 0, stdout: hcReply('{"ok":true}'), stderr: "" };
  };
  await sendCrossMachine("reviewer@workstation", "same text", origin, { run: herdrRun, herdrBin: "herdr" });
  await sendCrossMachine("reviewer@workstation", "same text", origin, { run: hcRun, transport: "hc" });
  // The herdr discovery resolves the session id; use the same target form so both envelopes name the same target.
  const herdr = JSON.parse(stdins.herdr!);
  const hc = JSON.parse(stdins.hc!);
  assert.equal(herdr.target, "00000000-0000-4000-8000-000000000001");
  assert.equal(hc.target, "reviewer");
  herdr.target = hc.target;
  assert.equal(JSON.stringify(herdr), JSON.stringify(hc));
  assert.equal(hc.version, 1);
  assert.equal(hc.trust, "ssh-asserted");
  assert.equal(hc.origin.machine, "laptop");
  assert.ok(stdins.hc!.endsWith("\n"));

  const uuidTarget = `${origin.sessionId}@workstation`;
  await sendCrossMachine(uuidTarget, "same text", origin, { run: herdrRun, herdrBin: "herdr" });
  await sendCrossMachine(uuidTarget, "same text", origin, { run: hcRun, transport: "hc" });
  assert.equal(stdins.hc, stdins.herdr, "identical bytes for a session-id target");
});

test("hc transport matches machine names exactly and refuses unknown or disabled machines", async () => {
  const run = hcRunner(() => ({ code: 0, stdout: hcReply('{"ok":true}') }));
  for (const machine of ["workstation", "WORKSTATION", "parked", "missing"]) {
    await assert.rejects(
      sendCrossMachine(`reviewer@${machine}`, "hi", origin, { run, transport: "hc" }),
      new RegExp(`hc machine "${machine}" is unknown or disabled`),
    );
  }
  const twice: CommandRunner = async () => ({ code: 0, stdout: JSON.stringify({ machines: [{ name: "a" }, { name: "a" }] }), stderr: "" });
  await assert.rejects(sendCrossMachine("x@a", "hi", origin, { run: twice, transport: "hc" }), /hc machine "a" is ambiguous/);
});

test("hc transport reports timeouts, hc failures and incompatible relays", async () => {
  const send = (execReply: Parameters<typeof hcRunner>[0]) => sendCrossMachine("reviewer@Workstation", "hi", origin, { run: hcRunner(execReply), transport: "hc" });
  await assert.rejects(send(() => ({ code: 124, stdout: "", timedOut: true })), /via Workstation failed: timed out/);
  await assert.rejects(send(() => ({ code: 0, stdout: hcReply("", 0, { timed_out: true }) })), /via Workstation failed: timed out/);
  await assert.rejects(
    send(() => ({ code: 1, stdout: "", stderr: JSON.stringify({ error: { hint: "", kind: "unreachable", message: "machine is down" } }) })),
    /via Workstation failed: hc: machine is down/,
  );
  await assert.rejects(send(() => ({ code: 0, stdout: hcReply("unknown command: relay", 1) })), /no compatible relay support and needs upgrading/);
  await assert.rejects(send(() => ({ code: 0, stdout: hcReply('{"version":2,"ok":true}') })), /no compatible relay support/);
  await assert.rejects(send(() => ({ code: 0, stdout: "not json" })), /no compatible relay support/);
  await assert.rejects(
    send(() => ({ code: 0, stdout: hcReply(JSON.stringify({ ok: false, error: "no such session" }), 1) })),
    /Remote intercom delivery via Workstation failed: no such session/,
  );
});

test("hc transport refuses an invalid remote argv before running anything", async () => {
  const calls: Call[] = [];
  const run = hcRunner(() => ({ code: 0, stdout: hcReply('{"ok":true}') }), calls);
  await assert.rejects(
    sendCrossMachine("reviewer@Workstation", "hi", origin, { run, transport: "hc", remoteArgv: ["node", "a;b"] }),
    /Remote argv/,
  );
  assert.equal(calls.some((call) => call.args[0] === "exec"), false);
});

test("hc transport never calls herdr or ssh and ignores the remote command", async () => {
  const calls: Call[] = [];
  const run = hcRunner(() => ({ code: 0, stdout: hcReply('{"ok":true,"version":1}\n') }), calls);
  await sendCrossMachine("reviewer@Workstation", "hi", origin, { run, transport: "hc", remoteCommand: "" });
  assert.deepEqual(calls.map((call) => call.command), ["hc", "hc"]);
  // An unknown hc machine is not retried as a plain SSH host.
  await assert.rejects(sendCrossMachine("reviewer@buildbox", "hi", origin, { run, transport: "hc" }), /hc machine "buildbox" is unknown or disabled/);
  assert.equal(calls.some((call) => call.command === "ssh" || call.command === "herdr"), false);
});

test("hc transport surfaces a stdin failure from the runner", async () => {
  const run: CommandRunner = async (_command, args) => {
    if (args[0] === "machine") return { code: 0, stdout: hcMachines, stderr: "" };
    throw new Error("write EPIPE");
  };
  await assert.rejects(sendCrossMachine("reviewer@Workstation", "hi", origin, { run, transport: "hc" }), /EPIPE/);
});

test("hc transport reports a non-zero hc exit with a non-JSON stdout", async () => {
  const run = hcRunner(() => ({ code: 3, stdout: "", stderr: JSON.stringify({ error: { message: "machine is down" } }) }));
  await assert.rejects(
    sendCrossMachine("reviewer@Workstation", "hi", origin, { run, transport: "hc" }),
    /via Workstation failed: hc: machine is down/,
  );
});
