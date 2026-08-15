import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BOSS_PARTICIPANT_BINDING_VERSION,
  BOSS_POLICY_PRINCIPAL_VERSION,
  WORKER_IDENTITY_VERSION,
  type BossParticipantRole,
  type BossPrivatePrincipal,
} from "@ctliz/agent-intercom-core/boss";
import { brokerGeneration, participantBindingEpoch, workerGeneration } from "@ctliz/agent-intercom-core/canonical";
import { formatIntercomTeam, resolveIntercomTeam, resolveManagedInboxSession, type TeamSession } from "./team.ts";

const legacyWorker = (id: string, runId: string, managerSessionId: string, state = "running") => ({
  id,
  runId,
  harness: "claude",
  role: "reviewer",
  state,
  owned: true,
  managerSessionId,
  intercomTarget: id,
});

function bossWorker(
  id: string,
  role: BossParticipantRole,
  managerSessionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    workerIncarnationId: `inc-${id}`,
    workerGeneration: 2,
    bossRunId: "boss-run-a",
    participantId: `participant-${id}`,
    bindingEpoch: 3,
    sessionId: id,
    harness: "claude",
    role,
    state: "working",
    owned: true,
    managerSessionId,
    intercomTarget: id,
    ...overrides,
  };
}

type BossBindingOverrides = Partial<NonNullable<TeamSession["boss"]>["binding"]>;
type BossPrincipalOverrides = Partial<BossPrivatePrincipal>;
type BossLiveWorkerOverrides = {
  identity?: Partial<NonNullable<TeamSession["boss"]>["liveWorker"]["identity"]>;
  state?: NonNullable<TeamSession["boss"]>["liveWorker"]["state"];
};

function bossSession(
  id: string,
  role: BossParticipantRole,
  overrides: BossBindingOverrides = {},
  liveOverrides: BossLiveWorkerOverrides = {},
  principalOverrides: BossPrincipalOverrides = {},
): TeamSession {
  const bindingEpoch = participantBindingEpoch(3);
  const assignedManagerParticipantId = "participant-manager";
  return {
    id,
    boss: {
      binding: {
        version: BOSS_PARTICIPANT_BINDING_VERSION,
        bossRunId: "boss-run-a",
        participantId: `participant-${id}`,
        bindingEpoch,
        role,
        communicationProfile: role,
        sessionId: id,
        brokerGeneration: brokerGeneration(1),
        brokerBootInstance: "boot-a",
        state: "active",
        ...(role === "worker" || role === "scout" ? { assignedManagerParticipantId } : {}),
        authorityTransitionId: `transition-${id}`,
        ...overrides,
      },
      principal: {
        version: BOSS_POLICY_PRINCIPAL_VERSION,
        principalId: id,
        principalClass: "boss-private",
        state: "active",
        bossRunId: "boss-run-a",
        participantId: `participant-${id}`,
        role,
        bindingEpoch,
        ...(role === "worker" || role === "scout" ? { assignedManagerParticipantId } : {}),
        ...(role === "manager" ? { assignedParticipantIds: ["participant-self", "participant-peer"] } : {}),
        ...(role === "council" ? { requestingPrincipalId: "boss" } : {}),
        ...principalOverrides,
      },
      liveWorker: {
        identity: {
          version: WORKER_IDENTITY_VERSION,
          workerId: id,
          workerIncarnationId: `inc-${id}`,
          workerGeneration: workerGeneration(2),
          bossRunId: "boss-run-a",
          participantId: `participant-${id}`,
          bindingEpoch,
          ...liveOverrides.identity,
        },
        state: liveOverrides.state ?? "working",
      },
    },
  };
}

