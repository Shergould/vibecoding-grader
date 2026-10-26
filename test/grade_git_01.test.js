import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGrader } from "../grader/grade_git_01.js";

const courseRepo = "Shergould/vibecoding-course";
const sha = "a".repeat(40);
const baseSha = "b".repeat(40);
const newSha = "c".repeat(40);
const correctAnswer = [
  "git clone https://github.com/Shergould/vibecoding-course.git",
  "git switch -c student/alice/git_01",
  "git add lessons/git_01/answer.md",
  'git commit -m "finish git_01"',
  "git push origin student/alice/git_01"
].map((command) => `\`\`\`bash\n${command}\n\`\`\``).join("\n");

function submission(number = 1, login = "Alice") {
  return {
    number, state: "open", draft: false, html_url: `https://github.com/${courseRepo}/pull/${number}`,
    user: { login },
    base: { ref: "main", sha: baseSha, repo: { full_name: courseRepo } },
    head: {
      ref: `student/${login}/git_01`, sha,
      repo: { full_name: `${login}/vibecoding-course`, name: "vibecoding-course", owner: { login }, fork: true }
    }
  };
}

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "vibecoding-grader-test-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const state = {
    pulls: [submission()], comments: [], calls: [], answer: correctAnswer,
    files: [{ filename: "lessons/git_01/answer.md" }],
    message: "finish git_01", failComment: false, failCompareFor: null,
    sourceIsRelated: true, afterReadAnswer: null, ...options
  };
  const api = (name, fn) => async (args) => {
    state.calls.push({ name, args: structuredClone(args) });
    return fn(args);
  };
  const octokit = {
    paginate: async (fn, args) => (await fn(args)).data,
    rest: {
      pulls: {
        list: api("listPulls", () => ({ data: structuredClone(state.pulls) })),
        get: api("getPull", ({ pull_number }) => ({ data: structuredClone(state.pulls.find((pr) => pr.number === pull_number)) }))
      },
      repos: {
        get: api("getRepo", ({ owner }) => ({ data: {
          full_name: `${owner}/vibecoding-course`, name: "vibecoding-course", owner: { login: owner },
          fork: true, parent: { full_name: state.sourceIsRelated ? courseRepo : "unrelated/project" }
        } })),
        compareCommitsWithBasehead: api("compare", ({ basehead }) => {
          if (basehead.endsWith(state.failCompareFor || "never")) throw new Error("Comparison unavailable");
          return { data: { files: structuredClone(state.files) } };
        }),
        getContent: api("getContent", () => {
          state.afterReadAnswer?.();
          if (state.answer === null) throw Object.assign(new Error("Not found"), { status: 404 });
          return { data: { type: "file", encoding: "base64", content: Buffer.from(state.answer).toString("base64") } };
        })
      },
      git: { getCommit: api("getCommit", () => ({ data: { message: state.message } })) },
      users: { getAuthenticated: api("getBot", () => ({ data: { id: 42 } })) },
      issues: {
        listComments: api("listComments", ({ issue_number }) => ({ data: structuredClone(state.comments.filter((c) => c.pr === issue_number)) })),
        createComment: api("createComment", ({ issue_number, body }) => {
          if (state.failComment) throw new Error("Temporary comment failure");
          const comment = { id: state.comments.length + 1, pr: issue_number, user: { id: 42 }, body };
          state.comments.push(comment);
          return { data: comment };
        }),
        updateComment: api("updateComment", ({ comment_id, body }) => {
          const comment = state.comments.find((c) => c.id === comment_id);
          comment.body = body;
          return { data: comment };
        })
      }
    }
  };
  const grader = createGrader({ octokit, courseRepo, completionKey: "TEST-ONLY-KEY", dataDir });
  const latest = async (user = "alice") => JSON.parse(await fs.readFile(path.join(dataDir, "submissions", user, "git_01", "latest.json")));
  const attempts = async (user = "alice") => (await fs.readdir(path.join(dataDir, "submissions", user, "git_01"))).filter((name) => name.startsWith("attempt-"));
  return { ...grader, state, dataDir, latest, attempts };
}

const dispatch = (headSha = sha, number = 1) => ({
  eventName: "repository_dispatch",
  event: { action: "student_submission", client_payload: { course_repo: courseRepo, pr_number: number, head_sha: headSha } }
});

