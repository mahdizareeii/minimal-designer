import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  assertNoDockerControlOverrides,
  assertDisposableComposeProject,
  cleanupProjectComplete,
  composeArguments,
  disposableProjectStartArguments,
  distinctVolumeEvidence,
  initialNoGoEvidence,
  isNonRootUserSpec,
  localDockerEndpointEvidence,
  restoreOneShotArguments,
  sanitizeComposeEnvironment,
  validateNoGoEvidence,
} from "./ci-offhost-restore-smoke.mjs";

const sourceProject = "formaspecdrsource0123456789";
const targetProject = "formaspecdrtarget0123456789";

function volumes(project, mountRoot) {
  return ["designer-backups", "designer-data", "renderer-socket"].map((kind) => ({
    kind,
    name: `${project}_${kind}`,
    mountpoint: `${mountRoot}/${kind}`,
    driver: "local",
    scope: "local",
  }));
}

test("accepts only random disposable DR project names and pins every Compose command", () => {
  assert.equal(assertDisposableComposeProject(sourceProject), sourceProject);
  assert.equal(assertDisposableComposeProject(targetProject), targetProject);
  assert.throws(() => assertDisposableComposeProject("minimalappdesigner"), /disposable project/u);
  assert.throws(() => assertDisposableComposeProject("formaspecdrsource0123;docker"), /disposable project/u);
  const args = composeArguments(sourceProject, ["ps", "--quiet"]);
  assert.equal(args[0], "compose");
  assert.equal(args[1], "--file");
  assert.ok(path.isAbsolute(args[2]));
  assert.equal(path.basename(args[2]), "docker-compose.yml");
  assert.equal(args[3], "--project-directory");
  assert.ok(path.isAbsolute(args[4]));
  assert.deepEqual(args.slice(5), ["--project-name", sourceProject, "ps", "--quiet"]);
});

test("uses an existing image without build and runs restore helpers without dependencies or a TTY", () => {
  const job = "formaspecdrjob0123456789ab";
  assert.deepEqual(
    disposableProjectStartArguments(),
    ["up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "240"],
  );
  const command = ["node", "apps/server/dist/restore-worker.js", "preflight"];
  const args = restoreOneShotArguments(command, job);
  assert.deepEqual(args.slice(0, 11), [
    "--profile", "operations", "run", "--name", job,
    "--no-deps", "-T", "--pull", "never", "restore-worker", "sh",
  ]);
  assert.deepEqual(args.slice(-command.length), command);
  assert.ok(!args.includes("--build"));
  assert.ok(!args.includes("--rm"));
  assert.throws(() => restoreOneShotArguments(command, "unsafe-job"), /not disposable/u);
});

test("removes Compose environment overrides and rejects root user specifications", () => {
  assert.deepEqual(sanitizeComposeEnvironment({
    PATH: "/bin",
    COMPOSE_FILE: "/tmp/evil.yml",
    COMPOSE_PROFILES: "operations",
    COMPOSE_PROJECT_NAME: "production",
  }), { PATH: "/bin" });
  for (const valid of ["pwuser", "1000", "pwuser:1000", "1000:1000"]) {
    assert.equal(isNonRootUserSpec(valid), true, valid);
  }
  for (const invalid of ["", "0", "00", "root", "0:1000", "root:pwuser", " pwuser", "pwuser:"]) {
    assert.equal(isNonRootUserSpec(invalid), false, invalid);
  }
});

test("rejects Docker daemon overrides and accepts only verified local endpoints", () => {
  assert.equal(assertNoDockerControlOverrides({ PATH: "/bin" }), true);
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]) {
    assert.throws(() => assertNoDockerControlOverrides({ [key]: "unsafe" }), /overrides are forbidden/u, key);
  }
  const context = (host) => ({ Name: "desktop-linux", Endpoints: { docker: { Host: host } } });
  const socket = { isSocket: () => true, isSymbolicLink: () => false };
  assert.deepEqual(localDockerEndpointEvidence("desktop-linux", context("unix:///tmp/docker.sock"), {
    platform: "darwin",
    lstat: () => socket,
  }), {
    contextName: "desktop-linux",
    endpointType: "unix-socket",
    endpoint: "unix:///tmp/docker.sock",
    localEndpointVerified: true,
    controlEnvironmentOverridesRejected: true,
  });
  assert.equal(localDockerEndpointEvidence("desktop-linux", context("npipe:////./pipe/docker_engine"), {
    platform: "win32",
  }).endpointType, "windows-named-pipe");
  assert.throws(() => localDockerEndpointEvidence("desktop-linux", context("tcp://prod.example:2376")), /not backed by an approved local/u);
  assert.throws(() => localDockerEndpointEvidence("desktop-linux", context("ssh://prod.example")), /not backed by an approved local/u);
  assert.throws(() => localDockerEndpointEvidence("desktop-linux", context("unix:///tmp/not-a-socket"), {
    lstat: () => ({ isSocket: () => false, isSymbolicLink: () => false }),
  }), /not a real local socket/u);
});

