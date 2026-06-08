# Phase 1 — Driver: Roslyn host + single-action protocol

**Goal:** Replace the driver's NDJSON RPC method dispatcher with a single-action loop that takes `{id, code}` and returns `{id, result, stdout, error}` after running the C# script via Roslyn against the live Word session.

**Files:**
- Modify: `drivers/WordDriver/WordDriver.csproj` (add Roslyn package)
- Modify: `drivers/WordDriver/Program.cs` (rewrite main loop)
- Create: `drivers/WordDriver/Roslyn/Host.cs` (Roslyn execution + Globals)
- Create: `drivers/WordDriver/RevisionScope.cs` (extracted from old Polish.cs)
- Keep unchanged: `drivers/WordDriver/WordSession.cs`
- Delete: `drivers/WordDriver/Methods/Observe.cs`, `Methods/Polish.cs`, `schema/methods.json`
- Test fixture (created here): `scripts/test-driver.ts`

**Why this is phase 1:** Sidecar's supervisor (phase 2) needs the new `{id, code}` protocol to talk to. Driver code is .NET and self-contained; can be built and tested without any sidecar/Word changes (compile errors / runtime errors / ok return all testable without launching Word, by feeding scripts that only use `System` types).

**Critical constraint:** All driver responses are **single-line JSON** (line-delimited; LF terminator). The C# script's stdout (via `Print(...)`) is collected separately into the `stdout` field — it does NOT mix into the protocol stream.

---

### Task 1.1: Add Roslyn package to driver

**File:** `drivers/WordDriver/WordDriver.csproj`

- [ ] **Step 1: Add `Microsoft.CodeAnalysis.CSharp.Scripting` 4.8.0**

Edit `drivers/WordDriver/WordDriver.csproj`. Replace the file contents with:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net48</TargetFramework>
    <RootNamespace>MswordUse.WordDriver</RootNamespace>
    <AssemblyName>WordDriver</AssemblyName>
    <LangVersion>latest</LangVersion>
    <Nullable>disable</Nullable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.Office.Interop.Word" Version="15.0.4797.1004" />
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp.Scripting" Version="4.8.0" />
  </ItemGroup>

</Project>
```

Pin reasons: 4.8.0 is the last 4.x line known to ship netstandard2.0 → net48-compatible binaries; 5.x targets net8 only and may not load on net48.

The old `<None Include="schema\methods.json">` block is gone — that file is being deleted in Task 1.6.

- [ ] **Step 2: Restore packages**

Run from worktree root:
```bash
bun run driver:build
```

Expected: build succeeds. The first build after adding the package downloads it; subsequent builds are fast.

If build fails with `Microsoft.CodeAnalysis.CSharp.Scripting could not be resolved`, the package version may be wrong for the local NuGet feed. Try `4.7.0` next, then `4.6.0`. Record whatever version works and update the csproj.

- [ ] **Step 3: Commit**

```bash
git add drivers/WordDriver/WordDriver.csproj
git commit -m "deps(driver): add Roslyn scripting package"
```

---

### Task 1.2: Extract `RevisionScope` from `Polish.cs`

**Files:**
- Create: `drivers/WordDriver/RevisionScope.cs`
- (Polish.cs gets deleted in Task 1.6 — leave it in place until then so the driver still compiles after this task.)

The `RevisionScope` is a RAII helper that enables `Doc.TrackRevisions` for a block and restores the prior value on dispose. It currently lives nested inside `Methods/Polish.cs`.

- [ ] **Step 1: Create `RevisionScope.cs`**

Create `drivers/WordDriver/RevisionScope.cs`:

```csharp
using System;
using Word = Microsoft.Office.Interop.Word;

namespace MswordUse.WordDriver
{
    /// <summary>
    /// RAII-style wrapper that enables TrackRevisions on entry and restores
    /// the previous value on dispose. Used by the `Track(...)` global
    /// exposed to Roslyn-scripted code.
    ///
    /// Pattern:
    ///   using (new RevisionScope(doc, true)) { rng.Text = newText; }
    /// </summary>
    public sealed class RevisionScope : IDisposable
    {
        readonly Word.Document _doc;
        readonly bool _prev;
        readonly bool _enabled;

        public RevisionScope(Word.Document doc, bool enabled)
        {
            _doc = doc;
            _prev = _doc.TrackRevisions;
            _enabled = enabled;
            if (enabled) _doc.TrackRevisions = true;
        }