test("dispatch grades a fork PR, records provenance and pins all reads to SHA", async (t) => {
  const f = await fixture(t);
  await f.run(dispatch());
  const result = await f.latest();
  assert.equal(result.status, "passed");
  assert.equal(result.score, 100);
  assert.equal(result.pr_number, 1);
  assert.equal(result.source_repo, "Alice/vibecoding-course");
  assert.equal(result.feedback_posted, true);
  assert.equal(f.state.comments.length, 1);
  assert.match(f.state.comments[0].body, /TEST-ONLY-KEY/);
  assert.deepEqual(f.state.calls.find((call) => call.name === "getContent").args, {
    owner: "Alice", repo: "vibecoding-course", path: "lessons/git_01/answer.md", ref: sha
  });
  assert.equal(f.state.calls.find((call) => call.name === "compare").args.basehead, `${baseSha}...${sha}`);
});

test("duplicate notifications and sweeps do not create duplicate attempts or comments", async (t) => {
  const f = await fixture(t);
  await f.run(dispatch());
  await f.run(dispatch());
  await f.run({ eventName: "schedule" });
  assert.equal((await f.attempts()).length, 1);
  assert.equal(f.state.comments.length, 1);
});

test("a new SHA creates a new attempt; returning to an old SHA does not overwrite latest", async (t) => {
  const f = await fixture(t);
  await f.run();
  f.state.pulls[0].head.sha = newSha;
  await f.run(dispatch(newSha));
  f.state.pulls[0].head.sha = sha;
  await f.run();
  assert.equal((await f.attempts()).length, 2);
  assert.equal((await f.latest()).commit, newSha);
  assert.equal(f.state.comments.length, 2);
});

test("same SHA in a second PR is tracked separately", async (t) => {
  const f = await fixture(t);
  await f.run();
  f.state.pulls.push(submission(2));
  await f.run(dispatch(sha, 2));
  assert.equal((await f.latest()).pr_number, 2);
  assert.equal((await f.attempts()).length, 2);
});

test("stale notifications do not grade the wrong version", async (t) => {
  const f = await fixture(t);
  f.state.pulls[0].head.sha = newSha;
  await f.run(dispatch());
  assert.equal(f.state.calls.some((call) => call.name === "getContent"), false);
  await f.run({ eventName: "schedule" });
  assert.equal((await f.latest()).commit, newSha);
});

test("an update during grading is deferred instead of recording mixed snapshots", async (t) => {
  const f = await fixture(t);
  f.state.afterReadAnswer = () => { f.state.pulls[0].head.sha = newSha; };
  await f.run();
  assert.equal(f.state.comments.length, 0);
  assert.equal((await f.attempts()).length, 0);
  await f.run();
  assert.equal((await f.latest()).commit, newSha);
});

test("branch impersonation is rejected without recording a grade", async (t) => {
  const f = await fixture(t);
  f.state.pulls[0].head.ref = "student/bob/git_01";
  await f.run();
  assert.match(f.state.comments[0].body, /本次未登记成绩/);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, "submissions")), []);
});

test("another user's fork and unrelated repositories are rejected", async (t) => {
  for (const unrelated of [false, true]) {
    const f = await fixture(t);
    if (unrelated) f.state.sourceIsRelated = false;
    else f.state.pulls[0].head.repo.owner.login = "bob";
    await f.run();
    assert.match(f.state.comments[0].body, /本次未登记成绩/);
    assert.equal(f.state.calls.some((call) => call.name === "getContent"), false);
  }
});

test("closed and draft PRs are not graded", async (t) => {
  for (const change of [{ state: "closed" }, { draft: true }]) {
    const f = await fixture(t);
    Object.assign(f.state.pulls[0], change);
    await f.run(dispatch());
    assert.equal(f.state.comments.length, 0);
    assert.equal(f.state.calls.some((call) => call.name === "getRepo"), false);
  }
});

test("dispatch payload must name the course and include a valid PR number and SHA", async (t) => {
  const f = await fixture(t);
  for (const changes of [{ course_repo: "evil/repo" }, { pr_number: "1; echo secret" }, { pr_number: -1 }, { head_sha: "main" }]) {
    const request = dispatch();
    Object.assign(request.event.client_payload, changes);
    await assert.rejects(f.run(request), /Invalid/);
  }
  assert.equal(f.state.calls.length, 0);
});

