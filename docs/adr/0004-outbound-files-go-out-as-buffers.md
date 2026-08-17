# 出站文件读成 Buffer 再发，不用 SDK 的本地路径通道

`@larksuite/channel` 的 `allowedFileDirs` 是构造 channel 时的静态配置，而 dsh-lark 的工作区是每会话动态的（`/cd` 一换 cwd 就变）。静态白名单表达不了"当前这个会话的 cwd"：要么把 `workspaceRoots` 整个塞进去（它默认为空，等于允许任何目录，等于不设防），要么每次 `/cd` 重建连接。所以出站文件由插件自己校验路径、读进内存，再以 `Buffer` 交给 `send({ file })`——路径策略因此跟着会话走。

## Consequences

- 出站必须有大小上限（定为 20MB），否则堆占用不可控。上限之内 Buffer 完全可接受。
- **不要"顺手"改成配 `allowedFileDirs` 传路径。** 它看起来像省内存的优化，其实两点都不成立：`MediaUploader.toBuffer` 对本地路径也是 `fs.promises.readFile` 全量读进内存，省不了内存；而它换来的是把动态的每会话边界替换成一条必须开得很宽的静态白名单，是安全回退。
- **走 Buffer 绕过了 SDK 自己的路径防护**：`toBuffer` 对本地路径会 `path.resolve` → POSIX 黑名单 → `realpath` → 对 realpath 再检一次黑名单 → allowlist 容器检查，而 `Buffer.isBuffer(source)` 在第一行就 return 了。所以本插件的"限当前会话 cwd 内"校验必须自己复刻 **resolve → realpath → 再校验** 这个顺序，否则 `<cwd>/link → /etc/shadow` 这类软链逃逸会绕过 cwd 检查。