        public void Dispose()
        {
            if (_enabled) _doc.TrackRevisions = _prev;
        }
    }
}
```

- [ ] **Step 2: Make `Polish.cs`'s nested `RevisionScope` public-but-unused (avoid duplicate-class compile error)**

This is temporary scaffolding for the next two steps. Open `drivers/WordDriver/Methods/Polish.cs` and **rename the nested class** so the new public one doesn't clash:

Find the line that reads:
```csharp
    sealed class RevisionScope : IDisposable
```

Change it to:
```csharp
    sealed class RevisionScopeLegacy : IDisposable
```

Find both usages further down in `Polish.cs`:
```csharp
            using (new RevisionScope(doc, track))
```
Change to:
```csharp
            using (new RevisionScopeLegacy(doc, track))
```

(There may be only one occurrence — fix all you find.)

This keeps `Polish.cs` compiling until Task 1.6 deletes it.

- [ ] **Step 3: Build to confirm no duplicate definitions**

```bash
bun run driver:build
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add drivers/WordDriver/RevisionScope.cs drivers/WordDriver/Methods/Polish.cs
git commit -m "refactor(driver): extract RevisionScope to top-level class"
```

---

### Task 1.3: Write the Roslyn host

**File (new):** `drivers/WordDriver/Roslyn/Host.cs`

This is the workhorse: takes a code string, runs it against the live Word session via `CSharpScript.RunAsync`, returns a structured result.

- [ ] **Step 1: Create the Globals + Host**

Create `drivers/WordDriver/Roslyn/Host.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using Microsoft.CodeAnalysis.CSharp.Scripting;
using Microsoft.CodeAnalysis.Scripting;
using Word = Microsoft.Office.Interop.Word;

namespace MswordUse.WordDriver.Roslyn
{
    /// <summary>
    /// Globals exposed to LLM-authored C# scripts. Keep this surface small
    /// and stable — the `word-com-cheatsheet` skill documents these names
    /// to the model. Renames are breaking changes for skills.
    /// </summary>
    public class Globals
    {
        public Word.Document Doc;
        public Word.Application App;
        public StringBuilder __Stdout;

        public void Print(object o)
        {
            __Stdout.AppendLine(o == null ? "null" : o.ToString());
        }

        /// <summary>
        /// Wrap a write block so all mutations are recorded as tracked
        /// revisions. Skill `track-changes-protocol` mandates that every
        /// mutating script run inside Track(...). Reads do not need it.
        /// </summary>
        public void Track(Action body)
        {
            if (body == null) throw new ArgumentNullException("body");
            using (new RevisionScope(Doc, true))
            {
                body();
            }
        }
    }

    /// <summary>
    /// Result envelope returned to the sidecar.
    /// `Result` is whatever the script's last expression evaluated to (often
    /// null for void-returning scripts). It will be serialised to JSON by
    /// Newtonsoft. Stdout is collected from `Print(...)` calls.
    /// </summary>
    public class ExecResult
    {
        public object Result;
        public string Stdout;
        public string Error;
    }

    public static class Host
    {
        // Whitelisted using-namespaces. Adding to this list is cheap; removing
        // is breaking for existing skills.
        static readonly string[] DefaultImports = new[]
        {
            "System",
            "System.Linq",
            "System.Collections.Generic",
            "System.Text",
            "System.Text.RegularExpressions",
            "Microsoft.Office.Interop.Word",
        };

        static ScriptOptions _cachedOptions;