test("renaming protected files into the lesson still fails grading", async (t) => {
  const f = await fixture(t, { files: [
    { filename: "lessons/git_01/answer.md" },
    { filename: "lessons/git_01/copied.yml", previous_filename: ".github/workflows/notify-grader.yml" }
  ] });
  await f.run();
  assert.equal((await f.latest()).status, "failed");
  assert.equal((await f.latest()).completion_key, null);
});

test("a truncated file comparison is rejected", async (t) => {
  const f = await fixture(t, { files: Array.from({ length: 300 }, (_, i) => ({ filename: `file-${i}` })) });
  await f.run();
  assert.match(f.state.comments[0].body, /修改文件过多/);
  assert.equal((await f.attempts()).length, 0);
});

test("missing answers and wrong commit messages fail without a completion key", async (t) => {
  const f = await fixture(t, { answer: null, message: "update answer" });
  await f.run();
  assert.equal((await f.latest()).status, "failed");
  assert.equal((await f.latest()).score, 0);
  assert.doesNotMatch(f.state.comments[0].body, /TEST-ONLY-KEY/);
});

test("extra answer blocks cannot yield a passed result", async (t) => {
  const f = await fixture(t, { answer: `${correctAnswer}\n\`\`\`bash\nextra\n\`\`\`` });
  await f.run();
  assert.equal((await f.latest()).status, "failed");
});

test("failed feedback persists the result and is retried even after the PR closes", async (t) => {
  const f = await fixture(t, { failComment: true });
  await assert.rejects(f.run());
  assert.equal((await f.latest()).feedback_posted, false);
  assert.equal((await f.attempts()).length, 1);
  f.state.failComment = false;
  f.state.pulls = [];
  await f.run({ eventName: "schedule" });
  assert.equal((await f.latest()).feedback_posted, true);
  assert.equal((await f.attempts()).length, 1);
  assert.equal(f.state.comments.length, 1);
});

test("retry after a posted comment but unsaved acknowledgement reuses the bot comment", async (t) => {
  const f = await fixture(t);
  await f.run();
  const result = await f.latest();
  result.feedback_posted = false;
  const dir = path.join(f.dataDir, "submissions", "alice", "git_01");
  await fs.writeFile(path.join(dir, "attempt-001.json"), JSON.stringify(result));
  await f.run();
  assert.equal(f.state.comments.length, 1);
  assert.equal((await f.latest()).feedback_posted, true);
});

test("student comments with a copied feedback marker cannot suppress bot feedback", async (t) => {
  const f = await fixture(t);
  f.state.comments.push({ id: 1, pr: 1, user: { id: 999 }, body: `<!-- vibecoding-grader:git_01:pr:1:sha:${sha} -->\nfake score` });
  await f.run();
  assert.equal(f.state.comments.length, 2);
  assert.equal(f.state.comments[1].user.id, 42);
});

test("one failing PR does not prevent another student's grade from being saved", async (t) => {
  const f = await fixture(t, { failCompareFor: sha });
  const bob = submission(2, "bob");
  bob.head.sha = newSha;
  f.state.pulls.push(bob);
  await assert.rejects(f.run());
  assert.equal((await f.latest("bob")).status, "passed");
  const summary = JSON.parse(await fs.readFile(path.join(f.dataDir, "summary", "results.json")));
  assert.equal(summary.length, 1);
});

test("legacy results and mixed-case student directories are retained", async (t) => {
  const f = await fixture(t);
  const dir = path.join(f.dataDir, "submissions", "Alice", "git_01");
  await fs.mkdir(dir, { recursive: true });
  const historical = { github_username: "Alice", attempt_number: 4, commit: "old", score: 60, lesson: "git_01" };
  await fs.writeFile(path.join(dir, "attempt-004.json"), JSON.stringify(historical));
  await fs.writeFile(path.join(dir, "latest.json"), JSON.stringify(historical));
  await f.run();
  assert.equal((await f.latest("Alice")).attempt_number, 5);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "attempt-004.json"))), historical);
});
