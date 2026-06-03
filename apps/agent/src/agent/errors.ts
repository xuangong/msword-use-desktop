/**
 * Map common driver / LLM exceptions to user-facing Chinese messages.
 * The goal is that any error surfaced to the chat UI tells the user
 * what to do next, not just what failed.
 */

const PATTERNS: Array<[RegExp, string]> = [
  [/Word\.Application not found|no running Word/i, "未检测到正在运行的 Word。请先启动 Microsoft Word 并打开一份文档。"],
  [/no active document/i, "Word 当前没有打开任何文档。请先在 Word 里打开或新建一份文档。"],
  [/bookmark not found/i, "找不到指定的书签，文档可能已被修改。请刷新后重试。"],
  [/protection|protected/i, "文档处于保护模式，无法编辑。请在 Word 中解除保护后重试。"],
  [/call timed out/i, "驱动响应超时——已自动重启。请重试上一条指令。"],
  [/driver exited/i, "驱动进程退出。请检查 Word 是否还在运行后重试。"],
  [/ANTHROPIC_API_KEY/i, "未配置 ANTHROPIC_API_KEY 环境变量。请在启动应用前设置它。"],
  [/rate.?limit/i, "Anthropic 接口被限流，请稍后重试。"],
  [/network|fetch failed|ECONNREFUSED|ETIMEDOUT/i, "网络异常，无法连接 Anthropic。请检查网络后重试。"],
];

/**
 * Wrap a driver / LLM Error into a friendly Chinese message. If no pattern
 * matches, prefix the original with "操作失败：" so the user knows it's an error.
 */
export function friendlyDriverError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  for (const [re, friendly] of PATTERNS) {
    if (re.test(msg)) return friendly;
  }
  return `操作失败：${msg}`;
}
