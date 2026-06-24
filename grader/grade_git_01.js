import { Octokit } from "@octokit/rest";
import fs from "node:fs/promises";
import path from "node:path";

const COURSE_REPO = process.env.COURSE_REPO;
const BASE_BRANCH = process.env.BASE_BRANCH || "main";
const TOKEN = process.env.GRADER_BOT_TOKEN;
const COMPLETION_KEY = process.env.GIT_01_COMPLETION_KEY;
const EVENT_PATH = process.env.GITHUB_EVENT_PATH;

const LESSON = "git_01";
const ANSWER_PATH = `lessons/${LESSON}/answer.md`;
const COURSE_CLONE_URL = "https://github.com/Shergould/vibecoding-course.git";
const MAX_SCORE = 100;

if (!COURSE_REPO) {
  throw new Error("Missing COURSE_REPO, expected owner/repo");
}

if (!TOKEN) {
  throw new Error("Missing GRADER_BOT_TOKEN");
}

const [owner, repo] = COURSE_REPO.split("/");

if (!owner || !repo) {
  throw new Error("COURSE_REPO must look like owner/repo");
}

const octokit = new Octokit({ auth: TOKEN });

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseStudentBranch(branchName) {
  const match = branchName.match(/^student\/([^/]+)\/git_01$/);
  if (!match) {
    return { valid: false, username: null, lesson: null };
  }

  return {
    valid: true,
    username: match[1],
    lesson: LESSON
  };
}

async function getDispatchBranch() {
  if (!EVENT_PATH) {
    return null;
  }

  const event = await readJson(EVENT_PATH);
  return event?.client_payload?.branch || null;
}

async function listStudentBranches() {
  const dispatchBranch = await getDispatchBranch();

  if (dispatchBranch) {
    const branch = await getBranch(dispatchBranch);
    return branch ? [branch] : [];
  }

  const branches = await octokit.paginate(octokit.rest.repos.listBranches, {
    owner,
    repo,
    per_page: 100
  });

  return branches.filter((branch) => branch.name.startsWith("student/"));
}

async function getBranch(branchName) {
  try {
    const response = await octokit.rest.repos.getBranch({
      owner,
      repo,
      branch: branchName
    });

    return {
      name: response.data.name,
      commit: {
        sha: response.data.commit.sha
      }
    };
  } catch (error) {
    if (error.status === 404) {
      console.log(`Branch not found, skip: ${branchName}`);
      return null;
    }
    throw error;
  }
}

async function getChangedFiles(branchName) {
  const compare = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${BASE_BRANCH}...${branchName}`
  });

  return (compare.data.files || []).map((file) => file.filename);
}

async function getCommitMessage(commitSha) {
  const commit = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: commitSha
  });

  return commit.data.message || "";
}

async function getFileContent(branchName, filePath) {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: branchName
    });

    if (Array.isArray(response.data) || response.data.type !== "file") {
      return "";
    }

    return Buffer.from(response.data.content, "base64").toString("utf8");
  } catch (error) {
    if (error.status === 404) {
      return "";
    }
    throw error;
  }
}

function extractBashAnswers(markdown) {
  const answers = [];
  const regex = /```bash\s*([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(markdown)) !== null) {
    answers.push(match[1].trim());
  }

  return answers;
}

function normalizeCommand(command) {
  return command
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'");
}

function commandContains(answer, expectedParts) {
  const normalized = normalizeCommand(answer);
  return expectedParts.every((part) => normalized.includes(part));
}

function gradeAnswerContent(answerContent) {
  const answers = extractBashAnswers(answerContent);
  const feedback = [];
  const problems = [];
  let score = 0;

  if (answers.length < 5) {
    problems.push("answer.md 中需要保留 5 个 bash 代码块，每道题一个。");
  }

  const q1 = answers[0] || "";
  const q2 = answers[1] || "";
  const q3 = answers[2] || "";
  const q4 = answers[3] || "";
  const q5 = answers[4] || "";

  if (commandContains(q1, ["git clone", COURSE_CLONE_URL])) {
    score += 20;
    feedback.push("Q1 正确：写出了 clone 课程仓库的命令。");
  } else {
    problems.push(`Q1 错误：需要使用 git clone ${COURSE_CLONE_URL}。`);
  }

  if (
    commandContains(q2, ["git checkout -b", "student/alice/git_01"])
    || commandContains(q2, ["git switch -c", "student/alice/git_01"])
  ) {
    score += 20;
    feedback.push("Q2 正确：写出了创建并切换到 student/alice/git_01 分支的命令。");
  } else {
    problems.push("Q2 错误：需要创建并切换到 student/alice/git_01 分支。");
  }

  if (commandContains(q3, ["git add", ANSWER_PATH])) {
    score += 20;
    feedback.push("Q3 正确：写出了暂存 answer.md 的命令。");
  } else {
    problems.push(`Q3 错误：需要使用 git add ${ANSWER_PATH}。`);
  }

  if (commandContains(q4, ["git commit", "finish git_01"])) {
    score += 20;
    feedback.push("Q4 正确：commit message 包含 finish git_01。");
  } else {
    problems.push("Q4 错误：需要使用 git commit，并且 message 包含 finish git_01。");
  }

  if (commandContains(q5, ["git push", "origin", "student/alice/git_01"])) {
    score += 20;
    feedback.push("Q5 正确：写出了推送 student/alice/git_01 到 origin 的命令。");
  } else {
    problems.push("Q5 错误：需要把 student/alice/git_01 推送到 origin。");
  }

  return { score, feedback, problems };
}

