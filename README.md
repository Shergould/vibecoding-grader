# Vibe Coding Grader

这是 Vibe Coding 课程的 GitHub-only 自动评审与成绩仓库。

## 仓库职责

本仓库用于：

1. 读取 `vibecoding-course` 中学生提交的分支。
2. 自动评审学生的 `git_01` 提交结果。
3. 记录学生课程进度和得分。
4. 生成老师可查看的成绩汇总。
5. 将评审结果反馈回 `vibecoding-course`。

学生不应该拥有本仓库的写权限。

## 与 vibecoding-course 的区别

`vibecoding-course` 是学生代码仓库：

```text
学生提交代码
学生创建自己的分支
学生查看反馈
```

`vibecoding-grader` 是可信评审仓库：

```text
老师和系统维护评审逻辑
系统保存成绩
系统生成反馈
学生不能修改成绩
```

## 当前阶段

当前只评审一个 lesson：

```text
git_01
```

第一阶段目标是跑通完整闭环：

```text
学生 push 到 vibecoding-course
  -> 本仓库自动扫描学生分支
  -> 自动计算 git_01 得分
  -> 保存成绩
  -> 反馈结果回 vibecoding-course
```

## 推荐权限设计

本仓库建议设为 private。

学生权限：

```text
无写权限
```

老师或管理员权限：

```text
可维护评审规则
可查看成绩文件
可手动触发评审
```

自动评审 bot 需要权限：

```text
读取 vibecoding-course
写入本仓库成绩文件
向 vibecoding-course 写入 commit status
向 vibecoding-course 创建或评论反馈 Issue
```

## 未来会逐步添加的内容

后续根据实施进度，本仓库会逐步添加：

```text
package.json
.github/workflows/grade-all.yml
grader/grade_git_01.js
data/submissions/
data/summary/
```

这些内容暂时不在本次创建范围内。

## 成绩数据原则

成绩和课程进度只保存在学生没有写权限的位置。

学生不能通过修改 `vibecoding-course` 来修改：

1. 最终得分。
2. 课程进度。
3. 老师看到的成绩汇总。

## 与 Odoo 的关系

Odoo 只作为课程入口。

本仓库负责自动评审和成绩记录。

第一阶段不需要 Odoo API，也不需要定制 Odoo 页面。