async function withWorkers(
  workers: unknown[],
  run: (agentDir: string) => Promise<void>,
): Promise<void> {
  const agentDir = await mkdtemp(join(tmpdir(), "claude-team-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers }));
    await run(agentDir);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

function bossEnvironment(id: string): NodeJS.ProcessEnv {
  return {
    AGENT_INTERCOM_WORKER_ID: id,
    AGENT_INTERCOM_WORKER_INCARNATION_ID: `inc-${id}`,
    AGENT_INTERCOM_WORKER_GENERATION: "2",
    AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-a",
    AGENT_INTERCOM_PARTICIPANT_ID: `participant-${id}`,
    AGENT_INTERCOM_BINDING_EPOCH: "3",
  };
}

const bossEnv = bossEnvironment("self");

test("ordinary team discovery preserves the legacy orchestrator-owner projection", async () => {
  await withWorkers([
    legacyWorker("self", "run-self", "manager-new"),
    legacyWorker("peer", "run-peer", "manager-new"),
    legacyWorker("old", "run-old", "manager-old"),
  ], async (agentDir) => {
    const team = await resolveIntercomTeam({
      selfId: "self",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "self",
        AGENT_INTERCOM_WORKER_INCARNATION_ID: "ignored-by-ordinary-discovery",
        AGENT_INTERCOM_RUN_ID: "run-self",
        AGENT_INTERCOM_MANAGER_SESSION_ID: "manager-old",
      },
      sessions: [{ id: "manager-new" }, { id: "peer" }],
    });
    assert.equal(team.manager?.target, "manager-new");
    assert.equal(team.manager?.connected, true);
    assert.deepEqual(team.coworkers.map((entry) => entry.id), ["peer"]);
  });
});

test("Boss team discovery intersects every registry identity field with exact live sessions", async () => {
  await withWorkers([
    bossWorker("self", "worker", "manager"),
    bossWorker("manager", "manager", "boss"),
    bossWorker("peer", "worker", "manager"),
  ], async (agentDir) => {
    const team = await resolveIntercomTeam({
      selfId: "self",
      agentDir,
      env: bossEnv,
      sessions: [bossSession("self", "worker"), bossSession("manager", "manager"), bossSession("peer", "worker")],
    });
    assert.equal(team.teamId, "boss-run-a");
    assert.equal(team.manager?.target, "manager");
    assert.equal(team.self.isManager, false);
    assert.deepEqual(team.coworkers.map((entry) => entry.id), ["peer"]);
  });
});

test("Boss worker discovery requires the registry edge and reciprocal Core assignment authority", async () => {
  const cases: Array<{
    name: string;
    current: Record<string, unknown>;
    currentSession: TeamSession;
    managerId: string;
    managerSession: TeamSession;
    otherWorkers?: Record<string, unknown>[];
    otherSessions?: TeamSession[];
  }> = [
    {
      name: "alternate same-run Manager",
      current: bossWorker("self", "worker", "manager-alt"),
      currentSession: bossSession("self", "worker"),
      managerId: "manager-alt",
      managerSession: bossSession("manager-alt", "manager", {}, {}, { assignedParticipantIds: ["participant-self"] }),
      otherWorkers: [bossWorker("manager", "manager", "boss")],
      otherSessions: [bossSession("manager", "manager")],
    },
    {
      name: "binding points to another Manager participant",
      current: bossWorker("self", "worker", "manager"),
      currentSession: bossSession(
        "self",
        "worker",
        { assignedManagerParticipantId: "participant-manager-alt" },
        {},
        { assignedManagerParticipantId: "participant-manager-alt" },
      ),
      managerId: "manager",
      managerSession: bossSession("manager", "manager"),
    },
    {
      name: "Manager principal does not assign the Worker",
      current: bossWorker("self", "worker", "manager"),
      currentSession: bossSession("self", "worker"),
      managerId: "manager",
      managerSession: bossSession("manager", "manager", {}, {}, { assignedParticipantIds: ["participant-peer"] }),
    },
    {
      name: "unassigned Worker",
      current: bossWorker("self", "worker", "manager"),
      currentSession: bossSession(
        "self",
        "worker",
        { assignedManagerParticipantId: undefined },
        {},
        { assignedManagerParticipantId: undefined },
      ),
      managerId: "manager",
      managerSession: bossSession("manager", "manager"),
    },
    {
      name: "non-managed Boss role",
      current: bossWorker("self", "adversary", "manager"),
      currentSession: bossSession("self", "adversary"),
      managerId: "manager",
      managerSession: bossSession("manager", "manager"),
    },
  ];

  for (const fixture of cases) {
    await withWorkers([
      fixture.current,
      bossWorker(fixture.managerId, "manager", "boss"),
      ...(fixture.otherWorkers ?? []),
    ], async (agentDir) => {
      const team = await resolveIntercomTeam({
        selfId: "self",
        agentDir,
        env: bossEnv,
        sessions: [fixture.currentSession, fixture.managerSession, ...(fixture.otherSessions ?? [])],
      });
      assert.equal(team.manager, undefined, fixture.name);
      assert.equal(team.self.isManager, false, fixture.name);
      assert.deepEqual(team.coworkers, [], fixture.name);
    });
  }
});

test("Boss Manager discovery exposes only reciprocally assigned live Workers", async () => {
  await withWorkers([
    bossWorker("manager", "manager", "boss"),
    bossWorker("peer", "worker", "manager"),
    bossWorker("unassigned", "worker", "manager"),
  ], async (agentDir) => {
    const team = await resolveIntercomTeam({
      selfId: "manager",
      agentDir,
      env: bossEnvironment("manager"),
      sessions: [
        bossSession("manager", "manager", {}, {}, { assignedParticipantIds: ["participant-peer"] }),
        bossSession("peer", "worker"),
        bossSession("unassigned", "worker"),
      ],
    });
    assert.equal(team.manager?.target, "manager");
    assert.equal(team.self.isManager, true);
    assert.deepEqual(team.coworkers.map((entry) => entry.id), ["peer"]);
  });
});

test("Boss coworker discovery intersects each registry edge with both assignment directions", async () => {
  const cases = [
    {
      name: "Worker binding points to another Manager participant",
      peerSession: bossSession(
        "peer",
        "worker",
        { assignedManagerParticipantId: "participant-manager-alt" },
        {},
        { assignedManagerParticipantId: "participant-manager-alt" },
      ),
      managerSession: bossSession("manager", "manager"),
    },
    {
      name: "Manager principal omits Worker participant",
      peerSession: bossSession("peer", "worker"),
      managerSession: bossSession("manager", "manager", {}, {}, { assignedParticipantIds: ["participant-self"] }),
    },
    {
      name: "registry-owned but non-managed Boss role",
      peerSession: bossSession("peer", "adversary"),
      managerSession: bossSession("manager", "manager"),
    },
  ];

  for (const fixture of cases) {
    await withWorkers([
      bossWorker("self", "worker", "manager"),
      bossWorker("manager", "manager", "boss"),
      bossWorker("peer", fixture.peerSession.boss!.binding.role, "manager"),
    ], async (agentDir) => {
      const team = await resolveIntercomTeam({
        selfId: "self",
        agentDir,
        env: bossEnv,
        sessions: [bossSession("self", "worker"), fixture.managerSession, fixture.peerSession],
      });
      assert.equal(team.manager?.target, "manager", fixture.name);
      assert.deepEqual(team.coworkers, [], fixture.name);
    });
  }
});

test("Boss team discovery denies target substitution, name collision, and stale Manager promotion", async () => {
  await withWorkers([
    bossWorker("self", "worker", "manager"),
    bossWorker("manager", "manager", "boss"),
    bossWorker("peer", "worker", "manager", { intercomTarget: "manager" }),
  ], async (agentDir) => {
    const team = await resolveIntercomTeam({
      selfId: "self",
      agentDir,
      env: bossEnv,
      sessions: [
        bossSession("self", "worker"),
        { ...bossSession("unrelated", "manager"), name: "manager" },
        bossSession("peer", "worker"),
      ],
    });
    assert.equal(team.manager, undefined);
    assert.equal(team.self.isManager, false);
    assert.deepEqual(team.coworkers, []);
  });
  await withWorkers([
    bossWorker("self", "worker", "manager"),
    bossWorker("manager", "worker", "boss"),
  ], async (agentDir) => {
    const team = await resolveIntercomTeam({
      selfId: "self",
      agentDir,
      env: bossEnv,
      sessions: [bossSession("self", "worker"), bossSession("manager", "worker")],
    });
    assert.equal(team.manager, undefined);
    assert.equal(team.self.isManager, false);
  });
});

test("Boss current identity fails closed on run, participant, epoch, role, session, incarnation, generation, or state mismatch", async () => {
  const cases: Array<{ name: string; worker?: Record<string, unknown>; session?: TeamSession; env?: NodeJS.ProcessEnv }> = [
    { name: "run", worker: bossWorker("self", "worker", "manager", { bossRunId: "boss-run-b" }) },
    { name: "participant", worker: bossWorker("self", "worker", "manager", { participantId: "other" }) },
    { name: "epoch", worker: bossWorker("self", "worker", "manager", { bindingEpoch: 4 }) },
    { name: "role", worker: bossWorker("self", "scout", "manager") },
    { name: "session", worker: bossWorker("self", "worker", "manager", { sessionId: "other" }) },
    { name: "incarnation", worker: bossWorker("self", "worker", "manager", { workerIncarnationId: "stale" }) },
    { name: "generation", worker: bossWorker("self", "worker", "manager", { workerGeneration: 1 }) },
    { name: "state", worker: bossWorker("self", "worker", "manager", { state: "stopped" }) },
    { name: "missing canonical incarnation", worker: bossWorker("self", "worker", "manager", { workerIncarnationId: undefined, runId: "inc-self" }) },
    { name: "binding session", session: bossSession("self", "worker", { sessionId: "other" }) },
    { name: "principal session", session: bossSession("self", "worker", {}, {}, { principalId: "other" }) },
    { name: "principal run", session: bossSession("self", "worker", {}, {}, { bossRunId: "boss-run-b" }) },
    { name: "principal participant", session: bossSession("self", "worker", {}, {}, { participantId: "other" }) },
    { name: "principal epoch", session: bossSession("self", "worker", {}, {}, { bindingEpoch: participantBindingEpoch(4) }) },
    { name: "principal role", session: bossSession("self", "worker", {}, {}, { role: "scout" }) },
    { name: "principal state", session: bossSession("self", "worker", {}, {}, { state: "revoked" }) },
    { name: "binding assignment", session: bossSession("self", "worker", { assignedManagerParticipantId: "participant-manager-alt" }) },
    { name: "live run", session: bossSession("self", "worker", {}, { identity: { bossRunId: "boss-run-b" } }) },
    { name: "live participant", session: bossSession("self", "worker", {}, { identity: { participantId: "other" } }) },
    { name: "live epoch", session: bossSession("self", "worker", {}, { identity: { bindingEpoch: participantBindingEpoch(4) } }) },
    { name: "live state", session: bossSession("self", "worker", {}, { state: "waiting" }) },
    { name: "terminal live state", session: bossSession("self", "worker", {}, { state: "stopped" }) },
    { name: "environment epoch", env: { ...bossEnv, AGENT_INTERCOM_BINDING_EPOCH: "0" } },
    { name: "deprecated environment mismatch", env: { ...bossEnv, AGENT_INTERCOM_RUN_ID: "stale-self" } },
    { name: "deprecated-only environment", env: { ...bossEnv, AGENT_INTERCOM_WORKER_INCARNATION_ID: undefined, AGENT_INTERCOM_RUN_ID: "inc-self" } },
  ];
  for (const mismatch of cases) {
    await withWorkers([
      mismatch.worker ?? bossWorker("self", "worker", "manager"),
      bossWorker("manager", "manager", "boss"),
    ], async (agentDir) => {
      const team = await resolveIntercomTeam({
        selfId: "self",
        agentDir,
        env: mismatch.env ?? bossEnv,
        sessions: [mismatch.session ?? bossSession("self", "worker"), bossSession("manager", "manager")],
      });
      assert.equal(team.manager, undefined, mismatch.name);
      assert.equal(team.self.isManager, false, mismatch.name);
      assert.deepEqual(team.coworkers, [], mismatch.name);
    });
  }
});

test("Boss Manager projection rejects stale registry incarnation, generation, and canonical state against live authority", async () => {
  for (const mismatch of [
    { name: "incarnation", override: { workerIncarnationId: "stale-manager" } },
    { name: "generation", override: { workerGeneration: 1 } },
    { name: "state", override: { state: "waiting" } },
  ]) {
    await withWorkers([
      bossWorker("self", "worker", "manager"),
      bossWorker("manager", "manager", "boss", mismatch.override),
    ], async (agentDir) => {
      const team = await resolveIntercomTeam({
        selfId: "self",
        agentDir,
        env: bossEnv,
        sessions: [bossSession("self", "worker"), bossSession("manager", "manager")],
      });
      assert.equal(team.manager, undefined, mismatch.name);
      assert.deepEqual(team.coworkers, [], mismatch.name);
    });
  }
});

test("Boss coworker projection rejects stale registry incarnation, generation, and canonical state against live authority", async () => {
  for (const mismatch of [
    { name: "incarnation", override: { workerIncarnationId: "stale-peer" } },
    { name: "generation", override: { workerGeneration: 1 } },
    { name: "state", override: { state: "waiting" } },
  ]) {
    await withWorkers([
      bossWorker("self", "worker", "manager"),
      bossWorker("manager", "manager", "boss"),
      bossWorker("peer", "worker", "manager", mismatch.override),
    ], async (agentDir) => {
      const team = await resolveIntercomTeam({
        selfId: "self",
        agentDir,
        env: bossEnv,
        sessions: [bossSession("self", "worker"), bossSession("manager", "manager"), bossSession("peer", "worker")],
      });
      assert.equal(team.manager?.target, "manager", mismatch.name);
      assert.deepEqual(team.coworkers, [], mismatch.name);
    });
  }
});

test("Boss Manager and coworker projections reject substituted live authority values independently", async () => {
  for (const target of ["manager", "peer"] as const) {
    await withWorkers([
      bossWorker("self", "worker", "manager"),
      bossWorker("manager", "manager", "boss"),
      bossWorker("peer", "worker", "manager"),
    ], async (agentDir) => {
      const sessions = [
        bossSession("self", "worker"),
        bossSession("manager", "manager", {}, target === "manager"
          ? { identity: { workerIncarnationId: "substituted-live-manager" } }
          : {}),
        bossSession("peer", "worker", {}, target === "peer"
          ? { identity: { workerGeneration: workerGeneration(3) } }
          : {}),
      ];
      const team = await resolveIntercomTeam({ selfId: "self", agentDir, env: bossEnv, sessions });
      if (target === "manager") {
        assert.equal(team.manager, undefined);
        assert.deepEqual(team.coworkers, []);
      } else {
        assert.equal(team.manager?.target, "manager");
        assert.deepEqual(team.coworkers, []);
      }
    });
  }
});

test("TmuxDeck manifest resolution correctly identifies Lead and Workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-manifest-"));
  if (process.platform !== "win32") {
    await chmod(dir, 0o700);
  }
  const manifestPath = join(dir, "team.json");
  const leadId = "tmuxdeck-11111111-1111-4111-8111-111111111111";
  const worker1 = "tmuxdeck-22222222-2222-4222-8222-222222222222";
  const worker2 = "tmuxdeck-33333333-3333-4333-8333-333333333333";
  const manifest = {
    version: "tmuxdeck.team.v1",
    backend: "tmuxdeck",
    runId: "team_44444444-4444-4444-8444-444444444444",
    leadId,
    members: [
      { sessionId: leadId, role: "lead" },
      { sessionId: worker1, role: "worker" },
      { sessionId: worker2, role: "worker" },
    ],
    createdAt: 1700000000000,
    capabilities: [],
  };
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(manifestPath, 0o600);
  }

  try {
    const sessions = [
      { id: leadId, model: "claude" },
      { id: worker1, model: "claude" },
      { id: worker2, model: "codex" },
    ];

    // 1. Worker 1 view
    const workerTeam = await resolveIntercomTeam({
      selfId: worker1,
      env: { AGENT_INTERCOM_TEAM_MANIFEST: manifestPath },
      sessions,
    });
    assert.equal(workerTeam.source, "manifest");
    assert.equal(workerTeam.teamId, manifest.runId);
    assert.equal(workerTeam.self.isManager, false);
    assert.equal(workerTeam.manager?.target, leadId);
    assert.equal(workerTeam.manager?.connected, true);
    assert.deepEqual(workerTeam.coworkers.map((c) => c.id), [worker2]);

    // 2. Lead view
    const leadTeam = await resolveIntercomTeam({
      selfId: leadId,
      env: { AGENT_INTERCOM_TEAM_MANIFEST: manifestPath },
      sessions,
    });
    assert.equal(leadTeam.source, "manifest");
    assert.equal(leadTeam.teamId, manifest.runId);
    assert.equal(leadTeam.self.isManager, true);
    assert.equal(leadTeam.manager?.target, leadId);
    assert.deepEqual(leadTeam.coworkers.map((c) => c.id), [worker1, worker2]);
    assert.match(formatIntercomTeam(leadTeam), new RegExp(`You: ${leadId} \\[manager\\]`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Invalid or unreadable TmuxDeck manifest fails closed without live fallback", async () => {
  // 1. Nonexistent manifest path
  await assert.rejects(
    async () => resolveIntercomTeam({
      selfId: "tmuxdeck-11111111-1111-4111-8111-111111111111",
      env: {
        AGENT_INTERCOM_TEAM_MANIFEST: "/nonexistent/manifest.json",
        AGENT_INTERCOM_SCOPE_ID: "a".repeat(48),
      },
      sessions: [{ id: "tmuxdeck-11111111-1111-4111-8111-111111111111" }, { id: "tmuxdeck-22222222-2222-4222-8222-222222222222" }],
    }),
    /ERR_TEAM_MANIFEST_UNAVAILABLE/,
  );

  // 2. Malformed JSON manifest
  const dir = await mkdtemp(join(tmpdir(), "claude-bad-manifest-"));
  if (process.platform !== "win32") {
    await chmod(dir, 0o700);
  }
  const badJsonPath = join(dir, "bad.json");
  await writeFile(badJsonPath, "{ not valid json", { mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(badJsonPath, 0o600);
  }
  try {
    await assert.rejects(
      async () => resolveIntercomTeam({
        selfId: "tmuxdeck-11111111-1111-4111-8111-111111111111",
        env: {
          AGENT_INTERCOM_TEAM_MANIFEST: badJsonPath,
          AGENT_INTERCOM_SCOPE_ID: "a".repeat(48),
        },
        sessions: [{ id: "tmuxdeck-11111111-1111-4111-8111-111111111111" }],
      }),
      /ERR_TEAM_MANIFEST_INVALID/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // 3. Empty or whitespace manifest env var throws ERR_TEAM_MANIFEST_INVALID
  for (const emptyVal of ["", "   ", "\t\n"]) {
    await assert.rejects(
      async () => resolveIntercomTeam({
        selfId: "tmuxdeck-11111111-1111-4111-8111-111111111111",
        env: {
          AGENT_INTERCOM_TEAM_MANIFEST: emptyVal,
          AGENT_INTERCOM_SCOPE_ID: "a".repeat(48),
        },
        sessions: [{ id: "tmuxdeck-11111111-1111-4111-8111-111111111111" }],
      }),
      /ERR_TEAM_MANIFEST_INVALID/,
    );
  }

  // 4. Valid manifest JSON but self is not in members throws ERR_TEAM_MANIFEST_INVALID
  const validDir = await mkdtemp(join(tmpdir(), "claude-self-not-member-"));
  if (process.platform !== "win32") {
    await chmod(validDir, 0o700);
  }
  const notMemberPath = join(validDir, "manifest.json");
  await writeFile(
    notMemberPath,
    JSON.stringify({
      version: "tmuxdeck.team.v1",
      backend: "tmuxdeck",
      runId: "team_44444444-4444-4444-8444-444444444444",
      leadId: "tmuxdeck-11111111-1111-4111-8111-111111111111",
      members: [{ sessionId: "tmuxdeck-11111111-1111-4111-8111-111111111111", role: "lead" }],
      createdAt: 1700000000000,
      capabilities: [],
    }),
    { mode: 0o600 },
  );
  if (process.platform !== "win32") {
    await chmod(notMemberPath, 0o600);
  }
  try {
    await assert.rejects(
      async () => resolveIntercomTeam({
        selfId: "tmuxdeck-99999999-9999-4999-8999-999999999999",
        env: { AGENT_INTERCOM_TEAM_MANIFEST: notMemberPath },
        sessions: [{ id: "tmuxdeck-99999999-9999-4999-8999-999999999999" }],
      }),
      /ERR_TEAM_MANIFEST_INVALID/,
    );
  } finally {
    await rm(validDir, { recursive: true, force: true });
  }
});

test("Workspace live roster fallback discovers same-scope active non-human peers", async () => {
  const sessions: TeamSession[] = [
    { id: "lead-pane", model: "claude" },
    { id: "worker-pane", model: "claude" },
    { id: "me", model: "opencode" }, // valid agent named "me"
    { id: "human-user", model: "human" }, // exact "human" session to be excluded
    { id: "human-caps", model: "Human" }, // non-exact "Human" model remains a peer
  ];

  // Worker pane view
  const workerTeam = await resolveIntercomTeam({
    selfId: "worker-pane",
    env: {
      AGENT_INTERCOM_SCOPE_ID: "b".repeat(48),
      AGENT_INTERCOM_MANAGER_TARGET: "lead-pane",
      AGENT_INTERCOM_ROLE: "worker",
    },
    sessions,
  });
  assert.equal(workerTeam.source, "live");
  assert.equal(workerTeam.self.isManager, false);
  assert.equal(workerTeam.manager?.target, "lead-pane");
  assert.equal(workerTeam.manager?.connected, true);
  // Exact "human" excluded, lead excluded, self excluded; "Human" and "me" retained
  assert.deepEqual(workerTeam.coworkers.map((c) => c.id), ["me", "human-caps"]);

  // Lead pane view
  const leadTeam = await resolveIntercomTeam({
    selfId: "lead-pane",
    env: {
      AGENT_INTERCOM_SCOPE_ID: "b".repeat(48),
      AGENT_INTERCOM_ROLE: "manager",
    },
    sessions,
  });
  assert.equal(leadTeam.source, "live");
  assert.equal(leadTeam.self.isManager, true);
  assert.equal(leadTeam.manager?.target, "lead-pane");
  assert.deepEqual(leadTeam.coworkers.map((c) => c.id), ["worker-pane", "me", "human-caps"]);
});

test("Inbox inspection resolveManagedInboxSession is restricted strictly to Orchestrator/Boss", async () => {
  const sessions: TeamSession[] = [{ id: "manager" }, { id: "worker-1" }];
  const orchestratorTeam = {
    teamId: "manager",
    self: { id: "manager", isManager: true },
    coworkers: [{ id: "worker-1", target: "worker-1", connected: true }],
    source: "orchestrator" as const,
  };
  const bossTeam = { ...orchestratorTeam, source: "boss" as const };
  const manifestTeam = { ...orchestratorTeam, source: "manifest" as const };
  const liveTeam = { ...orchestratorTeam, source: "live" as const };
  const standaloneTeam = { ...orchestratorTeam, source: "standalone" as const };
  const legacyUndefinedSourceTeam = {
    teamId: "manager",
    self: { id: "manager", isManager: true },
    coworkers: [{ id: "worker-1", target: "worker-1", connected: true }],
  } as unknown as import("./team.ts").IntercomTeam;

  // Orchestrator allowed
  assert.equal(
    resolveManagedInboxSession({ team: orchestratorTeam, sessions, requestedSession: "worker-1" }).id,
    "worker-1",
  );

  // Boss allowed
  assert.equal(
    resolveManagedInboxSession({ team: bossTeam, sessions, requestedSession: "worker-1" }).id,
    "worker-1",
  );

  // Manifest denied
  assert.throws(
    () => resolveManagedInboxSession({ team: manifestTeam, sessions, requestedSession: "worker-1" }),
    /Pending-ask inbox access denied.*only permitted for Orchestrator\/Boss-managed teams/,
  );

  // Live fallback denied
  assert.throws(
    () => resolveManagedInboxSession({ team: liveTeam, sessions, requestedSession: "worker-1" }),
    /Pending-ask inbox access denied.*only permitted for Orchestrator\/Boss-managed teams/,
  );

  // Standalone denied
  assert.throws(
    () => resolveManagedInboxSession({ team: standaloneTeam, sessions, requestedSession: "worker-1" }),
    /Pending-ask inbox access denied.*only permitted for Orchestrator\/Boss-managed teams/,
  );

  // Legacy undefined source denied
  assert.throws(
    () => resolveManagedInboxSession({ team: legacyUndefinedSourceTeam, sessions, requestedSession: "worker-1" }),
    /Pending-ask inbox access denied.*only permitted for Orchestrator\/Boss-managed teams/,
  );
});

test("Orchestrator manager without workerId owns live workers with matching managerSessionId", async () => {
  await withWorkers([
    {
      id: "worker-a",
      managerSessionId: "manager-session",
      owned: true,
      state: "running",
      harness: "claude",
      role: "worker",
      intercomTarget: "worker-a",
    },
    {
      id: "worker-b",
      managerSessionId: "manager-session",
      owned: true,
      state: "idle",
      harness: "codex",
      role: "worker",
      intercomTarget: "worker-b",
    },
  ], async (agentDir) => {
    const sessions: TeamSession[] = [
      { id: "manager-session", model: "claude" },
      { id: "worker-a", model: "claude" },
      { id: "worker-b", model: "codex" },
    ];
    const team = await resolveIntercomTeam({
      selfId: "manager-session",
      agentDir,
      env: {}, // no AGENT_INTERCOM_WORKER_ID
      sessions,
    });
    assert.equal(team.source, "orchestrator");
    assert.equal(team.self.isManager, true);
    assert.equal(team.manager?.target, "manager-session");
    assert.deepEqual(team.coworkers.map((c) => c.id), ["worker-a", "worker-b"]);

    // Manager can inspect owned coworker inbox
    const inspected = resolveManagedInboxSession({
      team,
      sessions,
      requestedSession: "worker-a",
    });
    assert.equal(inspected.id, "worker-a");
  });
});

test("Worker with missing managerSessionId in workers.json is never elevated to manager", async () => {
  await withWorkers([
    {
      id: "worker-malformed",
      // missing managerSessionId and owned
      state: "running",
      harness: "claude",
      role: "worker",
    },
  ], async (agentDir) => {
    const sessions: TeamSession[] = [
      { id: "worker-malformed", model: "claude" },
    ];
    const team = await resolveIntercomTeam({
      selfId: "worker-malformed",
      agentDir,
      env: { AGENT_INTERCOM_WORKER_ID: "worker-malformed" },
      sessions,
    });
    assert.equal(team.source, "orchestrator");
    assert.equal(team.self.isManager, false);
    assert.deepEqual(team.coworkers, []);

    // Cannot inspect inbox
    assert.throws(
      () => resolveManagedInboxSession({
        team,
        sessions,
        requestedSession: "worker-malformed",
      }),
      /Only a manager may inspect another session's pending-ask inbox/,
    );
  });
});

test("Current worker record missing stored managerSessionId + AGENT_INTERCOM_MANAGER_TARGET=selfId + owned peer => source orchestrator but self false and inbox denied", async () => {
  await withWorkers([
    {
      id: "worker-me",
      // missing managerSessionId
      owned: true,
      state: "running",
      harness: "claude",
      role: "worker",
      intercomTarget: "worker-me",
    },
    {
      id: "worker-peer",
      managerSessionId: "worker-me",
      owned: true,
      state: "running",
      harness: "claude",
      role: "worker",
      intercomTarget: "worker-peer",
    },
  ], async (agentDir) => {
    const sessions: TeamSession[] = [
      { id: "worker-me", model: "claude" },
      { id: "worker-peer", model: "claude" },
    ];
    const team = await resolveIntercomTeam({
      selfId: "worker-me",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "worker-me",
        AGENT_INTERCOM_MANAGER_TARGET: "worker-me",
      },
      sessions,
    });
    assert.equal(team.source, "orchestrator");
    assert.equal(team.self.isManager, false);
    assert.equal(team.manager?.target, "worker-me");
    assert.deepEqual(team.coworkers.map((c) => c.id), ["worker-peer"]);

    assert.throws(
      () => resolveManagedInboxSession({
        team,
        sessions,
        requestedSession: "worker-peer",
      }),
      /Only a manager may inspect another session's pending-ask inbox/,
    );
  });
});

test("Stale or unmatched worker ID + owned records targeting self => no orchestrator Manager/inbox; continue manifest/live/standalone resolution", async () => {
  await withWorkers([
    {
      id: "worker-owned",
      managerSessionId: "self-manager",
      owned: true,
      state: "running",
      harness: "claude",
      role: "worker",
      intercomTarget: "worker-owned",
    },
  ], async (agentDir) => {
    const sessions: TeamSession[] = [
      { id: "self-manager", model: "claude" },
      { id: "worker-owned", model: "claude" },
    ];
    // With stale/unmatched AGENT_INTERCOM_WORKER_ID, must NOT become orchestrator manager
    const team = await resolveIntercomTeam({
      selfId: "self-manager",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "nonexistent-stale-worker",
        AGENT_INTERCOM_SCOPE_ID: "c".repeat(48),
      },
      sessions,
    });
    // Falls through to live roster resolution
    assert.equal(team.source, "live");
    assert.throws(
      () => resolveManagedInboxSession({
        team,
        sessions,
        requestedSession: "worker-owned",
      }),
      /Pending-ask inbox access denied: cross-session inbox inspection is only permitted for Orchestrator\/Boss-managed teams/,
    );
  });
});