function gradeSubmission({ branchName, parsed, changedFiles, commitMessage, answerContent }) {
  const feedback = [];
  const problems = [];

  if (parsed.valid && branchName === `student/${parsed.username}/${LESSON}`) {
    feedback.push("分支命名正确。");
  } else {
    problems.push(`分支名应为 student/<你的 GitHub 用户名>/${LESSON}。`);
  }

  const protectedFiles = changedFiles.filter((file) => (
    file.startsWith(".github/")
    || file.startsWith("grader/")
    || file.startsWith("data/")
  ));

  if (protectedFiles.length === 0) {
    feedback.push("未修改保护目录。");
  } else {
    problems.push(`不能修改保护目录文件：${protectedFiles.join(", ")}。`);
  }

  if (changedFiles.includes(ANSWER_PATH)) {
    feedback.push(`已修改 ${ANSWER_PATH}。`);
  } else {
    problems.push(`需要修改 ${ANSWER_PATH}。`);
  }

  if (commitMessage.includes("finish git_01")) {
    feedback.push("commit message 包含 finish git_01。");
  } else {
    problems.push("commit message 必须包含 finish git_01。");
  }

  const answerGrade = gradeAnswerContent(answerContent);
  feedback.push(...answerGrade.feedback);
  problems.push(...answerGrade.problems);

  const score = Math.max(
    0,
    answerGrade.score
      - (parsed.valid ? 0 : 20)
      - (protectedFiles.length === 0 ? 0 : 20)
      - (changedFiles.includes(ANSWER_PATH) ? 0 : 20)
      - (commitMessage.includes("finish git_01") ? 0 : 20)
  );

  return {
    score,
    status: score === MAX_SCORE ? "passed" : "failed",
    feedback,
    problems
  };
}

async function getNextAttempt(username) {
  const attemptDir = path.join("data", "submissions", username, LESSON);
  await ensureDir(attemptDir);

  const files = await fs.readdir(attemptDir);
  const attemptNumbers = files
    .map((file) => file.match(/^attempt-(\d+)\.json$/))
    .filter(Boolean)
    .map((match) => Number(match[1]));

  return attemptNumbers.length ? Math.max(...attemptNumbers) + 1 : 1;
}

function formatAttemptFileName(attemptNumber) {
  return `attempt-${String(attemptNumber).padStart(3, "0")}.json`;
}

async function writeSubmission(result) {
  const attemptDir = path.join("data", "submissions", result.github_username, LESSON);
  await ensureDir(attemptDir);

  await writeJson(path.join(attemptDir, formatAttemptFileName(result.attempt_number)), result);
  await writeJson(path.join(attemptDir, "latest.json"), result);
}

async function writeSummary() {
  const submissionsRoot = path.join("data", "submissions");
  const summaryDir = path.join("data", "summary");
  await ensureDir(summaryDir);

  let studentDirs = [];
  try {
    studentDirs = await fs.readdir(submissionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const results = [];

  for (const entry of studentDirs) {
    if (!entry.isDirectory()) {
      continue;
    }

    const result = await readJson(path.join(submissionsRoot, entry.name, LESSON, "latest.json"));
    if (result) {
      results.push(result);
    }
  }

  results.sort((a, b) => a.github_username.localeCompare(b.github_username));

  const csv = [
    "github_username,lesson,attempt_number,status,score,commit,graded_at",
    ...results.map((result) => [
      result.github_username,
      result.lesson,
      result.attempt_number,
      result.status,
      result.score,
      result.commit,
      result.graded_at
    ].map(csvCell).join(","))
  ].join("\n");

  await fs.writeFile(path.join(summaryDir, "results.csv"), `${csv}\n`, "utf8");
  await writeJson(path.join(summaryDir, "results.json"), results);
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll("\"", "\"\"")}"`;
  }
  return text;
}

