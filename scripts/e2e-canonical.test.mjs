import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sampleRuntimeTelemetry } from "./e2e-runtime-telemetry.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("canonical E2E runs all original projects after a failure and preserves state before removing its containers", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "cvg-canonical-test-"));
  try {
    mkdirSync(path.join(fixture, "scripts"), { recursive: true });
    mkdirSync(path.join(fixture, ".github/workflows"), { recursive: true });
    mkdirSync(path.join(fixture, "tests/e2e/visual.spec.ts-snapshots"), { recursive: true });
    mkdirSync(path.join(fixture, "bin"));
    // Ubuntu runners may have grep and Docker without ripgrep installed.
    writeFileSync(path.join(fixture, "bin/rg"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
    copyFileSync(path.join(repo, "scripts/test-e2e-canonical.sh"), path.join(fixture, "scripts/test-e2e-canonical.sh"));
    copyFileSync(path.join(repo, ".github/workflows/ci.yml"), path.join(fixture, ".github/workflows/ci.yml"));
    const baseline = path.join(fixture, "tests/e2e/visual.spec.ts-snapshots/dashboard.png");
    writeFileSync(baseline, "existing baseline");
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
    execFileSync("git", ["add", "."], { cwd: fixture });
    execFileSync("git", ["-c", "user.name=Canonical test", "-c", "user.email=canonical@example.test", "commit", "--quiet", "-m", "fixture"], { cwd: fixture });
    const capture = path.join(fixture, "runner-call.json");
    writeFileSync(path.join(fixture, "bin/docker"), String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const capture = process.env.CVG_CANONICAL_CALL;
const previous = fs.existsSync(capture) ? JSON.parse(fs.readFileSync(capture)) : {calls:[]};
if (args[0] !== 'run') {
  previous.calls.push({operation:args[0],args}); fs.writeFileSync(capture, JSON.stringify(previous));
  if (args[0] === 'rm' && process.env.CVG_CANONICAL_CLEANUP_FAIL && previous.calls.filter(call=>call.operation==='rm'&&call.args.at(-1)===args.at(-1)).length === 1) { console.error('synthetic cleanup failed once'); process.exit(1); }
  if (args[0] === 'inspect' && process.env.CVG_CANONICAL_INSPECT_FAIL) { console.error('synthetic inspect unavailable'); process.exit(1); }
  if (args[0] === 'inspect') console.log(JSON.stringify({Status:'exited',Running:false,OOMKilled:true,ExitCode:137,Pid:0,Error:''}));
  process.exit(0);
}
const work = args[args.indexOf('-v') + 1].split(':')[0];
const project = args.find(arg=>arg.startsWith('CVG_E2E_PROJECT=')).split('=')[1];
const identifier = ({chromium:'a',tablet:'b',mobile:'c'})[project].repeat(64);
fs.writeFileSync(args[args.indexOf('--cidfile')+1], identifier+'\n');
previous.calls.push({operation:'run',args,work,project}); fs.writeFileSync(capture, JSON.stringify(previous));
fs.mkdirSync(path.join(work, 'canonical-artifacts/main',project,'test-results'), {recursive:true});
fs.writeFileSync(path.join(work, 'canonical-artifacts/main',project,'test-results/failure.png'), 'synthetic capture');
fs.writeFileSync(path.join(work, 'canonical-artifacts/main',project,'report.html'), 'synthetic failure report');
console.log('synthetic browser '+project);
process.exit(project === 'chromium' ? 7 : 0);
`, { mode: 0o755 });
    const environment = { ...process.env, PATH: `${path.join(fixture, "bin")}${path.delimiter}${process.env.PATH}`, CVG_CANONICAL_CALL: capture, CVG_E2E_CONTAINER_RUNTIME: "docker" };
    const outcome = spawnSync("bash", ["scripts/test-e2e-canonical.sh", "tests/e2e/visual.spec.ts"], { cwd: fixture, env: environment, encoding: "utf8" });
    assert.equal(outcome.status, 7, outcome.stderr);
    const called = JSON.parse(readFileSync(capture, "utf8")).calls;
    const runs = called.filter(call => call.operation === "run");
    assert.deepEqual(runs.map(call => call.project), ["chromium", "tablet", "mobile"], "a failed desktop must not skip tablet or mobile");
    assert.deepEqual(called.map(call => call.operation), ["run", "inspect", "rm", "run", "inspect", "rm", "run", "inspect", "rm"]);
    for (const run of runs) {
      assert.ok(run.args.includes("--memory=4g")); assert.ok(run.args.includes("--memory-swap=4g"));
      assert.ok(run.args.includes("--shm-size=1g")); assert.ok(run.args.includes("--cpus=4"));
      assert.ok(!run.args.includes("--rm"), "State must be captured before explicit cleanup");
      assert.equal(existsSync(run.work), false, "temporary source tree must be cleaned after failure");
    }
    for (const call of called.filter(call => call.operation === "inspect")) assert.deepEqual(call.args.slice(0,3), ["inspect", "--format", "{{json .State}}"]);
    assert.equal(readFileSync(baseline, "utf8"), "existing baseline");
    const [directory] = readdirSync(path.join(fixture, "test-results"));
    const artifacts = path.join(fixture, "test-results", directory);
    assert.equal(readFileSync(path.join(artifacts, "exit-code.txt"), "utf8"), "7\n");
    for (const project of ["chromium", "tablet", "mobile"]) {
      assert.equal(readFileSync(path.join(artifacts, "main",project,"test-results/failure.png"), "utf8"), "synthetic capture");
      assert.match(readFileSync(path.join(artifacts, "main",project,"run.log"), "utf8"), new RegExp(`synthetic browser ${project}`));
      assert.equal(JSON.parse(readFileSync(path.join(artifacts,"containers",`${project}.state.json`),"utf8")).OOMKilled, true);
      assert.equal(readFileSync(path.join(artifacts,"main",project,"runner-exit-code.txt"),"utf8"), project === "chromium" ? "7\n" : "0\n");
    }
    assert.equal(readFileSync(path.join(artifacts,"projects.txt"),"utf8"),"chromium\ntablet\nmobile\n");
    assert.match(readFileSync(path.join(artifacts, "image.txt"), "utf8"), /@sha256:[a-f0-9]{64}/);
    assert.match(readFileSync(path.join(artifacts, "resources.txt"), "utf8"), /memory=4g/);

    // A caller cannot turn a verification run into an update of golden images.
    rmSync(capture);
    const update = spawnSync("bash", ["scripts/test-e2e-canonical.sh", "--update-snapshots"], { cwd: fixture, env: environment, encoding: "utf8" });
    assert.equal(update.status, 2);
    assert.equal(existsSync(capture), false);
    assert.equal(readFileSync(baseline, "utf8"), "existing baseline");

    const invalidMemory = spawnSync("bash", ["scripts/test-e2e-canonical.sh"], { cwd: fixture, env: { ...environment, CVG_E2E_MEMORY_LIMIT: "64g" }, encoding: "utf8" });
    assert.equal(invalidMemory.status, 2);
    assert.equal(existsSync(capture), false, "unbounded memory must be refused before running a container");

    const increasedMemory = spawnSync("bash", ["scripts/test-e2e-canonical.sh", "tests/e2e/visual.spec.ts"], { cwd: fixture, env: { ...environment, CVG_E2E_MEMORY_LIMIT: "8g" }, encoding: "utf8" });
    assert.equal(increasedMemory.status, 7);
    const increasedCalls = JSON.parse(readFileSync(capture, "utf8")).calls.filter(call => call.operation === "run");
    assert.equal(increasedCalls.length,3);
    for (const increasedCall of increasedCalls) { assert.ok(increasedCall.args.includes("--memory=8g")); assert.ok(increasedCall.args.includes("--memory-swap=8g")); }
    assert.equal(readFileSync(baseline, "utf8"), "existing baseline");
    rmSync(capture);

    const selected = spawnSync("bash", ["scripts/test-e2e-canonical.sh", "tests/e2e/visual.spec.ts", "--project=mobile"], { cwd: fixture, env: environment, encoding: "utf8" });
    assert.equal(selected.status,0,selected.stderr);
    assert.deepEqual(JSON.parse(readFileSync(capture,"utf8")).calls.filter(call => call.operation === "run").map(call => call.project),["mobile"]);
    rmSync(capture);
    const unknownProject = spawnSync("bash", ["scripts/test-e2e-canonical.sh", "--project=unknown"], { cwd: fixture, env: environment, encoding: "utf8" });
    assert.equal(unknownProject.status,2); assert.equal(existsSync(capture),false);

    const cleanupFailed = spawnSync("bash", ["scripts/test-e2e-canonical.sh", "--project=mobile"], { cwd: fixture, env: {...environment,CVG_CANONICAL_CLEANUP_FAIL:"true"}, encoding: "utf8" });
    assert.equal(cleanupFailed.status,1,"cleanup failure must not be reported as a passing verification");
    const cleanupCalls=JSON.parse(readFileSync(capture,"utf8")).calls;
    assert.deepEqual(cleanupCalls.map(call=>call.operation),["run","inspect","rm","rm"],"EXIT retries removal independently of the captured State");
    const cleanupArtifact = cleanupFailed.stdout.match(/Canonical E2E artifacts: (.+)/)[1];
    assert.equal(readFileSync(path.join(cleanupArtifact,"containers/mobile.removed"),"utf8"),"removed\n");
    assert.equal(readFileSync(path.join(cleanupArtifact,"exit-code.txt"),"utf8"),"1\n");
    rmSync(capture);
    const inspectFailed = spawnSync("bash", ["scripts/test-e2e-canonical.sh", "--project=mobile"], { cwd: fixture, env: {...environment,CVG_CANONICAL_INSPECT_FAIL:"true"}, encoding: "utf8" });
    assert.equal(inspectFailed.status,0,inspectFailed.stderr);
    const inspectArtifact=inspectFailed.stdout.match(/Canonical E2E artifacts: (.+)/)[1];
    assert.deepEqual(JSON.parse(readFileSync(path.join(inspectArtifact,"containers/mobile.state.json"),"utf8")),{status:"UNKNOWN",reason:"STATE_INSPECTION_FAILED"});
    assert.equal(readFileSync(path.join(inspectArtifact,"containers/mobile.removed"),"utf8"),"removed\n");
    rmSync(capture);

    // A mismatched CI digest still prevents the container from being called.
    writeFileSync(path.join(fixture, ".github/workflows/ci.yml"), "name: fixture without the pinned image\n");
    const changedImage = spawnSync("bash", ["scripts/test-e2e-canonical.sh"], { cwd: fixture, env: environment, encoding: "utf8" });
    assert.equal(changedImage.status, 2);
    assert.match(changedImage.stderr, /CI browser image changed/);
    assert.equal(existsSync(capture), false);
    assert.equal(readFileSync(baseline, "utf8"), "existing baseline");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("runtime telemetry links only harness descendants to listening servers and never emits argv or environment", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(),"cvg-runtime-telemetry-test-"));
  try {
    const procRoot=path.join(fixture,"proc"), cgroupRoot=path.join(fixture,"cgroup");
    mkdirSync(path.join(procRoot,"net"),{recursive:true}); mkdirSync(cgroupRoot);
    const process_=(pid,parent,command,rss)=>{
      mkdirSync(path.join(procRoot,String(pid),"fd"),{recursive:true});
      writeFileSync(path.join(procRoot,String(pid),"status"),`Name:\tprivate-secret-name\nState:\tS (sleeping)\nPPid:\t${parent}\nVmRSS:\t${rss} kB\nVmHWM:\t${rss+10} kB\nThreads:\t2\n`);
      writeFileSync(path.join(procRoot,String(pid),"cmdline"),command);writeFileSync(path.join(procRoot,String(pid),"environ"),"SECRET=must-never-be-read");
    };
    process_(10,1,"bash",20); process_(20,10,"next-server\0PRIVATE_ARG=must-not-appear",2751364);process_(30,20,"headless_shell\0--type=renderer\0secret-token",400);
    process_(99,1,"unrelated-program-secret",999);
    writeFileSync(path.join(procRoot,"net","tcp"),"header\n0: 00000000:0C1C 00000000:0000 0A 0 0 0 0 0 123\n");
    symlinkSync("socket:[123]",path.join(procRoot,"20","fd","7"));
    writeFileSync(path.join(cgroupRoot,"memory.current"),"8388608\n");writeFileSync(path.join(cgroupRoot,"memory.max"),"8388608\n");
    writeFileSync(path.join(cgroupRoot,"memory.events"),"low 0\nhigh 0\nmax 12\noom 2\noom_kill 2\n");writeFileSync(path.join(cgroupRoot,"pids.current"),"3\n");
    const sample=sampleRuntimeTelemetry({procRoot,cgroupRoot,sharedMemoryRoot:fixture,rootPid:10,observedAt:"2026-10-11T00:00:00Z"});
    assert.deepEqual(sample.processes.map(record=>record.pid),[10,20,30]);
    assert.equal(sample.processes[1].rssKiB,2751364);assert.deepEqual(sample.processes[1].serverPorts,[3100]);assert.equal(sample.processes[2].category,"CHROMIUM_RENDERER");
    assert.equal(sample.cgroup.memoryEvents.oom_kill,2);assert.equal(sample.cgroup.memoryCurrentBytes,8388608);
    assert.equal(sample.cgroup.pidsCurrent,3);assert.equal(sample.cgroup.memoryEventsLocal,null);
    assert.doesNotMatch(JSON.stringify(sample),/secret|PRIVATE_ARG|must-never-be-read|unrelated-program/i);
    writeFileSync(path.join(cgroupRoot,"memory.events"),"oom_kill 3\n");
    assert.equal(sampleRuntimeTelemetry({procRoot,cgroupRoot,sharedMemoryRoot:fixture,rootPid:10}).cgroup.memoryEvents.oom_kill,3);
    const missing=sampleRuntimeTelemetry({procRoot:path.join(fixture,"absent"),cgroupRoot:path.join(fixture,"absent"),sharedMemoryRoot:path.join(fixture,"absent"),rootPid:10});
    assert.equal(missing.cgroup.source,"UNKNOWN");assert.equal(missing.cgroup.memoryCurrentBytes,null);assert.equal(missing.sharedMemory,null);assert.deepEqual(missing.processes,[]);
  } finally {rmSync(fixture,{recursive:true,force:true});}
});

test("canonical project config selects exactly one original viewport and one server, rejects unknown and external targets", () => {
  const fixture=mkdtempSync(path.join(os.tmpdir(),"cvg-project-config-test-"));
  try {
    mkdirSync(path.join(fixture,"scripts")); copyFileSync(path.join(repo,"playwright.config.ts"),path.join(fixture,"playwright.config.ts"));
    copyFileSync(path.join(repo,"scripts/scratch-tsconfig.ts"),path.join(fixture,"scripts/scratch-tsconfig.ts"));
    writeFileSync(path.join(fixture,"package.json"),'{"type":"module"}');symlinkSync(path.join(repo,"node_modules"),path.join(fixture,"node_modules"),"dir");
    const source='import config from "./playwright.config.ts"; console.log(JSON.stringify({projects:config.projects.map(p=>({name:p.name,viewport:p.use.viewport,isMobile:p.use.isMobile,timezone:p.use.timezoneId})),servers:config.webServer.map(s=>({name:s.name,url:s.url,stdout:s.stdout,stderr:s.stderr})),workers:config.workers,timeout:config.timeout}));';
    for(const [project,port] of [["chromium",3100],["tablet",3101],["mobile",3102]]) {
      const result=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",source],{cwd:fixture,env:{...process.env,BASE_URL:"",CVG_E2E_PROJECT:project,CVG_E2E_RUNTIME_TELEMETRY:"true"},encoding:"utf8"});
      assert.equal(result.status,0,result.stderr);const config=JSON.parse(result.stdout);
      assert.deepEqual(config.projects.map(p=>p.name),[project]);assert.deepEqual(config.servers,[{name:project,url:`http://localhost:${port}`,stdout:"pipe",stderr:"pipe"}]);
      assert.equal(config.workers,1);assert.equal(config.timeout,60000);if(project==="mobile")assert.equal(config.projects[0].isMobile,true);
    }
    for(const env of [{CVG_E2E_PROJECT:"unknown",BASE_URL:""},{CVG_E2E_PROJECT:"mobile",BASE_URL:"https://external.example.test"}]) {
      const denied=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",source],{cwd:fixture,env:{...process.env,...env},encoding:"utf8"});assert.notEqual(denied.status,0);
    }
  }finally{rmSync(fixture,{recursive:true,force:true});}
});

