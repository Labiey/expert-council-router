import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ObserverWindowLauncher,
  buildWatchInvocation,
  buildWindowPlan,
  defaultResolveCli,
  observerWindowTimeoutMs,
  quoteCmdToken,
  type WatchInvocationTarget,
} from "../packages/pi-runtime/src/window-launcher.js";
import { parseCouncilConfig } from "../packages/core/src/index.js";

/**
 * Observer windows: an opt-in convenience that opens a second terminal running the same
 * `watch` command an operator could run by hand. The expert itself is untouched, so these
 * tests are about the launcher only - and none of them may open a real window.
 */

const CLI: WatchInvocationTarget = { kind: "node", script: "C:\\Program Files\\council\\cli\\dist\\index.js" };

function harness(options: {
  platform?: NodeJS.Platform;
  spawnThrows?: boolean;
  resolveCli?: () => WatchInvocationTarget | undefined;
  now?: () => number;
} = {}) {
  const calls: Array<{ file: string; argv: string[]; env: NodeJS.ProcessEnv }> = [];
  const warnings: string[] = [];
  const launcher = new ObserverWindowLauncher({
    platform: options.platform ?? "win32",
    env: {},
    nodeExecutable: "C:\\nodejs\\node.exe",
    findExecutable: (name) => (name === "wt.exe" ? "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe" : "C:\\Windows\\System32\\cmd.exe"),
    resolveCli: options.resolveCli ?? (() => CLI),
    onWarning: (message) => warnings.push(message),
    spawn: (file, argv, env) => {
      if (options.spawnThrows) throw new Error("spawn EACCES");
      calls.push({ file, argv, env });
      return { unref: () => undefined };
    },
    ...(options.now ? { now: options.now } : {}),
  });
  return { launcher, calls, warnings };
}

describe("observer window budget", () => {
  it("covers the whole delegation, not one attempt", () => {
    // The operator's rule: the window is derived from the expert's budget and never shorter than
    // the work. But the work is the delegation, and a delegation may spend retry.maxAttempts
    // sessions each with its own timeoutMs. A 25-minute attempt budget with three attempts allowed
    // can legitimately run 75 minutes, and the old 1.5x-of-one-attempt rule killed the window at
    // 37.5 minutes while the third attempt was still streaming 1.6 MB of events.
    expect(observerWindowTimeoutMs(60_000, 3)).toBe(900_000);          // floored, not tiny
    expect(observerWindowTimeoutMs(700_000, 1)).toBe(900_000);          // 1.25x still under the floor
    expect(observerWindowTimeoutMs(1_800_000, 1)).toBe(2_250_000);      // 30 min -> 37.5 min
    expect(observerWindowTimeoutMs(1_500_000, 3)).toBe(5_625_000);      // the real case: 25 min x 3 + margin
    expect(observerWindowTimeoutMs(5_000_000, 3)).toBe(18_750_000);     // three long attempts
    expect(observerWindowTimeoutMs(21_600_000, 3)).toBe(21_600_000);    // capped by the follower ceiling
    expect(observerWindowTimeoutMs(undefined)).toBe(900_000);
    expect(observerWindowTimeoutMs(Number.NaN)).toBe(900_000);
    // A nonsense attempt count may shrink the window to one attempt's worth, never below it.
    expect(observerWindowTimeoutMs(1_800_000, 0)).toBe(2_250_000);
    expect(observerWindowTimeoutMs(1_800_000, -4)).toBe(2_250_000);
    expect(observerWindowTimeoutMs(1_800_000, Number.NaN)).toBe(2_250_000);
    // Omitting it entirely must not fall back to the old 1.5x, or every existing caller keeps the bug.
    expect(observerWindowTimeoutMs(1_500_000)).toBe(1_875_000);
  });
});

