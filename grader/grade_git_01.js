import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseStudentBranch, gradeSubmission } from "./rules_git_01.js";
import { formatFeedback } from "./feedback.js";

const LESSON = "git_01";
const ANSWER_PATH = `lessons/${LESSON}/answer.md`;
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const LOGIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Do not leave half-written JSON if the process is interrupted.
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(`${file}.tmp`, file);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function validateSubmission(pr, courseRepo, baseBranch) {
  const problems = [];
  const username = pr.user?.login;
  const parsed = parseStudentBranch(pr.head?.ref || "");
  if (!same(pr.base?.repo?.full_name, courseRepo) || pr.base?.ref !== baseBranch) {
    problems.push("PR 必须提交到课程原仓库的 main 分支。");
  }
  if (!LOGIN_PATTERN.test(username || "")) problems.push("无法确认提交者的 GitHub 用户名。");
  if (!parsed.valid || !same(parsed.username, username)) {
    problems.push("分支必须为 student/<PR 作者的 GitHub 用户名>/git_01。");
  }
  const source = pr.head?.repo;
  if (!source?.fork || same(source.full_name, courseRepo) || !same(source.owner?.login, username)) {
    problems.push("请从 PR 作者本人账号下的课程 Fork 提交作业。");
  }
  if (!SHA_PATTERN.test(pr.head?.sha || "") || !SHA_PATTERN.test(pr.base?.sha || "")) {
    problems.push("PR 缺少有效的提交 SHA。");
  }
  return problems;
}

