# 为什么选 C# (Roslyn + COM)，不选 VBA

本项目让 LLM 现写代码、即时执行去操作 Word。这条路径最关键的不是"能不能改文档"，而是**当 LLM 写错时，错误能不能被稳定、结构化地传回模型**——LLM 是概率系统，必须靠观测错误来自纠正。本文对比两条实现路径，并用真实例子说明各自的失败模式。

---

## 1. 方案对比

| 维度 | C# (Roslyn + COM, 当前方案) | VBA |
|---|---|---|
| 宿主进程 | 独立子进程 `WordDriver.exe` (.NET 4.8) | Word 进程内 |
| 代码注入 | sidecar 把 C# 字符串 stdin 喂给 driver，Roslyn `CSharpScript.RunAsync` 即时编译 | 需要往 .docm/工程里 `VBComponents.Add`，且要求"信任对 VBA 工程对象模型的访问" |
| 编译错误 | `CompilationErrorException.Diagnostics` 结构化（错误码+行列+描述） | VBE 模态对话框 / 笼统中文 |
| 运行时错误 | .NET 异常体系，`try/catch` 兜住任何一种 | `Err` 对象 + `On Error`，需要 LLM 每段代码自己写 |
| 错误传回通道 | stdin/stdout JSON 协议天然存在 | 需要自建 IPC（临时文件 / 命名管道 / COM callback） |
| 死循环 / 卡死 | sidecar supervisor 10s timeout → kill+respawn | Word UI 线程被锁，外部无法打断，只能强杀 Word |
| 崩溃域 | driver 挂了 → 重启子进程，Word 不受影响 | Word 本身就是宿主，宏崩 = Word 崩 = 用户稿丢 |
| 错误捕获是否依赖 LLM 配合 | **不依赖**（宿主层强制兜底） | **依赖**（LLM 必须每段写 `On Error GoTo Fail` 并主动调输出函数） |
| 分发 | 装了 Word 即可，desktop app 自带 driver | 需要 .docm/.dotm 模板 + 用户接受宏安全提示 |

---

## 2. C# 方案的错误捕获机制

核心代码在 `drivers/WordDriver/Roslyn/Host.cs`：

```csharp
try {
    var task = CSharpScript.RunAsync(code, BuildOptions(), globals);
    task.Wait();
    return new ExecResult {
        Result = task.Result.ReturnValue,
        Stdout = globals.__Stdout.ToString(),
    };
}
catch (CompilationErrorException cex) {
    return new ExecResult {
        Stdout = globals.__Stdout.ToString(),
        Error = "compile_error: " + string.Join("\n", cex.Diagnostics),
    };
}
catch (AggregateException aex) when (aex.InnerException != null) {
    return new ExecResult {
        Stdout = globals.__Stdout.ToString(),
        Error = "runtime_error: " + aex.InnerException.GetType().Name + ": " + aex.InnerException.Message,
    };
}
catch (Exception ex) {
    return new ExecResult {
        Stdout = globals.__Stdout.ToString(),
        Error = "runtime_error: " + ex.GetType().Name + ": " + ex.Message,
    };
}
```

外层 `drivers/WordDriver/Program.cs` 还有一层 catch 转 `host_error:`。**三层兜底，LLM 脚本里写不写 try/catch 都不影响错误能被结构化捕获。**

---

## 3. C# 实例：四种典型错误

以下例子用 stdin 直接喂 `WordDriver.exe` 复现（Word 已打开 `gongwen_sample.docx`）。

### 3.1 编译错误：类型不匹配

**输入**
```json
{"id":"1","code":"int x = \"hello\";"}
```

**输出**
```json
{
  "id": "1",
  "result": null,
  "stdout": "",
  "error": "compile_error: (1,9): error CS0029: Cannot implicitly convert type 'string' to 'int'"
}
```

LLM 拿到行列 `(1,9)` + 错误码 `CS0029` + 描述，能精确定位。

### 3.2 运行时异常：数组越界

**输入**
```json
{"id":"2","code":"int[] a = new int[3]; Print(a[10]);"}
```

**输出**
```json
{
  "id": "2",
  "result": null,
  "stdout": "",
  "error": "runtime_error: IndexOutOfRangeException: Index was outside the bounds of the array."
}
```

### 3.3 异常前的 stdout 不丢

**输入**
```json
{"id":"4","code":"Print(\"step 1\"); Print(\"step 2\"); int d = 0; int z = 1/d; Print(\"never\");"}
```

