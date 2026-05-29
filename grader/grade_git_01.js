import { Octokit } from "@octokit/rest";
import fs from "node:fs/promises";
import path from "node:path";

const COURSE_REPO = process.env.COURSE_REPO;
const BASE_BRANCH = process.env.BASE_BRANCH || "main";
const TOKEN = process.env.GRADER_BOT_TOKEN;

const LESSON = "git_01";
const ANSWER_PATH = `lessons/${LESSON}/answer.md`;
const MAX_SCORE = 100;
const PASS_SCORE = 60;

if (!COURSE_REPO) {
    throw new Error("Missing COURSE_REPO");
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

function parseStudentBranch(branchName) {
    const match = branchName.match(/^student\/([^/]+)\/git_01$/);

    if (!match) {
        return {
            valid: false,
            username: null
        };
    }

    return {
        valid: true,
        username: match[1]
    };
}

async function listStudentBranches() {
    const branches = await octokit.paginate(octokit.rest.repos.listBranches, {
        owner,
        repo,
        per_page: 100
    });

    return branches.filter((branch) => branch.name.startsWith("student/"));
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
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'");
}

function includesCommand(answer, expectedParts) {
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

    if (
        includesCommand(q1, [
            "git clone",
            "https://github.com/your-org/vibecoding-course.git"
        ])
    ) {
        score += 20;
        feedback.push("Q1 正确：写出了 git clone 课程仓库的命令。");
    } else {
        problems.push("Q1 错误：需要使用 git clone 克隆课程仓库。");
    }

    if (
        includesCommand(q2, [
            "git checkout -b",
            "student/alice/git_01"
        ])
        || includesCommand(q2, [
            "git switch -c",
            "student/alice/git_01"
        ])
    ) {
        score += 20;
        feedback.push("Q2 正确：写出了创建并切换到 student/alice/git_01 分支的命令。");
    } else {
        problems.push("Q2 错误：需要创建并切换到 student/alice/git_01 分支。");
    }

    if (
        includesCommand(q3, [
            "git add",
            "lessons/git_01/answer.md"
        ])
    ) {
        score += 20;
        feedback.push("Q3 正确：写出了暂存 answer.md 的命令。");
    } else {
        problems.push("Q3 错误：需要使用 git add lessons/git_01/answer.md。");
    }

    if (
        includesCommand(q4, [
            "git commit",
            "finish git_01"
        ])
    ) {
        score += 20;
        feedback.push("Q4 正确：commit message 包含 finish git_01。");
    } else {
        problems.push("Q4 错误：需要使用 git commit，并且 message 包含 finish git_01。");
    }

    if (
        includesCommand(q5, [
            "git push",
            "origin",
            "student/alice/git_01"
        ])
    ) {
        score += 20;
        feedback.push("Q5 正确：写出了推送 student/alice/git_01 到 origin 的命令。");
    } else {
        problems.push("Q5 错误：需要把 student/alice/git_01 推送到 origin。");
    }

    return {
        score,
        feedback,
        problems
    };
}

function gradeSubmission({ branchName, parsed, changedFiles, commitMessage, answerContent }) {
    let score = 0;
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

    const changedAnswer = changedFiles.includes(ANSWER_PATH);

    if (changedAnswer) {
        feedback.push(`已修改 ${ANSWER_PATH}。`);
    } else {
        problems.push(`需要修改 ${ANSWER_PATH}。`);
    }

    const messageOk = commitMessage.includes("finish git_01");

    if (messageOk) {
        feedback.push("commit message 包含 finish git_01。");
    } else {
        problems.push("commit message 必须包含 finish git_01。");
    }

    const answerGrade = gradeAnswerContent(answerContent);
    score += answerGrade.score;
    feedback.push(...answerGrade.feedback);
    problems.push(...answerGrade.problems);

    if (!parsed.valid) {
        score = Math.max(0, score - 20);
    }

    if (protectedFiles.length > 0) {
        score = Math.max(0, score - 20);
    }

    if (!changedAnswer) {
        score = Math.max(0, score - 20);
    }

    if (!messageOk) {
        score = Math.max(0, score - 20);
    }

    return {
        score,
        status: score >= PASS_SCORE ? "passed" : "failed",
        feedback,
        problems
    };
}

async function writeSubmission(result) {
    const studentDir = path.join("data", "submissions", result.github_username);
    await ensureDir(studentDir);

    await fs.writeFile(
        path.join(studentDir, `${LESSON}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
        "utf8"
    );
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

        const result = await readJson(path.join(submissionsRoot, entry.name, `${LESSON}.json`));

        if (result) {
            results.push(result);
        }
    }

    results.sort((a, b) => a.github_username.localeCompare(b.github_username));

    const csvRows = [
        "github_username,lesson,status,score,commit,graded_at",
        ...results.map((result) => [
            result.github_username,
            result.lesson,
            result.status,
            result.score,
            result.commit,
            result.graded_at
        ].map(csvCell).join(","))
    ];

    await fs.writeFile(
        path.join(summaryDir, "results.csv"),
        `${csvRows.join("\n")}\n`,
        "utf8"
    );

    await fs.writeFile(
        path.join(summaryDir, "results.json"),
        `${JSON.stringify(results, null, 2)}\n`,
        "utf8"
    );
}

function csvCell(value) {
    const text = String(value ?? "");

    if (/[",\n]/.test(text)) {
        return `"${text.replaceAll('"', '""')}"`;
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
        description: `${LESSON} ${result.status}, score ${result.score}/${MAX_SCORE}`
    });
}

async function findFeedbackIssue(username) {
    const expectedTitle = `[Feedback] ${username} ${LESSON}`;

    const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
        owner,
        repo,
        state: "all",
        labels: "grading-feedback",
        per_page: 100
    });

    return issues.find((issue) => issue.title === expectedTitle);
}

function formatFeedback(result) {
    const statusText = result.status === "passed" ? "通过" : "未通过";

    const feedback = result.feedback.length
        ? result.feedback.map((item) => `- ${item}`).join("\n")
        : "- 暂无通过项";

    const problems = result.problems.length
        ? result.problems.map((item) => `- ${item}`).join("\n")
        : "- 无";

    return [
        `## ${LESSON} 评审结果`,
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
        problems
    ].join("\n");
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
            body,
            labels: ["grading-feedback", LESSON, result.status]
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

async function gradeBranch(branch) {
    const parsed = parseStudentBranch(branch.name);

    if (!parsed.valid) {
        return;
    }

    const resultPath = path.join("data", "submissions", parsed.username, `${LESSON}.json`);
    const previous = await readJson(resultPath);

    if (previous?.commit === branch.commit.sha) {
        console.log(`Skip ${branch.name}: commit already graded`);
        return;
    }

    console.log(`Grade ${branch.name} at ${branch.commit.sha}`);

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

    const result = {
        github_username: parsed.username,
        lesson: LESSON,
        branch: branch.name,
        commit: branch.commit.sha,
        changed_files: changedFiles,
        score: grade.score,
        max_score: MAX_SCORE,
        status: grade.status,
        feedback: grade.feedback,
        problems: grade.problems,
        graded_at: new Date().toISOString()
    };

    await writeSubmission(result);
    await setCommitStatus(result);
    await postFeedbackIssue(result);
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