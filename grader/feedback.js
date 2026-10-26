const LESSON = "git_01";
const MAX_SCORE = 100;

export function formatFeedback(result) {
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
    `PR：#${result.pr_number}`,
    `来源仓库：${result.source_repo}`,
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