**输出**
```json
{
  "id": "4",
  "result": null,
  "stdout": "step 1\r\nstep 2\r\n",
  "error": "runtime_error: DivideByZeroException: Attempted to divide by zero."
}
```

`Print("step 1")` 和 `Print("step 2")` 的输出**保留**，崩在 `1/d`，最后一行 `Print("never")` 不执行。LLM 可以用 Print 做断点式调试，崩了照样能看到执行到哪一步。

### 3.4 COM 异常：Word 自己抛

**输入**
```json
{"id":"5","code":"Doc.Paragraphs[99999].Range.Text = \"x\";"}
```

**输出**
```json
{
  "id": "5",
  "result": null,
  "stdout": "",
  "error": "runtime_error: COMException: The requested member of the collection does not exist."
}
```

Word 抛的 HRESULT 被 .NET 自动包成 `COMException`，照样走同一条 catch，**且不弹模态对话框阻塞 Word**。

---

## 4. VBA 方案：正确捕获错误的写法

VBA 没有 try/catch，只有 `On Error GoTo` 跳转 + 全局 `Err` 对象。**正确写法**长这样：

```vba
Sub RunGenerated()
    On Error GoTo Fail
    
    ' === LLM 生成的业务代码 ===
    Dim p As Paragraph
    Set p = ActiveDocument.Paragraphs(99999)  ' 越界，会抛错
    p.Range.Text = "x"
    ' === 业务代码结束 ===
    
    WriteResult "ok", "", ""
    Exit Sub

Fail:
    WriteResult "error", _
        Err.Number & ": " & Err.Description, _
        "at line " & Erl  ' Erl 仅在打了行号时有效
End Sub

Sub WriteResult(status As String, msg As String, info As String)
    ' 自建 IPC：写到临时文件，sidecar 轮询读取
    Dim fso As Object, f As Object
    Set fso = CreateObject("Scripting.FileSystemObject")
    Set f = fso.CreateTextFile(Environ("TEMP") & "\vba_result.json", True)
    f.Write "{""status"":""" & status & """,""error"":""" & msg & """,""info"":""" & info & """}"
    f.Close
End Sub
```

**正常情况下能拿到的错误信息**：

```json
{"status":"error","error":"5941: 请求的集合成员不存在","info":"at line 0"}
```

`Err.Number = 5941`、`Err.Description = "请求的集合成员不存在"`、`Erl = 0`（因为代码没打行号）。

要拿到行号必须给每条语句加数字标签：

```vba
10  Dim p As Paragraph
20  Set p = ActiveDocument.Paragraphs(99999)
30  p.Range.Text = "x"
```

这是 90 年代 BASIC 风格，让 LLM 每次生成都打一遍行号既不优雅也容易漏。

**与 C# 路径相比的差距**：

| 项 | C# 路径 | VBA 路径 |
|---|---|---|
| 错误信息粒度 | 类型名 + 完整 Message + 行列 | 错误号 + 描述（行号要靠 Erl，要求行号标签） |
| 编译错误 | Roslyn 自动给 `CS0029` 这种结构化诊断 | VBE 弹框，没法被脚本捕获 |
| stdout 保留 | 自动（Globals 注入 StringBuilder） | 需要自己实现"日志缓冲" |
| 是否依赖 LLM 写法 | 不依赖 | **完全依赖**（漏一行 `On Error` 全完蛋） |

---

## 5. VBA 失败模式之一：LLM 漏写 `On Error`

**LLM 抽风生成的代码**：

```vba
Sub RunGenerated()
    ' 忘了 On Error GoTo Fail
    Dim p As Paragraph
    Set p = ActiveDocument.Paragraphs(99999)
    p.Range.Text = "x"
    WriteResult "ok", "", ""
End Sub
```

**实际后果**：

1. `Set p = ActiveDocument.Paragraphs(99999)` 抛错
2. VBA 走默认错误处理：**Word 弹出模态对话框 "运行时错误 '5941': 请求的集合成员不存在"**
3. Word UI 线程被对话框阻塞
4. sidecar 那边永远等不到 `vba_result.json` 被写入（因为 `WriteResult` 根本没执行到）
5. sidecar 超时也没法 kill 一段宏——VBA 没提供从外部停宏的接口
6. 用户必须手动点掉对话框，**且必须人肉告诉 LLM 出了什么错**

**对比 C# 路径**：LLM 漏写 try/catch 完全没问题，因为 catch 在 `Host.cs` 宿主层，不是脚本层。

---

## 6. VBA 失败模式之二：LLM 把错误吞掉