// Dependency injection keeps verification offline: tests use a fake GitHub API
// and temporary directories, never real submissions, credentials or comments.
export function createGrader({ octokit, courseRepo, baseBranch = "main", completionKey, dataDir = "data" }) {
  if (!/^[^/]+\/[^/]+$/.test(courseRepo || "")) throw new Error("COURSE_REPO must look like owner/repo");
  const [owner, repo] = courseRepo.split("/");
  const submissionsRoot = path.join(dataDir, "submissions");
  let botId;

  async function getPull(number) {
    return (await octokit.rest.pulls.get({ owner, repo, pull_number: number })).data;
  }

  async function postComment(prNumber, marker, body) {
    // Only reuse comments belonging to the authenticated grading account.
    // Students cannot suppress feedback by posting a matching HTML marker.
    botId ??= (await octokit.rest.users.getAuthenticated()).data.id;
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner, repo, issue_number: prNumber, per_page: 100
    });
    const existing = comments.find((item) => item.user?.id === botId && item.body?.startsWith(marker));
    const content = `${marker}\n${body}`;
    if (existing) {
      if (existing.body !== content) {
        await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: content });
      }
      return existing.id;
    }
    return (await octokit.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body: content
    })).data.id;
  }

  async function reportInvalid(pr, problems) {
    await postComment(pr.number, `<!-- vibecoding-grader:${LESSON}:validation -->`, [
      "## 作业提交方式需要调整", "",
      ...problems.map((problem) => `- ${problem}`), "",
      "本次未登记成绩。请修正后更新 PR；如需更换来源分支，请重新创建 PR。"
    ].join("\n"));
  }

  async function studentDirectory(username) {
    // Keep pre-migration history, including directories with mixed-case logins.
    await fs.mkdir(submissionsRoot, { recursive: true });
    const entries = await fs.readdir(submissionsRoot, { withFileTypes: true });
    const existing = entries.find((entry) => entry.isDirectory() && same(entry.name, username));
    return path.join(submissionsRoot, existing?.name || username.toLowerCase(), LESSON);
  }

  async function attemptsIn(dir) {
    await fs.mkdir(dir, { recursive: true });
    const names = (await fs.readdir(dir)).filter((name) => /^attempt-\d+\.json$/.test(name));
    return Promise.all(names.map((name) => readJson(path.join(dir, name))));
  }

  async function saveResult(dir, result) {
    const name = `attempt-${String(result.attempt_number).padStart(3, "0")}.json`;
    await writeJson(path.join(dir, name), result);
    const latest = await readJson(path.join(dir, "latest.json"));
    if (!latest || latest.attempt_number <= result.attempt_number) {
      await writeJson(path.join(dir, "latest.json"), result);
    }
  }

  async function deliverFeedback(dir, result) {
    if (result.feedback_posted) return;
    result.feedback_comment_id = await postComment(
      result.pr_number,
      `<!-- vibecoding-grader:${LESSON}:pr:${result.pr_number}:sha:${result.commit} -->`,
      formatFeedback(result)
    );
    result.feedback_posted = true;
    await saveResult(dir, result);
  }

  async function gradePullRequest(pr) {
    if (pr.state !== "open" || pr.draft) return;
    const problems = validateSubmission(pr, courseRepo, baseBranch);
    if (problems.length) {
      await reportInvalid(pr, problems);
      return;
    }
    // Re-fetch repository metadata instead of trusting dispatch payloads or PR text.
    const source = (await octokit.rest.repos.get({
      owner: pr.head.repo.owner.login, repo: pr.head.repo.name
    })).data;
    if (!source.fork || !same(source.owner?.login, pr.user.login)
      || !same(source.full_name, pr.head.repo.full_name)
      || !(same(source.parent?.full_name, courseRepo) || same(source.source?.full_name, courseRepo))) {
      await reportInvalid(pr, ["来源仓库必须是课程仓库的 Fork，并属于 PR 作者本人。"]);
      return;
    }

    const dir = await studentDirectory(pr.user.login);
    const attempts = await attemptsIn(dir);
    const previous = attempts.find((item) => item.pr_number === pr.number && item.commit === pr.head.sha);
    if (previous) {
      await deliverFeedback(dir, previous);
      console.log(`Skip PR #${pr.number}: SHA already graded`);
      return;
    }

    // Both endpoints use immutable SHAs, never a moving student branch.
    const sourceArgs = { owner: source.owner.login, repo: source.name };
    const [comparison, commit, answer] = await Promise.all([
      octokit.rest.repos.compareCommitsWithBasehead({
        owner, repo, basehead: `${pr.base.sha}...${pr.head.sha}`, per_page: 1, page: 1
      }),
      octokit.rest.git.getCommit({ ...sourceArgs, commit_sha: pr.head.sha }),
      octokit.rest.repos.getContent({ ...sourceArgs, path: ANSWER_PATH, ref: pr.head.sha })
        .catch((error) => {
          if (error.status === 404) return { data: null };
          throw error;
        })
    ]);
    const files = comparison.data.files;
    // GitHub truncates comparisons at 300 files. Never silently grade a partial diff.
    if (!Array.isArray(files) || files.length >= 300) {
      await reportInvalid(pr, ["修改文件过多或无法完整读取差异，请只提交本节课的作业文件。"]);
      return;
    }
    const changedFiles = [...new Set(files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean)))];
    const data = answer.data;
    const answerContent = data?.type === "file" && data.encoding === "base64"
      ? Buffer.from(data.content, "base64").toString("utf8") : "";
    const grade = gradeSubmission({
      branchName: pr.head.ref,
      parsed: parseStudentBranch(pr.head.ref),
      changedFiles,
      commitMessage: commit.data.message || "",
      answerContent
    });
    const current = await getPull(pr.number);
    if (current.state !== "open" || current.draft || current.head.sha !== pr.head.sha
      || current.base.sha !== pr.base.sha || current.head.ref !== pr.head.ref
      || !same(current.head.repo?.full_name, source.full_name)
      || validateSubmission(current, courseRepo, baseBranch).length) {
      console.log(`Skip PR #${pr.number}: changed during grading; next event/sweep will retry`);
      return;
    }
    if (grade.status === "passed" && !completionKey) {
      throw new Error("GIT_01_COMPLETION_KEY is required when a submission passes");
    }
    const result = {
      github_username: pr.user.login.toLowerCase(),
      lesson: LESSON,
      attempt_number: Math.max(0, ...attempts.map((item) => item.attempt_number)) + 1,
      pr_number: pr.number,
      pr_url: pr.html_url,
      source_repo: source.full_name,
      branch: pr.head.ref,
      commit: pr.head.sha,
      base_commit: pr.base.sha,
      changed_files: changedFiles,
      ...grade,
      max_score: 100,
      completion_key: grade.status === "passed" ? completionKey : null,
      graded_at: new Date().toISOString(),
      feedback_posted: false
    };
    // Persist the attempt before posting. Failed feedback is retried without regrading.
    await saveResult(dir, result);
    await deliverFeedback(dir, result);
  }

  async function writeSummary() {
    await fs.mkdir(submissionsRoot, { recursive: true });
    const entries = await fs.readdir(submissionsRoot, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const latest = await readJson(path.join(submissionsRoot, entry.name, LESSON, "latest.json"));
      if (latest) results.push(latest);
    }
    results.sort((a, b) => a.github_username.localeCompare(b.github_username));
    const fields = ["github_username", "lesson", "attempt_number", "status", "score", "commit", "graded_at", "pr_number", "source_repo"];
    await writeJson(path.join(dataDir, "summary", "results.json"), results);
    await fs.writeFile(path.join(dataDir, "summary", "results.csv"), [
      fields.join(","), ...results.map((result) => fields.map((field) => csvCell(result[field])).join(",")), ""
    ].join("\n"));
  }

  async function retryPendingFeedback(errors) {
    await fs.mkdir(submissionsRoot, { recursive: true });
    const entries = await fs.readdir(submissionsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(submissionsRoot, entry.name, LESSON);
      for (const result of await attemptsIn(dir)) {
        if (!result.pr_number || result.feedback_posted !== false) continue;
        try {
          await deliverFeedback(dir, result);
        } catch (error) {
          errors.push(new Error(`Feedback retry for PR #${result.pr_number}: ${error.message}`));
        }
      }
    }
  }

  async function run({ eventName = "workflow_dispatch", event = {} } = {}) {
    const errors = [];
    let numbers;
    let expectedSha;
    if (eventName === "repository_dispatch") {
      const payload = event.client_payload;
      if (event.action !== "student_submission" || !same(payload?.course_repo, courseRepo)
        || !Number.isSafeInteger(payload?.pr_number) || payload.pr_number < 1
        || !SHA_PATTERN.test(payload?.head_sha || "")) {
        throw new Error("Invalid student_submission dispatch payload");
      }
      numbers = [payload.pr_number];
      expectedSha = payload.head_sha;
    } else if (["schedule", "workflow_dispatch"].includes(eventName)) {
      const pulls = await octokit.paginate(octokit.rest.pulls.list, {
        owner, repo, state: "open", base: baseBranch, per_page: 100
      });
      numbers = pulls.filter((pr) => !pr.draft).map((pr) => pr.number);
      await retryPendingFeedback(errors);
    } else {
      throw new Error(`Unsupported event: ${eventName}`);
    }
    for (const number of numbers) {
      try {
        const pr = await getPull(number);
        if (expectedSha && pr.head.sha !== expectedSha) {
          console.log(`Skip stale dispatch for PR #${number}`);
          continue;
        }
        await gradePullRequest(pr);
      } catch (error) {
        errors.push(new Error(`PR #${number}: ${error.message}`));
      }
    }
    await writeSummary();
    if (errors.length) throw new AggregateError(errors, "Some submissions or feedback failed; next sweep will retry");
  }

  return { run };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.env.GRADER_BOT_TOKEN) throw new Error("Missing GRADER_BOT_TOKEN");
    const { Octokit } = await import("@octokit/rest");
    const grader = createGrader({
      octokit: new Octokit({ auth: process.env.GRADER_BOT_TOKEN, request: { timeout: 30000 } }),
      courseRepo: process.env.COURSE_REPO,
      baseBranch: process.env.BASE_BRANCH || "main",
      completionKey: process.env.GIT_01_COMPLETION_KEY
    });
    const event = process.env.GITHUB_EVENT_PATH ? await readJson(process.env.GITHUB_EVENT_PATH) : {};
    await grader.run({ eventName: process.env.GITHUB_EVENT_NAME || "workflow_dispatch", event });
  } catch (error) {
    // Avoid logging request objects that may contain credentials.
    console.error(error.message);
    for (const item of error.errors || []) console.error(item.message);
    process.exitCode = 1;
  }
}