        static ScriptOptions BuildOptions()
        {
            if (_cachedOptions != null) return _cachedOptions;

            // Reference every assembly already loaded in the driver process.
            // Filtering would be safer, but the LLM legitimately wants Linq,
            // Regex, Office Interop, etc. The Roslyn sandbox is "lock the
            // front door", not a true sandbox — that's an accepted tradeoff
            // for a local desktop app.
            var refs = new List<Microsoft.CodeAnalysis.MetadataReference>();
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    if (string.IsNullOrEmpty(asm.Location)) continue;
                    refs.Add(Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(asm.Location));
                }
                catch { /* dynamic / in-memory assemblies; skip */ }
            }
            _cachedOptions = ScriptOptions.Default
                .WithReferences(refs)
                .WithImports(DefaultImports);
            return _cachedOptions;
        }

        public static ExecResult Run(string code)
        {
            if (string.IsNullOrWhiteSpace(code))
                return new ExecResult { Error = "empty_code" };

            // Attach to Word lazily: scripts that only read `App` still get
            // a ready Application; if no Word is running this throws and we
            // surface it as a runtime error.
            Word.Document doc;
            Word.Application app;
            try
            {
                doc = WordSession.ActiveDoc();
                app = doc.Application;
            }
            catch (Exception ex)
            {
                return new ExecResult { Error = "word_unavailable: " + ex.Message };
            }

            var globals = new Globals
            {
                Doc = doc,
                App = app,
                __Stdout = new StringBuilder(),
            };

            try
            {
                var task = CSharpScript.RunAsync(code, BuildOptions(), globals);
                task.Wait();
                return new ExecResult
                {
                    Result = task.Result.ReturnValue,
                    Stdout = globals.__Stdout.ToString(),
                };
            }
            catch (CompilationErrorException cex)
            {
                return new ExecResult
                {
                    Stdout = globals.__Stdout.ToString(),
                    Error = "compile_error: " + string.Join("\n", cex.Diagnostics),
                };
            }
            catch (AggregateException aex) when (aex.InnerException != null)
            {
                return new ExecResult
                {
                    Stdout = globals.__Stdout.ToString(),
                    Error = "runtime_error: " + aex.InnerException.GetType().Name + ": " + aex.InnerException.Message,
                };
            }
            catch (Exception ex)
            {
                return new ExecResult
                {
                    Stdout = globals.__Stdout.ToString(),
                    Error = "runtime_error: " + ex.GetType().Name + ": " + ex.Message,
                };
            }
        }
    }
}
```

- [ ] **Step 2: Build to confirm Roslyn references resolve**

```bash
bun run driver:build
```

Expected: build succeeds. (We're not yet using `Host.Run` from `Program.cs` — that's Task 1.4. This step just verifies the Roslyn types resolve.)

If build fails on `Microsoft.CodeAnalysis.MetadataReference` not found, the wrong NuGet was added. Re-check Task 1.1.

- [ ] **Step 3: Commit**

```bash
git add drivers/WordDriver/Roslyn/Host.cs
git commit -m "feat(driver): Roslyn host with Globals (Doc/App/Track/Print)"
```

---

### Task 1.4: Rewrite `Program.cs` to single-action loop

**File:** `drivers/WordDriver/Program.cs`

Old protocol: `{id, method, params}` → `{id, result, error}` with method dispatch table.
New protocol: `{id, code}` → `{id, result, stdout, error}`.

- [ ] **Step 1: Replace `Program.cs`**

Open `drivers/WordDriver/Program.cs` and replace its full contents with:

```csharp
using System;
using System.IO;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace MswordUse.WordDriver
{
    /// <summary>
    /// Driver main loop.
    ///
    /// Wire format: line-delimited JSON (LF terminator).
    ///   request:  {"id":"<str>","code":"<C# script>"}
    ///   response: {"id":"<str>","result":<json>,"stdout":"<str>","error":null}
    ///   error:    {"id":"<str>","result":null,"stdout":"<str>","error":"<msg>"}
    ///
    /// Special inputs:
    ///   {"id":"x","code":"_freeze"}  — hidden test trigger: blocks forever so the
    ///                                   sidecar supervisor can verify timeout+respawn.
    ///   {"id":"x","code":"_shutdown"} — cooperative shutdown; returns then exits.
    /// </summary>
    static class Program
    {
        static int Main()
        {
            // Force UTF-8 so Chinese content round-trips correctly through the pipe.
            Console.InputEncoding = Encoding.UTF8;
            Console.OutputEncoding = Encoding.UTF8;
            Console.Error.WriteLine("[driver] ready");

            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;

                JObject req;
                try { req = JObject.Parse(line); }
                catch (Exception ex)
                {
                    WriteResponse(null, null, "", "parse_error: " + ex.Message);
                    continue;
                }

                var id = req["id"]?.ToString();
                var code = req["code"]?.ToString() ?? "";

                // Test/shutdown pseudo-codes (kept verbatim from v0.3 for the
                // existing supervisor hang test).
                if (code == "_freeze")
                {
                    while (true) System.Threading.Thread.Sleep(1000);
                }
                if (code == "_shutdown")
                {
                    WriteResponse(id, new { bye = true }, "", null);
                    return 0;
                }

                try
                {
                    var er = Roslyn.Host.Run(code);
                    WriteResponse(id, er.Result, er.Stdout ?? "", er.Error);
                }
                catch (Exception ex)
                {
                    WriteResponse(id, null, "", "host_error: " + ex.GetType().Name + ": " + ex.Message);
                }
            }
            return 0;
        }

        static void WriteResponse(string id, object result, string stdout, string error)
        {
            var resp = new
            {
                id = id,
                result = error == null ? result : null,
                stdout = stdout ?? "",
                error = error,
            };
            Console.Out.WriteLine(JsonConvert.SerializeObject(resp));
            Console.Out.Flush();
        }
    }
}
```

- [ ] **Step 2: Build**

```bash
bun run driver:build
```

Expected: succeeds.

If you see `Methods.Polish` or `Methods.Observe` undefined errors, that means **Polish.cs/Observe.cs still reference the old method names**. They haven't been deleted yet (Task 1.6 does that), but they should still compile in isolation since `Program.cs` no longer references them. If they error, check whether anything in `Methods/*.cs` uses types deleted from `Program.cs` — likely not, as Methods only depend on `WordSession` and Word interop.

- [ ] **Step 3: Commit**

```bash
git add drivers/WordDriver/Program.cs
git commit -m "feat(driver): single-action protocol — {id,code} ↔ {id,result,stdout,error}"
```

---

### Task 1.5: Driver smoke test (no Word required)

**File (new):** `scripts/test-driver.ts`

A small Bun script that spawns `WordDriver.exe`, sends a few canned requests, asserts the JSON response shape. Does NOT require Word — uses scripts that only touch `System` types.

- [ ] **Step 1: Write the test driver**

Create `scripts/test-driver.ts`:

```typescript
/**
 * Phase 1 driver smoke test.
 *
 * Spawns WordDriver.exe, pipes a few requests, checks responses.
 * Does NOT need Word running — every script here only uses System types
 * (no `Doc` / `App` access). Word-aware tests come at e2e in phase 7.
 *
 * Run from repo root:
 *   bun run scripts/test-driver.ts
 *
 * Exit 0 on all-pass, 1 on any failure. Output is human-readable.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const driverExe = process.env.MSWORD_DRIVER_EXE ?? resolve(
  "drivers/WordDriver/bin/Debug/net48/WordDriver.exe"
);

interface DriverResp {
  id: string | null;
  result: unknown;
  stdout: string;
  error: string | null;
}

async function runFixtures(): Promise<number> {
  const child = spawn(driverExe, [], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const responses = new Map<string, DriverResp>();
  let resolveDone: ((v: void) => void) | null = null;

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf-8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const r = JSON.parse(line) as DriverResp;
        responses.set(String(r.id), r);
      } catch {
        // ignore
      }
    }
  });

  function send(id: string, code: string): Promise<DriverResp> {
    child.stdin.write(JSON.stringify({ id, code }) + "\n");
    return new Promise(async (resolveResp) => {
      for (let i = 0; i < 50; i++) {
        if (responses.has(id)) return resolveResp(responses.get(id)!);
        await delay(100);
      }
      resolveResp({ id, result: null, stdout: "", error: "timeout_in_test" });
    });
  }

  let failures = 0;
  function expect(name: string, ok: boolean, detail = "") {
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures++;
  }

  // Wait for driver ready (it writes [driver] ready to stderr; we just delay
  // and rely on the first request waking it up).
  await delay(200);

  // 1. Trivial integer return
  let r = await send("t1", "return 1 + 2;");
  expect("t1: integer return", r.result === 3 && r.error === null, JSON.stringify(r));

  // 2. Compile error
  r = await send("t2", "this is not c#;");
  expect(
    "t2: compile error reported",
    r.error !== null && r.error.startsWith("compile_error"),
    r.error ?? "(no error)"
  );

  // 3. Runtime error (divide by zero)
  r = await send("t3", "int x = 0; return 1 / x;");
  expect(
    "t3: runtime error reported",
    r.error !== null && r.error.startsWith("runtime_error"),
    r.error ?? "(no error)"
  );

  // 4. Print -> stdout
  r = await send("t4", 'Print("hello"); Print(42);');
  expect(
    "t4: stdout captured",
    r.error === null && r.stdout.includes("hello") && r.stdout.includes("42"),
    JSON.stringify(r.stdout)
  );

  // 5. Empty code rejected
  r = await send("t5", "");
  expect(
    "t5: empty_code error",
    r.error === "empty_code",
    r.error ?? "(no error)"
  );

  // 6. Cooperative shutdown
  r = await send("t6", "_shutdown");
  expect("t6: shutdown returns bye:true", (r.result as any)?.bye === true && r.error === null, JSON.stringify(r));

  // Wait for driver to actually exit on its own.
  await new Promise<void>((res) => child.on("exit", () => res()));

  return failures;
}

const failures = await runFixtures();
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll driver smoke checks passed.");
process.exit(0);
```

- [ ] **Step 2: Run it**

```bash
bun run scripts/test-driver.ts
```

Expected: six green ticks, exit 0.

Common failures and fixes:
- `t1: integer return` fails with `r.result === null` — means the script didn't get to `Roslyn.Host.Run`. Check `Program.cs` step compiled the new file.
- `t3: runtime error reported` fails because the error is `compile_error` instead — Roslyn caught it at compile time. That's actually fine; relax the assertion to accept either, OR rewrite the fixture to a guaranteed-runtime error like `throw new System.Exception("boom");`.
- Driver hangs forever on `t1` — Word might be wedged. Try `taskkill /im WINWORD.EXE /f` (yes, even though we don't use Word in this test, the driver attaches to it lazily; for **this** smoke we don't actually call `ActiveDoc`, so it should not matter, but if you see a hang, audit `Roslyn.Host.Run` to confirm `WordSession.ActiveDoc` is only called once a script tries to use it).

Actually — re-read `Host.Run`. Step 1 in Task 1.3 calls `WordSession.ActiveDoc()` **before** running the script. That means even `return 1+2;` requires Word. **Fix**: lazy-attach. Update `Host.Run` to only call `WordSession.ActiveDoc()` if the script body references `Doc` or `App` — but that's hard to detect statically.

Simpler fix: catch the `Word.Application not found` exception and **continue with `Doc=null, App=null`**; let the script blow up itself if it actually uses Doc/App. Most scripts will. The smoke fixtures (`return 1+2;` etc.) do not, so they'll work.

- [ ] **Step 3: Patch `Roslyn/Host.cs` to allow null Word**

Edit `drivers/WordDriver/Roslyn/Host.cs`. Find this block in `Host.Run`:

```csharp
            Word.Document doc;
            Word.Application app;
            try
            {
                doc = WordSession.ActiveDoc();
                app = doc.Application;
            }
            catch (Exception ex)
            {
                return new ExecResult { Error = "word_unavailable: " + ex.Message };
            }
```

Replace with:

```csharp
            // Lazy attach: scripts that only use System types don't need Word.
            // If Word isn't running, Doc/App stay null and the script will
            // NRE on first use — surfaced as a runtime_error to the LLM.
            Word.Document doc = null;
            Word.Application app = null;
            try
            {
                doc = WordSession.ActiveDoc();
                app = doc.Application;
            }
            catch
            {
                /* leave nulls; LLM will see a clear runtime error if it tries to access Doc/App */
            }