**LLM 另一种抽风方式**：

```vba
Sub RunGenerated()
    On Error Resume Next  ' 把所有错误"吞掉"
    Dim p As Paragraph
    Set p = ActiveDocument.Paragraphs(99999)  ' 静默失败
    p.Range.Text = "x"                         ' p 是 Nothing，又错，继续吞
    WriteResult "ok", "", ""                   ' 报告"成功"
End Sub
```

**实际后果**：

`vba_result.json` 写出 `{"status":"ok"}`，sidecar 以为脚本跑成功了，LLM 也以为自己写对了。**用户文档没改，但系统没人知道**——比直接报错更糟，因为 LLM 不会重试。

或者 LLM 写成：

```vba
Fail:
    Exit Sub  ' 跳到 Fail 标签但没调 WriteResult
```

—— sidecar 收到的是空回执，又是一种"看起来在跑但啥都没发生"的状态。

**对比 C# 路径**：宿主层永远会返回 `{result, stdout, error}` 之一，LLM 没有"绕过协议"的能力。它生成的 C# 代码不管多奇葩，最终都被 `Host.cs` 的 try/catch 包着，输出格式由宿主决定，**不由 LLM 决定**。

---

## 7. VBA 失败模式之三：死循环让 Word 彻底卡住

**LLM 抽风（或被恶意提示注入）写出**：

```vba
Sub RunGenerated()
    On Error GoTo Fail
    Do While True
        ' 等待某个条件，但条件永远不成立
    Loop
    WriteResult "ok", "", ""
    Exit Sub
Fail:
    WriteResult "error", Err.Description, ""
End Sub
```

**实际后果**：

1. Word 主线程跑这个宏，UI 线程死循环
2. **Word 完全无响应**：
   - 用户点不动菜单
   - 文档滚不动、改不了
   - 自动保存停掉
3. VBA 死循环**没法被外部进程打断**：
   - 没有"暂停宏"的 API
   - sidecar 即使发现超时也没辙
4. 唯一的恢复方法是**任务管理器强杀 WINWORD.EXE**
5. **用户没保存的修改全丢**

**对比 C# 路径**：

```
sidecar (Bun)
  ├─ Supervisor (callTimeoutMs: 10_000)
  └─ DriverClient ──spawn──> WordDriver.exe (子进程)
                                    └─ Roslyn 跑 LLM 代码
```

如果 LLM 写出 `while(true) {}`：

1. 10 秒后 Supervisor 触发 `HangError`
2. `this.client.kill()` 强杀 WordDriver.exe 子进程
3. Supervisor 立刻 `restart("hang")`，启动新 driver
4. 通过 `_ref_open` 重新挂载所有参考文档
5. UI 显示一次"驱动重启 N → N+1"
6. **Word 进程不受影响，用户文档安全**
7. sidecar 把 hang 错误结构化返回给 LLM，LLM 知道刚才那段代码超时了，下次会改写

`apps/agent/src/rpc/supervisor.ts:76-98` 就是这套机制：

```typescript
private async runWithTimeout(fn: () => Promise<DriverResponse>): Promise<DriverResponse> {
    let timer;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HangError()), this.opts.callTimeoutMs);
    });
    const work = fn();
    work.catch(() => {});  // 防止 unhandledRejection
    try {
        return await Promise.race([work, timeout]);
    } catch (err) {
        if (err instanceof HangError) {
            this.client.kill();        // 强杀挂死的 driver
            await this.handleHang();   // 重启
        }
        throw err;
    } finally {
        if (timer) clearTimeout(timer);
    }
}
```

---

## 8. 结论

> **C# 路径的可靠性是宿主层保证的，跟 LLM 写得好不好无关；VBA 路径的可靠性需要 LLM 配合，每段代码都得遵守一份不成文的协议。**

LLM 是概率系统，"每次都遵守协议"在统计意义上不可能。VBA 路径的失败模式不是"偶尔出 bug"，而是**"在不可观测、不可恢复的状态里卡住"**——对一个修改用户真实 Word 文档的 agent 来说，这种失败模式不可接受。

C# + Roslyn + 子进程 supervisor 的代价（多一个 .NET 子进程、多一层 stdio 协议、driver 重启时丢失内存态），换来的是：

- 错误捕获不依赖 LLM 自律
- 死循环可恢复，Word 不丢稿
- 错误信息结构化、粒度细，LLM 能自纠错
- 编译错误自带行列和错误码

这就是为什么本项目走 C# 路径而非 VBA。