describe("observer window command line", () => {
  it("tails the delegation's own stream with the shared follower", () => {
    const command = buildWatchInvocation(CLI, "exec_abc_1", 900_000);
    // cmd rejects a quoted first token, so the interpreter is a bare name and only the script
    // - which is never first - carries quoting. Proven by opening a real window, not by
    // reasoning: the fake spawner in every other test here would pass either way.
    expect(command.startsWith("node ")).toBe(true);
    expect(command).toContain("watch");
    expect(command).toContain("--exec exec_abc_1");
    expect(command).toContain("--follow");
    expect(command).toContain("--timeout-ms 900000");
    // The window is *told* it is a terminal instead of left to sniff it. The launcher spawns with
    // stdio ignored and `start` hands those handles down, so an isTTY probe inside the follower
    // reports a pipe - which is how an operator ended up with the plain single-line form, no
    // blocks and no shading, in a window that is a console by construction. Layout must be
    // explicit here; `--style auto` is for a human at their own terminal.
    expect(command).toContain("--style panel");
    expect(command).toContain("--color");
    // A path with spaces must survive as one token inside the cmd command line.
    expect(command).toContain('"C:\\Program Files\\council\\cli\\dist\\index.js"');
    expect(quoteCmdToken("plain")).toBe("plain");
    expect(quoteCmdToken("has space")).toBe('"has space"');
  });

  it("waits for a keypress after the stream ends instead of closing", () => {
    // The requested close rule: the follower stops at the final marker, the window stays
    // until the operator presses a key. Pinned at the plan level because the pause comes
    // from cmd itself, so any CLI version behaves the same.
    for (const host of ["windows-terminal", "console-host"] as const) {
      const plan = buildWindowPlan({
        host,
        terminalExecutable: host === "windows-terminal" ? "C:\\wt.exe" : "C:\\Windows\\System32\\cmd.exe",
        cli: CLI,
        executionId: "exec_abc_1",
        role: "architecture-oracle",
        windowTimeoutMs: 900_000,
      });
      const joined = plan.argv.join(" ");
      expect(joined).toContain("pause");
      expect(joined).toContain("press any key");
      expect(joined).toContain("--exec exec_abc_1");
    }
  });

  it("resolves the executable CLI entry, not the library surface", () => {
    // dist/index.js also exists and exits silently when run, which is how this feature
    // nearly shipped a window that displayed nothing. Pinned because reasoning said the
    // opposite; only opening a real window revealed it.
    // The launcher passes its own module URL; the test must imitate that layout rather than
    // resolve from the tests directory, which has no sibling cli package.
    const launcherUrl = new URL("../packages/pi-runtime/dist/window-launcher.js", import.meta.url).href;
    const cli = defaultResolveCli({}, launcherUrl);
    expect(cli?.kind).toBe("node");
    if (cli && cli.kind === "node") expect(cli.script.endsWith("bin.js")).toBe(true);
    // An explicit override that does not exist is refused rather than guessed around.
    expect(defaultResolveCli({ EXPERT_COUNCIL_CLI: "C:/definitely/not/here.js" }, launcherUrl)).toBeUndefined();
  });

  it("gives the window a PATH that resolves the bare interpreter", () => {
    const { launcher, calls } = harness();
    launcher.ensureOpen({ executionId: "exec_one", role: "scout" });
    const env = calls[0]?.env ?? {};
    const pathKey = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "";
    expect(pathKey).not.toBe("");
    // The harness injects no PATH at all, so the interpreter directory alone proves the
    // prepend: without it, `node` in the command line depends on how the host was started.
    const expectedDir = ["C:", "nodejs"].join(String.fromCharCode(92));
    expect((env[pathKey] ?? "").split(path.delimiter)).toContain(expectedDir);
    // The inner command line must start with the bare interpreter. Asserting the token, not
    // a spaced substring: the CLI path here contains spaces and is therefore quoted, so
    // "node " is followed by a quote - and a quoted *first* token is the thing cmd rejects.
    const argv = calls[0]?.argv ?? [];
    const inner = String(argv[argv.length - 1]);
    expect(inner.startsWith("node ")).toBe(true);
    expect(inner.split(" ")[0]).toBe("node");
  });

  it("forces a new window under Windows Terminal and start otherwise, with a sanitized title", () => {
    const wt = buildWindowPlan({
      host: "windows-terminal",
      terminalExecutable: "C:\\wt.exe",
      cli: CLI,
      executionId: "exec_abc_1",
      role: "implementation-worker",
      windowTimeoutMs: 900_000,
    });
    expect(wt.file).toBe("C:\\wt.exe");
    // The `-w new` prefix is the entire point of this test. It used to assert `["new-tab",
    // "--title"]`, which pinned the defect itself: the observer opened as a tab inside the terminal
    // the agent was running in, and every gate stayed green while operators saw no window at all.
    expect(wt.argv.slice(0, 4)).toEqual(["-w", "new", "new-tab", "--title"]);
    expect(wt.argv[4]).toBe("EXPERT implementation-worker exec_abc_1");
    expect(wt.argv.slice(5, 8)).toEqual(["cmd", "/d", "/c"]);
    expect(typeof wt.argv[8]).toBe("string");

    const legacy = buildWindowPlan({
      host: "console-host",
      terminalExecutable: "C:\\Windows\\System32\\cmd.exe",
      cli: { kind: "bin", command: "expert-council" },
      executionId: 'exec"evil && del C:\\',
      role: "scout",
      windowTimeoutMs: 900_000,
    });
    expect(legacy.argv.slice(0, 3)).toEqual(["/d", "/c", "start"]);
    expect(typeof legacy.argv[3]).toBe("string");
    // Titles must not carry shell metacharacters even if an identifier tried to.
    expect(legacy.argv[3]).not.toMatch(/[&"\\]/);
    expect(legacy.argv[4]).toBe("cmd");
    expect(legacy.argv[5]).toBe("/d");
  });
});

describe("opening one observer window per delegation", () => {
  it("opens once and never reopens for retries or escalations of the same id", () => {
    const { launcher, calls, warnings } = harness();
    launcher.ensureOpen({ executionId: "exec_one", role: "scout", timeoutMs: 600_000 });
    launcher.ensureOpen({ executionId: "exec_one", role: "scout", timeoutMs: 900_000 }); // attempt 2
    launcher.ensureOpen({ executionId: "exec_one", role: "debugger", timeoutMs: 900_000 }); // escalated
    expect(calls).toHaveLength(1);
    expect(warnings).toEqual([]);
    expect(launcher.isOpen("exec_one")).toBe(true);
  });

  it("has no cap: distinct delegations each get their own window", () => {
    const { launcher, calls } = harness();
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) {
      launcher.ensureOpen({ executionId: `exec_${id}`, role: "scout", timeoutMs: 60_000 });
    }
    expect(calls).toHaveLength(7);
  });

  it("releases on delegation end so a later delegation opens a fresh window", () => {
    const { launcher, calls } = harness();
    launcher.ensureOpen({ executionId: "exec_one", role: "scout" });
    launcher.release("exec_one");
    launcher.ensureOpen({ executionId: "exec_one", role: "scout" });
    expect(calls).toHaveLength(2);
  });

  it("forgets tracked ids once a delegation is older than the tracking window", () => {
    let now = Date.now();
    const { launcher, calls } = harness({ now: () => now });
    launcher.ensureOpen({ executionId: "exec_stale", role: "scout" });
    now += 7 * 60 * 60 * 1000; // abandoned without a final marker (killed host)
    launcher.ensureOpen({ executionId: "exec_stale", role: "scout" });
    expect(calls).toHaveLength(2);
  });

  it("does nothing on a platform it cannot open a window on, and says so once", () => {
    const { launcher, calls, warnings } = harness({ platform: "linux" });
    launcher.ensureOpen({ executionId: "exec_one", role: "scout" });
    launcher.ensureOpen({ executionId: "exec_two", role: "scout" });
    expect(calls).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0] ?? "").toContain("Windows");
  });

  it("degrades to one clear warning when the CLI cannot be located", () => {
    const { launcher, calls, warnings } = harness({ resolveCli: () => undefined });
    launcher.ensureOpen({ executionId: "exec_one", role: "scout" });
    launcher.ensureOpen({ executionId: "exec_two", role: "scout" });
    expect(calls).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0] ?? "").toContain("EXPERT_COUNCIL_CLI");
  });

  it("survives a terminal host that refuses, and lets a later attempt retry", () => {
    let attempts = 0;
    const warnings: string[] = [];
    const launcher = new ObserverWindowLauncher({
      platform: "win32",
      env: {},
      nodeExecutable: "C:\\nodejs\\node.exe",
      findExecutable: () => "C:\Windows\System32\cmd.exe",
      resolveCli: () => CLI,
      onWarning: (message) => warnings.push(message),
      spawn: () => {
        attempts += 1;
        throw new Error("spawn EACCES");
      },
    });
    launcher.ensureOpen({ executionId: "exec_one", role: "scout" });
    expect(attempts).toBe(1);
    expect(launcher.isOpen("exec_one")).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0] ?? "").toContain("spawn EACCES");
    // A refused spawn is not recorded, so the next attempt of the same delegation may try
    // again instead of the failure being silently swallowed for the whole run.
    launcher.ensureOpen({ executionId: "exec_one", role: "scout" });
    expect(attempts).toBe(2);
    expect(warnings).toHaveLength(1); // warned once, not once per attempt
  });
});

describe("autoOpenWindow is opt-in and cannot be half-configured", () => {
  it("defaults to off", () => {
    const config = parseCouncilConfig({});
    expect(config.security.observability.autoOpenWindow).toBe(false);
    expect(config.security.observability.expertWindow).toBe("off");
  });

  it("refuses a window with no stream to follow, and points at the fix", () => {
    expect(() => parseCouncilConfig({ security: { observability: { autoOpenWindow: true } } })).toThrow(/interactive/);
    expect(() =>
      parseCouncilConfig({ security: { observability: { expertWindow: "events", autoOpenWindow: true } } }),
    ).toThrow(/interactive/);
  });

  it("accepts the valid combination", () => {
    const config = parseCouncilConfig({ security: { observability: { expertWindow: "interactive", autoOpenWindow: true } } });
    expect(config.security.observability.autoOpenWindow).toBe(true);
  });
});
