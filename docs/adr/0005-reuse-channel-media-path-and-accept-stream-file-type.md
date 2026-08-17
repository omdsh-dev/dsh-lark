# 出站文件走 Channel 的 `send({ file })`，接受它固定上传为 `stream` 类型

`@larksuite/channel` 的 `send(to, { file: { source, fileName } })` 已经把上传（`im.v1.file.create`）和发消息串成一步，本插件不再自己碰上传。代价是它对通用文件**硬编码** `file_type: 'stream'`，不按扩展名推断——而 Feishu 对 `pdf / doc / xls / ppt` 有专门类型，只有用对类型才可能有在线预览。所以 agent 产出的 pdf、xlsx 发到聊天里大概率只能下载，不能点开预览。

绕过的唯一办法是拿 `rawClient` 自己调 `im.v1.file.create` 再拼消息——那等于放弃复用，把上传、重试、错误码分类整套搬进本仓库来维护，只为换一个预览。不值得。

## Consequences

- 产物是文档类格式时，聊天里没有在线预览。这是已知取舍，不是缺陷。
- **修它的正确方向是上游**：让 `MediaUploader.upload()` 按 `fileName` 扩展名推断 `file_type`（它内部的 `uploadFile` 本来就接受这几种类型）。在上游修好之前，不要在本仓库用 `rawClient` 绕过。
