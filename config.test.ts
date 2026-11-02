import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfigPath, loadConfig } from "./config.ts";

async function withAgentDir<T>(agentDir: string, fn: () => T | Promise<T>): Promise<T> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await fn();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

test("getConfigPath uses the centralized intercom runtime directory", () => {
  assert.equal(getConfigPath("/tmp/pi-agent/intercom"), join("/tmp/pi-agent", "intercom", "config.json"));
});

test("loadConfig reads config below PI_CODING_AGENT_DIR", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));

  try {
    const intercomDir = join(root, "intercom");
    mkdirSync(intercomDir, { recursive: true });
    writeFileSync(join(intercomDir, "config.json"), JSON.stringify({ status: "platform-test" }));

    await withAgentDir(root, () => {
      assert.equal(loadConfig().status, "platform-test");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig defaults inboundTrigger to current auto-trigger behavior", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    await withAgentDir(root, () => {
      assert.equal(loadConfig().inboundTrigger, "always");
      assert.equal(loadConfig().busyDelivery, "steer");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig defaults cross-machine routing", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    await withAgentDir(root, () => {
      const config = loadConfig().crossMachine;
      assert.equal(config.remoteCommand, "pi-intercom");
      assert.equal(config.machineName.length > 0, true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig accepts cross-machine overrides", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ crossMachine: {
      machineName: "laptop",
      remoteCommand: "/opt/tools/pi-intercom",
    } }));
    await withAgentDir(root, () => {
      assert.deepEqual(loadConfig().crossMachine, {
        machineName: "laptop",
        remoteCommand: "/opt/tools/pi-intercom",
        transport: "herdr",
        hcBin: process.env.HC_BIN?.trim() || "hc",
        remoteArgv: ["pi-intercom"],
      });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function withCrossMachine<T>(crossMachine: unknown, fn: () => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ crossMachine }));
    return await withAgentDir(root, fn);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("loadConfig defaults the hc transport keys and accepts overrides", async () => {
  const previous = process.env.HC_BIN;
  delete process.env.HC_BIN;
  try {
    const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
    try {
      await withAgentDir(root, () => {
        const config = loadConfig().crossMachine;
        assert.equal(config.transport, "herdr");
        assert.equal(config.hcBin, "hc");
        assert.deepEqual(config.remoteArgv, ["pi-intercom"]);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const remoteArgv = ["C:/Program Files/nodejs/node.exe", "C:\\tools\\pi-intercom\\cli.mjs"];
    await withCrossMachine({ transport: "hc", hcBin: "/opt/bin/hc", remoteArgv }, () => {
      const config = loadConfig().crossMachine;
      assert.deepEqual([config.transport, config.hcBin, config.remoteArgv], ["hc", "/opt/bin/hc", remoteArgv]);
    });
    process.env.HC_BIN = "/env/hc";
    await withCrossMachine({ hcBin: "/opt/bin/hc" }, () => assert.equal(loadConfig().crossMachine.hcBin, "/env/hc"));
  } finally {
    if (previous === undefined) delete process.env.HC_BIN;
    else process.env.HC_BIN = previous;
  }
});

test("loadConfig rejects invalid hc transport keys by name", async () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ transport: "ssh" }, /"crossMachine.transport" must be "herdr" or "hc"/],
    [{ hcBin: " " }, /"crossMachine.hcBin" must be a non-empty string/],
    [{ remoteArgv: [] }, /"crossMachine.remoteArgv" must be an array of 1 to 8 words/],
    [{ remoteArgv: "pi-intercom" }, /"crossMachine.remoteArgv" must be an array/],
    [{ remoteArgv: Array.from({ length: 9 }, () => "a") }, /"crossMachine.remoteArgv" must be an array of 1 to 8 words/],
    [{ remoteArgv: ["node", "a;b"] }, /"crossMachine.remoteArgv" words must be strings/],
    [{ remoteArgv: ["node", 7] }, /"crossMachine.remoteArgv" words must be strings/],
    [{ remoteArgv: ["-x"] }, /"crossMachine.remoteArgv" first word must not start with -/],
  ];
  for (const [crossMachine, pattern] of cases) {
    await withCrossMachine(crossMachine, () => assert.throws(() => loadConfig(), pattern));
  }
  await withCrossMachine({ remoteArgv: Array.from({ length: 8 }, () => "a") }, () => assert.equal(loadConfig().crossMachine.remoteArgv.length, 8));
});

test("loadConfig refuses a remoteArgv first word starting with - after leading spaces", async () => {
  await withCrossMachine({ remoteArgv: [" -x"] }, () =>
    assert.throws(() => loadConfig(), /"crossMachine.remoteArgv" first word must not start with -/));
  await withCrossMachine({ remoteArgv: ["C:/Program Files/x.exe"] }, () =>
    assert.deepEqual(loadConfig().crossMachine.remoteArgv, ["C:/Program Files/x.exe"]));
});

test("loadConfig accepts inboundTrigger replies policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ inboundTrigger: "replies", busyDelivery: "human-first" }));
    await withAgentDir(root, () => {
      assert.equal(loadConfig().inboundTrigger, "replies");
      assert.equal(loadConfig().busyDelivery, "human-first");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig ignores obsolete toolVisibility values", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ toolVisibility: "lazy", replyHint: false }));
    await withAgentDir(root, () => {
      assert.equal(loadConfig().replyHint, false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig accepts a restart-stable intercom id", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ stableId: " pinned-worker " }));
    await withAgentDir(root, () => {
      assert.equal(loadConfig().stableId, "pinned-worker");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid inboundTrigger values", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ inboundTrigger: "prompt" }));

    await withAgentDir(root, () => {
      assert.throws(
        () => loadConfig(),
        /Failed to load intercom config.*"inboundTrigger" must be "always", "replies", or "never"/,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects empty cross-machine strings", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ crossMachine: { remoteCommand: "  " } }));
    await withAgentDir(root, () => {
      assert.throws(() => loadConfig(), /"crossMachine.remoteCommand" must be a non-empty string/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid busyDelivery values", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ busyDelivery: "prompt" }));
    await withAgentDir(root, () => {
      assert.throws(() => loadConfig(), /"busyDelivery" must be "steer" or "human-first"/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
