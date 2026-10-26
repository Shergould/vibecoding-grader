# Vibe Coding Grader

这是私有的课程自动评分与成绩仓库。学生通过本人 Fork 向 `Shergould/vibecoding-course` 创建 PR，无需拥有课程仓库或本仓库的写权限。

## 提交与评分链路

```text
course: pull_request_target (opened / synchronize / reopened / ready_for_review)
  → repository_dispatch: student_submission
  → grader 从 GitHub API 核实 PR、作者、Fork 和提交 SHA
  → 固定 base/head SHA，读取差异、提交信息和答案文本
  → 保存成绩 → 在该 PR 下发布评分评论
```

保留每 5 分钟的定时补偿扫描和 Actions 页面手动运行入口。GitHub 实际调度可能延迟。草稿和已关闭的 PR 不接收新的作业评分，PR 无需合并。

## 代码与数据

- `grader/grade_git_01.js`：PR 查询、身份核验、成绩存储、反馈重试。
- `grader/rules_git_01.js`：纯文本评分规则，不执行学生代码。
- `grader/feedback.js`：评分反馈格式。
- `test/grade_git_01.test.js`：使用模拟 GitHub API 和临时目录的离线测试。
- `data/submissions/<username>/git_01/attempt-NNN.json`：不可重复计次的作业记录。
- `data/submissions/<username>/git_01/latest.json`：该学生最新一次成绩。
- `data/summary/results.json` 和 `results.csv`：汇总表。

成绩包含 PR 编号、来源仓库、分支、head/base SHA。历史分支制成绩保留，新的尝试次数从已有最大值继续；已存在的大小写目录继续沿用，新用户名按小写保存。

按 **PR 编号 + head SHA** 去重，包括历史尝试。反馈失败后保持 `feedback_posted: false`，补偿扫描会重试，已关闭 PR 的待发反馈也可以补发。只识别评分账号自己发出的反馈标记，不信任学生伪造的标记评论。

不同 PR 使用同一提交会分别记次；短时间连续推送时，旧通知会跳过，由新通知或扫描处理最新版本，不保证保留每个中间提交的评分。

所有入口通过同一个 workflow concurrency group 串行写入成绩。GitHub 可能替换等待中的运行，定时扫描会补偿；请不要同时从别的工作流或本地进程向成绩分支写入。若数据推送失败，应先检查 Actions，再重跑扫描。

## GitHub 配置

两个仓库的默认分支均使用 `main`。本仓库保持 private，不向学生开放写权限。

### course 仓库 secret

`GRADER_DISPATCH_TOKEN`：fine-grained PAT，resource owner 为 `Shergould`，只选中 `vibecoding-grader`，授予 **Contents: Read and write**。用于 `POST /repos/Shergould/vibecoding-grader/dispatches`。

course 的通知工作流必须存在于默认分支，并且 Actions 策略允许 `pull_request_target`。该工作流只通知评分仓库，不 checkout 或运行学生 PR 中的任何代码。学生不需要启用 Fork Actions，也不需要任何 secret。

### grader 仓库 secrets

| Secret | 用途和权限 |
| --- | --- |
| `GRADER_BOT_TOKEN` | 使用能访问 course 的 GitHub 用户/机器人账号 PAT；fine-grained PAT 只选中 course，授予 Contents: Read、Pull requests: Read and write。用于读 PR、比较提交和发布 PR 评论；公开 Fork 内容可通过 API 读取。 |
| `GIT_01_COMPLETION_KEY` | 原有 Odoo 完成密钥，满分且检查全部通过时随 PR 评论返回。 |

当前反馈去重使用 PAT 对应账号的 `/user` 身份，因此本实现使用用户/机器人账号 PAT，不直接使用 GitHub App installation token。

工作流自己的 `GITHUB_TOKEN` 具有本仓库 `contents: write`，负责保存 `data/`。如果 `main` 的保护规则阻止 bot 直接推送，需要管理员按仓库策略允许该成绩写入流程。不要向学生开放写入权限来解决。

原有 commit status 和独立反馈 Issue 已改为 PR 评论，因此评分 PAT 不再需要 Commit statuses 写权限，也不再需要删除学生分支的 Contents 写权限。

Odoo 完成密钥保持现有发放方式：公共课程仓库的 PR 评论是公开的，这串密钥不是每个学生的私密凭据。

## 通知格式

```json
{
  "event_type": "student_submission",
  "client_payload": {
    "course_repo": "Shergould/vibecoding-course",
    "pr_number": 12,
    "head_sha": "<40 位提交 SHA>"
  }
}
```

评分器不信任 payload 提供的学生身份或仓库地址，只按 PR 编号重新查询 GitHub。通知中的 SHA 与当前 PR 不一致时跳过，等待新事件或定时扫描。旧版本只有 `branch` 的通知格式不再接受。

身份校验要求 PR 作者、本人 Fork 所有者和分支中的用户名一致，Fork 必须来自课程仓库；不支持组织拥有的学生 Fork。身份或提交方式错误时，PR 会收到说明，但不登记成绩。

GitHub 比较接口最多返回 300 个修改文件，达到上限时拒绝评分，避免遗漏保护目录。重命名同时检查原路径和新路径。仅允许修改 `lessons/git_01/`。

## 本地验证

```bash
npm ci
npm run check:git_01
npm test
```

测试不读取真实 Token，不请求 GitHub，不修改实际成绩，不发送评论。`npm run grade:git_01` 则会真实读写 GitHub 和 `data/`，只应由配置好的评分环境执行。

答案题设保持兼容：Q1 使用题目给定的原仓库 clone 地址，Q2/Q5 使用假设用户名 `alice`；学生实际提交则使用本人 Fork 和用户名。

## 发布顺序与验收

1. 将 grader 的代码、测试和工作流发布到本仓库 `main`，确认 secrets 和成绩写入权限。
2. 将 course 的通知工作流及学生说明发布到 course 的 `main`，配置通知 secret 与 Actions 事件策略。
3. 使用没有协作者权限的学生账号 Fork course，提交答案并创建普通 PR。
4. 检查 course 的 `Notify Grader`、grader 的 `Grade Git Lesson`、PR 评论和 `data/` 记录。
5. 修改答案后向同一分支 push，确认出现新一次评分；手动再扫描，确认不重复计分。
6. 检查草稿、错误分支名和保护目录修改能够被跳过或拒绝。

本地离线测试不能确认真实 PAT 权限、Actions 策略或跨 Fork API 的线上表现，必须完成以上真实 PR 验收后再通知全班切换。

已按旧流程提交的学生不需要重做：Fork 后将本地 `origin` 改为自己的 Fork，推送原分支，再创建 PR。新系统不再扫描课程原仓库的学生分支，也不删除远程分支。

## 排查

- 没有评分：确认已创建目标为 course/main 的普通 PR，PR 仍打开，并查看两个仓库的 Actions。
- course 通知失败：检查 `GRADER_DISPATCH_TOKEN` 是否过期、是否选中 grader、是否有 Contents 写权限及事件策略是否允许。
- 评分读取或评论失败：检查 `GRADER_BOT_TOKEN` 的有效性和 course 权限，查看日志中的 PR 编号；定时扫描会继续尝试。
- 成绩未保存到 GitHub：检查 Commit results 步骤、`GITHUB_TOKEN` 写权限和 main 保护规则。
- 满分但作业运行失败：检查是否配置 `GIT_01_COMPLETION_KEY`。
- 无需通过打开“向 Fork 工作流发送 secrets”来解决问题；评分和通知始终在老师维护的仓库内运行。
