// Pure grading rules. Student answers are treated only as text.
const LESSON = "git_01";
const ANSWER_PATH = `lessons/${LESSON}/answer.md`;
const COURSE_CLONE_URL = "https://github.com/Shergould/vibecoding-course.git";
const MAX_SCORE = 100;

export function parseStudentBranch(branchName) {
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

  if (answers.length !== 5) {
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

export function gradeSubmission({ branchName, parsed, changedFiles, commitMessage, answerContent }) {
  const feedback = [];
  const problems = [];

  if (parsed.valid && branchName === `student/${parsed.username}/${LESSON}`) {
    feedback.push("分支命名正确。");
  } else {
    problems.push(`分支名应为 student/<你的 GitHub 用户名>/${LESSON}。`);
  }

  const protectedFiles = changedFiles.filter((file) => (
    !file.startsWith(`lessons/${LESSON}/`)
  ));

  if (protectedFiles.length === 0) {
    feedback.push("未修改保护目录。");
  } else {
    problems.push(`只能修改 lessons/git_01/，不能修改这些文件：${protectedFiles.join(", ")}。`);
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
    status: score === MAX_SCORE && problems.length === 0 ? "passed" : "failed",
    feedback,
    problems
  };
}