test("requires all source and target volume names and backing mountpoints to differ", () => {
  const source = volumes(sourceProject, "/docker/source");
  const target = volumes(targetProject, "/docker/target");
  assert.deepEqual(distinctVolumeEvidence(source, target), {
    allVolumeNamesDistinct: true,
    allMountpointsDistinct: true,
    sourceDataVolume: source[1],
    targetDataVolume: target[1],
  });
  const sharedName = structuredClone(target);
  sharedName[1].name = source[1].name;
  assert.throws(() => distinctVolumeEvidence(source, sharedName), /share a named volume/u);
  const sharedMountpoint = structuredClone(target);
  sharedMountpoint[1].mountpoint = source[1].mountpoint;
  assert.throws(() => distinctVolumeEvidence(source, sharedMountpoint), /alias a volume mountpoint/u);
});

test("cleanup passes only after successful container, volume, and network inspections", () => {
  const complete = {
    logCaptureSucceeded: true,
    downSucceeded: true,
    containerInspectionSucceeded: true,
    containersRemoved: true,
    volumeInspectionSucceeded: true,
    volumesRemoved: true,
    networkInspectionSucceeded: true,
    networksRemoved: true,
  };
  assert.equal(cleanupProjectComplete(complete), true);
  for (const field of Object.keys(complete)) {
    assert.equal(cleanupProjectComplete({ ...complete, [field]: false }), false, field);
  }
  assert.equal(cleanupProjectComplete(undefined), false);
});

test("evidence remains NO-GO and cannot claim a remote host, network transfer, or TLS", () => {
  const evidence = initialNoGoEvidence({
    sourceProject,
    targetProject,
    sourceEndpoint: "http://127.0.0.1:43001",
    targetEndpoint: "http://127.0.0.1:43002",
  });
  assert.equal(validateNoGoEvidence(evidence), evidence);
  assert.equal(evidence.releaseStatus, "NO-GO");
  assert.equal(evidence.evidenceLevel, "same-host-disposable-isolation-simulation");
  assert.equal(evidence.claims.realRemoteHostVerified, false);
  assert.equal(evidence.claims.realNetworkTransferVerified, false);
  assert.equal(evidence.claims.tlsVerified, false);
  assert.match(evidence.blockers.join("\n"), /not a real remote-host restore/u);
  assert.match(evidence.blockers.join("\n"), /No network transfer, TLS/u);
  assert.match(evidence.blockers.join("\n"), /prebuilt local image checkpoint/u);

  assert.throws(() => validateNoGoEvidence({ ...evidence, releaseStatus: "GO" }), /NO-GO/u);
  assert.throws(() => validateNoGoEvidence({
    ...evidence,
    claims: { ...evidence.claims, realRemoteHostVerified: true },
  }), /real remote host/u);
  assert.throws(() => validateNoGoEvidence({
    ...evidence,
    claims: { ...evidence.claims, realNetworkTransferVerified: true },
  }), /real network transfer/u);
  assert.throws(() => validateNoGoEvidence({
    ...evidence,
    claims: { ...evidence.claims, tlsVerified: true },
  }), /TLS/u);
});