```

- [ ] **Step 4: Rebuild and re-run smoke**

```bash
bun run driver:build && bun run scripts/test-driver.ts
```

Expected: six green ticks.

- [ ] **Step 5: Commit both changes**

```bash
git add drivers/WordDriver/Roslyn/Host.cs scripts/test-driver.ts
git commit -m "test(driver): smoke fixtures + lazy Word attach"
```

---

### Task 1.6: Delete old method dispatch files

Now the new path is proven, remove the dead code.

- [ ] **Step 1: Delete the files**

```bash
git rm drivers/WordDriver/Methods/Polish.cs \
       drivers/WordDriver/Methods/Observe.cs \
       drivers/WordDriver/schema/methods.json
rmdir drivers/WordDriver/Methods drivers/WordDriver/schema 2>/dev/null || true
```

- [ ] **Step 2: Build to confirm nothing else referenced them**

```bash
bun run driver:build
```

Expected: succeeds.

- [ ] **Step 3: Re-run driver smoke**

```bash
bun run scripts/test-driver.ts
```

Expected: still six ticks.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(driver): remove old method dispatch files"
```

---

## Phase 1 acceptance

- ✅ `drivers/WordDriver/WordDriver.csproj` references `Microsoft.CodeAnalysis.CSharp.Scripting` 4.8.0.
- ✅ `drivers/WordDriver/Roslyn/Host.cs` exists with `Globals` (Doc/App/Track/Print) and `Host.Run`.
- ✅ `drivers/WordDriver/RevisionScope.cs` exists at top level.
- ✅ `drivers/WordDriver/Program.cs` uses single-action `{id, code}` ↔ `{id, result, stdout, error}` protocol.
- ✅ `drivers/WordDriver/Methods/`, `drivers/WordDriver/schema/` are deleted.
- ✅ `bun run driver:build` succeeds.
- ✅ `bun run scripts/test-driver.ts` passes all six fixtures.

If any of the above is missing, do not start phase 2.