async function setCommitStatus(result) {
  await octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: result.commit,
    state: result.status === "passed" ? "success" : "failure",
    context: `vibecoding/${LESSON}`,
    description: `${LESSON} attempt #${result.attempt_number} ${result.status}, score ${result.score}/${MAX_SCORE}`
  });
}

async function findFeedbackIssue(username) {
  const expectedTitle = `[Feedback] ${username} ${LESSON}`;
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    per_page: 100
  });

  return issues.find((issue) => issue.title === expectedTitle);
}

async function postFeedbackIssue(result) {
  const title = `[Feedback] ${result.github_username} ${LESSON}`;
  const body = formatFeedback(result);
  const issue = await findFeedbackIssue(result.github_username);

  if (!issue) {
    await octokit.rest.issues.create({
      owner,
      repo,
      title,
      body
    });
    return;
  }

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issue.number,
    body
  });
}

function formatFeedback(result) {
  const statusText = result.status === "passed" ? "通过" : "未通过";
  const feedback = result.feedback.length
    ? result.feedback.map((item) => `- ${item}`).join("\n")
    : "- 暂无通过项";
  const problems = result.problems.length
    ? result.problems.map((item) => `- ${item}`).join("\n")
    : "- 无";
  const keyBlock = result.status === "passed"
    ? [
      "",
      "### Odoo 完成密钥",
      "",
      "请在 Odoo 课程选择题中选择下面这串密钥：",
      "",
      "```text",
      result.completion_key,
      "```"
    ]
    : [];

  return [
    `## ${LESSON} 第 ${result.attempt_number} 次提交反馈`,
    "",
    `学生：${result.github_username}`,
    `状态：${statusText}`,
    `得分：${result.score} / ${MAX_SCORE}`,
    `分支：${result.branch}`,
    `Commit：${result.commit}`,
    `评审时间：${result.graded_at}`,
    "",
    "### 已通过检查",
    "",
    feedback,
    "",
    "### 需要修正",
    "",
    problems,
    ...keyBlock
  ].join("\n");
}

async function deleteRemoteBranch(branchName) {
  try {
    await octokit.rest.git.deleteRef({
      owner,
      repo,
      ref: `heads/${branchName}`
    });
    console.log(`Deleted remote branch: ${branchName}`);
  } catch (error) {
    if (error.status === 404) {
      console.log(`Remote branch already deleted: ${branchName}`);
      return;
    }
    throw error;
  }
}

async function gradeBranch(branch) {
  const parsed = parseStudentBranch(branch.name);

  if (!parsed.valid) {
    return;
  }

  const latest = await readJson(path.join("data", "submissions", parsed.username, LESSON, "latest.json"));

  if (latest?.commit === branch.commit.sha) {
    console.log(`Skip ${branch.name}: commit already graded`);
    await deleteRemoteBranch(branch.name);
    return;
  }

  const attemptNumber = await getNextAttempt(parsed.username);
  console.log(`Grade ${branch.name} at ${branch.commit.sha} as attempt #${attemptNumber}`);

  const [changedFiles, commitMessage, answerContent] = await Promise.all([
    getChangedFiles(branch.name),
    getCommitMessage(branch.commit.sha),
    getFileContent(branch.name, ANSWER_PATH)
  ]);

  const grade = gradeSubmission({
    branchName: branch.name,
    parsed,
    changedFiles,
    commitMessage,
    answerContent
  });

  if (grade.status === "passed" && !COMPLETION_KEY) {
    throw new Error("GIT_01_COMPLETION_KEY is required when a submission passes");
  }

  const result = {
    github_username: parsed.username,
    lesson: LESSON,
    attempt_number: attemptNumber,
    branch: branch.name,
    commit: branch.commit.sha,
    changed_files: changedFiles,
    score: grade.score,
    max_score: MAX_SCORE,
    status: grade.status,
    feedback: grade.feedback,
    problems: grade.problems,
    completion_key: grade.status === "passed" ? COMPLETION_KEY : null,
    graded_at: new Date().toISOString()
  };

  await writeSubmission(result);
  await writeSummary();
  await setCommitStatus(result);
  await postFeedbackIssue(result);
  await deleteRemoteBranch(branch.name);
}

async function main() {
  await ensureDir(path.join("data", "submissions"));
  await ensureDir(path.join("data", "summary"));

  const branches = await listStudentBranches();

  for (const branch of branches) {
    await gradeBranch(branch);
  }

  await writeSummary();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
