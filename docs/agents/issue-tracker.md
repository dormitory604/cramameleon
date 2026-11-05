# Issue tracker: GitHub

本项目的规格和任务保存在 GitHub 仓库 `dormitory604/cramameleon` 的 Issues 中。使用 `gh` CLI 操作。

## 基本操作

- 创建规格或任务：`gh issue create --repo dormitory604/cramameleon --title "<标题>" --body-file <正文文件>`。
- 读取任务及评论：`gh issue view <number> --repo dormitory604/cramameleon --json number,title,body,labels,comments`。
- 查询开放任务：`gh issue list --repo dormitory604/cramameleon --state open --json number,title,body,labels,assignees`；按需使用 `--label` 和 `--state` 筛选。
- 修改正文：`gh issue edit <number> --repo dormitory604/cramameleon --body-file <正文文件>`。
- 添加或移除标签：`gh issue edit <number> --repo dormitory604/cramameleon --add-label "<标签>"` 或 `--remove-label "<标签>"`。
- 添加评论：`gh issue comment <number> --repo dormitory604/cramameleon --body-file <正文文件>`。
- 关闭任务：`gh issue close <number> --repo dormitory604/cramameleon`。需要说明时，先添加评论。

多行正文先保存为 UTF-8 临时文件，通过 `--body-file` 传入，保留真实换行。

技能要求“发布到 issue tracker”时，创建 GitHub Issue；要求“获取任务”时，读取 Issue 完整正文与评论。标签含义见 `triage-labels.md`。

## 父子任务与阻塞依赖

优先使用 GitHub 原生父子任务与阻塞关系。API 参数中的数据库 ID 通过以下命令取得：

```sh
gh api repos/dormitory604/cramameleon/issues/<number> --jq .id
```

数据库 ID 与 Issue 编号不同。

- 设置子任务：`gh api --method POST repos/dormitory604/cramameleon/issues/<parent-number>/sub_issues -F sub_issue_id=<child-db-id>`。
- 为任务添加阻塞项：`gh api --method POST repos/dormitory604/cramameleon/issues/<task-number>/dependencies/blocked_by -F issue_id=<blocker-db-id>`。
- 原生父子关系不可用时，在子任务正文注明 `Part of #<parent-number>`，并在父任务正文维护任务清单。
- 原生依赖关系不可用时，在任务正文注明 `Blocked by: #<number>, #<number>`。

按依赖顺序创建任务，先创建阻塞项。所有阻塞项完成后，该任务才进入可执行集合。

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub 的 Issue 与 PR 共用编号空间。引用可能指向 PR 时，先用 `gh pr view <number>` 确认，再按对应对象操作。