test("browser CI gates every checked-in spec per isolated project and preserves the protected aggregate check", () => {
  const workflow = readFileSync(path.join(repo, ".github/workflows/ci.yml"), "utf8");
  const lines = workflow.split("\n");
  const job = (name) => {
    const start = lines.indexOf(`  ${name}:`);
    if (start < 0) return undefined;
    const end = lines.findIndex((line, index) => index > start && /^  [\w-]+:$/.test(line));
    return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  };
  const projects = job("browser-projects");
  const runner = projects ?? job("browser");
  assert.ok(runner, "the browser gate must exist");
  const commands = runner.split("\n").filter(line => /^ {8}run: npm run test:e2e --/.test(line)).map(line => line.trim().slice(5));
  const home = commands.filter(command => command.includes('--grep "Plane-style home"'));
  const main = commands.filter(command => !home.includes(command));
  assert.equal(home.length, 1, "keep the independently started Home preflight");
  assert.equal(main.length, 1, "there must be one complete main run per project");
  const expectedSpecs = readdirSync(path.join(repo, "tests/e2e")).filter(name => name.endsWith(".spec.ts")).map(name => `tests/e2e/${name}`).sort();
  const explicitSpecs = main[0].match(/tests\/e2e\/[^\s]+\.spec\.ts/g) ?? [];
  const selectedSpecs = explicitSpecs.length ? [...explicitSpecs].sort() : expectedSpecs;
  assert.deepEqual(selectedSpecs, expectedSpecs, `The CI browser gate omits checked-in specs: ${expectedSpecs.filter(spec => !selectedSpecs.includes(spec)).join(", ")}`);
  assert.equal(explicitSpecs.length, 0, "new specs must automatically enter the main gate");
  assert.ok(projects, "use independent jobs for all three original projects");
  assert.match(projects, /^ {4}needs: verify$/m);
  assert.match(projects, /^ {6}fail-fast: false$/m);
  assert.match(projects, /^ {8}node-version: \["22\.x"\]$/m);
  assert.match(projects, /^ {8}project: \["chromium", "tablet", "mobile"\]$/m);
  assert.match(projects, /^ {6}CVG_E2E_PROJECT: \$\{\{ matrix\.project \}\}$/m);
  assert.match(projects, /^ {4}container: mcr\.microsoft\.com\/playwright:v1\.55\.1-noble@sha256:2f29369043d81d6d69a815ceb80760f55e85f5020371ad06a4d996f18503ad1c$/m);
  for (const command of [...home, ...main]) {
    assert.match(command, /--project=\$\{\{ matrix\.project \}\}/);
    assert.match(command, /--retries=0(?:\s|$)/);
    assert.match(command, /--fail-on-flaky-tests(?:\s|$)/);
    assert.doesNotMatch(command, /--update-snapshots|-u(?:\s|$)|--pass-with-no-tests|--last-failed|--shard|--grep-invert|--list(?:\s|=|$)|--test-list|--only-changed|--config(?:\s|=|$)/);
  }
  const mainArguments = main[0].replace(/^npm run test:e2e --\s+/, "").replaceAll("${{ matrix.project }}", "PROJECT").split(/\s+/);
  assert.ok(mainArguments.every(argument => argument.startsWith("--")), "no positional path filters may narrow the full testDir");
  assert.doesNotMatch(main[0], /--grep/);
  assert.doesNotMatch(projects, /run: npm run test:accessibility/, "accessibility specs are already in the complete main gate");
  assert.match(projects, /name: playwright-e2e-\$\{\{ matrix\.project \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(projects, /^ {8}if: always\(\)$/m);
  assert.match(projects, /playwright-report\/\n {12}test-results\//);
  assert.match(projects, /^ {10}retention-days: 14$/m);
  const aggregate = job("browser");
  assert.ok(aggregate);
  assert.match(aggregate, /^ {4}name: browser \(22\.x\)$/m, "preserve the existing required status context");
  assert.match(aggregate, /^ {4}needs: \[browser-projects\]$/m);
  assert.match(aggregate, /^ {4}if: always\(\)$/m);
  assert.match(aggregate, /^ {10}BROWSER_PROJECTS_RESULT: \$\{\{ needs\.browser-projects\.result \}\}$/m);
  const aggregateRun = /^ {8}run: \|\n((?: {10}[^\n]*(?:\n|$))+)/m.exec(aggregate)?.[1].replace(/^ {10}/gm, "");
  assert.ok(aggregateRun, "the aggregate must explicitly evaluate the matrix result");
  for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
    const outcome = spawnSync("bash", ["-e", "-u", "-o", "pipefail", "-c", aggregateRun], { env: { ...process.env, BROWSER_PROJECTS_RESULT: result }, encoding: "utf8" });
    assert.equal(outcome.status, result === "success" ? 0 : 1, `matrix result ${JSON.stringify(result)} must not turn skipped/failed projects green`);
  }
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  assert.ok(job("browser-postgres"), "retain the separate production/PostgreSQL browser lane");
});
